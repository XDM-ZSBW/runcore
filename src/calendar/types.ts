/**
 * Types for the native calendar primitive.
 * Based on RFC 5545 VEVENT with pragmatic additions for scheduling tools.
 * See brain/knowledge/protocols/native-calendar-2.0.md
 */

// ── CalendarEvent ────────────────────────────────────────────────────────────

export interface CalendarEvent {
  // Identity
  id: string;                    // cal_<timestamp>_<8hex>
  uid: string;                   // RFC 5545 UID — globally unique, stable across syncs
  externalIds: {
    google?: string;
    calendly?: string;
    calcom?: string;
    caldav?: string;
  };

  // Content
  title: string;                 // SUMMARY (required)
  description?: string;

  // Timing
  start: string;                 // ISO 8601 with timezone
  end: string;                   // ISO 8601 with timezone
  duration?: number;             // Minutes — computed if not provided (end - start)
  allDay: boolean;
  timezone: string;              // IANA timezone (e.g., "America/Los_Angeles")

  // Location
  location?: string;
  geo?: { lat: number; lon: number };
  conferenceUrl?: string;

  // People
  organizer?: {
    name: string;
    email: string;
  };
  attendees: Array<{
    name?: string;
    email: string;
    role: "required" | "optional" | "chair" | "non-participant";
    status: "accepted" | "declined" | "tentative" | "needs-action";
    rsvp?: boolean;
  }>;

  // Status & visibility
  status: "confirmed" | "tentative" | "cancelled";
  transparency: "opaque" | "transparent";
  visibility: "public" | "private" | "confidential";

  // Recurrence (RFC 5545 native)
  recurrence?: string[];          // ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]
  recurringEventId?: string;

  // Scheduling-tool fields (optional)
  cancellationReason?: string;
  rescheduled?: boolean;
  noShow?: boolean;

  // Classification
  categories: string[];
  calendarId?: string;            // Which calendar this belongs to (default: "primary")

  // Reminders
  reminders: Array<{
    method: "popup" | "email" | "sms";
    minutes: number;
  }>;

  // Versioning
  sequence: number;

  // Timestamps
  createdAt: string;
  updatedAt: string;

  // Provenance
  source: CalendarSource;
  metadata?: Record<string, unknown>;

  // Append-only lifecycle
  status_record: "active" | "archived";
}

export type CalendarSource = "manual" | "google" | "calendly" | "calcom" | "caldav" | "mesh";

// ── Calendar (collection) ────────────────────────────────────────────────────

export interface Calendar {
  id: string;                    // coll_<timestamp>_<8hex>
  name: string;
  color: string;                 // Hex color
  source: "manual" | "google" | "caldav";
  externalId?: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  status: "active" | "archived";
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface EventFilter {
  timeMin?: string;              // ISO 8601
  timeMax?: string;
  calendarId?: string;
  q?: string;                    // Free-text search
  status?: "confirmed" | "tentative" | "cancelled";
  maxResults?: number;
}

// ── Adapter interfaces ───────────────────────────────────────────────────────

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  errors: string[];
  syncedAt: string;
}

export interface CalendarAdapter {
  id: string;
  name: string;
  isAvailable(): boolean;
  sync(since?: string): Promise<SyncResult>;
  push(event: CalendarEvent): Promise<void>;
  remove(externalId: string): Promise<void>;
}

// ── Free/busy ────────────────────────────────────────────────────────────────

export interface FreeBusySlot {
  start: string;
  end: string;
}
