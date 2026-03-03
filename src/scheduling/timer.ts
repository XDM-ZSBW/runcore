/**
 * Background scheduling timer.
 * Checks for upcoming/overdue blocks every 5 minutes.
 * Follows src/google/calendar-timer.ts pattern: module-level state, idempotent start/stop.
 *
 * Behavior:
 * 1. Blocks starting within 15 min → push notification
 * 2. Blocks past end time + still planned → log activity (creates voltage)
 * 3. Blocks 2+ hours overdue → auto-transition to skipped
 * 4. Blocks whose start has arrived → auto-transition to active
 */

import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { getPressureIntegrator } from "../pulse/pressure.js";
import { createLogger } from "../utils/logger.js";
import type { SchedulingStore } from "./store.js";

const log = createLogger("scheduling");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SOON_THRESHOLD_MS = 15 * 60 * 1000;  // 15 minutes
const OVERDUE_SKIP_MS = 2 * 60 * 60 * 1000; // 2 hours

let timer: ReturnType<typeof setInterval> | null = null;
const notifiedBlockIds = new Set<string>();

/**
 * Start the scheduling timer. Idempotent.
 */
export function startSchedulingTimer(store: SchedulingStore, intervalMs?: number): void {
  if (timer) return;

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;

  timer = setInterval(async () => {
    try {
      await tick(store);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "scheduling", summary: `Timer error: ${msg}` });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Scheduling timer: every ${mins} min`);
}

async function tick(store: SchedulingStore): Promise<void> {
  const now = Date.now();

  // 1. Blocks whose start has arrived → activate
  const readyToActivate = await store.getReadyToActivate();
  for (const block of readyToActivate) {
    await store.update(block.id, { status: "active" });
    logActivity({ source: "scheduling", summary: `Block activated: ${block.title}` });
  }

  // 2. Upcoming blocks → notify
  const upcoming = await store.getUpcoming(SOON_THRESHOLD_MS);
  for (const block of upcoming) {
    if (notifiedBlockIds.has(block.id)) continue;
    notifiedBlockIds.add(block.id);

    const startTime = new Date(block.start!).getTime();
    const minsAway = Math.round((startTime - now) / 60_000);
    const msg = `Upcoming in ${minsAway} min: ${block.title}`;

    pushNotification({
      timestamp: new Date().toISOString(),
      source: "scheduling",
      message: msg,
    });

    logActivity({ source: "scheduling", summary: msg });
  }

  // 3. Overdue blocks → log activity (voltage) or auto-skip
  const overdue = await store.getOverdue();
  for (const block of overdue) {
    const endTime = block.end
      ? new Date(block.end).getTime()
      : block.dueAt
        ? new Date(block.dueAt).getTime()
        : 0;

    const overdueMs = now - endTime;

    if (overdueMs >= OVERDUE_SKIP_MS) {
      // 2+ hours overdue → auto-skip
      await store.update(block.id, { status: "skipped" });
      const msg = `Block auto-skipped (2h+ overdue): ${block.title}`;
      logActivity({ source: "scheduling", summary: msg });

      // Inject tension — missed scheduling creates voltage
      const pulse = getPressureIntegrator();
      if (pulse) {
        pulse.addTension("scheduling", msg);
      }
    } else {
      // Just overdue — log it (may create voltage through pressure integrator)
      const minsOverdue = Math.round(overdueMs / 60_000);
      logActivity({
        source: "scheduling",
        summary: `Block overdue by ${minsOverdue} min: ${block.title}`,
      });
    }
  }

  // Clean up notified IDs for blocks that have passed
  for (const id of notifiedBlockIds) {
    const block = await store.get(id);
    if (!block || block.status !== "planned") {
      notifiedBlockIds.delete(id);
    }
  }
}

/**
 * Stop the scheduling timer.
 */
export function stopSchedulingTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  notifiedBlockIds.clear();
}

/**
 * Check if the scheduling timer is running.
 */
export function isSchedulingTimerRunning(): boolean {
  return timer !== null;
}
