/**
 * Calendar store — append-only JSONL persistence for CalendarEvent and Calendar.
 * Follows src/contacts/store.ts pattern.
 *
 * Files: brain/calendar/events.jsonl, brain/calendar/calendars.jsonl
 * Update strategy: append full updated record. On load, last occurrence per id wins.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import type { CalendarEvent, Calendar, EventFilter, FreeBusySlot } from "./types.js";

const log = createLogger("calendar.store");

const EVENTS_SCHEMA = JSON.stringify({ _schema: "calendar-events", _version: "1.0" });
const CALENDARS_SCHEMA = JSON.stringify({ _schema: "calendar-collections", _version: "1.0" });

function generateEventId(): string {
  const ts = Date.now();
  const hex = randomBytes(4).toString("hex");
  return `cal_${ts}_${hex}`;
}

function generateCalendarId(): string {
  const ts = Date.now();
  const hex = randomBytes(4).toString("hex");
  return `coll_${ts}_${hex}`;
}

function generateUid(): string {
  const hex1 = randomBytes(4).toString("hex");
  const hex2 = randomBytes(4).toString("hex");
  return `${hex1}-${hex2}@dash`;
}

export class CalendarStore {
  private readonly eventsPath: string;
  private readonly calendarsPath: string;
  private eventCache: Map<string, CalendarEvent> | null = null;
  private calendarCache: Map<string, Calendar> | null = null;
  private eventMtime = 0;
  private calendarMtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.eventsPath = join(brainDir, "calendar", "events.jsonl");
    this.calendarsPath = join(brainDir, "calendar", "calendars.jsonl");
  }

  // ── File management ──────────────────────────────────────────────────────

  private async ensureFiles(): Promise<void> {
    await ensureBrainJsonl(this.eventsPath, EVENTS_SCHEMA);
    await ensureBrainJsonl(this.calendarsPath, CALENDARS_SCHEMA);
  }

  private async checkStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;

    try {
      if (this.eventCache) {
        const s = await stat(this.eventsPath);
        if (s.mtimeMs > this.eventMtime) this.eventCache = null;
      }
      if (this.calendarCache) {
        const s = await stat(this.calendarsPath);
        if (s.mtimeMs > this.calendarMtime) this.calendarCache = null;
      }
    } catch {
      // Files may not exist yet
    }
  }

  // ── Load events ────────────────────────────────────────────────────────────

  private async loadEvents(): Promise<Map<string, CalendarEvent>> {
    await this.checkStale();
    if (this.eventCache) return this.eventCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.eventsPath);
    const map = new Map<string, CalendarEvent>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as CalendarEvent);
      } catch { continue; }
    }

    this.eventCache = map;
    try {
      const s = await stat(this.eventsPath);
      this.eventMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private async loadCalendars(): Promise<Map<string, Calendar>> {
    await this.checkStale();
    if (this.calendarCache) return this.calendarCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.calendarsPath);
    const map = new Map<string, Calendar>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as Calendar);
      } catch { continue; }
    }

    this.calendarCache = map;
    try {
      const s = await stat(this.calendarsPath);
      this.calendarMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private invalidateEvents(): void { this.eventCache = null; }
  private invalidateCalendars(): void { this.calendarCache = null; }

  // ── Event CRUD ─────────────────────────────────────────────────────────────

  async list(filter?: EventFilter): Promise<CalendarEvent[]> {
    const map = await this.loadEvents();
    let events = Array.from(map.values());

    // Only active records by default
    events = events.filter((e) => e.status_record !== "archived");

    if (filter?.timeMin) {
      events = events.filter((e) => e.end >= filter.timeMin!);
    }
    if (filter?.timeMax) {
      events = events.filter((e) => e.start <= filter.timeMax!);
    }
    if (filter?.calendarId) {
      events = events.filter((e) => e.calendarId === filter.calendarId);
    }
    if (filter?.status) {
      events = events.filter((e) => e.status === filter.status);
    }
    if (filter?.q) {
      const q = filter.q.toLowerCase();
      events = events.filter((e) =>
        e.title.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.location?.toLowerCase().includes(q) ||
        e.attendees.some((a) => a.email.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q)),
      );
    }

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    if (filter?.maxResults) {
      events = events.slice(0, filter.maxResults);
    }

    return events;
  }

  async get(id: string): Promise<CalendarEvent | null> {
    const map = await this.loadEvents();
    return map.get(id) ?? null;
  }

  async getByUid(uid: string): Promise<CalendarEvent | null> {
    const map = await this.loadEvents();
    for (const event of map.values()) {
      if (event.uid === uid) return event;
    }
    return null;
  }

  async getByExternalId(source: keyof CalendarEvent["externalIds"], externalId: string): Promise<CalendarEvent | null> {
    const map = await this.loadEvents();
    for (const event of map.values()) {
      if (event.externalIds[source] === externalId) return event;
    }
    return null;
  }

  async create(opts: {
    title: string;
    start: string;
    end: string;
    allDay?: boolean;
    timezone?: string;
    description?: string;
    location?: string;
    conferenceUrl?: string;
    organizer?: CalendarEvent["organizer"];
    attendees?: CalendarEvent["attendees"];
    status?: CalendarEvent["status"];
    transparency?: CalendarEvent["transparency"];
    visibility?: CalendarEvent["visibility"];
    recurrence?: string[];
    recurringEventId?: string;
    categories?: string[];
    calendarId?: string;
    reminders?: CalendarEvent["reminders"];
    source?: CalendarEvent["source"];
    uid?: string;
    externalIds?: CalendarEvent["externalIds"];
    metadata?: Record<string, unknown>;
  }): Promise<CalendarEvent> {
    const now = new Date().toISOString();
    const event: CalendarEvent = {
      id: generateEventId(),
      uid: opts.uid ?? generateUid(),
      externalIds: opts.externalIds ?? {},
      title: opts.title,
      description: opts.description,
      start: opts.start,
      end: opts.end,
      allDay: opts.allDay ?? false,
      timezone: opts.timezone ?? "America/Los_Angeles",
      location: opts.location,
      conferenceUrl: opts.conferenceUrl,
      organizer: opts.organizer,
      attendees: opts.attendees ?? [],
      status: opts.status ?? "confirmed",
      transparency: opts.transparency ?? "opaque",
      visibility: opts.visibility ?? "public",
      recurrence: opts.recurrence,
      recurringEventId: opts.recurringEventId,
      categories: opts.categories ?? [],
      calendarId: opts.calendarId ?? "primary",
      reminders: opts.reminders ?? [],
      sequence: 0,
      createdAt: now,
      updatedAt: now,
      source: opts.source ?? "manual",
      metadata: opts.metadata,
      status_record: "active",
    };

    await appendBrainLine(this.eventsPath, JSON.stringify(event));
    this.invalidateEvents();
    log.info(`Created event ${event.id}: ${event.title}`);
    return event;
  }

  async update(id: string, changes: Partial<Pick<CalendarEvent,
    "title" | "description" | "start" | "end" | "allDay" | "timezone" |
    "location" | "conferenceUrl" | "organizer" | "attendees" | "status" |
    "transparency" | "visibility" | "recurrence" | "recurringEventId" |
    "categories" | "calendarId" | "reminders" | "externalIds" | "metadata" |
    "cancellationReason" | "rescheduled" | "noShow"
  >>): Promise<CalendarEvent | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updated: CalendarEvent = {
      ...existing,
      ...changes,
      sequence: existing.sequence + 1,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.eventsPath, JSON.stringify(updated));
    this.invalidateEvents();
    log.info(`Updated event ${id}: ${updated.title}`);
    return updated;
  }

  async cancel(id: string, reason?: string): Promise<CalendarEvent | null> {
    return this.update(id, {
      status: "cancelled",
      cancellationReason: reason,
    });
  }

  async archive(id: string): Promise<CalendarEvent | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const archived: CalendarEvent = {
      ...existing,
      status_record: "archived",
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.eventsPath, JSON.stringify(archived));
    this.invalidateEvents();
    log.info(`Archived event ${id}`);
    return archived;
  }

  // ── Calendar collection CRUD ───────────────────────────────────────────────

  async listCalendars(): Promise<Calendar[]> {
    const map = await this.loadCalendars();
    return Array.from(map.values()).filter((c) => c.status !== "archived");
  }

  async getCalendar(id: string): Promise<Calendar | null> {
    const map = await this.loadCalendars();
    return map.get(id) ?? null;
  }

  async createCalendar(opts: {
    name: string;
    color?: string;
    source?: Calendar["source"];
    externalId?: string;
    visible?: boolean;
  }): Promise<Calendar> {
    const now = new Date().toISOString();
    const cal: Calendar = {
      id: generateCalendarId(),
      name: opts.name,
      color: opts.color ?? "#4285f4",
      source: opts.source ?? "manual",
      externalId: opts.externalId,
      visible: opts.visible ?? true,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };

    await appendBrainLine(this.calendarsPath, JSON.stringify(cal));
    this.invalidateCalendars();
    log.info(`Created calendar ${cal.id}: ${cal.name}`);
    return cal;
  }

  async updateCalendar(id: string, changes: Partial<Pick<Calendar, "name" | "color" | "visible" | "status">>): Promise<Calendar | null> {
    const existing = await this.getCalendar(id);
    if (!existing) return null;

    const updated: Calendar = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.calendarsPath, JSON.stringify(updated));
    this.invalidateCalendars();
    log.info(`Updated calendar ${id}: ${updated.name}`);
    return updated;
  }

  // ── Free/busy ──────────────────────────────────────────────────────────────

  async freeBusy(start: string, end: string): Promise<FreeBusySlot[]> {
    const events = await this.list({
      timeMin: start,
      timeMax: end,
      status: "confirmed",
    });

    // Only opaque events block time
    const busy = events
      .filter((e) => e.transparency === "opaque" && !e.allDay)
      .map((e) => ({
        start: e.start < start ? start : e.start,
        end: e.end > end ? end : e.end,
      }));

    // Merge overlapping slots
    if (busy.length === 0) return [];
    busy.sort((a, b) => a.start.localeCompare(b.start));

    const merged: FreeBusySlot[] = [busy[0]];
    for (let i = 1; i < busy.length; i++) {
      const last = merged[merged.length - 1];
      if (busy[i].start <= last.end) {
        last.end = busy[i].end > last.end ? busy[i].end : last.end;
      } else {
        merged.push(busy[i]);
      }
    }

    return merged;
  }

  // ── Convenience queries ────────────────────────────────────────────────────

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    return this.list({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
    });
  }

  async getUpcomingEvents(hours: number = 4): Promise<CalendarEvent[]> {
    const now = new Date();
    const later = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return this.list({
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
    });
  }

  /** Format events as readable text for LLM context injection. */
  formatEventsForContext(events: CalendarEvent[]): string {
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
        const attendeeStr = e.attendees.length > 0
          ? ` (with: ${e.attendees.map((a) => a.name ?? a.email).join(", ")})`
          : "";
        const locationStr = e.location ? ` @ ${e.location}` : "";
        const sourceStr = e.source !== "manual" ? ` [${e.source}]` : "";
        return `- ${timeStr}: ${e.title}${attendeeStr}${locationStr}${sourceStr}`;
      })
      .join("\n");
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _store: CalendarStore | null = null;

export function createCalendarStore(brainDir: string): CalendarStore {
  if (_store) return _store;
  _store = new CalendarStore(brainDir);
  return _store;
}

export function getCalendarStore(): CalendarStore | null {
  return _store;
}
