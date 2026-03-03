/**
 * Google Calendar API client.
 * Raw fetch via googleGet/googlePost/googlePatch — no SDK.
 * All functions return { ok, data?, message } — never throw.
 */

import { googleGet, googlePost, googlePatch, googleDelete, isGoogleAuthenticated } from "./auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("google.calendar");

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// --- Types ---

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string; // ISO datetime or date
  end: string;
  location?: string;
  attendees: string[];
  htmlLink?: string;
  status: string;
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email?: string; displayName?: string }>;
  htmlLink?: string;
  status?: string;
}

interface GoogleCalendarList {
  items?: GoogleCalendarEvent[];
}

interface GoogleFreeBusyResponse {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
}

// --- Helpers ---

function parseEvent(e: GoogleCalendarEvent): CalendarEvent {
  return {
    id: e.id,
    summary: e.summary ?? "(no title)",
    description: e.description,
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location,
    attendees: (e.attendees ?? []).map((a) => a.displayName ?? a.email ?? "unknown"),
    htmlLink: e.htmlLink,
    status: e.status ?? "confirmed",
  };
}

function toISORange(hours: number): { timeMin: string; timeMax: string } {
  const now = new Date();
  const later = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return {
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
  };
}

function todayRange(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  return {
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
  };
}

// --- Public API ---

/**
 * Check if Calendar is ready (Google authenticated).
 */
export function isCalendarAvailable(): boolean {
  return isGoogleAuthenticated();
}

/**
 * Get today's events from the primary calendar.
 */
export async function getTodaySchedule(): Promise<{
  ok: boolean;
  events?: CalendarEvent[];
  message: string;
}> {
  log.debug("Fetching today's schedule");
  const range = todayRange();
  const result = await googleGet<GoogleCalendarList>(
    `${CALENDAR_API}/calendars/primary/events`,
    {
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    },
  );

  if (!result.ok) {
    log.error("Failed to fetch today's schedule", { error: result.message });
    return { ok: false, message: result.message };
  }

  const events = (result.data?.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map(parseEvent);

  log.info("Fetched today's schedule", { count: events.length });
  return { ok: true, events, message: `${events.length} events today` };
}

/**
 * Get events in the next N hours.
 */
export async function getUpcomingEvents(hours: number = 4): Promise<{
  ok: boolean;
  events?: CalendarEvent[];
  message: string;
}> {
  log.debug("Fetching upcoming events", { hours });
  const range = toISORange(hours);
  const result = await googleGet<GoogleCalendarList>(
    `${CALENDAR_API}/calendars/primary/events`,
    {
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "20",
    },
  );

  if (!result.ok) {
    log.error("Failed to fetch upcoming events", { hours, error: result.message });
    return { ok: false, message: result.message };
  }

  const events = (result.data?.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map(parseEvent);

  log.debug("Fetched upcoming events", { hours, count: events.length });
  return { ok: true, events, message: `${events.length} events in next ${hours}h` };
}

/**
 * List events with flexible filtering.
 * @param opts.timeMin - Start of range (ISO string). Defaults to now.
 * @param opts.timeMax - End of range (ISO string). Defaults to 24h from timeMin.
 * @param opts.query - Free text search (matches summary, description, location, attendees).
 * @param opts.maxResults - Maximum events to return (default 50).
 * @param opts.showDeleted - Include cancelled events (default false).
 */
export async function listEvents(opts?: {
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
  showDeleted?: boolean;
}): Promise<{
  ok: boolean;
  events?: CalendarEvent[];
  message: string;
}> {
  const now = new Date();
  const params: Record<string, string> = {
    timeMin: opts?.timeMin ?? now.toISOString(),
    timeMax: opts?.timeMax ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(opts?.maxResults ?? 50),
  };
  if (opts?.query) params.q = opts.query;
  if (opts?.showDeleted) params.showDeleted = "true";

  log.debug("Listing events", { timeMin: params.timeMin, timeMax: params.timeMax, query: opts?.query });
  const result = await googleGet<GoogleCalendarList>(
    `${CALENDAR_API}/calendars/primary/events`,
    params,
  );

  if (!result.ok) {
    log.error("Failed to list events", { error: result.message });
    return { ok: false, message: result.message };
  }

  const events = (result.data?.items ?? [])
    .filter((e) => opts?.showDeleted || e.status !== "cancelled")
    .map(parseEvent);

  log.debug("Listed events", { count: events.length });
  return { ok: true, events, message: `${events.length} events` };
}

/**
 * Get free/busy windows for a time range.
 */
export async function getFreeBusy(
  start: string,
  end: string,
): Promise<{
  ok: boolean;
  busy?: Array<{ start: string; end: string }>;
  message: string;
}> {
  log.debug("Querying free/busy", { start, end });
  const result = await googlePost<GoogleFreeBusyResponse>(
    `${CALENDAR_API}/freeBusy`,
    {
      timeMin: start,
      timeMax: end,
      items: [{ id: "primary" }],
    },
  );

  if (!result.ok) {
    log.error("Failed to query free/busy", { error: result.message });
    return { ok: false, message: result.message };
  }

  const busy = result.data?.calendars?.primary?.busy ?? [];
  log.debug("Free/busy query complete", { busyBlocks: busy.length });
  return { ok: true, busy, message: `${busy.length} busy blocks` };
}

/**
 * Create a new calendar event.
 */
export async function createEvent(
  title: string,
  start: string,
  end: string,
  opts?: { description?: string; location?: string; attendees?: string[]; recurrence?: string[]; timeZone?: string },
): Promise<{ ok: boolean; event?: CalendarEvent; message: string }> {
  const body: Record<string, any> = {
    summary: title,
    start: { dateTime: start, ...(opts?.timeZone && { timeZone: opts.timeZone }) },
    end: { dateTime: end, ...(opts?.timeZone && { timeZone: opts.timeZone }) },
  };
  if (opts?.description) body.description = opts.description;
  if (opts?.location) body.location = opts.location;
  if (opts?.attendees?.length) {
    body.attendees = opts.attendees.map((email) => ({ email }));
  }
  if (opts?.recurrence?.length) body.recurrence = opts.recurrence;

  log.debug("Creating calendar event", { title, start, end });
  const result = await googlePost<GoogleCalendarEvent>(
    `${CALENDAR_API}/calendars/primary/events`,
    body,
  );

  if (!result.ok) {
    log.error("Failed to create calendar event", { title, error: result.message });
    return { ok: false, message: result.message };
  }

  log.info("Calendar event created", { title, eventId: result.data!.id });
  return {
    ok: true,
    event: parseEvent(result.data!),
    message: `Event created: ${title}`,
  };
}

/**
 * Update an existing calendar event.
 */
export async function updateEvent(
  eventId: string,
  changes: {
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    recurrence?: string[];
    timeZone?: string;
  },
): Promise<{ ok: boolean; event?: CalendarEvent; message: string }> {
  if (!eventId) return { ok: false, message: "eventId is required" };

  const body: Record<string, any> = {};
  if (changes.title !== undefined) body.summary = changes.title;
  if (changes.start !== undefined) {
    body.start = { dateTime: changes.start, ...(changes.timeZone && { timeZone: changes.timeZone }) };
  }
  if (changes.end !== undefined) {
    body.end = { dateTime: changes.end, ...(changes.timeZone && { timeZone: changes.timeZone }) };
  }
  if (changes.description !== undefined) body.description = changes.description;
  if (changes.location !== undefined) body.location = changes.location;
  if (changes.attendees !== undefined) {
    body.attendees = changes.attendees.map((email) => ({ email }));
  }
  if (changes.recurrence !== undefined) body.recurrence = changes.recurrence;

  log.debug("Updating calendar event", { eventId, changes: Object.keys(changes) });
  const result = await googlePatch<GoogleCalendarEvent>(
    `${CALENDAR_API}/calendars/primary/events/${eventId}`,
    body,
  );

  if (!result.ok) {
    log.error("Failed to update calendar event", { eventId, error: result.message });
    return { ok: false, message: result.message };
  }

  log.info("Calendar event updated", { eventId });
  return {
    ok: true,
    event: parseEvent(result.data!),
    message: `Event updated: ${eventId}`,
  };
}

/**
 * Delete a calendar event.
 * Optionally send cancellation notifications to attendees.
 */
export async function deleteEvent(
  eventId: string,
  opts?: { sendUpdates?: "all" | "externalOnly" | "none" },
): Promise<{ ok: boolean; message: string }> {
  if (!eventId) return { ok: false, message: "eventId is required" };

  log.debug("Deleting calendar event", { eventId, sendUpdates: opts?.sendUpdates });
  const sendUpdates = opts?.sendUpdates ?? "none";
  const result = await googleDelete(
    `${CALENDAR_API}/calendars/primary/events/${eventId}?sendUpdates=${sendUpdates}`,
  );

  if (!result.ok) {
    log.error("Failed to delete calendar event", { eventId, error: result.message });
    return { ok: false, message: result.message };
  }

  log.info("Calendar event deleted", { eventId });
  return { ok: true, message: `Event deleted: ${eventId}` };
}

/**
 * Search events by text query across a wide time range.
 * Searches summary, description, location, and attendees.
 * Defaults to ±6 months from now if no range provided.
 */
export async function searchEvents(
  query: string,
  opts?: { timeMin?: string; timeMax?: string; maxResults?: number },
): Promise<{ ok: boolean; events?: CalendarEvent[]; message: string }> {
  if (!query) return { ok: false, message: "query is required" };

  log.debug("Searching calendar events", { query });
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const sixMonthsAhead = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());

  return listEvents({
    timeMin: opts?.timeMin ?? sixMonthsAgo.toISOString(),
    timeMax: opts?.timeMax ?? sixMonthsAhead.toISOString(),
    query,
    maxResults: opts?.maxResults ?? 25,
  });
}

/**
 * Format events as a readable text block for LLM context injection.
 */
export function formatEventsForContext(events: CalendarEvent[]): string {
  if (events.length === 0) return "No events.";

  return events
    .map((e) => {
      const startTime = e.start.includes("T")
        ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "All day";
      const endTime = e.end.includes("T")
        ? new Date(e.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "";
      const timeStr = endTime ? `${startTime}–${endTime}` : startTime;
      const attendeeStr = e.attendees.length > 0 ? ` (with: ${e.attendees.join(", ")})` : "";
      const locationStr = e.location ? ` @ ${e.location}` : "";
      return `- ${timeStr}: ${e.summary}${attendeeStr}${locationStr}`;
    })
    .join("\n");
}
