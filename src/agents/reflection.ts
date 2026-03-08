/**
 * Session-level reflection engine.
 * Consolidates per-agent reflections into a session summary,
 * writes to decisions.jsonl, and triggers loop lifecycle when appropriate.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { completeChat } from "../llm/complete.js";
import { resolveAgentProvider, resolveAgentModelAsync } from "../settings.js";
import { listTasks } from "./store.js";
import { loadLoops } from "../openloop/store.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { getInstanceName } from "../instance.js";
import { appendBrainLine } from "../lib/brain-io.js";
import type { LoopImpactAction } from "../openloop/types.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("session-reflection");

const DECISIONS_FILE = join(BRAIN_DIR, "memory", "decisions.jsonl");

// ─── Strategy Cache ──────────────────────────────────────────────────────────

interface ReflectionCache {
  fingerprint: string;
  reflection: SessionReflection;
  timestamp: number;
}
let reflectionCache: ReflectionCache | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — stale cache is worse than an LLM call

/**
 * Build a fingerprint from the structural content of a reflection input.
 * If two consecutive rounds have the same fingerprint, the cached strategy
 * can be reused without an LLM call.
 */
function buildFingerprint(results: Array<{ label: string; status: string }>, loopCount: number): string {
  const sorted = [...results].sort((a, b) => a.label.localeCompare(b.label));
  const pattern = sorted.map((r) => `${r.label}:${r.status}`).join("|");
  return `${pattern}#loops=${loopCount}`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReflectionInput {
  sessionId: string;
  round: number;
  results: Array<{ label: string; status: string }>;
  isFinal: boolean;
}

export interface SessionReflection {
  id: string;
  date: string;
  sessionId: string;
  round: number;
  context: string;
  successes: string[];
  failures: string[];
  rootCauses: string[];
  loopImpact: LoopImpactAction[];
  strategyAdjustments: string[];
  confidenceDelta: number;
  status: "active";
}

// ─── LLM prompt ─────────────────────────────────────────────────────────────

function getReflectionSystemPrompt(): string {
  return `You are ${getInstanceName()}'s session-level reflection engine. You synthesize learnings from a batch of autonomous agent tasks.

Given:
- Batch results (labels + statuses)
- Per-agent reflections (JSON from completed tasks)
- Per-agent output summaries
- Active open loop anchors and dissonances

Produce a JSON object (no markdown fences, no extra text):
{
  "context": "1-2 sentence summary of this session round",
  "successes": ["what went well — be specific"],
  "failures": ["what failed — be specific"],
  "rootCauses": ["underlying reasons for failures, not symptoms"],
  "loopImpact": [{"loopId": "ol_xxx", "action": "close|merge|flag", "reason": "...", "mergeWith": "ol_yyy (optional)"}],
  "strategyAdjustments": ["concrete changes for next round"],
  "confidenceDelta": 0.0
}

Rules:
- confidenceDelta: positive if session improved things, negative if it made things worse. Range -1.0 to 1.0.
- loopImpact: only include loops where the session results clearly affect them. "close" means the tension is resolved. "merge" means two loops should be combined. "flag" means it needs human attention.
- strategyAdjustments: be concrete. "try X instead of Y" not "improve performance".
- If nothing meaningful happened, return minimal arrays. Don't invent insights.`;
}

// ─── Core ───────────────────────────────────────────────────────────────────

function generateReflectionId(): string {
  return "sr_" + randomBytes(4).toString("hex");
}

/**
 * Run session-level reflection after a batch completes.
 * Returns the reflection (for feeding strategy adjustments into the next round),
 * or null if reflection fails or is not useful.
 */
export async function reflectOnSession(
  input: ReflectionInput,
): Promise<SessionReflection | null> {
  const { sessionId, round, results, isFinal } = input;

  try {
    // Step 1: Load per-agent reflections and summaries for this session.
    // Optimization: use `since` to skip reading old task files from disk.
    // Session tasks are always recent (created within the current autonomous run),
    // so a 2-hour lookback is generous.
    const recentCutoff = Date.now() - 2 * 60 * 60 * 1000;
    const recentTasks = await listTasks({ since: recentCutoff });
    const sessionTasks = recentTasks.filter((t) => t.sessionId === sessionId);

    const agentData = sessionTasks.map((t) => ({
      label: t.label,
      status: t.status,
      reflection: t.reflection ?? null,
      outputSummary: t.resultSummary?.slice(0, 500) ?? "",
    }));

    // Step 2: Load active open loops for context
    const loops = await loadLoops();
    const activeLoops = loops
      .filter((l) => l.state === "active" || l.state === "resonant" || l.state === "dormant")
      .map((l) => ({
        id: l.id,
        anchor: l.anchor,
        dissonance: l.dissonance,
        state: l.state,
      }));

    // Strategy cache check: if the same task pattern + loop count, reuse previous reflection
    const fingerprint = buildFingerprint(results, activeLoops.length);
    if (
      reflectionCache &&
      reflectionCache.fingerprint === fingerprint &&
      Date.now() - reflectionCache.timestamp < CACHE_TTL_MS &&
      !isFinal // always run LLM for final reflections
    ) {
      log.info(`Strategy cache hit for session ${sessionId} round ${round} — reusing previous reflection`);
      const cached: SessionReflection = {
        ...reflectionCache.reflection,
        id: generateReflectionId(),
        date: new Date().toISOString(),
        sessionId,
        round,
      };
      await appendBrainLine(DECISIONS_FILE, JSON.stringify(cached));
      logActivity({
        source: "agent",
        summary: `Session reflection (round ${round}, cached): ${cached.context}`,
        actionLabel: "REFLECTIVE",
        reason: "strategy cache hit",
      });
      return cached;
    }

    // Step 3: Build the LLM prompt
    const userContent = JSON.stringify({
      sessionId,
      round,
      isFinal,
      batchResults: results,
      agentReflections: agentData,
      activeOpenLoops: activeLoops.slice(0, 20), // cap to avoid token bloat
    }, null, 2);

    // Step 4: Call LLM
    const provider = resolveAgentProvider();
    const model = await resolveAgentModelAsync();

    const response = await completeChat({
      messages: [
        { role: "system", content: getReflectionSystemPrompt() },
        { role: "user", content: userContent },
      ],
      model,
      provider,
    });

    // Step 5: Parse JSON response
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      log.warn(`No JSON in reflection response: ${response.slice(0, 200)}`);
      return null;
    }

    const parsed = JSON.parse(objMatch[0]) as {
      context: string;
      successes: string[];
      failures: string[];
      rootCauses: string[];
      loopImpact: LoopImpactAction[];
      strategyAdjustments: string[];
      confidenceDelta: number;
    };

    // Step 6: Build the SessionReflection record
    const reflection: SessionReflection = {
      id: generateReflectionId(),
      date: new Date().toISOString(),
      sessionId,
      round,
      context: parsed.context ?? "",
      successes: parsed.successes ?? [],
      failures: parsed.failures ?? [],
      rootCauses: parsed.rootCauses ?? [],
      loopImpact: parsed.loopImpact ?? [],
      strategyAdjustments: parsed.strategyAdjustments ?? [],
      confidenceDelta: parsed.confidenceDelta ?? 0,
      status: "active",
    };

    // Update strategy cache for potential reuse in next round
    reflectionCache = { fingerprint, reflection, timestamp: Date.now() };

    // Step 7: Append to decisions.jsonl (encrypted via brain-io)
    await appendBrainLine(DECISIONS_FILE, JSON.stringify(reflection));

    // Step 8: Log activity
    logActivity({
      source: "agent",
      summary: `Session reflection (round ${round}${isFinal ? ", final" : ""}): ${reflection.context}`,
      detail: JSON.stringify({
        id: reflection.id,
        successes: reflection.successes.length,
        failures: reflection.failures.length,
        adjustments: reflection.strategyAdjustments.length,
        loopImpacts: reflection.loopImpact.length,
      }),
      actionLabel: "REFLECTIVE",
      reason: "session-level reflection consolidation",
    });

    log.info(
      `Reflected on session ${sessionId} round ${round}: ${reflection.successes.length} successes, ${reflection.failures.length} failures, ${reflection.strategyAdjustments.length} adjustments`,
    );

    // Step 9: If final round, trigger loop lifecycle with reflection actions
    if (isFinal && reflection.loopImpact.length > 0) {
      try {
        const { runLoopLifecycle } = await import("../openloop/lifecycle.js");
        await runLoopLifecycle(reflection.loopImpact);
      } catch (err) {
        log.warn(
          `Loop lifecycle trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return reflection;
  } catch (err) {
    log.warn(
      `Session reflection failed for ${sessionId} round ${round}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
