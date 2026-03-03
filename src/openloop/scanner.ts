/**
 * Open Loop Protocol — background scanning service.
 * Follows src/services/traceInsights.ts pattern: module-level state, idempotent start/stop, timer-driven.
 * Scans active open loops against new activity entries for resonance matches.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getActivities, logActivity } from "../activity/log.js";
import type { ActivityEntry } from "../activity/log.js";
import { readBrainLines, appendBrainLine } from "../lib/brain-io.js";
import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveUtilityModel } from "../settings.js";
import { VectorIndex } from "../memory/vector-index.js";
import { createLogger } from "../utils/logger.js";
import { loadLoops, transitionLoop, updateLoopSalience } from "./store.js";
import type { OpenLoopPacket, ResonanceMatch, ScanRunSummary } from "./types.js";
import { triggerResolutionScan } from "./resolution-scanner.js";
import { emitCdt } from "../pulse/activation-event.js";
import { resolveEnv, getInstanceName } from "../instance.js";

const log = createLogger("open-loop-scanner");

// ─── Constants ──────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5 * 60 * 1000;       // 5 min
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;     // 3 min
const MAX_ENTRIES_PER_SCAN = 50;
const MAX_RESONANCES = 30;                      // FIFO
const VECTOR_SIMILARITY_THRESHOLD = 0.55;
const KEYWORD_HIT_THRESHOLD = 2;
// ─── DASH-94: Exponential salience decay ──────────────────────────────────
const SALIENCE_HALF_LIFE_HOURS = 72;                       // 3 days
const SALIENCE_LAMBDA = Math.LN2 / SALIENCE_HALF_LIFE_HOURS; // decay constant
const SALIENCE_DORMANCY_THRESHOLD = 0.1;                   // below this → dormant
const SALIENCE_RESONANCE_BOOST = 0.5;                      // additive boost on resonance (clamped to 1.0)

// ─── DASH-66 safeguards ────────────────────────────────────────────────────
/** Max wall-clock time for the full scan pipeline before aborting. */
const SCAN_TIMEOUT_MS = 90_000;                 // 90s
/** Sources excluded from scanning to prevent self-amplification loops. */
const EXCLUDED_ACTIVITY_SOURCES = new Set(["open-loop"]);
/** Max resonances per single scan cycle to prevent cascade flooding. */
const MAX_RESONANCES_PER_CYCLE = 5;
// ─── DASH-142 safeguards ──────────────────────────────────────────────────
/** Time budget for the candidate search phase (leave margin for LLM + transitions). */
const CANDIDATE_BUDGET_MS = 30_000;             // 30s

// ─── State ──────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
let lastScanId = 0;
let resonances: ResonanceMatch[] = [];
let lastRun: ScanRunSummary | null = null;
let hydrated = false;
/** Guard against overlapping scans (DASH-66). */
let scanInProgress = false;

// ─── OLP Metrics (B-014) ────────────────────────────────────────────────────

interface OlpMetrics {
  totalScans: number;
  totalResonancesFound: number;
  totalDuplicatesFiltered: number;
  vectorMatchCount: number;
  keywordMatchCount: number;
  averageScanDurationMs: number;
}

const olpMetrics: OlpMetrics = {
  totalScans: 0,
  totalResonancesFound: 0,
  totalDuplicatesFiltered: 0,
  vectorMatchCount: 0,
  keywordMatchCount: 0,
  averageScanDurationMs: 0,
};

const RESONANCES_FILE = join(
  resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"),
  "memory",
  "resonances.jsonl",
);
const RESONANCE_SCHEMA_LINE = JSON.stringify({ _schema: "resonances", _version: "1.0" });
const RESONANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// On-the-fly vector index (not shared with memory embeddings)
const vectorIndex = new VectorIndex(process.cwd());

// ─── DASH-142: Embedding caches ─────────────────────────────────────────────
// Loop texts are stable across iterations; cache survives between scans.
const loopEmbedCache = new Map<string, Float32Array>();

// ─── Salience decay (DASH-94) ───────────────────────────────────────────────

/** Resolve a loop's effective salience (absent field = 1.0 for legacy loops). */
function effectiveSalience(loop: OpenLoopPacket): number {
  return loop.salience ?? 1.0;
}

/** Compute decayed salience for a loop based on elapsed time since creation. */
function decayedSalience(loop: OpenLoopPacket, nowMs: number): number {
  const elapsedHours = (nowMs - new Date(loop.createdAt).getTime()) / (1000 * 60 * 60);
  return effectiveSalience(loop) * Math.exp(-SALIENCE_LAMBDA * elapsedHours);
}

/** Boost a loop's salience on resonance (DASH-94). Additive, clamped to 1.0. */
async function boostLoopSalience(loopId: string): Promise<void> {
  const loops = await loadLoops();
  const loop = loops.find((l) => l.id === loopId);
  if (!loop) return;
  const current = decayedSalience(loop, Date.now());
  const boosted = Math.min(1.0, current + SALIENCE_RESONANCE_BOOST);
  await updateLoopSalience(loopId, boosted);
}

/**
 * Apply exponential salience decay. Transition to dormant when salience < 0.1,
 * expire when past expiresAt. Resonant loops still decay but at half rate.
 */
async function pruneStates(): Promise<void> {
  const loops = await loadLoops();
  const now = Date.now();

  for (const loop of loops) {
    if (loop.state === "expired" || loop.state === "dormant") continue;

    const pastExpiry = now >= new Date(loop.expiresAt).getTime();

    // Compute current salience from creation time
    const currentSalience = decayedSalience(loop, now);

    if (loop.state === "active" && (currentSalience < SALIENCE_DORMANCY_THRESHOLD || pastExpiry)) {
      await transitionLoop(loop.id, "dormant");
    } else if (loop.state === "resonant" && pastExpiry) {
      await transitionLoop(loop.id, "expired");
    }
  }
}

// ─── Matching ───────────────────────────────────────────────────────────────

function buildLoopText(loop: OpenLoopPacket): string {
  return [loop.anchor, loop.dissonance, ...loop.searchHeuristic].join(" ");
}

function buildEntryText(entry: ActivityEntry): string {
  return [entry.summary, entry.detail ?? ""].join(" ");
}

/** Keyword fallback: count how many heuristic terms appear in entry text. */
function keywordMatch(loop: OpenLoopPacket, entryText: string): number {
  const lower = entryText.toLowerCase();
  let hits = 0;
  for (const heuristic of loop.searchHeuristic) {
    const terms = heuristic.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    for (const term of terms) {
      if (lower.includes(term)) {
        hits++;
        break; // one hit per heuristic
      }
    }
  }
  return hits;
}

/**
 * Try vector matching, fall back to keyword matching. Salience multiplies scores (DASH-94).
 *
 * DASH-142: Pre-compute entry embeddings once (O(N+M) instead of O(N×M)).
 * Uses loopEmbedCache across scans for stable loop texts.
 * Budget-aware: aborts early if approaching CANDIDATE_BUDGET_MS.
 */
async function findCandidates(
  loops: OpenLoopPacket[],
  entries: ActivityEntry[],
  scanStart: number,
): Promise<Array<{ loop: OpenLoopPacket; entry: ActivityEntry; similarity: number }>> {
  const candidates: Array<{ loop: OpenLoopPacket; entry: ActivityEntry; similarity: number }> = [];
  const now = Date.now();
  const t0 = now;
  const ollamaAvailable = await vectorIndex.isAvailable();
  const availCheckMs = Date.now() - t0;

  let embedCallCount = 0;
  let embedTotalMs = 0;
  let embedMaxMs = 0;
  let cacheHits = 0;

  if (ollamaAvailable) {
    // DASH-142: Pre-compute all entry embeddings once (was previously O(N×M))
    const entryVecs = new Map<number, Float32Array>();
    for (const entry of entries) {
      if (Date.now() - scanStart > CANDIDATE_BUDGET_MS) {
        log.warn(`DASH-142: Budget exceeded during entry pre-embed — embedded ${entryVecs.size}/${entries.length} entries`);
        break;
      }
      const entryText = buildEntryText(entry);
      try {
        const embedStart = Date.now();
        const vec = await vectorIndex.embed(entryText);
        const embedMs = Date.now() - embedStart;
        embedCallCount++;
        embedTotalMs += embedMs;
        if (embedMs > embedMaxMs) embedMaxMs = embedMs;
        entryVecs.set(entry.id, vec);
      } catch {
        continue;
      }
    }

    // Vector path: compare each loop against pre-computed entry embeddings
    for (const loop of loops) {
      if (Date.now() - scanStart > CANDIDATE_BUDGET_MS) {
        log.warn(`DASH-142: Budget exceeded during loop matching — processed ${loops.indexOf(loop)}/${loops.length} loops`);
        break;
      }

      const salience = decayedSalience(loop, now);
      const loopText = buildLoopText(loop);
      let loopVec: Float32Array;
      try {
        const hadCache = loopEmbedCache.has(loop.id);
        const embedStart = Date.now();
        if (hadCache) {
          loopVec = loopEmbedCache.get(loop.id)!;
          cacheHits++;
        } else {
          loopVec = await vectorIndex.embed(loopText);
          loopEmbedCache.set(loop.id, loopVec);
          embedCallCount++;
        }
        const embedMs = Date.now() - embedStart;
        embedTotalMs += embedMs;
        if (embedMs > embedMaxMs) embedMaxMs = embedMs;
      } catch {
        continue;
      }

      let bestEntry: ActivityEntry | null = null;
      let bestScore = 0;

      for (const entry of entries) {
        const entryVec = entryVecs.get(entry.id);
        if (!entryVec) continue; // skip entries that failed to embed
        // DASH-94: raw cosine × salience
        const score = cosine(loopVec, entryVec) * salience;
        if (score >= VECTOR_SIMILARITY_THRESHOLD && score > bestScore) {
          bestScore = score;
          bestEntry = entry;
        }
      }

      if (bestEntry) {
        candidates.push({ loop, entry: bestEntry, similarity: bestScore });
      }
    }

    // Log embedding performance stats
    const avgEmbedMs = embedCallCount > 0 ? Math.round(embedTotalMs / embedCallCount) : 0;
    log.info(
      `Resonance embedding stats: ${embedCallCount} calls (${cacheHits} cache hits), ${embedTotalMs}ms total, ${avgEmbedMs}ms avg, ${embedMaxMs}ms max, ollamaCheck: ${availCheckMs}ms`,
    );
    if (embedMaxMs > 2000) {
      log.warn(
        `PERF_ALERT: Slow embedding detected — max single embed: ${embedMaxMs}ms (${embedCallCount} total calls). ` +
        `Possible Ollama cold start or model reload.`,
      );
    }
  } else {
    // Keyword fallback
    for (const loop of loops) {
      const salience = decayedSalience(loop, now);
      let bestEntry: ActivityEntry | null = null;
      let bestHits = 0;

      for (const entry of entries) {
        const entryText = buildEntryText(entry);
        const hits = keywordMatch(loop, entryText);
        if (hits >= KEYWORD_HIT_THRESHOLD && hits > bestHits) {
          bestHits = hits;
          bestEntry = entry;
        }
      }

      if (bestEntry) {
        // DASH-94: keyword ratio × salience
        candidates.push({ loop, entry: bestEntry, similarity: (bestHits / loop.searchHeuristic.length) * salience });
      }
    }
  }

  return candidates;
}

// ─── LLM confirmation ───────────────────────────────────────────────────────

const RESONANCE_SYSTEM_PROMPT = `You are a conservative resonance filter for ${getInstanceName()}'s Open Loop Protocol.
You receive candidate matches between open loops (unresolved questions) and new activity entries.
Your job is to reject superficial keyword overlap and confirm only genuine semantic connections.

For each candidate, respond with ONLY a JSON array of objects:
{ "loopId": "ol_...", "resonant": true|false, "explanation": "1 sentence why" }

Be conservative: reject matches that are surface-level keyword coincidences.
Only confirm matches where the new activity genuinely relates to the open loop's unresolved tension.`;

async function confirmResonances(
  candidates: Array<{ loop: OpenLoopPacket; entry: ActivityEntry; similarity: number }>,
): Promise<ResonanceMatch[]> {
  if (candidates.length === 0) return [];

  const payload = candidates.map((c) => ({
    loopId: c.loop.id,
    loopAnchor: c.loop.anchor,
    loopDissonance: c.loop.dissonance,
    loopHeuristics: c.loop.searchHeuristic,
    entrySource: c.entry.source,
    entrySummary: c.entry.summary,
    entryDetail: c.entry.detail ?? "",
    similarity: c.similarity,
  }));

  try {
    const provider = resolveProvider();
    const model = resolveUtilityModel();

    const response = await completeChat({
      messages: [
        { role: "system", content: RESONANCE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ],
      model,
      provider,
    });

    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    const parsed = JSON.parse(arrayMatch[0]) as Array<{
      loopId: string;
      resonant: boolean;
      explanation: string;
    }>;

    const confirmed: ResonanceMatch[] = [];
    for (const result of parsed) {
      if (!result.resonant) continue;
      const candidate = candidates.find((c) => c.loop.id === result.loopId);
      if (!candidate) continue;

      confirmed.push({
        loopId: result.loopId,
        matchedActivityId: candidate.entry.id,
        matchedSource: candidate.entry.source,
        matchedSummary: candidate.entry.summary,
        similarity: candidate.similarity,
        explanation: result.explanation,
      });
    }

    return confirmed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`LLM resonance confirmation failed: ${msg}`);
    return [];
  }
}

// ─── Resonance persistence ───────────────────────────────────────────────────

/** Hydrate in-memory resonances from JSONL on first scan. */
async function hydrateResonances(): Promise<void> {
  try {
    const lines = await readBrainLines(RESONANCES_FILE);
    const loaded: ResonanceMatch[] = [];
    const cutoff = new Date(Date.now() - RESONANCE_MAX_AGE_MS).toISOString();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.timestamp && obj.timestamp >= cutoff) {
          loaded.push(obj as ResonanceMatch);
        }
      } catch { /* skip malformed */ }
    }
    resonances = loaded.slice(-MAX_RESONANCES);
  } catch { /* file may not exist yet */ }
  hydrated = true;
}

/** Persist confirmed resonance matches to JSONL. */
async function persistResonances(matches: ResonanceMatch[]): Promise<void> {
  const ts = new Date().toISOString();
  for (const m of matches) {
    await appendBrainLine(RESONANCES_FILE, JSON.stringify({ ...m, timestamp: ts }));
  }
}

// ─── Core scan ──────────────────────────────────────────────────────────────

async function runScan(): Promise<ScanRunSummary | null> {
  // DASH-66: Prevent overlapping scans
  if (scanInProgress) {
    log.warn("Scan already in progress — skipping overlapping invocation");
    return null;
  }
  scanInProgress = true;

  const scanStart = Date.now();
  const phaseTimings: Record<string, number> = {};

  try {
    // Hydrate persisted resonances on first run
    let t0 = Date.now();
    if (!hydrated) await hydrateResonances();
    phaseTimings.hydrate = Date.now() - t0;

    // Step 1: Prune states
    t0 = Date.now();
    await pruneStates();
    phaseTimings.pruneStates = Date.now() - t0;

    // Step 2: Load scannable loops (active + dormant)
    t0 = Date.now();
    const allLoops = await loadLoops();
    phaseTimings.loadLoops = Date.now() - t0;
    const scannable = allLoops.filter((l) => l.state === "active" || l.state === "dormant");

    if (scannable.length === 0) {
      log.info("No scannable loops — skipping");
      const summary: ScanRunSummary = {
        ranAt: new Date().toISOString(),
        activeLoopsScanned: 0,
        newEntriesScanned: 0,
        resonancesFound: 0,
      };
      lastRun = summary;
      return summary;
    }

    // Step 3: Poll new activity entries (DASH-66: filter out self-referential sources)
    t0 = Date.now();
    const rawEntries = (await getActivities(lastScanId)).slice(0, MAX_ENTRIES_PER_SCAN);
    const newEntries = rawEntries.filter((e) => !EXCLUDED_ACTIVITY_SOURCES.has(e.source));
    phaseTimings.getActivities = Date.now() - t0;
    if (rawEntries.length !== newEntries.length) {
      log.info(`Filtered ${rawEntries.length - newEntries.length} self-referential entries (DASH-66)`);
    }
    if (newEntries.length === 0) {
      log.info("No new activity entries — skipping");
      const summary: ScanRunSummary = {
        ranAt: new Date().toISOString(),
        activeLoopsScanned: scannable.length,
        newEntriesScanned: 0,
        resonancesFound: 0,
      };
      lastRun = summary;
      return summary;
    }

    log.info(`Scanning ${scannable.length} loops against ${newEntries.length} new entries...`);

    // Step 4 & 5: Find candidates (deduplicated: one per loop, highest score)
    // DASH-142: pass scanStart for budget-aware early abort
    t0 = Date.now();
    const candidates = await findCandidates(scannable, newEntries, scanStart);
    phaseTimings.findCandidates = Date.now() - t0;

    // Step 6: LLM confirmation
    t0 = Date.now();
    const confirmed = await confirmResonances(candidates);
    phaseTimings.llmConfirmation = Date.now() - t0;

    // DASH-66: Timeout check after expensive phases
    if (Date.now() - scanStart > SCAN_TIMEOUT_MS) {
      log.warn(`PERF_ALERT: Scan exceeded ${SCAN_TIMEOUT_MS}ms timeout after findCandidates+LLM — aborting. Phase timings: ${JSON.stringify(phaseTimings)}`);
      return null;
    }

    // Step 7: Deduplicate against existing resonances, then transition + log
    const existingKeys = new Set(
      resonances.map((r) => `${r.loopId}:${r.matchedActivityId}`),
    );
    // DASH-66: Cap resonances per cycle to prevent cascade flooding
    const deduplicated = confirmed
      .filter((m) => !existingKeys.has(`${m.loopId}:${m.matchedActivityId}`))
      .slice(0, MAX_RESONANCES_PER_CYCLE);

    t0 = Date.now();
    for (const match of deduplicated) {
      // DASH-94: Boost salience on resonance before transitioning
      await boostLoopSalience(match.loopId);
      await transitionLoop(match.loopId, "resonant");
      logActivity({
        source: "open-loop" as any,
        summary: `Resonance: loop ${match.loopId} matched ${match.matchedSource} entry — ${match.explanation}`,
        actionLabel: "AUTONOMOUS",
        reason: "resonance scanner detected match",
      });

      // DASH-102: Emit CDT activation via unified primitive
      emitCdt({
        triggerId: match.loopId,
        sourceKey: `olp:${match.loopId}`,
        anchor: match.matchedSummary,
        loopsInvolved: [match.loopId],
      });
    }
    phaseTimings.transitionAndLog = Date.now() - t0;

    // Step 8: FIFO resonances + persist + advance watermark
    t0 = Date.now();
    resonances.push(...deduplicated);
    if (resonances.length > MAX_RESONANCES) {
      resonances = resonances.slice(resonances.length - MAX_RESONANCES);
    }
    if (deduplicated.length > 0) {
      await persistResonances(deduplicated);
    }
    phaseTimings.persistResonances = Date.now() - t0;

    // DASH-66: advance watermark past ALL entries (including filtered self-gen ones)
    lastScanId = rawEntries[rawEntries.length - 1].id;

    const summary: ScanRunSummary = {
      ranAt: new Date().toISOString(),
      activeLoopsScanned: scannable.length,
      newEntriesScanned: newEntries.length,
      resonancesFound: deduplicated.length,
    };
    lastRun = summary;

    // Update OLP metrics
    const scanDuration = Date.now() - scanStart;
    olpMetrics.totalScans++;
    olpMetrics.totalResonancesFound += deduplicated.length;
    olpMetrics.totalDuplicatesFiltered += confirmed.length - deduplicated.length;
    olpMetrics.averageScanDurationMs = Math.round(
      (olpMetrics.averageScanDurationMs * (olpMetrics.totalScans - 1) + scanDuration) / olpMetrics.totalScans,
    );

    // Phase timing breakdown — always log for diagnostics
    log.info(`Resonance scan phase timings (ms): ${JSON.stringify(phaseTimings)}`);

    // Performance alert: warn if total resonance scan exceeds threshold
    const RESONANCE_SCAN_WARN_MS = 5000;
    const resonanceScanMs = phaseTimings.findCandidates + phaseTimings.llmConfirmation;
    if (resonanceScanMs > RESONANCE_SCAN_WARN_MS) {
      log.warn(
        `PERF_ALERT: Resonance scan took ${resonanceScanMs}ms (threshold: ${RESONANCE_SCAN_WARN_MS}ms). ` +
        `Candidates: ${candidates.length}, Loops: ${scannable.length}, Entries: ${newEntries.length}. ` +
        `Breakdown — findCandidates: ${phaseTimings.findCandidates}ms, LLM: ${phaseTimings.llmConfirmation}ms`,
      );
    }

    log.info(`Scan complete: ${scannable.length} loops, ${newEntries.length} entries, ${deduplicated.length} resonances (${confirmed.length - deduplicated.length} dupes filtered) [${scanDuration}ms total]`);

    // Run resolution scan after resonance scan (Option A from spec)
    // DASH-66: skip cascade steps if already past 70% of time budget
    const cascadeElapsed = Date.now() - scanStart;
    if (cascadeElapsed < SCAN_TIMEOUT_MS * 0.7) {
      t0 = Date.now();
      try {
        await triggerResolutionScan();
      } catch (err) {
        const resMsg = err instanceof Error ? err.message : String(err);
        log.error(`Resolution scan error: ${resMsg}`);
      }
      phaseTimings.resolutionScan = Date.now() - t0;

      // Run loop lifecycle maintenance (staleness archival, merge detection)
      // DASH-66: skip if past 85% of time budget
      if (Date.now() - scanStart < SCAN_TIMEOUT_MS * 0.85) {
        t0 = Date.now();
        try {
          const { triggerLoopLifecycle } = await import("./lifecycle.js");
          await triggerLoopLifecycle();
        } catch (err) {
          const lcMsg = err instanceof Error ? err.message : String(err);
          log.error(`Loop lifecycle error: ${lcMsg}`);
        }
        phaseTimings.lifecycle = Date.now() - t0;
      } else {
        log.warn(`DASH-66: Skipping lifecycle — ${Date.now() - scanStart}ms elapsed, nearing ${SCAN_TIMEOUT_MS}ms timeout`);
      }
    } else {
      log.warn(`DASH-66: Skipping resolution+lifecycle cascade — ${cascadeElapsed}ms elapsed, nearing ${SCAN_TIMEOUT_MS}ms timeout`);
    }

    // Full pipeline timing — alert if total exceeds threshold
    const totalDuration = Date.now() - scanStart;
    const FULL_PIPELINE_WARN_MS = 5000;
    if (totalDuration > FULL_PIPELINE_WARN_MS) {
      log.warn(
        `PERF_ALERT: Full OLP pipeline took ${totalDuration}ms (threshold: ${FULL_PIPELINE_WARN_MS}ms). ` +
        `Phase breakdown: ${JSON.stringify(phaseTimings)}`,
      );
    }
    log.info(`Full OLP pipeline completed in ${totalDuration}ms`);

    return summary;
  } finally {
    scanInProgress = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Start the open loop scanner timer. Idempotent. */
export function startOpenLoopScanner(): void {
  if (timer) return;

  firstRunTimer = setTimeout(async () => {
    firstRunTimer = null;
    log.info("First open loop scan starting...");
    try {
      await runScan();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`First scan error: ${msg}`);
    }
  }, FIRST_RUN_DELAY_MS);

  timer = setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Scan error: ${msg}`);
    }
  }, SCAN_INTERVAL_MS);

  log.info(
    `Open loop scanner: first run in ${FIRST_RUN_DELAY_MS / 1000}s, then every ${SCAN_INTERVAL_MS / 60_000} min`,
  );
}

/** Stop the open loop scanner. */
export function stopOpenLoopScanner(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Get recent resonance matches. */
export function getResonances(): ResonanceMatch[] {
  return [...resonances];
}

/** Get the summary of the last scan run. */
export function getLastScanRun(): ScanRunSummary | null {
  return lastRun;
}

/** Trigger an immediate scan (for manual/API use). */
export async function triggerOpenLoopScan(): Promise<ScanRunSummary | null> {
  return runScan();
}

/** Get cumulative OLP metrics for observatory. */
export function getOlpMetrics(): Readonly<OlpMetrics> {
  return { ...olpMetrics };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
