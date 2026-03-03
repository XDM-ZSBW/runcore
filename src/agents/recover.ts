/**
 * Agent failure recovery — when an agent fails, spawn a recovery agent
 * that diagnoses the failure and attempts to fix the issue.
 *
 * Recovery agents get the original prompt + error output and try to:
 * 1. Identify the root cause from the error output
 * 2. Fix the underlying issue (missing imports, type errors, etc.)
 * 3. Complete the original task if possible
 *
 * Guards against retry loops:
 * - Max 1 recovery attempt per task (tracked by ID)
 * - Recovery agents (label starts with "Fix:") are never themselves recovered
 * - Global circuit breaker: if too many recoveries fail in a window, stop trying
 */

import { submitTask } from "./index.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import type { AgentTask } from "./types.js";

const log = createLogger("agent-recover");

/** Track which tasks already had a recovery attempt (prevent retry loops). */
const recoveryAttempted = new Set<string>();

/** Max chars of error output to include in recovery prompt. */
const MAX_ERROR_CONTEXT = 3000;

/** Max timeout for recovery agents — prevents wasting resources on simple fixes. */
const RECOVERY_MAX_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// ─── Recovery circuit breaker ─────────────────────────────────────────────
// If too many recovery agents fail within a short window, stop spawning
// new recovery agents entirely until the cooldown expires.

const RECOVERY_FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RECOVERY_FAILURE_THRESHOLD = 3; // 3 failed recoveries → stop
const RECOVERY_COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown

const recentRecoveryFailures: number[] = [];
let recoveryCooldownUntil = 0;

/** Record that a recovery agent itself failed (called externally from spawn.ts). */
export function recordRecoveryFailure(): void {
  const now = Date.now();
  recentRecoveryFailures.push(now);

  // Prune old entries outside the window
  while (recentRecoveryFailures.length > 0 && recentRecoveryFailures[0] < now - RECOVERY_FAILURE_WINDOW_MS) {
    recentRecoveryFailures.shift();
  }

  if (recentRecoveryFailures.length >= RECOVERY_FAILURE_THRESHOLD) {
    recoveryCooldownUntil = now + RECOVERY_COOLDOWN_MS;
    log.warn("Recovery circuit breaker tripped", { failures: recentRecoveryFailures.length, cooldownMs: RECOVERY_COOLDOWN_MS });
    logActivity({
      source: "agent",
      summary: `Recovery circuit breaker tripped: ${recentRecoveryFailures.length} recovery failures in ${RECOVERY_FAILURE_WINDOW_MS / 60000}min — pausing recoveries for ${RECOVERY_COOLDOWN_MS / 60000}min`,
      actionLabel: "AUTONOMOUS",
      reason: "recovery circuit breaker",
    });
  }
}

/** Check if recovery spawning is currently allowed. */
function isRecoveryAllowed(): boolean {
  if (Date.now() < recoveryCooldownUntil) return false;
  return true;
}

/** Check if a task is itself a recovery agent (prevent recovery-of-recovery chains). */
function isRecoveryTask(task: AgentTask): boolean {
  return task.label.startsWith("Fix: ");
}

/**
 * Attempt to recover from a failed agent by spawning a recovery agent.
 * Returns true if a recovery agent was spawned, false if skipped.
 */
export async function attemptRecovery(
  failedTask: AgentTask,
  output: string,
): Promise<boolean> {
  log.info(`Attempting recovery for: ${failedTask.label}`, { taskId: failedTask.id, exitCode: failedTask.exitCode });

  // Don't retry if we already tried recovery for this task
  if (recoveryAttempted.has(failedTask.id)) {
    logActivity({ source: "agent", summary: `Recovery skipped (already attempted): ${failedTask.label}`, actionLabel: "AUTONOMOUS", reason: "auto-recovery from agent failure" });
    return false;
  }

  // Don't recover user-triggered tasks — only AI-triggered ones
  // (User tasks are intentional; AI tasks are part of backlog automation)
  if (failedTask.origin === "user") {
    return false;
  }

  // Don't recover recovery agents — prevents recursive Fix: Fix: Fix: chains
  if (isRecoveryTask(failedTask)) {
    logActivity({ source: "agent", summary: `Recovery skipped (is already a recovery agent): ${failedTask.label}`, actionLabel: "AUTONOMOUS", reason: "prevent recovery chain" });
    recordRecoveryFailure();
    return false;
  }

  // Check global recovery circuit breaker
  if (!isRecoveryAllowed()) {
    logActivity({ source: "agent", summary: `Recovery skipped (circuit breaker open): ${failedTask.label}`, actionLabel: "AUTONOMOUS", reason: "recovery circuit breaker" });
    return false;
  }

  recoveryAttempted.add(failedTask.id);

  // Extract the most useful part of the error output (tail)
  const errorTail = output.length > MAX_ERROR_CONTEXT
    ? "...(truncated)\n" + output.slice(-MAX_ERROR_CONTEXT)
    : output;

  const recoveryPrompt = [
    `A previous agent task failed. Your job is to diagnose the failure and fix the issue.`,
    ``,
    `## Original task`,
    `Label: ${failedTask.label}`,
    `Exit code: ${failedTask.exitCode ?? "unknown"}`,
    ``,
    `## Original prompt`,
    failedTask.prompt,
    ``,
    `## Error output from the failed agent`,
    `\`\`\``,
    errorTail,
    `\`\`\``,
    ``,
    `## Your instructions`,
    `1. Read the error output carefully and identify the root cause.`,
    `2. Common causes: missing imports, type errors, file not found, build failures, missing dependencies.`,
    `3. Fix the root cause in the codebase. Make the minimum change needed.`,
    `4. If the original task was partially completed, finish the remaining work.`,
    `5. Run \`npm run build\` to verify your fix compiles.`,
    `6. If the failure is due to an external issue you can't fix (missing API key, network error, etc.), ` +
      `just create a brief note at brain/knowledge/notes/ explaining what went wrong and what's needed.`,
  ].join("\n");

  try {
    const task = await submitTask({
      label: `Fix: ${failedTask.label}`,
      prompt: recoveryPrompt,
      origin: "ai",
      sessionId: failedTask.sessionId,
      timeoutMs: Math.min(failedTask.timeoutMs ?? RECOVERY_MAX_TIMEOUT_MS, RECOVERY_MAX_TIMEOUT_MS),
      // DASH-143: Forward boardTaskId so recovery agent failures contribute
      // to the original board task's cooldown escalation.
      boardTaskId: failedTask.boardTaskId,
    });

    logActivity({
      source: "agent",
      summary: `Recovery agent spawned for: ${failedTask.label}`,
      detail: `Recovery task ${task.id}`,
      actionLabel: "AUTONOMOUS",
      reason: "auto-recovery from agent failure",
    });

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({ source: "agent", summary: `Recovery spawn failed: ${msg}`, actionLabel: "AUTONOMOUS", reason: "auto-recovery spawn failed" });
    return false;
  }
}

/** Clear recovery tracking (e.g., on session reset). */
export function clearRecoveryTracking(): void {
  recoveryAttempted.clear();
  recentRecoveryFailures.length = 0;
  recoveryCooldownUntil = 0;
}

/**
 * Prune the recoveryAttempted set to prevent unbounded memory growth.
 * Called periodically (e.g., from monitor). Keeps only the most recent entries.
 */
export function pruneRecoveryTracking(maxSize = 200): void {
  if (recoveryAttempted.size <= maxSize) return;
  // Sets iterate in insertion order — delete oldest entries
  const excess = recoveryAttempted.size - maxSize;
  let i = 0;
  for (const id of recoveryAttempted) {
    if (i++ >= excess) break;
    recoveryAttempted.delete(id);
  }
}
