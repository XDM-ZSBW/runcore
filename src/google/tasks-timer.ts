/**
 * Background tasks polling timer.
 * Checks for tasks due soon every 15 minutes.
 * When a task is due within 60 min, pushes a notification.
 * When a task is overdue, pushes a notification.
 * Follows calendar-timer.ts pattern: module-level state, idempotent start/stop.
 */

import { listTasks, isTasksAvailable } from "./tasks.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tasks");

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DUE_SOON_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

let timer: ReturnType<typeof setInterval> | null = null;
const notifiedTaskIds = new Set<string>(); // Avoid duplicate notifications

/**
 * Start the tasks polling timer. Idempotent.
 */
export function startTasksTimer(intervalMs?: number): void {
  if (timer) return;

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;

  timer = setInterval(async () => {
    if (!isTasksAvailable()) return;

    try {
      // Fetch incomplete tasks due within the next 24 hours
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const result = await listTasks("@default", {
        showCompleted: false,
        dueMax: tomorrow.toISOString(),
      });

      if (!result.ok || !result.data) return;

      for (const task of result.data) {
        if (notifiedTaskIds.has(task.id)) continue;
        if (!task.due) continue;

        // Parse the due date safely (extract YYYY-MM-DD to avoid UTC shift)
        const match = task.due.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!match) continue;

        // Due date is date-only (no time), so treat as end-of-day local
        const dueDate = new Date(
          parseInt(match[1]),
          parseInt(match[2]) - 1,
          parseInt(match[3]),
          23, 59, 59,
        );
        const msUntilDue = dueDate.getTime() - now.getTime();

        if (msUntilDue < 0) {
          // Overdue
          notifiedTaskIds.add(task.id);

          const msg = `Overdue task: ${task.title}`;
          pushNotification({
            timestamp: new Date().toISOString(),
            source: "tasks",
            message: msg,
          });
          logActivity({ source: "tasks", summary: msg });
        } else if (msUntilDue <= DUE_SOON_THRESHOLD_MS) {
          // Due soon
          notifiedTaskIds.add(task.id);

          const minsAway = Math.round(msUntilDue / 60_000);
          const msg = minsAway > 0
            ? `Task due in ${minsAway} min: ${task.title}`
            : `Task due now: ${task.title}`;

          pushNotification({
            timestamp: new Date().toISOString(),
            source: "tasks",
            message: msg,
          });
          logActivity({ source: "tasks", summary: msg });
        }
      }

      // Prune old notification IDs (keep max 200)
      if (notifiedTaskIds.size > 200) {
        const arr = [...notifiedTaskIds];
        const toRemove = arr.slice(0, arr.length - 200);
        for (const id of toRemove) notifiedTaskIds.delete(id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "tasks", summary: `Poll error: ${msg}` });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Tasks poll: every ${mins} min`);
}

/**
 * Stop the tasks polling timer.
 */
export function stopTasksTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  notifiedTaskIds.clear();
}

/**
 * Check if the tasks timer is running.
 */
export function isTasksTimerRunning(): boolean {
  return timer !== null;
}
