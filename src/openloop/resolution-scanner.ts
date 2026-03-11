/**
 * Resolution Scanner — detects resolution in resonant open loops.
 * Mirror of scanner.ts (resonance detection), but transitions resonant → expired
 * when git commits or activity entries resolve the underlying tension.
 *
 * Signal sources: git commits + activity entries.
 * Confirmation: LLM analysis requiring medium+ confidence.
 * Output: loop transition to expired with resolvedBy, plus activity entry.
 */

import { getActivities, logActivity } from "../activity/log.js";
import type { ActivityEntry } from "../activity/log.js";
import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveUtilityModel } from "../settings.js";
import { VectorIndex } from "../memory/vector-index.js";
import { createLogger } from "../utils/logger.js";
import { git, gitAvailable } from "../utils/git.js";
import { loadLoops, transitionLoop } from "./store.js";
import type { OpenLoopPacket, ResolutionMatch, ResolutionScanSummary } from "./types.js";
import { getInstanceName } from "../instance.js";

const log = createLogger("resolution-scanner");

// ─── Constants ──────────────────────────────────────────────────────────────

const VECTOR_SIMILARITY_THRESHOLD = 0.60;  // Higher than resonance (0.55)
const KEYWORD_HIT_THRESHOLD = 2;
const MAX_LOOPS_PER_SCAN = 10;             // Bound LLM calls per cycle
const GIT_LOOKBACK_HOURS = 24;             // Cold start lookback
const MAX_RESOLUTIONS = 30;                // FIFO history

// ─── DASH-66 safeguards ────────────────────────────────────────────────────
/** Max wall-clock time for resolution scan before aborting. */
const RESOLUTION_TIMEOUT_MS = 5_000;         // 5s — hard budget for <5s resolution time
/** Time budget for candidate search phase (leave margin for transitions). */
const CANDIDATE_BUDGET_MS = 3_500;
/** Sources excluded from resolution scanning to prevent self-amplification. */
const EXCLUDED_ACTIVITY_SOURCES = new Set(["open-loop"]);

// ─── Types ──────────────────────────────────────────────────────────────────

interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  files: string[];
}

interface ResolutionCandidate {
  loop: OpenLoopPacket;
  signalId: string;
  signalType: "commit" | "activity";
  signalText: string;
  similarity: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let lastActivityScanId = 0;
let lastScanCommitHash = "";               // Git watermark
let resolutions: ResolutionMatch[] = [];
let lastRun: ResolutionScanSummary | null = null;
/** Guard against overlapping scans. */
let scanInProgress = false;

const vectorIndex = new VectorIndex(process.cwd());

// ─── Embedding cache ────────────────────────────────────────────────────────
// Loop texts are stable across iterations; cache survives between scans.
// Signal texts are only valid within a single scan (cleared each run).
const loopEmbedCache = new Map<string, Float32Array>();
let signalEmbedCache = new Map<string, Float32Array>();

// ─── Git helpers ────────────────────────────────────────────────────────────

/** Collect git commits since a given ISO timestamp or hash. */
function collectGitCommits(sinceHash: string): CommitInfo[] {
  if (!gitAvailable()) return [];
  let raw: string | null;

  if (sinceHash) {
    // Get commits after the watermark hash
    raw = git(`log ${sinceHash}..HEAD --format="%H|||%s|||%b|||" --no-merges`);
  } else {
    // Cold start: look back 24h
    const since = new Date(Date.now() - GIT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    raw = git(`log --since="${since}" --format="%H|||%s|||%b|||" --no-merges`);
  }

  if (!raw || raw.length === 0) return [];

  const commits: CommitInfo[] = [];
  // Split on the record separator (each commit ends with |||)
  const entries = raw.split("|||").filter((s) => s.trim().length > 0);

  // Entries come in groups of 3: hash, subject, body
  for (let i = 0; i + 2 < entries.length; i += 3) {
    const hash = entries[i].trim();
    const subject = entries[i + 1].trim();
    const body = entries[i + 2].trim();

    if (!hash || hash.length < 7) continue;

    // Get changed files for this commit
    const filesRaw = git(`diff-tree --no-commit-id --name-only -r ${hash}`);
    const files = filesRaw ? filesRaw.split("\n").filter((f) => f.trim().length > 0) : [];

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      subject,
      body,
      files,
    });
  }

  return commits;
}

// ─── Matching ───────────────────────────────────────────────────────────────

function buildLoopText(loop: OpenLoopPacket): string {
  return [loop.anchor, loop.dissonance, ...loop.searchHeuristic].join(" ");
}

function buildCommitText(commit: CommitInfo): string {
  return [commit.subject, commit.body, ...commit.files].join(" ");
}

function buildEntryText(entry: ActivityEntry): string {
  return [entry.summary, entry.detail ?? ""].join(" ");
}

/** Keyword fallback: count heuristic term matches in signal text. */
function keywordMatch(loop: OpenLoopPacket, signalText: string): number {
  const lower = signalText.toLowerCase();
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

/** Cached embed: check loop cache → signal cache → call Ollama. */
async function cachedEmbed(
  text: string,
  cacheKey: string,
  isLoop: boolean,
): Promise<Float32Array> {
  const cache = isLoop ? loopEmbedCache : signalEmbedCache;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const vec = await vectorIndex.embed(text);
  cache.set(cacheKey, vec);
  return vec;
}

/** Find resolution candidates via vector similarity or keyword fallback.
 *  Budget-aware: aborts early if scanStart + CANDIDATE_BUDGET_MS is exceeded. */
async function findResolutionCandidates(
  loops: OpenLoopPacket[],
  commits: CommitInfo[],
  entries: ActivityEntry[],
  scanStart: number,
): Promise<ResolutionCandidate[]> {
  const candidates: ResolutionCandidate[] = [];
  const t0 = Date.now();
  const ollamaAvailable = await vectorIndex.isAvailable();
  const availCheckMs = Date.now() - t0;

  let embedCallCount = 0;
  let embedTotalMs = 0;
  let embedMaxMs = 0;
  let cacheHits = 0;

  if (ollamaAvailable) {
    // Pre-compute signal embeddings once (O(C+E) instead of O(L×(C+E)))
    // Same optimization as DASH-142 in scanner.ts
    const commitVecs = new Map<string, { vec: Float32Array; text: string }>();
    for (const commit of commits) {
      if (Date.now() - scanStart > CANDIDATE_BUDGET_MS) {
        log.warn(`Budget exceeded during commit pre-embed — embedded ${commitVecs.size}/${commits.length}`);
        break;
      }
      const text = buildCommitText(commit);
      const cacheKey = `commit:${commit.shortHash}`;
      try {
        const hadCache = signalEmbedCache.has(cacheKey);
        const embedStart = Date.now();
        const vec = await cachedEmbed(text, cacheKey, false);
        const embedMs = Date.now() - embedStart;
        if (hadCache) { cacheHits++; } else { embedCallCount++; embedTotalMs += embedMs; }
        if (embedMs > embedMaxMs) embedMaxMs = embedMs;
        commitVecs.set(cacheKey, { vec, text });
      } catch { continue; }
    }

    const entryVecs = new Map<string, { vec: Float32Array; text: string }>();
    for (const entry of entries) {
      if (Date.now() - scanStart > CANDIDATE_BUDGET_MS) {
        log.warn(`Budget exceeded during entry pre-embed — embedded ${entryVecs.size}/${entries.length}`);
        break;
      }
      const text = buildEntryText(entry);
      const cacheKey = `activity:${entry.id}`;
      try {
        const hadCache = signalEmbedCache.has(cacheKey);
        const embedStart = Date.now();
        const vec = await cachedEmbed(text, cacheKey, false);
        const embedMs = Date.now() - embedStart;
        if (hadCache) { cacheHits++; } else { embedCallCount++; embedTotalMs += embedMs; }
        if (embedMs > embedMaxMs) embedMaxMs = embedMs;
        entryVecs.set(cacheKey, { vec, text });
      } catch { continue; }
    }

    // Vector path: compare each loop against pre-computed signal embeddings
    for (const loop of loops) {
      if (Date.now() - scanStart > CANDIDATE_BUDGET_MS) {
        log.warn(`Budget exceeded during loop matching — processed ${loops.indexOf(loop)}/${loops.length} loops`);
        break;
      }

      const loopText = buildLoopText(loop);
      let loopVec: Float32Array;
      try {
        const hadCache = loopEmbedCache.has(loop.id);
        const embedStart = Date.now();
        loopVec = await cachedEmbed(loopText, loop.id, true);
        const embedMs = Date.now() - embedStart;
        if (hadCache) { cacheHits++; } else { embedCallCount++; embedTotalMs += embedMs; }
        if (embedMs > embedMaxMs) embedMaxMs = embedMs;
      } catch {
        continue;
      }

      let bestSignalId = "";
      let bestSignalType: "commit" | "activity" = "commit";
      let bestSignalText = "";
      let bestScore = 0;

      // Check commits (pre-computed vectors — no embed calls)
      for (const [cacheKey, { vec, text }] of commitVecs) {
        const score = cosine(loopVec, vec);
        if (score >= VECTOR_SIMILARITY_THRESHOLD && score > bestScore) {
          bestScore = score;
          bestSignalId = cacheKey;
          bestSignalType = "commit";
          bestSignalText = text;
        }
      }

      // Check activity entries (pre-computed vectors — no embed calls)
      for (const [cacheKey, { vec, text }] of entryVecs) {
        const score = cosine(loopVec, vec);
        if (score >= VECTOR_SIMILARITY_THRESHOLD && score > bestScore) {
          bestScore = score;
          bestSignalId = cacheKey;
          bestSignalType = "activity";
          bestSignalText = text;
        }
      }

      if (bestSignalId) {
        candidates.push({
          loop,
          signalId: bestSignalId,
          signalType: bestSignalType,
          signalText: bestSignalText,
          similarity: bestScore,
        });
      }
    }

    // Log embedding performance stats
    const avgEmbedMs = embedCallCount > 0 ? Math.round(embedTotalMs / embedCallCount) : 0;
    log.info(
      `Resolution embedding stats: ${embedCallCount} calls (${cacheHits} cache hits), ${embedTotalMs}ms total, ${avgEmbedMs}ms avg, ${embedMaxMs}ms max, ollamaCheck: ${availCheckMs}ms`,
    );
    if (embedMaxMs > 2000) {
      log.warn(
        `PERF_ALERT: Slow embedding detected — max single embed: ${embedMaxMs}ms (${embedCallCount} total calls). ` +
        `Possible Ollama cold start or model reload.`,
      );
    }
  } else {
    // Keyword fallback (fast — no budget check needed)
    for (const loop of loops) {
      let bestSignalId = "";
      let bestSignalType: "commit" | "activity" = "commit";
      let bestSignalText = "";
      let bestHits = 0;

      for (const commit of commits) {
        const text = buildCommitText(commit);
        const hits = keywordMatch(loop, text);
        if (hits >= KEYWORD_HIT_THRESHOLD && hits > bestHits) {
          bestHits = hits;
          bestSignalId = `commit:${commit.shortHash}`;
          bestSignalType = "commit";
          bestSignalText = text;
        }
      }

      for (const entry of entries) {
        const text = buildEntryText(entry);
        const hits = keywordMatch(loop, text);
        if (hits >= KEYWORD_HIT_THRESHOLD && hits > bestHits) {
          bestHits = hits;
          bestSignalId = `activity:${entry.id}`;
          bestSignalType = "activity";
          bestSignalText = text;
        }
      }

      if (bestSignalId) {
        candidates.push({
          loop,
          signalId: bestSignalId,
          signalType: bestSignalType,
          signalText: bestSignalText,
          similarity: bestHits / loop.searchHeuristic.length,
        });
      }
    }
  }

  return candidates;
}

// ─── LLM confirmation ───────────────────────────────────────────────────────

const RESOLUTION_SYSTEM_PROMPT = `You are a resolution detector for ${getInstanceName()}'s Open Loop Protocol.

You receive a resonant open loop (an unresolved tension) and a candidate signal
(a git commit or activity entry). Your job is to determine whether the signal
RESOLVES the tension — not just touches it.

Resolution means:
- The specific question/contradiction in the dissonance has been answered
- Code was written, tested, or deployed that addresses the root cause
- The tension no longer needs to vibrate because its purpose has been fulfilled

NOT resolution:
- The signal merely discusses the same topic
- The signal acknowledges the problem without fixing it
- The signal addresses a related but different tension
- Partial fixes that leave the core dissonance open

For each candidate, respond with ONLY a JSON array of objects:
{ "loopId": "ol_...", "resolved": true|false, "confidence": "high"|"medium"|"low", "explanation": "1 sentence why" }

Only return resolved: true with high or medium confidence.`;

async function confirmResolutions(
  candidates: ResolutionCandidate[],
): Promise<ResolutionMatch[]> {
  if (candidates.length === 0) return [];

  const payload = candidates.map((c) => ({
    loopId: c.loop.id,
    loopAnchor: c.loop.anchor,
    loopDissonance: c.loop.dissonance,
    loopHeuristics: c.loop.searchHeuristic,
    signalId: c.signalId,
    signalType: c.signalType,
    signalText: c.signalText,
    similarity: c.similarity,
  }));

  try {
    const provider = resolveProvider();
    const model = resolveUtilityModel();

    const response = await completeChat({
      messages: [
        { role: "system", content: RESOLUTION_SYSTEM_PROMPT },
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
      resolved: boolean;
      confidence: "high" | "medium" | "low";
      explanation: string;
    }>;

    const confirmed: ResolutionMatch[] = [];
    for (const result of parsed) {
      // Only accept resolved with medium+ confidence
      if (!result.resolved) continue;
      if (result.confidence === "low") continue;

      const candidate = candidates.find((c) => c.loop.id === result.loopId);
      if (!candidate) continue;

      confirmed.push({
        loopId: result.loopId,
        signalId: candidate.signalId,
        signalType: candidate.signalType,
        signalSummary: candidate.signalText.slice(0, 200),
        similarity: candidate.similarity,
        confidence: result.confidence,
        explanation: result.explanation,
      });
    }

    return confirmed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`LLM resolution confirmation failed: ${msg}`);
    return [];
  }
}

// ─── Core scan ──────────────────────────────────────────────────────────────

async function runResolutionScan(): Promise<ResolutionScanSummary | null> {
  // Concurrency guard: prevent overlapping scans
  if (scanInProgress) {
    log.warn("Resolution scan already in progress — skipping overlapping invocation");
    return null;
  }
  scanInProgress = true;

  // Clear per-scan signal embed cache (loop cache persists across scans)
  signalEmbedCache = new Map();

  const scanStart = Date.now();
  const phaseTimings: Record<string, number> = {};

  try {
    // Step 1: Load resonant loops only
    let t0 = Date.now();
    const allLoops = await loadLoops();
    const resonantLoops = allLoops
      .filter((l) => l.state === "resonant")
      .slice(0, MAX_LOOPS_PER_SCAN);
    phaseTimings.loadLoops = Date.now() - t0;

    if (resonantLoops.length === 0) {
      log.info("No resonant loops — skipping resolution scan");
      const summary: ResolutionScanSummary = {
        ranAt: new Date().toISOString(),
        resonantLoopsScanned: 0,
        commitsScanned: 0,
        activitiesScanned: 0,
        resolutionsFound: 0,
      };
      lastRun = summary;
      return summary;
    }

    // Step 2a: Collect git commits since last scan
    t0 = Date.now();
    const commits = collectGitCommits(lastScanCommitHash);
    phaseTimings.collectGitCommits = Date.now() - t0;

    // Step 2b: Collect activity entries since last scan
    // DASH-66: filter out self-generated "open-loop" activities to prevent feedback loops
    t0 = Date.now();
    const rawEntries = await getActivities(lastActivityScanId);
    const newEntries = rawEntries.filter((e) => !EXCLUDED_ACTIVITY_SOURCES.has(e.source));
    phaseTimings.getActivities = Date.now() - t0;
    if (rawEntries.length !== newEntries.length) {
      log.info(`DASH-66: Filtered ${rawEntries.length - newEntries.length} self-generated activities from resolution pool`);
    }

    if (commits.length === 0 && newEntries.length === 0) {
      log.info("No new signals — skipping resolution scan");
      const summary: ResolutionScanSummary = {
        ranAt: new Date().toISOString(),
        resonantLoopsScanned: resonantLoops.length,
        commitsScanned: 0,
        activitiesScanned: 0,
        resolutionsFound: 0,
      };
      lastRun = summary;
      return summary;
    }

    log.info(
      `Resolution scan: ${resonantLoops.length} loops, ${commits.length} commits, ${newEntries.length} entries`,
    );

    // Step 3-4: Find candidates (vector similarity or keyword fallback)
    // Budget-aware: will abort early if approaching CANDIDATE_BUDGET_MS
    t0 = Date.now();
    const candidates = await findResolutionCandidates(resonantLoops, commits, newEntries, scanStart);
    phaseTimings.findCandidates = Date.now() - t0;

    // Budget check: skip LLM if already over budget
    if (Date.now() - scanStart > RESOLUTION_TIMEOUT_MS) {
      log.warn(`Budget exceeded after candidate search — skipping LLM. Phase timings: ${JSON.stringify(phaseTimings)}`);
      if (commits.length > 0) lastScanCommitHash = commits[0].hash;
      if (rawEntries.length > 0) lastActivityScanId = rawEntries[rawEntries.length - 1].id;
      return lastRun;
    }

    // Step 5: LLM confirmation (conservative — requires medium+ confidence)
    t0 = Date.now();
    const confirmed = await confirmResolutions(candidates);
    phaseTimings.llmConfirmation = Date.now() - t0;

    // Step 6: Revalidate loop state + transition confirmed loops to expired
    // After LLM confirmation (which takes time), re-check that each loop is still
    // resonant to prevent duplicate transitions from concurrent processes.
    t0 = Date.now();
    const freshLoops = await loadLoops();
    const stillResonant = new Set(
      freshLoops.filter((l) => l.state === "resonant").map((l) => l.id),
    );

    let transitioned = 0;
    for (const match of confirmed) {
      // Skip if loop was already resolved by another process
      if (!stillResonant.has(match.loopId)) {
        log.info(`Loop ${match.loopId} no longer resonant — skipping duplicate resolution`);
        continue;
      }

      await transitionLoop(match.loopId, "expired", match.signalId);
      stillResonant.delete(match.loopId); // prevent double-transition within this batch
      transitioned++;

      const loop = resonantLoops.find((l) => l.id === match.loopId);
      logActivity({
        source: "open-loop",
        summary: `Resolution: loop ${match.loopId} resolved by ${match.signalId} — ${match.explanation}`,
        actionLabel: "AUTONOMOUS",
        reason: "resolution scanner detected healing",
        detail: JSON.stringify({
          loopId: match.loopId,
          anchor: loop?.anchor,
          dissonance: loop?.dissonance,
          resolvedBy: match.signalId,
          confidence: match.confidence,
          explanation: match.explanation,
        }),
      });
    }
    phaseTimings.transitionAndLog = Date.now() - t0;

    // Step 7: FIFO resolutions history
    resolutions.push(...confirmed);
    if (resolutions.length > MAX_RESOLUTIONS) {
      resolutions = resolutions.slice(resolutions.length - MAX_RESOLUTIONS);
    }

    // Step 8: Advance watermarks
    // DASH-66: advance past ALL entries (including filtered self-gen ones) to prevent re-processing
    if (commits.length > 0) {
      lastScanCommitHash = commits[0].hash; // Most recent commit (git log is newest-first)
    }
    if (rawEntries.length > 0) {
      lastActivityScanId = rawEntries[rawEntries.length - 1].id;
    }

    const totalDuration = Date.now() - scanStart;

    const summary: ResolutionScanSummary = {
      ranAt: new Date().toISOString(),
      resonantLoopsScanned: resonantLoops.length,
      commitsScanned: commits.length,
      activitiesScanned: newEntries.length,
      resolutionsFound: transitioned,
    };
    lastRun = summary;

    // Phase timing breakdown — always log for diagnostics
    log.info(`Resolution scan phase timings (ms): ${JSON.stringify(phaseTimings)}`);

    // Performance alert: warn if resolution scan exceeds threshold
    const RESOLUTION_SCAN_WARN_MS = 5000;
    if (totalDuration > RESOLUTION_SCAN_WARN_MS) {
      log.warn(
        `PERF_ALERT: Resolution scan took ${totalDuration}ms (threshold: ${RESOLUTION_SCAN_WARN_MS}ms). ` +
        `Loops: ${resonantLoops.length}, Commits: ${commits.length}, Entries: ${newEntries.length}, ` +
        `Candidates: ${candidates.length}, Confirmed: ${confirmed.length}, Transitioned: ${transitioned}. ` +
        `Breakdown: ${JSON.stringify(phaseTimings)}`,
      );
    }

    log.info(
      `Resolution scan complete: ${resonantLoops.length} loops, ${commits.length} commits, ${newEntries.length} entries, ${transitioned} resolutions [${totalDuration}ms]`,
    );
    return summary;
  } finally {
    scanInProgress = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Run a resolution scan. Called by the resonance scanner after its own scan. */
export async function triggerResolutionScan(): Promise<ResolutionScanSummary | null> {
  return runResolutionScan();
}

/** Get recent resolution matches. */
export function getResolutions(): ResolutionMatch[] {
  return [...resolutions];
}

/** Get the summary of the last resolution scan run. */
export function getLastResolutionScanRun(): ResolutionScanSummary | null {
  return lastRun;
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
