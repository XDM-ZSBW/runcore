/**
 * Calendar API routes — mounted at /api/calendar in server.ts.
 * Reads from the local CalendarStore (not Google directly).
 */

import { Hono } from "hono";
import { createLogger } from "../utils/logger.js";
import { getCalendarStore } from "./store.js";
import { getGoogleCalendarAdapter } from "./google-adapter.js";

const log = createLogger("calendar.routes");

export const calendarRoutes = new Hono();

/** Get store or 503. */
function store() {
  const s = getCalendarStore();
  if (!s) throw new Error("Calendar store not initialized");
  return s;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** GET /events — list events with filtering */
calendarRoutes.get("/events", async (c) => {
  try {
    const events = await store().list({
      timeMin: c.req.query("timeMin"),
      timeMax: c.req.query("timeMax"),
      calendarId: c.req.query("calendarId") ?? undefined,
      q: c.req.query("q") ?? undefined,
      maxResults: c.req.query("maxResults") ? parseInt(c.req.query("maxResults")!, 10) : undefined,
    });
    return c.json({ ok: true, events, message: `${events.length} events` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to list events", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

/** GET /events/:id — single event */
calendarRoutes.get("/events/:id", async (c) => {
  try {
    const event = await store().get(c.req.param("id"));
    if (!event) return c.json({ error: "Event not found" }, 404);
    return c.json({ ok: true, event });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /events — create event */
calendarRoutes.post("/events", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.title || !body.start || !body.end) {
      return c.json({ error: "title, start, and end are required" }, 400);
    }

    const event = await store().create(body);

    // Push to Google if available
    const adapter = getGoogleCalendarAdapter();
    if (adapter.isAvailable()) {
      try {
        await adapter.push(event);
      } catch (err) {
        log.warn("Failed to push new event to Google", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return c.json({ ok: true, event, message: `Event created: ${event.title}` }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to create event", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

/** PATCH /events/:id — update event */
calendarRoutes.patch("/events/:id", async (c) => {
  try {
    const body = await c.req.json();
    const event = await store().update(c.req.param("id"), body);
    if (!event) return c.json({ error: "Event not found" }, 404);

    // Push to Google if available and event is Google-synced
    const adapter = getGoogleCalendarAdapter();
    if (adapter.isAvailable() && event.externalIds.google) {
      try {
        await adapter.push(event);
      } catch (err) {
        log.warn("Failed to push update to Google", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return c.json({ ok: true, event, message: `Event updated: ${event.title}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to update event", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

/** DELETE /events/:id — cancel event (soft-delete) */
calendarRoutes.delete("/events/:id", async (c) => {
  try {
    const reason = c.req.query("reason") ?? undefined;
    const event = await store().cancel(c.req.param("id"), reason);
    if (!event) return c.json({ error: "Event not found" }, 404);

    // Remove from Google if applicable
    const adapter = getGoogleCalendarAdapter();
    if (adapter.isAvailable() && event.externalIds.google) {
      try {
        await adapter.remove(event.externalIds.google);
      } catch (err) {
        log.warn("Failed to remove event from Google", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return c.json({ ok: true, message: `Event cancelled: ${event.title}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to cancel event", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

// ── Free/busy ────────────────────────────────────────────────────────────────

/** POST /freebusy — compute free/busy from local store */
calendarRoutes.post("/freebusy", async (c) => {
  try {
    const body = await c.req.json<{ start: string; end: string }>();
    if (!body.start || !body.end) return c.json({ error: "start and end are required" }, 400);

    const busy = await store().freeBusy(body.start, body.end);
    return c.json({ ok: true, busy, message: `${busy.length} busy blocks` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Calendars ────────────────────────────────────────────────────────────────

/** GET /calendars — list calendar collections */
calendarRoutes.get("/calendars", async (c) => {
  try {
    const calendars = await store().listCalendars();
    return c.json({ ok: true, calendars });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /calendars — create calendar collection */
calendarRoutes.post("/calendars", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const cal = await store().createCalendar(body);
    return c.json({ ok: true, calendar: cal, message: `Calendar created: ${cal.name}` }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** PATCH /calendars/:id — update calendar collection */
calendarRoutes.patch("/calendars/:id", async (c) => {
  try {
    const body = await c.req.json();
    const cal = await store().updateCalendar(c.req.param("id"), body);
    if (!cal) return c.json({ error: "Calendar not found" }, 404);
    return c.json({ ok: true, calendar: cal, message: `Calendar updated: ${cal.name}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Sync ─────────────────────────────────────────────────────────────────────

/** POST /sync — trigger manual sync from all adapters */
calendarRoutes.post("/sync", async (c) => {
  try {
    const adapter = getGoogleCalendarAdapter();
    if (!adapter.isAvailable()) {
      return c.json({ ok: true, message: "No adapters connected", results: [] });
    }

    const since = c.req.query("since") ?? undefined;
    const result = await adapter.sync(since);
    return c.json({ ok: true, results: [{ adapter: "google", ...result }] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Sync failed", { error: msg });
    return c.json({ error: msg }, 500);
  }
});
