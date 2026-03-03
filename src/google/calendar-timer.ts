/**
 * Background calendar polling timer.
 * Checks for upcoming events every 5 minutes from the local CalendarStore.
 * When an event is < 30 min away, pushes a notification.
 * Also triggers Google sync on each tick (if available).
 * Follows src/goals/timer.ts pattern: module-level state, idempotent start/stop.
 */

import { getCalendarStore } from "../calendar/store.js";
import { getGoogleCalendarAdapter } from "../calendar/google-adapter.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("calendar");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SOON_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

let timer: ReturnType<typeof setInterval> | null = null;
const notifiedEventIds = new Set<string>(); // Avoid duplicate notifications

/**
 * Start the calendar polling timer. Idempotent.
 */
export function startCalendarTimer(intervalMs?: number): void {
  if (timer) return;

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;

  timer = setInterval(async () => {
    const store = getCalendarStore();
    if (!store) return;

    try {
      // Sync from Google on each tick (if available)
      const adapter = getGoogleCalendarAdapter();
      if (adapter.isAvailable()) {
        adapter.sync().catch((err) => {
          log.warn("Background Google Calendar sync failed", { error: err instanceof Error ? err.message : String(err) });
        });
      }

      // Check upcoming events from local store
      const events = await store.getUpcomingEvents(1); // Next hour
      const now = Date.now();

      for (const event of events) {
        if (notifiedEventIds.has(event.id)) continue;

        const eventStart = new Date(event.start).getTime();
        const minsAway = Math.round((eventStart - now) / 60_000);

        if (eventStart > now && eventStart - now <= SOON_THRESHOLD_MS) {
          notifiedEventIds.add(event.id);

          const attendeeStr = event.attendees.length > 0
            ? ` with ${event.attendees.map((a) => a.name ?? a.email).join(", ")}`
            : "";
          const msg = `Upcoming in ${minsAway} min: ${event.title}${attendeeStr}`;

          pushNotification({
            timestamp: new Date().toISOString(),
            source: "calendar",
            message: msg,
          });

          logActivity({ source: "calendar", summary: msg });
        }
      }

      // Clean up old event IDs (events that have passed)
      for (const id of notifiedEventIds) {
        const event = events.find((e) => e.id === id);
        if (!event || new Date(event.end).getTime() < now) {
          notifiedEventIds.delete(id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "calendar", summary: `Poll error: ${msg}` });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Calendar poll: every ${mins} min`);
}

/**
 * Stop the calendar polling timer.
 */
export function stopCalendarTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  notifiedEventIds.clear();
}

/**
 * Check if the calendar timer is running.
 */
export function isCalendarTimerRunning(): boolean {
  return timer !== null;
}
