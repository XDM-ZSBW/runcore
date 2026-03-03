import { listTasks, updateTask, readTaskOutput } from "./store.js";
import { spawnAgent, activeProcesses, updateBoardTaskState } from "./spawn.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { rememberTaskOutcome } from "./memory.js";
import { pruneRecoveryTracking, attemptRecovery } from "./recover.js";
import { createLogger } from "../utils/logger.js";
import { getRuntime } from "./runtime/index.js";

const log = createLogger("agent-monitor");

const POLL_INTERVAL_MS = 15_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Set of task IDs we're monitoring (recovered PIDs that we didn't spawn).
 * For PIDs we spawned, the exit handler in spawn.ts handles completion.
 * This set tracks recovered PIDs that need poll-based monitoring.
 *
 * Only contains tasks NOT managed by the RuntimeManager — pool-spawned
 * tasks are handled by the RuntimeManager's own monitor cycle.
 */
const monitoredPids = new Map<string, number>();

/** Check if a process is alive by sending signal 0. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a task is managed by the RuntimeManager.
 * Tasks spawned via the agent pool have a corresponding runtime instance
 * and should NOT be double-recovered by the monitor.
 */
function isRuntimeManaged(taskId: string): boolean {
  const runtime = getRuntime();
  return runtime?.getByTaskId(taskId) != null;
}

/**
 * Called once at startup. Scans all task files and recovers state:
 * - running + PID alive → register for monitoring (only if not runtime-managed)
 * - running + PID dead → read log, mark completed/failed (only if not runtime-managed)
 * - pending → re-spawn (only if not runtime-managed)
 *
 * IMPORTANT: Call this AFTER createRuntime() so the runtime registry is
 * available for dedup checks. Tasks managed by the RuntimeManager are
 * skipped — its own recoverAgents() handles them.
 */
export async function recoverTasks(): Promise<void> {
  log.info("Recovering tasks from previous session");
  const tasks = await listTasks();
  let recovered = 0;
  let requeued = 0;
  let skippedRuntime = 0;

  // Separate tasks by recovery action for parallel processing
  const aliveTasks: typeof tasks = [];
  const deadTasks: typeof tasks = [];
  const pendingTasks: typeof tasks = [];

  for (const task of tasks) {
    // Skip tasks managed by the RuntimeManager — prevents double-recovery
    // that causes duplicate retries + recovery agent fan-out (DASH-82)
    if (isRuntimeManaged(task.id)) {
      skippedRuntime++;
      continue;
    }

    if (task.status === "running" && task.pid) {
      if (isPidAlive(task.pid)) {
        aliveTasks.push(task);
      } else {
        deadTasks.push(task);
      }
    } else if (task.status === "pending") {
      pendingTasks.push(task);
    }
  }

  if (skippedRuntime > 0) {
    log.info(`Skipped ${skippedRuntime} runtime-managed task(s) — RuntimeManager handles recovery`);
  }

  // Register alive processes (no I/O needed)
  for (const task of aliveTasks) {
    monitoredPids.set(task.id, task.pid!);
    recovered++;
    logActivity({
      source: "agent",
      summary: `Recovered running agent: ${task.label}`,
      detail: `PID ${task.pid} still alive`,
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "monitor recovered running process",
    });
  }

  // Recover dead tasks in parallel (each reads task output from disk)
  if (deadTasks.length > 0) {
    await Promise.all(deadTasks.map(async (task) => {
      const output = await readTaskOutput(task.id);
      const hasOutput = output.trim().length > 0;

      const finalStatus = hasOutput ? "completed" : "failed";
      await updateTask(task.id, {
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        resultSummary: hasOutput ? output.slice(0, 500) : undefined,
        error: hasOutput ? undefined : "Process died while server was down (no output)",
      });

      // Update board task state on recovery
      if (task.boardTaskId) {
        if (finalStatus === "completed") {
          updateBoardTaskState(task.boardTaskId, { state: "done" });
        } else {
          updateBoardTaskState(task.boardTaskId, { state: "todo", assignee: null });
        }
      }

      rememberTaskOutcome(
        { ...task, status: finalStatus, error: hasOutput ? undefined : "Process died while server was down" },
        output,
      ).catch(() => {});

      logActivity({
        source: "agent",
        summary: `Recovered ${finalStatus} agent: ${task.label}`,
        detail: `PID ${task.pid} was dead on recovery`,
        actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
        reason: "monitor detected process exit",
      });

      const outputSnippet = hasOutput
        ? `\nOutput:\n${output.trim().slice(0, 1000)}`
        : "";
      pushNotification({
        timestamp: new Date().toISOString(),
        source: "agent",
        message: `Agent task "${task.label}" ${finalStatus} (recovered after restart).${outputSnippet}`,
      });
    }));
  }

  // Re-queue pending tasks with staggered delays
  for (const task of pendingTasks) {
    requeued++;
    const delayMs = requeued * 2000;
    logActivity({
      source: "agent",
      summary: `Re-queuing pending agent (${delayMs}ms delay): ${task.label}`,
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "monitor re-queuing pending task",
    });
    setTimeout(() => {
      spawnAgent(task).catch((err) => {
        logActivity({
          source: "agent",
          summary: `Failed to re-spawn agent: ${task.label}`,
          detail: err.message,
          actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
          reason: "monitor re-spawn failed",
        });
      });
    }, delayMs);
  }

  if (recovered > 0 || requeued > 0 || deadTasks.length > 0 || skippedRuntime > 0) {
    log.info("Task recovery complete", { recovered, resolved: deadTasks.length, requeued, skippedRuntime });
    logActivity({
      source: "agent",
      summary: `Agent recovery: ${recovered} running, ${deadTasks.length} resolved, ${requeued} re-queued${skippedRuntime > 0 ? `, ${skippedRuntime} runtime-managed` : ""}`,
    });
  }
}

/** Start the 15s poll loop for monitoring recovered PIDs. */
export function startAgentMonitor(): void {
  if (pollTimer) return;

  pollTimer = setInterval(async () => {
    // Periodically prune the recovery tracking set to prevent memory growth
    pruneRecoveryTracking();

    for (const [taskId, pid] of monitoredPids) {
      if (!isPidAlive(pid)) {
        log.info(`Monitored PID exited`, { taskId, pid });
        monitoredPids.delete(taskId);

        const output = await readTaskOutput(taskId);
        const hasOutput = output.trim().length > 0;

        const finalStatus = hasOutput ? "completed" : "failed";
        const updated = await updateTask(taskId, {
          status: finalStatus,
          finishedAt: new Date().toISOString(),
          resultSummary: hasOutput ? output.slice(0, 500) : undefined,
          error: hasOutput ? undefined : "Process exited with no output",
        });

        const label = updated?.label ?? taskId;

        // Update board task state from monitor
        const boardTaskId = updated?.boardTaskId;
        if (boardTaskId) {
          if (finalStatus === "completed") {
            updateBoardTaskState(boardTaskId, { state: "done" });
          } else {
            updateBoardTaskState(boardTaskId, { state: "todo", assignee: null });
          }
        }

        if (updated) {
          rememberTaskOutcome(updated, output).catch(() => {});
        }

        logActivity({
          source: "agent",
          summary: `Agent ${finalStatus}: ${label}`,
          detail: `Detected via monitor poll (PID ${pid})`,
          actionLabel: updated?.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
          reason: "monitor detected process exit",
        });

        const outputSnippet = hasOutput
          ? `\nOutput:\n${output.trim().slice(0, 1000)}`
          : "";
        pushNotification({
          timestamp: new Date().toISOString(),
          source: "agent",
          message: `Agent task "${label}" ${finalStatus}.${outputSnippet}`,
        });

        // Attempt recovery for failed monitored tasks — but ONLY for tasks
        // not managed by the RuntimeManager. Runtime-managed tasks should never
        // be in monitoredPids (filtered in recoverTasks), but guard here too
        // to prevent double-retry fan-out (DASH-82).
        if (finalStatus === "failed" && updated && updated.origin === "ai") {
          if (isRuntimeManaged(taskId)) {
            log.info(`Skipping recovery for runtime-managed task: ${label}`, { taskId });
          } else {
            attemptRecovery(
              { ...updated, status: "failed", error: "Process exited with no output" },
              output,
            ).catch(() => {});
          }
        }
      }
    }
  }, POLL_INTERVAL_MS);
}

/** Stop the poll loop. */
export function stopAgentMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
