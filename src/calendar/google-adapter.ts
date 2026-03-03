/**
 * Google Calendar adapter — wraps existing src/google/calendar.ts.
 * Maps Google's nested format to the native CalendarEvent schema.
 * Bidirectional sync: pull from Google → local store, push local → Google.
 */

import { createLogger } from "../utils/logger.js";
import {
  isCalendarAvailable,
  listEvents as googleListEvents,
  createEvent as googleCreateEvent,
  updateEvent as googleUpdateEvent,
  deleteEvent as googleDeleteEvent,
} from "../google/calendar.js";
import type { CalendarEvent, CalendarAdapter, SyncResult } from "./types.js";
import { getCalendarStore } from "./store.js";

const log = createLogger("calendar.google-adapter");

/** Map a Google Calendar API event to native CalendarEvent fields for upsert. */
function googleEventToNative(gEvent: {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  htmlLink?: string;
  status: string;
}): Partial<CalendarEvent> & { title: string; start: string; end: string } {
  const allDay = !gEvent.start.includes("T");
  return {
    title: gEvent.summary,
    description: gEvent.description,
    start: gEvent.start,
    end: gEvent.end,
    allDay,
    location: gEvent.location,
    attendees: gEvent.attendees.map((a) => ({
      email: a,
      name: undefined,
      role: "required" as const,
      status: "needs-action" as const,
    })),
    status: (gEvent.status === "cancelled" ? "cancelled" : "confirmed") as CalendarEvent["status"],
    externalIds: { google: gEvent.id },
    metadata: gEvent.htmlLink ? { htmlLink: gEvent.htmlLink } : undefined,
  };
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  id = "google" as const;
  name = "Google Calendar";

  isAvailable(): boolean {
    return isCalendarAvailable();
  }

  async sync(since?: string): Promise<SyncResult> {
    const store = getCalendarStore();
    if (!store) return { created: 0, updated: 0, deleted: 0, errors: ["Calendar store not initialized"], syncedAt: new Date().toISOString() };
    if (!this.isAvailable()) return { created: 0, updated: 0, deleted: 0, errors: ["Google not authenticated"], syncedAt: new Date().toISOString() };

    let created = 0;
    let updated = 0;
    let deleted = 0;
    const errors: string[] = [];

    try {
      // Pull events from Google — default to 30 days back / 90 days forward
      const now = new Date();
      const timeMin = since ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

      const result = await googleListEvents({
        timeMin,
        timeMax,
        maxResults: 250,
        showDeleted: true,
      });

      if (!result.ok || !result.events) {
        errors.push(result.message);
        return { created, updated, deleted, errors, syncedAt: new Date().toISOString() };
      }

      for (const gEvent of result.events) {
        try {
          const existing = await store.getByExternalId("google", gEvent.id);

          if (gEvent.status === "cancelled") {
            if (existing && existing.status !== "cancelled") {
              await store.cancel(existing.id, "Cancelled in Google Calendar");
              deleted++;
            }
            continue;
          }

          const native = googleEventToNative(gEvent);

          if (existing) {
            // Update existing — Google is authoritative for Google-sourced events
            await store.update(existing.id, native);
            updated++;
          } else {
            // Create new local event
            await store.create({
              ...native,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              source: "google",
              uid: `google-${gEvent.id}@dash`,
              externalIds: { google: gEvent.id },
            });
            created++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Event ${gEvent.id}: ${msg}`);
        }
      }

      log.info(`Google sync complete: ${created} created, ${updated} updated, ${deleted} deleted`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sync failed: ${msg}`);
      log.error("Google sync failed", { error: msg });
    }

    return { created, updated, deleted, errors, syncedAt: new Date().toISOString() };
  }

  async push(event: CalendarEvent): Promise<void> {
    if (!this.isAvailable()) {
      log.warn("Cannot push to Google — not authenticated");
      return;
    }

    const store = getCalendarStore();
    const googleId = event.externalIds.google;

    if (googleId) {
      // Update existing Google event
      const result = await googleUpdateEvent(googleId, {
        title: event.title,
        start: event.start,
        end: event.end,
        description: event.description,
        location: event.location,
        attendees: event.attendees.map((a) => a.email),
        recurrence: event.recurrence,
        timeZone: event.timezone,
      });
      if (!result.ok) {
        log.error("Failed to push update to Google", { eventId: event.id, googleId, error: result.message });
      }
    } else {
      // Create new Google event
      const result = await googleCreateEvent(event.title, event.start, event.end, {
        description: event.description,
        location: event.location,
        attendees: event.attendees.map((a) => a.email),
        recurrence: event.recurrence,
        timeZone: event.timezone,
      });
      if (result.ok && result.event && store) {
        // Store the Google ID back on the local event
        await store.update(event.id, {
          externalIds: { ...event.externalIds, google: result.event.id },
        });
      } else if (!result.ok) {
        log.error("Failed to push new event to Google", { eventId: event.id, error: result.message });
      }
    }
  }

  async remove(externalId: string): Promise<void> {
    if (!this.isAvailable()) return;

    const result = await googleDeleteEvent(externalId);
    if (!result.ok) {
      log.error("Failed to remove event from Google", { externalId, error: result.message });
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _adapter: GoogleCalendarAdapter | null = null;

export function getGoogleCalendarAdapter(): GoogleCalendarAdapter {
  if (!_adapter) _adapter = new GoogleCalendarAdapter();
  return _adapter;
}
