/**
 * Autonomous work loop — the missing "first nudge" that makes the agent proactive.
 *
 * Two entry points:
 *   1. Timer: fires 60s after boot, then every 15 min. Checks board, spawns agents.
 *   2. continueAfterBatch(): called when a batch completes, decides what's next.
 *
 * Both use planAndSpawn() which:
 *   - Reads board state directly (no HTTP, no SSE, no session validation)
 *   - Asks the LLM to pick tasks and write agent prompts
 *   - Parses [AGENT_REQUEST] blocks from the response
 *   - Spawns agents via submitTask()
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBoardProvider } from "../board/provider.js";

// Resolve package root so agents work in the Runcore codebase, not the brain directory.
const __autonomousDir = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __autonomousDir.endsWith("dist/agents")
  ? join(__autonomousDir, "..", "..")
  : join(__autonomousDir, "..");
import { submitTask } from "./index.js";
import { isAgentsBusy, activeAgentCount, generateBridgeReport } from "./spawn.js";
import { commitAgentBatch } from "./commit.js";
import { listTasks as listAgentTasks } from "./store.js";
import { logActivity } from "../activity/log.js";
import { checkResendInbox } from "../resend/inbox.js";
import { pushNotification } from "../goals/notifications.js";
import { completeChat } from "../llm/complete.js";
import { LLMError } from "../llm/errors.js";
import { resolveProvider } from "../settings.js";
import { resolveEnv, getInstanceName, getInstanceNameLower } from "../instance.js";
import { createLogger } from "../utils/logger.js";
import { reflectOnSession } from "./reflection.js";
import { TaskCooldownManager } from "./cooldown.js";
import { checkDedup } from "./dedup-guard.js";
import { recordAutonomousAction, recordDedupBlock } from "../metrics/firewall-metrics.js";
import { getCapabilityRegistry } from "../capabilities/index.js";
import type { ContextMessage } from "../types.js";
import type { QueueTask } from "../queue/types.js";
import type { PulseStatus } from "../pulse/types.js";
import { getPressureIntegrator } from "../pulse/pressure.js";

const log = createLogger("autonomous");

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTONOMOUS_INTERVAL_MS = 60 * 60 * 1000;   // 60 min (coma failsafe — primary trigger is now tension-based)
const FIRST_CHECK_DELAY_MS = 60 * 1000;           // 60s after boot
const MAX_CONTINUATION_ROUNDS = 5;
const MAX_AGENTS_PER_ROUND = 5;

/** Model for the planner LLM — needs to be capable enough for structured output. */
const PLANNER_MODEL = "anthropic/claude-sonnet-4";

// ─── State ───────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
const continuationRounds = new Map<string, number>();
let autonomousSessionCounter = 0;

/** Guard against concurrent planAndSpawn calls (timer vs continuation race). */
let planningInProgress = false;

/**
 * Per-session cumulative failure counter.
 * If a session accumulates too many total failures across all continuation rounds,
 * stop the session entirely. This prevents the scenario where mixed success/failure
 * batches keep the session alive while repeatedly retrying the same failing tasks.
 */
const sessionCumulativeFailures = new Map<string, number>();
const MAX_SESSION_CUMULATIVE_FAILURES = 8;

/**
 * Recent spawn failures that happened BEFORE agents started running.
 * These are validation failures, rate limits, etc. that the batch completion
 * callback never sees. Fed into the next planAndSpawn call so the planner
 * knows what went wrong and doesn't regenerate the same broken task.
 */
const recentSpawnFailures: Array<{ label: string; reason: string; timestamp: number }> = [];
const MAX_SPAWN_FAILURE_MEMORY = 20;
const SPAWN_FAILURE_TTL_MS = 30 * 60_000; // 30 min

/** Persistent cooldown tracker — survives restarts, shared across modules. */
const cooldownManager = TaskCooldownManager.getInstance();

/**
 * Planner skip cache — tracks items the LLM planner reviewed and decided
 * weren't ready. Avoids re-calling the LLM (~2 min round-trip) for the same
 * unchanged items. Items are re-evaluated if their `updatedAt` changes or
 * after the cooldown expires.
 */
const plannerSkipCache = new Map<string, { skippedAt: number; itemUpdatedAt: string }>();
const PLANNER_SKIP_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Max agents the planner will allow before skipping a work check.
 * The planner can still spawn 1-3 agents per round, so actual peak may
 * briefly exceed this while a batch is starting up.
 */
const MAX_CONCURRENT_AGENTS = parseInt(resolveEnv("MAX_CONCURRENT_AGENTS") ?? "", 10) || 3;

/**
 * Map agent label → board taskId, so we can mark the board task as failed
 * when the agent fails and avoid immediately re-assigning it.
 */
const labelToBoardTaskId = new Map<string, string>();

/**
 * Circuit breaker for LLM credit exhaustion.
 * When a credit error is detected, autonomous work pauses until the cooldown expires.
 * This prevents burning through the 15-min cycle repeatedly hitting a dead API.
 */
let creditCircuitBreakerUntil: number = 0;
const CREDIT_CIRCUIT_BREAKER_MS = 30 * 60_000; // 30 minutes

/** Record a spawn-time failure so the planner can learn from it. */
function recordSpawnFailure(label: string, reason: string): void {
  recentSpawnFailures.push({ label, reason, timestamp: Date.now() });
  // Trim old entries
  while (recentSpawnFailures.length > MAX_SPAWN_FAILURE_MEMORY) {
    recentSpawnFailures.shift();
  }
}

/** Get recent spawn failures as planner context, pruning expired entries. */
function getSpawnFailureContext(): string | null {
  const now = Date.now();
  // Prune expired
  while (recentSpawnFailures.length > 0 && now - recentSpawnFailures[0].timestamp > SPAWN_FAILURE_TTL_MS) {
    recentSpawnFailures.shift();
  }
  if (recentSpawnFailures.length === 0) return null;
  const lines = recentSpawnFailures.map((f) =>
    `- "${f.label}": ${f.reason} (${Math.round((now - f.timestamp) / 60_000)}min ago)`
  );
  return `## Recent spawn failures (DO NOT retry these — fix the underlying issue or skip)\n${lines.join("\n")}`;
}

// ─── Periodic State Cleanup ──────────────────────────────────────────────────

/** TTL for orphaned session entries in Maps that track per-session state. */
const SESSION_STATE_TTL_MS = 60 * 60_000; // 1 hour

/** Tracks when each session was last active (created or updated). */
const sessionLastActive = new Map<string, number>();

/** Record session activity (call when a session starts or continues). */
function touchSession(sessionId: string): void {
  sessionLastActive.set(sessionId, Date.now());
}

/**
 * Sweep orphaned session state — entries where the session died without
 * reaching a terminal path (all-fail, round limit, cumulative limit).
 */
function sweepOrphanedSessionState(): void {
  const now = Date.now();
  for (const [sessionId, lastActive] of sessionLastActive) {
    if (now - lastActive > SESSION_STATE_TTL_MS) {
      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
      sessionLastActive.delete(sessionId);
    }
  }
  // Sweep labelToBoardTaskId — entries older than TTL with no matching active session
  // These are bounded by MAX_AGENTS_PER_ROUND × rounds, but clean up stale ones
  if (labelToBoardTaskId.size > 100) {
    log.warn(`labelToBoardTaskId has ${labelToBoardTaskId.size} entries — clearing stale`);
    labelToBoardTaskId.clear();
  }
  // Sweep plannerSkipCache expired entries
  for (const [taskId, entry] of plannerSkipCache) {
    if (now - entry.skippedAt > PLANNER_SKIP_COOLDOWN_MS) {
      plannerSkipCache.delete(taskId);
    }
  }
}

// Run session state sweep every 15 minutes
setInterval(sweepOrphanedSessionState, 15 * 60_000).unref();

// ─── Backlog Promotion ───────────────────────────────────────────────────────

/**
 * Auto-promote "backlog" items to "todo" so the planner can pick them up.
 *
 * Promotion criteria:
 * - Has a description (spec exists, not just a title)
 * - Not on cooldown (don't promote items that keep failing)
 *
 * This closes the gap where items seeded into "backlog" state would sit
 * forever because the planner only picks up "todo" items.
 */
async function promoteBacklogItems(store: any, tasks: QueueTask[]): Promise<void> {
  const backlog = tasks.filter((t) =>
    t.state === "backlog" &&
    t.description && t.description.length > 0 &&
    !cooldownManager.shouldSkip(t.id)
  );

  for (const task of backlog) {
    await store.update(task.id, { state: "todo" });
    task.state = "todo"; // Update in-place so the filter below sees it
    log.info(`Promoted ${task.identifier} from backlog → todo`, {
      identifier: task.identifier,
      title: task.title,
    });
    logActivity({
      source: "autonomous",
      summary: `Promoted ${task.identifier} from backlog → todo: "${task.title}"`,
      actionLabel: "AUTONOMOUS",
      reason: "backlog auto-promotion",
    });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the autonomous work timer. Idempotent.
 * First check fires 60s after boot (not immediately — gives system time to init).
 * Then repeats every 15 min.
 */
export function startAutonomousTimer(intervalMs?: number): void {
  if (timer) return;

  const interval = intervalMs ?? AUTONOMOUS_INTERVAL_MS;

  // Initialize cooldown manager (loads persisted state from disk)
  cooldownManager.init().catch((err) => {
    log.warn(`Cooldown manager init failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Fire first check shortly after boot
  firstCheckTimer = setTimeout(async () => {
    firstCheckTimer = null;
    log.info(` First work check starting...`);
    try {
      await checkForWork();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(` First check error: ${msg}`);
      logActivity({ source: "autonomous", summary: `First check error: ${msg}`, actionLabel: "AUTONOMOUS", reason: "15-min autonomous planner cycle" });
    }
  }, FIRST_CHECK_DELAY_MS);

  // Then repeat on interval
  timer = setInterval(async () => {
    try {
      await checkForWork();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(` Work check error: ${msg}`);
      logActivity({ source: "autonomous", summary: `Work check error: ${msg}`, actionLabel: "AUTONOMOUS", reason: "15-min autonomous planner cycle" });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Autonomous work: first check in ${FIRST_CHECK_DELAY_MS / 1000}s, then every ${mins} min`);
}

/** Stop the autonomous timer. */
export function stopAutonomousTimer(): void {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Flush cooldown state to disk
  cooldownManager.shutdown();
}

/** Is the autonomous timer running? */
export function isAutonomousTimerRunning(): boolean {
  return timer !== null;
}

/**
 * Called by PressureIntegrator when tension exceeds threshold.
 * Wraps checkForWork() with the existing planningInProgress guard.
 */
export async function triggerPulse(): Promise<void> {
  if (planningInProgress) {
    log.info(`Pulse trigger skipped: planning already in progress`);
    return;
  }
  if (activeAgentCount() >= MAX_CONCURRENT_AGENTS) {
    log.info(`Pulse trigger skipped: at capacity (${activeAgentCount()}/${MAX_CONCURRENT_AGENTS})`);
    return;
  }
  log.info(`Pulse trigger: checking for work...`);
  await checkForWork();
}

/** Status snapshot for the `auto` chat command. */
export interface AutonomousStatus {
  timerRunning: boolean;
  intervalMs: number;
  firstCheckDelayMs: number;
  creditCircuitBreakerActive: boolean;
  creditCircuitBreakerRemainingMin: number;
  planningInProgress: boolean;
  activeAgents: number;
  maxConcurrentAgents: number;
  activeSessions: string[];
  cooldowns: Array<{ taskId: string; label?: string; failureCount: number; remainingMin: number }>;
  plannerSkippedItems: number;
  pulse: PulseStatus | null;
}

/** Get a snapshot of the autonomous work loop's current state. */
export function getAutonomousStatus(): AutonomousStatus {
  const activeSessions = [...continuationRounds.keys()];
  const activeCooldowns = cooldownManager.listActiveCooldowns().map((c) => ({
    taskId: c.taskId,
    label: c.label,
    failureCount: c.failureCount,
    remainingMin: Math.round(c.remainingMs / 60_000),
  }));

  const cbRemain = Math.max(0, creditCircuitBreakerUntil - Date.now());

  return {
    timerRunning: timer !== null,
    intervalMs: AUTONOMOUS_INTERVAL_MS,
    firstCheckDelayMs: FIRST_CHECK_DELAY_MS,
    creditCircuitBreakerActive: Date.now() < creditCircuitBreakerUntil,
    creditCircuitBreakerRemainingMin: Math.ceil(cbRemain / 60_000),
    planningInProgress,
    activeAgents: activeAgentCount(),
    maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
    activeSessions,
    cooldowns: activeCooldowns,
    plannerSkippedItems: plannerSkipCache.size,
    pulse: getPressureIntegrator()?.getStatus() ?? null,
  };
}

/**
 * Called by onBatchComplete when all agents in a session finish.
 * Commits work, then checks if there's more to do.
 */
export async function continueAfterBatch(
  sessionId: string,
  results: Array<{ label: string; status: string }>,
): Promise<void> {
  // Commit agent work as a logical batch
  const round = (continuationRounds.get(sessionId) ?? 0) + 1;
  try {
    const commitResult = await commitAgentBatch(results, round);
    if (commitResult.ok && commitResult.message !== "No changes to commit" && commitResult.message !== "No staged changes to commit") {
      logActivity({ source: "system", summary: commitResult.message });
    }
  } catch (err) {
    logActivity({ source: "autonomous", summary: `Commit error: ${err instanceof Error ? err.message : String(err)}`, actionLabel: "AUTONOMOUS", reason: "batch continuation commit" });
  }

  // Record failed agent labels → board task cooldown (escalating, persisted)
  const batchFailedCount = results.filter((r) => r.status === "failed").length;
  for (const r of results) {
    if (r.status === "failed") {
      const boardTaskId = labelToBoardTaskId.get(r.label);
      if (boardTaskId) {
        cooldownManager.recordFailure(boardTaskId, r.label);
        const failureCount = cooldownManager.getFailureCount(boardTaskId);
        if (failureCount >= 3) {
          generateBridgeReport(boardTaskId, r.label, failureCount).catch(() => {});
        }
        labelToBoardTaskId.delete(r.label);
      }
    }
  }

  // Track cumulative failures across all rounds for this session
  if (batchFailedCount > 0) {
    const prevCumulative = sessionCumulativeFailures.get(sessionId) ?? 0;
    const newCumulative = prevCumulative + batchFailedCount;
    sessionCumulativeFailures.set(sessionId, newCumulative);

    if (newCumulative >= MAX_SESSION_CUMULATIVE_FAILURES) {
      log.info(` Session ${sessionId} hit ${newCumulative} cumulative failures (limit ${MAX_SESSION_CUMULATIVE_FAILURES}) — stopping`);
      logActivity({
        source: "autonomous",
        summary: `Session hit ${newCumulative} cumulative failures — stopping`,
        actionLabel: "AUTONOMOUS",
        reason: "cumulative failure limit reached",
      });
      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
      await reflectOnSession({ sessionId, round, results, isFinal: true }).catch(() => {});
      return;
    }
  }

  // If all agents in the batch failed, stop continuation — don't keep trying
  const allFailed = results.every((r) => r.status === "failed");
  if (allFailed) {
    log.info(` All ${results.length} agent(s) in batch failed — stopping continuation for session ${sessionId}`);
    logActivity({ source: "autonomous", summary: `All agents in batch failed — stopping continuation`, actionLabel: "AUTONOMOUS", reason: "all-failure batch halt" });
    continuationRounds.delete(sessionId);
    sessionCumulativeFailures.delete(sessionId);
    await reflectOnSession({ sessionId, round, results, isFinal: true }).catch(() => {});
    return;
  }

  // Check round limit
  if (round > MAX_CONTINUATION_ROUNDS) {
    log.info(` Hit ${MAX_CONTINUATION_ROUNDS}-round limit for session ${sessionId}, pausing`);
    logActivity({ source: "autonomous", summary: `Hit ${MAX_CONTINUATION_ROUNDS}-round limit, pausing`, actionLabel: "AUTONOMOUS", reason: "round limit reached" });
    continuationRounds.delete(sessionId);
    sessionCumulativeFailures.delete(sessionId);
    await reflectOnSession({ sessionId, round, results, isFinal: true }).catch(() => {});
    return;
  }

  continuationRounds.set(sessionId, round);
  touchSession(sessionId);

  const batchSummary = results.map((r) => `${r.label}: ${r.status}`).join(", ");

  // Fixed 2s pause between rounds — enough to prevent rapid cycling,
  // short enough to keep the cluster responsive. Guards (dedup, cooldown,
  // cumulative failure limit) handle runaway scenarios, not the delay.
  const continuationDelayMs = 2000;
  const msg = `Batch done (${batchSummary}). Checking for more work in ${Math.round(continuationDelayMs / 1000)}s (round ${round}/${MAX_CONTINUATION_ROUNDS})...`;
  log.info(` ${msg}`);
  logActivity({ source: "autonomous", summary: msg, actionLabel: "AUTONOMOUS", reason: `batch continuation round ${round}` });
  pushNotification({ timestamp: new Date().toISOString(), source: "autonomous", message: msg });

  // Build context from batch results
  const resultSummary = results
    .map((r) => `- ${r.label}: ${r.status}`)
    .join("\n");

  // Skip LLM-based reflection on intermediate rounds — saves 30-60s per round.
  // Final reflections still run at the early-exit points above (all-failed, cumulative limit, round limit).
  await new Promise((resolve) => setTimeout(resolve, continuationDelayMs));

  const enhancedContext = `Just completed round ${round}:\n${resultSummary}`;
  await planAndSpawn(sessionId, enhancedContext);
}

/** Reset continuation tracking for a session. */
export function resetContinuation(sessionId: string): void {
  continuationRounds.delete(sessionId);
  sessionCumulativeFailures.delete(sessionId);
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Periodic check: if agents are idle and there's actionable work, spawn agents.
 * Exported so PressureIntegrator can call it directly on pulse.
 */
export async function checkForWork(): Promise<void> {
  // Piggyback: check Resend inbox while we're already awake.
  // Debounced internally — cheap no-op if checked recently or not configured.
  checkResendInbox().catch(() => {});

  // Circuit breaker: skip if credits are exhausted (avoid hammering a dead API)
  if (Date.now() < creditCircuitBreakerUntil) {
    const remainMin = Math.ceil((creditCircuitBreakerUntil - Date.now()) / 60_000);
    log.info(` Credit circuit breaker active — skipping work check (${remainMin}min remaining)`);
    return;
  }

  const currentAgents = activeAgentCount();
  if (currentAgents >= MAX_CONCURRENT_AGENTS) {
    log.info(` At capacity (${currentAgents}/${MAX_CONCURRENT_AGENTS} agents), skipping work check`);
    return;
  }

  if (planningInProgress) {
    log.info(` Planning already in progress, skipping work check`);
    return;
  }

  const board = getBoardProvider();
  if (!board?.isAvailable()) {
    log.info(` No board provider available`);
    return;
  }

  const store = (board as any).getStore?.();
  if (!store) {
    log.info(` No queue store available`);
    return;
  }

  const allTasks: QueueTask[] = await store.list();
  const atCapacity = currentAgents >= MAX_CONCURRENT_AGENTS;

  // Auto-promote backlog items to todo so they become actionable
  await promoteBacklogItems(store, allTasks);

  // Filter to tasks the planner can assign.
  // "todo" tasks assigned to the agent are reclaimed if no agent is actively running —
  // they're leftovers from a previous session that failed or was interrupted.
  const agentAssignee = `${getInstanceNameLower()}-agent`;
  const actionable = allTasks.filter((t: QueueTask) => {
    if (t.state !== "todo" && t.state !== "triage") return false;
    if (t.assignee && !(t.assignee === agentAssignee && t.state === "todo" && !atCapacity)) return false;
    if (cooldownManager.shouldSkip(t.id)) return false;
    // Skip self-referential investigation tasks — insight engine creates these,
    // planner picks them up, agents run and create more activity, which triggers
    // more insights. Breaks the feedback loop (DASH-66).
    if (/^\[(bottleneck|anomaly)\]/i.test(t.title)) return false;
    return true;
  });

  if (actionable.length === 0) {
    log.info(` No actionable items on the board`);
    return;
  }

  // Filter out items the planner already reviewed and skipped (unless updated since)
  const now = Date.now();
  const needsReview = actionable.filter((t) => {
    const cached = plannerSkipCache.get(t.id);
    if (!cached) return true;
    // Re-evaluate if item was updated after the planner skipped it
    if (t.updatedAt && t.updatedAt !== cached.itemUpdatedAt) return true;
    // Re-evaluate if the skip cooldown expired
    if (now - cached.skippedAt >= PLANNER_SKIP_COOLDOWN_MS) {
      plannerSkipCache.delete(t.id);
      return true;
    }
    return false;
  });

  if (needsReview.length === 0) {
    log.info(` ${actionable.length} actionable item(s) all recently reviewed by planner — skipping LLM call`);
    return;
  }

  log.info(` Found ${needsReview.length} actionable item(s) (${actionable.length - needsReview.length} cached skip), calling LLM planner...`);

  // Create an internal session for batch tracking
  autonomousSessionCounter++;
  const sessionId = `auto-${Date.now()}-${autonomousSessionCounter}`;
  touchSession(sessionId);

  await planAndSpawn(sessionId, null, needsReview);
}

/**
 * Ask the LLM what to work on, parse AGENT_REQUEST blocks, spawn agents.
 */
async function planAndSpawn(
  sessionId: string,
  priorContext: string | null,
  explicitItems?: QueueTask[],
): Promise<void> {
  if (planningInProgress) {
    log.info(` planAndSpawn already running, skipping duplicate call`);
    return;
  }
  planningInProgress = true;

  try {
    await planAndSpawnInner(sessionId, priorContext, explicitItems);
  } finally {
    planningInProgress = false;
  }
}

async function planAndSpawnInner(
  sessionId: string,
  priorContext: string | null,
  explicitItems?: QueueTask[],
): Promise<void> {
  // Get actionable board items (unless explicitly provided)
  let actionable = explicitItems;
  if (!actionable) {
    const board = getBoardProvider();
    if (!board?.isAvailable()) return;

    const store = (board as any).getStore?.();
    if (!store) return;

    const allTasks: QueueTask[] = await store.list();
    const atCap = activeAgentCount() >= MAX_CONCURRENT_AGENTS;

    // Auto-promote backlog items to todo so they become actionable
    await promoteBacklogItems(store, allTasks);

    const agentAssigneeInner = `${getInstanceNameLower()}-agent`;
    actionable = allTasks.filter((t: QueueTask) => {
      if (t.state !== "todo") return false;
      if (t.assignee && !(t.assignee === agentAssigneeInner && t.state === "todo" && !atCap)) return false;
      if (cooldownManager.shouldSkip(t.id)) return false;
      if (/^\[(bottleneck|anomaly)\]/i.test(t.title)) return false;
      return true;
    });

    if (actionable.length === 0) {
      log.info(` No more actionable items — pausing`);
      logActivity({ source: "autonomous", summary: "No more actionable items — pausing", actionLabel: "AUTONOMOUS", reason: "planner found no work" });
      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
      return;
    }
  }

  // Build board context with descriptions and project names
  const boardContext = actionable
    .map((t) => {
      const desc = t.description ? `\n  ${t.description.slice(0, 1500)}` : "";
      const proj = t.project ? ` {${t.project}}` : "";
      return `- **${t.identifier}**: ${t.title} [${t.state}, P${t.priority ?? 4}]${proj} (id: ${t.id})${desc}`;
    })
    .join("\n");

  // Build the planning prompt
  const prompt = await buildPlannerPrompt(boardContext, priorContext);

  const messages: ContextMessage[] = [
    { role: "system", content: getPlannerSystemPrompt() },
    { role: "user", content: prompt },
  ];

  try {
    log.info(` Calling LLM planner (model: ${PLANNER_MODEL}, provider: ${resolveProvider()})...`);

    const response = await completeChat({
      messages,
      model: PLANNER_MODEL,
      provider: resolveProvider(),
    });

    log.info(` LLM response (${response.length} chars): ${response.slice(0, 200)}...`);

    // Process action blocks + meta blocks (TASK_DONE, etc.) via capability registry
    let actionsExecuted = 0;
    {
      const capReg = getCapabilityRegistry();
      if (capReg) {
        const { results, metaResults } = await capReg.processResponse(response, { origin: "autonomous" });
        actionsExecuted += results.filter((r) => r.ok).length;
        actionsExecuted += metaResults.reduce((n, m) => n + m.results.filter((r) => r.ok).length, 0);
      }
    }

    // Parse WHITEBOARD_QUESTION blocks and plant them
    const questionBlocks = [...response.matchAll(/\[WHITEBOARD_QUESTION\]\s*([\s\S]*?)\s*\[\/WHITEBOARD_QUESTION\]/g)];
    if (questionBlocks.length > 0) {
      await plantWhiteboardQuestions(questionBlocks);
    }

    // Parse AGENT_REQUEST blocks from LLM response
    const blocks = [...response.matchAll(/\[AGENT_REQUEST\]\s*([\s\S]*?)\s*\[\/AGENT_REQUEST\]/g)];

    if (blocks.length === 0 && actionsExecuted === 0 && questionBlocks.length === 0) {
      // Extract a brief reason from the LLM response (strip markdown noise)
      const briefReason = response.replace(/[#*`\[\]]/g, "").trim().slice(0, 150);
      log.info(` LLM decided no agents needed. Response: ${response.slice(0, 300)}`);
      logActivity({
        source: "autonomous",
        summary: `Reviewed ${actionable.length} backlog item(s), none ready: ${briefReason}`,
        actionLabel: "AUTONOMOUS",
        reason: "planner decided no action needed",
      });

      // Cache these items so the next cycle skips the LLM call for unchanged items
      const skipTime = Date.now();
      for (const t of actionable) {
        plannerSkipCache.set(t.id, { skippedAt: skipTime, itemUpdatedAt: t.updatedAt });
      }
      log.info(` Cached ${actionable.length} item(s) as planner-skipped for ${PLANNER_SKIP_COOLDOWN_MS / 60_000}min`);

      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
      return;
    }

    if (blocks.length === 0 && actionsExecuted > 0) {
      log.info(` Executed ${actionsExecuted} action(s), no agents spawned`);
      logActivity({
        source: "autonomous",
        summary: `Executed ${actionsExecuted} action(s) from ${actionable.length} backlog item(s)`,
        actionLabel: "AUTONOMOUS",
        reason: "planner executed actions directly",
      });
      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
      return;
    }

    // Log the planning entry now that the LLM has actually decided to spawn
    const planEntry = logActivity({
      source: "autonomous",
      summary: `Planning ${blocks.length} agent(s) from ${actionable.length} backlog item(s)`,
      actionLabel: "AUTONOMOUS",
      reason: "15-min autonomous planner cycle",
    });
    const planTraceId = planEntry.traceId;

    log.info(` Found ${blocks.length} AGENT_REQUEST block(s)`);

    let spawnCount = 0;
    const spawnedLabels: string[] = [];

    for (const block of blocks) {
      if (spawnCount >= MAX_AGENTS_PER_ROUND) break;

      const rawContent = block[1].trim();
      let jsonStr = rawContent
        .replace(/^`{3,}(?:json)?\s*/i, "")
        .replace(/\s*`{3,}$/i, "")
        .replace(/^`+|`+$/g, "");

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.warn(` No JSON in AGENT_REQUEST block: ${rawContent.slice(0, 200)}`);
        logActivity({ source: "autonomous", summary: `No JSON in AGENT_REQUEST block`, actionLabel: "AUTONOMOUS", reason: "planner output parse issue" });
        continue;
      }

      try {
        const req = JSON.parse(jsonMatch[0]);
        if (!req.prompt) {
          log.warn(` AGENT_REQUEST missing "prompt" field`);
          continue;
        }

        const label = req.label || req.prompt.slice(0, 60);
        let finalPrompt = req.prompt as string;

        // Guard: dedup — skip if same work is already in progress or recently done
        const dedup = await checkDedup(label, finalPrompt);
        if (dedup.blocked) {
          log.info(` Dedup guard blocked: "${label}" — ${dedup.reason}`);
          recordDedupBlock(dedup.reason ?? "unknown");
          logActivity({
            source: "autonomous",
            summary: `Skipped "${label}": ${dedup.reason}`,
            actionLabel: "AUTONOMOUS",
            reason: "dedup guard",
          });
          continue;
        }

        // Guard: reject hallucinated file paths (planner fabricates .py, .db, .csv, pipe chars)
        const hallucinated = finalPrompt.match(/(?:src\/brain\/|\.py\b|\.db\b|\.csv\b|\.axi\b|\|[a-z])/i);
        if (hallucinated) {
          const reason = `Hallucinated path pattern: "${hallucinated[0]}"`;
          log.warn(` Rejected "${label}": ${reason}`);
          recordSpawnFailure(label, reason);
          if (req.taskId) cooldownManager.recordFailure(req.taskId, label);
          logActivity({
            source: "autonomous",
            summary: `Rejected "${label}": ${reason}`,
            actionLabel: "AUTONOMOUS",
            reason: "hallucinated path guard",
          });
          continue;
        }

        // Guard: detect vague prompts
        const hasFilePath = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md|\.json|\.yaml|\.yml)/.test(finalPrompt);
        const isVague = /\b(?:comprehensive|robust|production-ready|enterprise|scalable|world-class)\b/i.test(finalPrompt)
          && !hasFilePath;

        if (isVague) {
          finalPrompt = [
            `IMPORTANT: The original request is vague. Do NOT try to build everything listed.`,
            `Instead: 1) Read the existing codebase (start with src/ and package.json).`,
            `2) Pick ONE small, concrete piece you can implement that connects to existing code.`,
            `3) Build that one thing well.`,
            `4) If nothing concrete can be built without more requirements, create a brief spec at brain/knowledge/notes/.`,
            ``,
            `Original request:`,
            finalPrompt,
          ].join("\n");
        }

        // Track label→boardTaskId so we can cooldown on failure
        if (req.taskId) {
          labelToBoardTaskId.set(label, req.taskId);
        }

        spawnCount++;
        spawnedLabels.push(label);
        recordAutonomousAction();
        log.info(` Spawning agent: ${label}`);
        logActivity({ source: "autonomous", summary: `Spawning: ${label}`, backref: planTraceId, actionLabel: "AUTONOMOUS", reason: "planner selected from backlog" });

        await submitTask({
          label,
          prompt: finalPrompt,
          origin: "ai",
          sessionId,
          boardTaskId: req.taskId,
          cwd: PKG_ROOT,   // Work in the Runcore codebase, not the brain directory
          readOnly: true,   // Autonomous agents investigate and report only — no file edits
        });
      } catch (err) {
        log.error(` AGENT_REQUEST parse error: ${err instanceof Error ? err.message : String(err)}`);
        logActivity({
          source: "autonomous",
          summary: `AGENT_REQUEST parse error: ${err instanceof Error ? err.message : String(err)}`,
          actionLabel: "AUTONOMOUS",
          reason: "planner output parse error",
        });
      }
    }

    if (spawnCount > 0) {
      const summary = `Working on ${spawnCount} task(s): ${spawnedLabels.join(", ")}`;
      log.info(` ${summary}`);
      logActivity({ source: "autonomous", summary, backref: planTraceId, actionLabel: "AUTONOMOUS", reason: "planner selected from backlog" });
      pushNotification({
        timestamp: new Date().toISOString(),
        source: "autonomous",
        message: summary,
      });
    } else {
      log.warn(` Found ${blocks.length} block(s) but spawned 0 agents`);
      logActivity({ source: "autonomous", summary: "Parsed blocks but spawned 0 agents", actionLabel: "AUTONOMOUS", reason: "planner blocks had no valid agents" });
      continuationRounds.delete(sessionId);
      sessionCumulativeFailures.delete(sessionId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(` LLM call failed: ${msg}`);
    logActivity({ source: "autonomous", summary: `LLM call failed: ${msg}`, actionLabel: "AUTONOMOUS", reason: "15-min autonomous planner cycle" });

    // Trip circuit breaker on credit/billing errors to stop hammering a dead API
    const isCreditsIssue = (err instanceof LLMError && err.isCreditsError)
      || /402|credits|afford|payment.required|billing/i.test(msg);
    if (isCreditsIssue) {
      creditCircuitBreakerUntil = Date.now() + CREDIT_CIRCUIT_BREAKER_MS;
      const breaker_msg = `API credits exhausted — autonomous work paused for ${CREDIT_CIRCUIT_BREAKER_MS / 60_000}min. Top up at openrouter.ai/settings/credits.`;
      log.warn(breaker_msg);
      logActivity({ source: "autonomous", summary: breaker_msg, actionLabel: "AUTONOMOUS", reason: "credit circuit breaker tripped" });
      pushNotification({
        timestamp: new Date().toISOString(),
        source: "autonomous",
        message: breaker_msg,
      });
    }

    continuationRounds.delete(sessionId);
    sessionCumulativeFailures.delete(sessionId);
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function getPlannerSystemPrompt(): string {
  const capInstructions = getCapabilityRegistry()?.getPromptInstructions({ origin: "autonomous" }) ?? "";
  return `You are ${getInstanceName()}'s autonomous work planner. Your job is to look at the backlog and decide what agents should work on next.

Rules:
- Pick 1-3 items from the backlog that are ready to implement NOW.
- Skip items that are vague specs or need human decisions — those need grooming first.
- Prefer items with clear titles and descriptions over ambiguous ones.
- Each agent gets ONE focused task. Don't bundle multiple items into one agent.
- Write clear, specific agent prompts with file paths when possible.
- If nothing is ready to implement, output NO [AGENT_REQUEST] blocks and explain why.
- DO NOT retry tasks that have already been attempted and failed. If the "Recent agent history" section shows a task was tried before, skip it unless you have a fundamentally different approach (not just "try again").
- If the same board item has failed multiple times, it probably needs human input or a spec change — skip it.
- ONLY reference files that exist in this TypeScript project. This is a TS/JS codebase — there are NO .py, .db, .csv, or .axi files. No src/brain/ directory exists. If you aren't sure a file exists, tell the agent to check first.
- If the "Recent spawn failures" section lists tasks that were rejected, DO NOT regenerate similar tasks. The failure reason explains what went wrong.
- Check the whiteboard section below. If there are ANSWERED questions, treat the answer as a direct instruction — act on it. If there are OPEN questions, DO NOT guess — the human hasn't decided yet.
- If a backlog item is ambiguous and needs human input, you may output a [WHITEBOARD_QUESTION] block instead of an agent. This plants a question on the whiteboard for the human to answer.

## Whiteboard questions (for ambiguous tasks)
When a task needs human input before you can proceed, output:

[WHITEBOARD_QUESTION]
{"title": "Short question title", "question": "The specific question for the human", "taskId": "DASH-NNN", "tags": ["relevant-tag"]}
[/WHITEBOARD_QUESTION]

Always include the taskId of the board item that triggered the question so the human knows which task is blocked.

## Two types of actions

### 1. Code agents (for code/file tasks)
For tasks that require reading/writing code or files, output:

[AGENT_REQUEST]
{
  "label": "Short descriptive name",
  "prompt": "Detailed instructions for the agent. Reference specific files. Be concrete.",
  "taskId": "the-task-id-from-the-board"
}
[/AGENT_REQUEST]

The agent runs \`claude --print --dangerously-skip-permissions\` in the project root.
It can read/write files, run npm commands, etc. Give it everything it needs to succeed independently.
After making changes, the agent should run \`npm run build\` to verify compilation.

### 2. Google Workspace actions (for calendar, email, docs tasks)
For tasks like scheduling meetings, sending emails, or creating documents, output action blocks directly — NO agent needed.

${capInstructions}

IMPORTANT: When a task says "schedule", "meeting", "calendar", "appointment" — use [CALENDAR_ACTION], not an agent.
When a task says "email", "send", "notify" — use [EMAIL_ACTION], not an agent.
After outputting the action block, also include the taskId so the task can be marked done:
[TASK_DONE]{"taskId": "the-task-id"}[/TASK_DONE]`;
}

async function buildPlannerPrompt(boardContext: string, priorContext: string | null): Promise<string> {
  const parts: string[] = [];

  parts.push(`Current time: ${new Date().toISOString()}`);
  parts.push(``);

  if (priorContext) {
    parts.push(`## Previous batch results`);
    parts.push(priorContext);
    parts.push(``);
  }

  // Include recent agent history so the planner knows what's been tried
  const historyContext = await buildAgentHistoryContext();
  if (historyContext) {
    parts.push(`## Recent agent history (last 24h)`);
    parts.push(historyContext);
    parts.push(``);
  }

  // Include recent spawn failures so planner doesn't regenerate broken tasks
  const spawnFailureCtx = getSpawnFailureContext();
  if (spawnFailureCtx) {
    parts.push(spawnFailureCtx);
    parts.push(``);
  }

  // Include currently cooling-down tasks
  const cooldownContext = cooldownManager.getCooldownContext();
  if (cooldownContext) {
    parts.push(`## Tasks on cooldown (DO NOT assign these)`);
    parts.push(cooldownContext);
    parts.push(``);
  }

  // Include whiteboard context — answered questions are instructions to act on,
  // open questions mean the human hasn't decided yet (don't guess).
  const whiteboardContext = await buildWhiteboardContext();
  if (whiteboardContext) {
    parts.push(whiteboardContext);
    parts.push(``);
  }

  parts.push(`## Actionable backlog items (unassigned, ready to work)`);
  parts.push(boardContext);
  parts.push(``);
  parts.push(`Review these items and decide which ones to assign to agents. Output [AGENT_REQUEST] blocks for each.`);
  parts.push(`If an item is too vague or needs human input, skip it and explain why.`);

  return parts.join("\n");
}

/**
 * Build a summary of recent agent task results so the planner can avoid
 * re-attempting tasks that have already been tried and failed.
 *
 * Optimization: uses `since` filter to skip reading old task files from disk
 * entirely (filename-embedded timestamps are checked before file read).
 */
/**
 * Build whiteboard context for the planner — answered questions become
 * instructions, open questions signal "human hasn't decided yet".
 */
async function buildWhiteboardContext(): Promise<string | null> {
  try {
    const { WhiteboardStore } = await import("../whiteboard/store.js");
    const { BRAIN_DIR } = await import("../lib/paths.js");
    const store = new WhiteboardStore(BRAIN_DIR);
    const summary = await store.getSummary();

    if (summary.total === 0) return null;

    const parts: string[] = [];
    parts.push(`## Whiteboard (shared with human)`);
    parts.push(`${summary.total} items, ${summary.open} open, ${summary.openQuestions} open questions`);

    // Answered questions = instructions to act on
    const allNodes = await store.list();
    const answered = allNodes.filter((n: any) =>
      n.type === "question" && n.answer && n.status === "done"
    );
    if (answered.length > 0) {
      parts.push(``);
      parts.push(`### Answered questions (ACT ON THESE — the answer IS the instruction)`);
      for (const a of answered) {
        parts.push(`- Q: "${a.question || a.title}" → A: ${a.answer}`);
      }
    }

    // Open questions = don't guess, wait for human
    const openQs = await store.getOpenQuestions();
    if (openQs.length > 0) {
      parts.push(``);
      parts.push(`### Open questions (DO NOT guess — human hasn't decided)`);
      for (const q of openQs) {
        parts.push(`- "${q.question || q.title}" (planted by: ${q.plantedBy})`);
      }
    }

    // Top weighted items for awareness
    if (summary.topWeighted.length > 0) {
      parts.push(``);
      parts.push(`### Top attention items`);
      for (const n of summary.topWeighted) {
        const icon = n.type === "question" ? "?" : n.type === "goal" ? "★" : "-";
        parts.push(`  ${icon} [${n.weight}] ${n.title}`);
      }
    }

    return parts.join("\n");
  } catch (err) {
    log.debug(`Failed to load whiteboard context: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Plant whiteboard questions from [WHITEBOARD_QUESTION] blocks in planner response.
 */
async function plantWhiteboardQuestions(blocks: RegExpMatchArray[]): Promise<void> {
  try {
    const { WhiteboardStore } = await import("../whiteboard/store.js");
    const { BRAIN_DIR } = await import("../lib/paths.js");
    const store = new WhiteboardStore(BRAIN_DIR);

    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block[1]);
        if (!parsed.title || !parsed.question) continue;

        const node = await store.create({
          title: parsed.title,
          type: "question",
          parentId: null,
          tags: parsed.tags ?? [],
          plantedBy: "agent",
          question: parsed.question,
          boardTaskId: parsed.taskId,
        });

        const taskRef = parsed.taskId ? ` (blocking ${parsed.taskId})` : "";
        log.info(`Planted whiteboard question: "${parsed.title}"${taskRef} (${node.id})`);
        logActivity({
          source: "autonomous",
          summary: `Whiteboard question planted: "${parsed.title}"`,
          actionLabel: "AUTONOMOUS",
          reason: "planner needs human input",
        });
      } catch {
        log.warn(`Failed to parse WHITEBOARD_QUESTION block`);
      }
    }
  } catch (err) {
    log.warn(`Whiteboard question planting failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function buildAgentHistoryContext(): Promise<string | null> {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    const tasks = await listAgentTasks({ since: cutoff });
    const recent = tasks.filter((t) => {
      const ts = t.finishedAt || t.createdAt;
      return ts && new Date(ts).getTime() > cutoff;
    });

    if (recent.length === 0) return null;

    // Group by normalized label to show patterns
    const byLabel = new Map<string, { completed: number; failed: number; labels: string[] }>();
    for (const t of recent) {
      const key = t.label.replace(/\d+/g, "N").slice(0, 60);
      if (!byLabel.has(key)) byLabel.set(key, { completed: 0, failed: 0, labels: [] });
      const entry = byLabel.get(key)!;
      if (t.status === "completed") entry.completed++;
      else if (t.status === "failed") entry.failed++;
      if (!entry.labels.includes(t.label)) entry.labels.push(t.label);
    }

    const lines: string[] = [];
    for (const [key, info] of byLabel) {
      const status = [];
      if (info.completed > 0) status.push(`${info.completed} completed`);
      if (info.failed > 0) status.push(`${info.failed} FAILED`);
      lines.push(`- "${info.labels[0]}": ${status.join(", ")}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

