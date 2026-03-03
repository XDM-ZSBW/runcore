/**
 * Open Loop Protocol — lifecycle automation.
 * Handles reflection-driven closures, staleness archival, and duplicate merging.
 * Triggered after resolution scans and after session reflections.
 */

import { randomBytes } from "node:crypto";
import { logActivity } from "../activity/log.js";
import { VectorIndex } from "../memory/vector-index.js";
import { createLogger } from "../utils/logger.js";
import { createLoop, loadLoops, transitionLoop } from "./store.js";
import type {
  LifecycleAction,
  LifecycleConfig,
  LifecycleRunSummary,
  LoopImpactAction,
  OpenLoopPacket,
} from "./types.js";

const log = createLogger("loop-lifecycle");

const DEFAULT_CONFIG: LifecycleConfig = {
  staleDays: 5,
  similarityThreshold: 0.80,
  minConfidenceForArchive: 0.3,
};

// ─── DASH-66 safeguards ────────────────────────────────────────────────────
/** Max wall-clock time for lifecycle run before aborting merge detection. */
const LIFECYCLE_TIMEOUT_MS = 30_000;         // 30s
/** Max merges per cycle to prevent creating too many new scannable loops. */
const MAX_MERGES_PER_CYCLE = 3;

const vectorIndex = new VectorIndex(process.cwd());

// ─── Merge logic ────────────────────────────────────────────────────────────

/**
 * Merge multiple loops into one combined loop.
 * Originals are transitioned to expired with resolvedBy pointing to the new loop.
 * Returns the new loop ID, or null if merge fails.
 */
async function mergeLoops(
  loopIds: string[],
  reason: string,
): Promise<string | null> {
  if (loopIds.length < 2) return null;

  const allLoops = await loadLoops();
  const toMerge = loopIds
    .map((id) => allLoops.find((l) => l.id === id))
    .filter((l): l is OpenLoopPacket => l != null && l.state !== "expired");

  if (toMerge.length < 2) return null;

  // Combined loop: shortest anchor, concatenated dissonances, deduplicated heuristics, latest expiry
  const shortestAnchor = toMerge.reduce((a, b) =>
    a.anchor.length <= b.anchor.length ? a : b,
  ).anchor;

  const combinedDissonance = toMerge
    .map((l) => l.dissonance)
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .join(" + ");

  const seenHeuristics = new Set<string>();
  const combinedHeuristics: string[] = [];
  for (const loop of toMerge) {
    for (const h of loop.searchHeuristic) {
      if (!seenHeuristics.has(h.toLowerCase())) {
        seenHeuristics.add(h.toLowerCase());
        combinedHeuristics.push(h);
      }
    }
  }

  const latestExpiry = toMerge.reduce((a, b) =>
    a.expiresAt > b.expiresAt ? a : b,
  ).expiresAt;

  // Create the combined loop
  const newLoop = await createLoop({
    anchor: shortestAnchor,
    dissonance: combinedDissonance,
    searchHeuristic: combinedHeuristics,
    expiresAt: latestExpiry,
  });

  // Transition originals to expired
  for (const loop of toMerge) {
    await transitionLoop(loop.id, "expired", `merge:${newLoop.id}`);
  }

  log.info(
    `Merged ${toMerge.length} loops [${loopIds.join(", ")}] → ${newLoop.id}: ${reason}`,
  );

  return newLoop.id;
}

// ─── Staleness detection ────────────────────────────────────────────────────

/**
 * Find loops that have been active/dormant with no resonance for too long.
 * These get archived (transitioned to expired).
 */
async function archiveStaleLoops(
  loops: OpenLoopPacket[],
  staleDays: number,
): Promise<LifecycleAction[]> {
  const actions: LifecycleAction[] = [];
  const cutoffMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const loop of loops) {
    if (loop.state === "expired" || loop.state === "resonant") continue;

    const age = now - new Date(loop.createdAt).getTime();
    if (age > cutoffMs) {
      await transitionLoop(loop.id, "expired", "lifecycle:stale");
      actions.push({
        type: "archived",
        loopId: loop.id,
        reason: `Stale after ${Math.round(age / (24 * 60 * 60 * 1000))} days with no resonance`,
      });
      log.info(`Archived stale loop ${loop.id} (${Math.round(age / (24 * 60 * 60 * 1000))}d old)`);
    }
  }

  return actions;
}

// ─── Merge detection ────────────────────────────────────────────────────────

function buildLoopText(loop: OpenLoopPacket): string {
  return [loop.anchor, loop.dissonance, ...loop.searchHeuristic].join(" ");
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Keyword-based similarity fallback: Jaccard of heuristic terms. */
function keywordSimilarity(a: OpenLoopPacket, b: OpenLoopPacket): number {
  const termsA = new Set(
    a.searchHeuristic.flatMap((h) =>
      h.toLowerCase().split(/\s+/).filter((t) => t.length > 2),
    ),
  );
  const termsB = new Set(
    b.searchHeuristic.flatMap((h) =>
      h.toLowerCase().split(/\s+/).filter((t) => t.length > 2),
    ),
  );

  if (termsA.size === 0 || termsB.size === 0) return 0;

  let intersection = 0;
  for (const t of termsA) {
    if (termsB.has(t)) intersection++;
  }

  const union = termsA.size + termsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find pairs of active loops that are similar enough to merge.
 * Uses vector similarity when Ollama is available, falls back to keyword overlap.
 */
const MAX_MERGE_COMPARISONS = 50;

async function findMergeCandidates(
  loops: OpenLoopPacket[],
  threshold: number,
): Promise<LifecycleAction[]> {
  const actions: LifecycleAction[] = [];
  let active = loops.filter((l) => l.state === "active" || l.state === "dormant");
  if (active.length < 2) return actions;

  // Cap comparisons to avoid O(n²) explosion with large loop counts
  if (active.length > MAX_MERGE_COMPARISONS) {
    log.info(`Merge detection: sampling ${MAX_MERGE_COMPARISONS} of ${active.length} active loops`);
    // Keep most recent loops (more likely to have duplicates)
    active = active
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, MAX_MERGE_COMPARISONS);
  }

  const merged = new Set<string>();
  const ollamaAvailable = await vectorIndex.isAvailable();

  // Build embeddings cache if vector path available
  const embeddings = new Map<string, Float32Array>();
  if (ollamaAvailable) {
    for (const loop of active) {
      try {
        embeddings.set(loop.id, await vectorIndex.embed(buildLoopText(loop)));
      } catch {
        // skip — will use keyword fallback for this loop
      }
    }
  }

  for (let i = 0; i < active.length; i++) {
    if (merged.has(active[i].id)) continue;

    for (let j = i + 1; j < active.length; j++) {
      if (merged.has(active[j].id)) continue;

      // Same anchor check for keyword path
      const sameAnchor =
        (active[i].anchor ?? "").toLowerCase() === (active[j].anchor ?? "").toLowerCase();

      let similarity = 0;
      const vecA = embeddings.get(active[i].id);
      const vecB = embeddings.get(active[j].id);

      if (vecA && vecB) {
        similarity = cosine(vecA, vecB);
      } else {
        // Keyword fallback — require same anchor
        if (!sameAnchor) continue;
        similarity = keywordSimilarity(active[i], active[j]);
      }

      if (similarity >= threshold) {
        const newId = await mergeLoops(
          [active[i].id, active[j].id],
          `Similarity ${similarity.toFixed(2)} >= ${threshold}`,
        );
        if (newId) {
          merged.add(active[i].id);
          merged.add(active[j].id);
          actions.push({
            type: "merged",
            sourceIds: [active[i].id, active[j].id],
            newLoopId: newId,
            reason: `Similarity ${similarity.toFixed(2)}`,
          });
        }
      }
    }
  }

  return actions;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Run the full loop lifecycle: process reflection actions, archive stale loops, merge duplicates.
 */
export async function runLoopLifecycle(
  reflectionActions?: LoopImpactAction[],
  config?: Partial<LifecycleConfig>,
): Promise<LifecycleRunSummary> {
  const lifecycleStart = Date.now();
  const phaseTimings: Record<string, number> = {};
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const actions: LifecycleAction[] = [];
  let reflectionCount = 0;

  // Step 1: Process reflection-driven actions
  let t0 = Date.now();
  if (reflectionActions && reflectionActions.length > 0) {
    for (const action of reflectionActions) {
      try {
        switch (action.action) {
          case "close":
            await transitionLoop(action.loopId, "expired", `reflection:${action.reason}`);
            actions.push({ type: "closed", loopId: action.loopId, reason: action.reason });
            reflectionCount++;
            break;

          case "merge":
            if (action.mergeWith) {
              const newId = await mergeLoops(
                [action.loopId, action.mergeWith],
                action.reason,
              );
              if (newId) {
                actions.push({
                  type: "merged",
                  sourceIds: [action.loopId, action.mergeWith],
                  newLoopId: newId,
                  reason: action.reason,
                });
                reflectionCount++;
              }
            }
            break;

          case "flag":
            actions.push({ type: "flagged", loopId: action.loopId, reason: action.reason });
            reflectionCount++;
            break;
        }
      } catch (err) {
        log.warn(
          `Failed to process reflection action for ${action.loopId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  phaseTimings.reflectionActions = Date.now() - t0;

  // Step 2: Load current loops for automated maintenance
  t0 = Date.now();
  const loops = await loadLoops();
  phaseTimings.loadLoops = Date.now() - t0;

  // Step 3: Archive stale loops
  t0 = Date.now();
  const staleActions = await archiveStaleLoops(loops, cfg.staleDays);
  actions.push(...staleActions);
  phaseTimings.archiveStale = Date.now() - t0;

  // Step 4: Merge detection (reload loops after staleness archival)
  // DASH-66: skip merge detection if already past timeout budget
  let mergeActions: LifecycleAction[] = [];
  if (Date.now() - lifecycleStart < LIFECYCLE_TIMEOUT_MS) {
    t0 = Date.now();
    const currentLoops = await loadLoops();
    phaseTimings.reloadLoops = Date.now() - t0;

    t0 = Date.now();
    mergeActions = await findMergeCandidates(currentLoops, cfg.similarityThreshold);
    // DASH-66: cap merges per cycle to limit new loop creation
    if (mergeActions.length > MAX_MERGES_PER_CYCLE) {
      log.warn(`DASH-66: Capping merges from ${mergeActions.length} to ${MAX_MERGES_PER_CYCLE} per cycle`);
      mergeActions = mergeActions.slice(0, MAX_MERGES_PER_CYCLE);
    }
    actions.push(...mergeActions);
    phaseTimings.mergeDetection = Date.now() - t0;
  } else {
    log.warn(`DASH-66: Skipping merge detection — ${Date.now() - lifecycleStart}ms elapsed, past ${LIFECYCLE_TIMEOUT_MS}ms timeout`);
  }

  const totalDuration = Date.now() - lifecycleStart;

  const summary: LifecycleRunSummary = {
    ranAt: new Date().toISOString(),
    reflectionActions: reflectionCount,
    staleArchived: staleActions.length,
    mergesPerformed: mergeActions.length,
    actions,
  };

  if (actions.length > 0) {
    logActivity({
      source: "open-loop",
      summary: `Loop lifecycle: ${reflectionCount} reflection, ${staleActions.length} stale, ${mergeActions.length} merged`,
      detail: JSON.stringify(summary),
      actionLabel: "REFLECTIVE",
      reason: "loop lifecycle maintenance",
    });
  }

  // Phase timing breakdown — always log
  log.info(`Lifecycle phase timings (ms): ${JSON.stringify(phaseTimings)}`);

  // Performance alert: warn if lifecycle exceeds threshold
  const LIFECYCLE_WARN_MS = 5000;
  if (totalDuration > LIFECYCLE_WARN_MS) {
    log.warn(
      `PERF_ALERT: Loop lifecycle took ${totalDuration}ms (threshold: ${LIFECYCLE_WARN_MS}ms). ` +
      `Loops: ${loops.length}, Stale: ${staleActions.length}, Merges: ${mergeActions.length}. ` +
      `Breakdown: ${JSON.stringify(phaseTimings)}`,
    );
  }

  log.info(
    `Lifecycle complete: ${reflectionCount} reflection, ${staleActions.length} stale, ${mergeActions.length} merged [${totalDuration}ms]`,
  );

  return summary;
}

/**
 * Convenience wrapper for triggering lifecycle from the scanner.
 * Runs without reflection actions (automated maintenance only).
 */
export async function triggerLoopLifecycle(): Promise<LifecycleRunSummary> {
  return runLoopLifecycle();
}
