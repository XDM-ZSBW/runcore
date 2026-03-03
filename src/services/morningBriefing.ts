/**
 * Daily morning briefing — aggregates calendar, email, and board status.
 * Follows src/services/backlogReview.ts pattern: module-level state, idempotent start/stop.
 *
 * Data sources:
 * - Google Calendar: today's events via getTodaySchedule()
 * - Gmail: inbox summary via getInboxSummary()
 * - Queue: board status digest via QueueStore.list()
 *
 * Delivery: SMS, email (Gmail), and WhatsApp via existing channel modules.
 *
 * DASH-44
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { getTrainingSummary } from "./training.js";
import { isCalendarAvailable, getTodaySchedule, formatEventsForContext } from "../google/calendar.js";
import { resolveEnv, getInstanceName } from "../instance.js";

const log = createLogger("morning-briefing");
import type { CalendarEvent } from "../google/calendar.js";
import { isGmailAvailable, getInboxSummary, formatInboxSummaryForContext } from "../google/gmail.js";
import type { InboxSummary } from "../google/gmail.js";
import { sendEmail } from "../google/gmail-send.js";
import { QueueStore } from "../queue/store.js";
import type { QueueTask, QueueTaskState } from "../queue/types.js";
import { stateDisplayName } from "../queue/types.js";
import { getClient as getWhatsAppClient, isWhatsAppConfigured } from "../channels/whatsapp.js";
import { logActivity, getActivities } from "../activity/log.js";
import type { ActivityEntry } from "../activity/log.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15 * 60 * 1000;  // check every 15 minutes
const BRIEFING_HOUR = 6;                     // 6 AM local — delivers by ~6:15 AM (before 7 AM)

const BRIEFING_CHANNELS_FILE = join(
  resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"),
  "operations",
  "briefing-channels.json",
);

/**
 * Load briefing channel config from brain/operations/briefing-channels.json.
 * Returns empty config if file is missing or malformed.
 */
export function loadBriefingChannelsFile(): BriefingConfig {
  try {
    if (!existsSync(BRIEFING_CHANNELS_FILE)) return {};
    const raw = readFileSync(BRIEFING_CHANNELS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: BriefingConfig = {};
    if (Array.isArray(parsed.emailTo)) config.emailTo = parsed.emailTo.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (Array.isArray(parsed.smsTo)) config.smsTo = parsed.smsTo.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (Array.isArray(parsed.whatsappTo)) config.whatsappTo = parsed.whatsappTo.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (typeof parsed.briefingHour === "number") config.briefingHour = parsed.briefingHour;
    return config;
  } catch {
    log.warn("Failed to read briefing-channels.json — using empty config");
    return {};
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MorningBriefing {
  generatedAt: string;
  calendar: {
    available: boolean;
    eventCount: number;
    events: CalendarEvent[];
    formatted: string;
  };
  email: {
    available: boolean;
    unreadCount: number;
    highPriorityCount: number;
    summary: InboxSummary | null;
    formatted: string;
  };
  board: {
    totalActive: number;
    byState: Record<string, number>;
    inProgress: BoardTaskSummary[];
    todoPending: BoardTaskSummary[];
    recentlyDone: BoardTaskSummary[];
  };
  agentActivity: AgentActivitySummary;
  urgentItems: UrgentItemsSummary;
}

export interface AgentActivitySummary {
  recentCount: number;
  entries: ActivityEntry[];
}

export interface UrgentItemsSummary {
  count: number;
  items: BoardTaskSummary[];
}

export interface BoardTaskSummary {
  identifier: string;
  title: string;
  state: string;
  priority: number;
  assignee: string | null;
}

export interface BriefingDeliveryResult {
  sms: boolean | null;
  email: boolean | null;
  whatsapp: boolean | null;
}

export interface BriefingConfig {
  /** SMS recipients (phone numbers). Empty = skip SMS. */
  smsTo?: string[];
  /** Email recipients. Empty = skip email. */
  emailTo?: string[];
  /** WhatsApp recipients (phone numbers). Empty = skip WhatsApp. */
  whatsappTo?: string[];
  /** Hour of day to send briefing (0–23). Default: 7. */
  briefingHour?: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let activeStore: QueueStore | null = null;
let activeConfig: BriefingConfig = {};
let lastBriefingDate: string | null = null;   // "2026-02-27" format to avoid double-sends
let dailyRetryCount = 0;                      // track retries to cap at MAX_DAILY_RETRIES
const MAX_DAILY_RETRIES = 3;                  // stop retrying after 3 failed attempts per day

// ─── Persist lastBriefingDate across restarts ─────────────────────────────────

const BRIEFING_STATE_DIR = join(
  resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"),
  "operations",
);
const BRIEFING_STATE_FILE = join(BRIEFING_STATE_DIR, ".briefing-last-date");

function loadLastBriefingDate(): string | null {
  try {
    const raw = readFileSync(BRIEFING_STATE_FILE, "utf-8").trim();
    // Sanity check: should be YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

function persistLastBriefingDate(date: string): void {
  try {
    mkdirSync(BRIEFING_STATE_DIR, { recursive: true });
    writeFileSync(BRIEFING_STATE_FILE, date, "utf-8");
  } catch {
    // Best-effort — log warning but don't break the briefing flow
    log.warn("Failed to persist briefing last-date to disk");
  }
}
let lastBriefing: MorningBriefing | null = null;
let lastDelivery: BriefingDeliveryResult | null = null;

// ─── Data gathering ──────────────────────────────────────────────────────────

async function gatherCalendar(): Promise<MorningBriefing["calendar"]> {
  if (!isCalendarAvailable()) {
    return { available: false, eventCount: 0, events: [], formatted: "Calendar not connected." };
  }

  const result = await getTodaySchedule();
  if (!result.ok || !result.events) {
    return { available: true, eventCount: 0, events: [], formatted: `Calendar error: ${result.message}` };
  }

  return {
    available: true,
    eventCount: result.events.length,
    events: result.events,
    formatted: formatEventsForContext(result.events),
  };
}

async function gatherEmail(): Promise<MorningBriefing["email"]> {
  if (!isGmailAvailable()) {
    return { available: false, unreadCount: 0, highPriorityCount: 0, summary: null, formatted: "Gmail not connected." };
  }

  const result = await getInboxSummary(12); // last 12 hours (overnight)
  if (!result.ok || !result.summary) {
    return { available: true, unreadCount: 0, highPriorityCount: 0, summary: null, formatted: `Gmail error: ${result.message}` };
  }

  return {
    available: true,
    unreadCount: result.summary.unreadCount,
    highPriorityCount: result.summary.highPriority.length,
    summary: result.summary,
    formatted: formatInboxSummaryForContext(result.summary),
  };
}

async function gatherBoard(store: QueueStore): Promise<MorningBriefing["board"]> {
  const tasks = await store.list();

  const byState: Record<string, number> = {};
  for (const t of tasks) {
    const label = stateDisplayName(t.state);
    byState[label] = (byState[label] ?? 0) + 1;
  }

  const toSummary = (t: QueueTask): BoardTaskSummary => ({
    identifier: t.identifier,
    title: t.title,
    state: stateDisplayName(t.state),
    priority: t.priority,
    assignee: t.assignee,
  });

  const inProgress = tasks.filter((t) => t.state === "in_progress").map(toSummary);
  const todoPending = tasks.filter((t) => t.state === "todo").map(toSummary);

  // Recently done = done items updated in last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentlyDone = tasks
    .filter((t) => t.state === "done" && t.updatedAt > oneDayAgo)
    .map(toSummary);

  return {
    totalActive: tasks.filter((t) => t.state !== "done" && t.state !== "cancelled").length,
    byState,
    inProgress,
    todoPending,
    recentlyDone,
  };
}

async function gatherAgentActivity(): Promise<AgentActivitySummary> {
  const all = await getActivities();

  // Last 12 hours of non-trivial activity
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const recent = all.filter(
    (e) => e.timestamp >= cutoff && e.source !== "system",
  );

  // Keep the most recent 10 to keep the briefing concise
  const entries = recent.slice(-10);

  return { recentCount: recent.length, entries };
}

function gatherUrgentItems(store: QueueStore, tasks: QueueTask[]): UrgentItemsSummary {
  // P0 (urgent) and P1 (high) that aren't done/cancelled
  const urgent = tasks.filter(
    (t) =>
      t.priority <= 2 &&
      t.state !== "done" &&
      t.state !== "cancelled",
  );

  const items: BoardTaskSummary[] = urgent.map((t) => ({
    identifier: t.identifier,
    title: t.title,
    state: stateDisplayName(t.state),
    priority: t.priority,
    assignee: t.assignee,
  }));

  // Sort by priority ascending (1=urgent first), then by state
  items.sort((a, b) => a.priority - b.priority);

  return { count: items.length, items };
}

// ─── Briefing generation ─────────────────────────────────────────────────────

/**
 * Generate a morning briefing by aggregating all data sources.
 */
export async function generateBriefing(store: QueueStore): Promise<MorningBriefing> {
  const [calendar, email, board] = await Promise.all([
    gatherCalendar(),
    gatherEmail(),
    gatherBoard(store),
  ]);

  // Board tasks are already loaded — reuse for urgent items filter
  const tasks = await store.list();
  const agentActivity = await gatherAgentActivity();
  const urgentItems = gatherUrgentItems(store, tasks);

  const briefing: MorningBriefing = {
    generatedAt: new Date().toISOString(),
    calendar,
    email,
    board,
    agentActivity,
    urgentItems,
  };

  lastBriefing = briefing;
  return briefing;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  0: "",
  1: "P0-urgent",
  2: "P1-high",
  3: "P2-medium",
  4: "P3-low",
};

function priorityTag(p: number): string {
  return PRIORITY_LABELS[p] ?? "";
}

/**
 * Format briefing as plain text (for SMS / WhatsApp).
 * Compact format, max ~1500 chars for SMS/WhatsApp limits.
 */
export function formatBriefingText(briefing: MorningBriefing): string {
  const lines: string[] = [];
  const date = new Date(briefing.generatedAt).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  lines.push(`Good morning! Here's your briefing for ${date}:`);
  lines.push("");

  // Calendar
  lines.push(`CALENDAR (${briefing.calendar.eventCount} events)`);
  if (briefing.calendar.eventCount === 0) {
    lines.push("  No events today.");
  } else {
    for (const e of briefing.calendar.events.slice(0, 8)) {
      const startTime = e.start.includes("T")
        ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "All day";
      lines.push(`  ${startTime}: ${e.summary}`);
    }
    if (briefing.calendar.eventCount > 8) {
      lines.push(`  ...and ${briefing.calendar.eventCount - 8} more`);
    }
  }
  lines.push("");

  // Email
  lines.push(`EMAIL (${briefing.email.unreadCount} unread)`);
  if (briefing.email.highPriorityCount > 0) {
    lines.push(`  ${briefing.email.highPriorityCount} high priority`);
    for (const m of (briefing.email.summary?.highPriority ?? []).slice(0, 3)) {
      const from = m.from.replace(/<[^>]+>/, "").trim();
      lines.push(`  * ${from}: ${m.subject}`);
    }
  } else {
    lines.push("  No high-priority emails.");
  }
  lines.push("");

  // Board
  lines.push(`BOARD (${briefing.board.totalActive} active)`);
  if (briefing.board.inProgress.length > 0) {
    lines.push(`  In progress: ${briefing.board.inProgress.map((t) => t.identifier).join(", ")}`);
  }
  if (briefing.board.todoPending.length > 0) {
    lines.push(`  Todo: ${briefing.board.todoPending.length} items`);
  }
  if (briefing.board.recentlyDone.length > 0) {
    lines.push(`  Done (24h): ${briefing.board.recentlyDone.map((t) => t.identifier).join(", ")}`);
  }
  const stateEntries = Object.entries(briefing.board.byState)
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");
  if (stateEntries) {
    lines.push(`  Breakdown: ${stateEntries}`);
  }
  lines.push("");

  // Urgent Items
  if (briefing.urgentItems.count > 0) {
    lines.push(`URGENT (${briefing.urgentItems.count} items)`);
    for (const t of briefing.urgentItems.items.slice(0, 5)) {
      const pri = priorityTag(t.priority);
      lines.push(`  ${t.identifier}: ${t.title} [${t.state}]${pri ? ` ${pri}` : ""}`);
    }
    if (briefing.urgentItems.count > 5) {
      lines.push(`  ...and ${briefing.urgentItems.count - 5} more`);
    }
    lines.push("");
  }

  // Agent Activity
  if (briefing.agentActivity.recentCount > 0) {
    lines.push(`AGENT ACTIVITY (${briefing.agentActivity.recentCount} actions, last 12h)`);
    for (const e of briefing.agentActivity.entries) {
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`  ${time} [${e.source}] ${e.summary}`);
    }
  } else {
    lines.push("AGENT ACTIVITY");
    lines.push("  No recent activity.");
  }

  // Training progress
  const training = getTrainingSummary();
  if (training) {
    lines.push("");
    lines.push("TRAINING");
    lines.push(training);
  }

  return lines.join("\n");
}

/**
 * Format briefing as HTML (for email delivery).
 */
export function formatBriefingHtml(briefing: MorningBriefing): string {
  const date = new Date(briefing.generatedAt).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const calendarRows = briefing.calendar.events.map((e) => {
    const startTime = e.start.includes("T")
      ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "All day";
    const endTime = e.end.includes("T")
      ? new Date(e.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "";
    const time = endTime ? `${startTime}–${endTime}` : startTime;
    const attendees = e.attendees.length > 0 ? `<br><small>with: ${escapeHtml(e.attendees.join(", "))}</small>` : "";
    const location = e.location ? `<br><small>@ ${escapeHtml(e.location)}</small>` : "";
    return `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:#6b7280;">${time}</td><td style="padding:4px 0;vertical-align:top;">${escapeHtml(e.summary)}${attendees}${location}</td></tr>`;
  }).join("");

  const highPriorityRows = (briefing.email.summary?.highPriority ?? []).map((m) => {
    const from = escapeHtml(m.from.replace(/<[^>]+>/, "").trim());
    return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${from}</td><td style="padding:4px 0;">${escapeHtml(m.subject)}</td></tr>`;
  }).join("");

  const boardTaskRow = (t: BoardTaskSummary) => {
    const pri = priorityTag(t.priority);
    const priSpan = pri ? ` <span style="color:#f59e0b;font-size:12px;">${escapeHtml(pri)}</span>` : "";
    return `<li>${escapeHtml(t.identifier)}: ${escapeHtml(t.title)}${priSpan}</li>`;
  };

  const stateEntries = Object.entries(briefing.board.byState)
    .map(([state, count]) => `<strong>${escapeHtml(state)}</strong>: ${count}`)
    .join(" &middot; ");

  return `
<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;">
  <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">Morning Briefing</h2>
    <p style="margin:4px 0 0;opacity:0.9;">${date}</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px;">

    <h3 style="color:#1e40af;margin:0 0 8px;">Calendar (${briefing.calendar.eventCount} events)</h3>
    ${briefing.calendar.eventCount === 0
      ? '<p style="color:#6b7280;">No events today.</p>'
      : `<table style="border-collapse:collapse;width:100%;">${calendarRows}</table>`}

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">

    <h3 style="color:#1e40af;margin:0 0 8px;">Email (${briefing.email.unreadCount} unread)</h3>
    ${briefing.email.highPriorityCount > 0
      ? `<p style="margin:0 0 4px;"><strong>${briefing.email.highPriorityCount} high priority:</strong></p><table style="border-collapse:collapse;width:100%;">${highPriorityRows}</table>`
      : '<p style="color:#6b7280;">No high-priority emails overnight.</p>'}

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">

    <h3 style="color:#1e40af;margin:0 0 8px;">Board (${briefing.board.totalActive} active)</h3>
    <p style="margin:0 0 8px;font-size:14px;">${stateEntries}</p>
    ${briefing.board.inProgress.length > 0
      ? `<p style="margin:0 0 2px;"><strong>In Progress:</strong></p><ul style="margin:0 0 8px;padding-left:20px;">${briefing.board.inProgress.map(boardTaskRow).join("")}</ul>`
      : ""}
    ${briefing.board.todoPending.length > 0
      ? `<p style="margin:0 0 2px;"><strong>Todo:</strong></p><ul style="margin:0 0 8px;padding-left:20px;">${briefing.board.todoPending.slice(0, 5).map(boardTaskRow).join("")}${briefing.board.todoPending.length > 5 ? `<li style="color:#6b7280;">...and ${briefing.board.todoPending.length - 5} more</li>` : ""}</ul>`
      : ""}
    ${briefing.board.recentlyDone.length > 0
      ? `<p style="margin:0 0 2px;"><strong>Done (last 24h):</strong></p><ul style="margin:0 0 8px;padding-left:20px;">${briefing.board.recentlyDone.map(boardTaskRow).join("")}</ul>`
      : ""}

    ${briefing.urgentItems.count > 0 ? `
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">

    <h3 style="color:#dc2626;margin:0 0 8px;">Urgent Items (${briefing.urgentItems.count})</h3>
    <ul style="margin:0 0 8px;padding-left:20px;">
      ${briefing.urgentItems.items.slice(0, 8).map((t) => {
        const pri = priorityTag(t.priority);
        const priSpan = pri ? ` <span style="color:#dc2626;font-size:12px;">${escapeHtml(pri)}</span>` : "";
        return `<li>${escapeHtml(t.identifier)}: ${escapeHtml(t.title)} <span style="color:#6b7280;">[${escapeHtml(t.state)}]</span>${priSpan}</li>`;
      }).join("")}
      ${briefing.urgentItems.count > 8 ? `<li style="color:#6b7280;">...and ${briefing.urgentItems.count - 8} more</li>` : ""}
    </ul>` : ""}

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">

    <h3 style="color:#1e40af;margin:0 0 8px;">Agent Activity (${briefing.agentActivity.recentCount} actions, last 12h)</h3>
    ${briefing.agentActivity.recentCount === 0
      ? '<p style="color:#6b7280;">No recent agent activity.</p>'
      : `<table style="border-collapse:collapse;width:100%;font-size:13px;">
        ${briefing.agentActivity.entries.map((e) => {
          const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          return `<tr><td style="padding:2px 8px 2px 0;white-space:nowrap;color:#6b7280;vertical-align:top;">${time}</td><td style="padding:2px 4px 2px 0;white-space:nowrap;color:#9ca3af;vertical-align:top;">${escapeHtml(e.source)}</td><td style="padding:2px 0;vertical-align:top;">${escapeHtml(e.summary)}</td></tr>`;
        }).join("")}
      </table>`}

    <p style="color:#9ca3af;font-size:11px;margin:16px 0 0;text-align:center;">Generated by ${getInstanceName()} at ${new Date(briefing.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</p>
  </div>
</div>`.trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/** Check if at least one delivery channel is configured. */
function hasConfiguredChannels(config: BriefingConfig): boolean {
  return (
    (config.smsTo != null && config.smsTo.length > 0) ||
    (config.emailTo != null && config.emailTo.length > 0) ||
    (config.whatsappTo != null && config.whatsappTo.length > 0)
  );
}

/**
 * Deliver a briefing through configured channels (SMS, email, WhatsApp).
 * Returns null if no channels are configured (skips delivery entirely).
 */
export async function deliverBriefing(
  briefing: MorningBriefing,
  config: BriefingConfig,
): Promise<BriefingDeliveryResult | null> {
  if (!hasConfiguredChannels(config)) {
    log.warn("No delivery channels configured — skipping briefing delivery");
    return null;
  }

  const text = formatBriefingText(briefing);
  const html = formatBriefingHtml(briefing);
  const result: BriefingDeliveryResult = { sms: null, email: null, whatsapp: null };

  // SMS via Twilio
  if (config.smsTo && config.smsTo.length > 0) {
    try {
      result.sms = await sendSms(text, config.smsTo);
    } catch (err) {
      log.error("SMS delivery threw", { error: String(err) });
      result.sms = false;
    }
  }

  // Email via Gmail
  if (config.emailTo && config.emailTo.length > 0) {
    try {
      result.email = await sendBriefingEmail(text, html, config.emailTo, briefing.generatedAt);
    } catch (err) {
      log.error("Email delivery threw", { error: String(err) });
      result.email = false;
    }
  }

  // WhatsApp via Twilio
  if (config.whatsappTo && config.whatsappTo.length > 0) {
    try {
      result.whatsapp = await sendWhatsApp(text, config.whatsappTo);
    } catch (err) {
      log.error("WhatsApp delivery threw", { error: String(err) });
      result.whatsapp = false;
    }
  }

  lastDelivery = result;

  const channels = Object.entries(result)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v ? "ok" : "failed"}`)
    .join(", ");

  logActivity({
    source: "system",
    summary: `Morning briefing delivered — ${channels}`,
    detail: `Calendar: ${briefing.calendar.eventCount} events, Email: ${briefing.email.unreadCount} unread, Board: ${briefing.board.totalActive} active tasks`,
  });

  return result;
}

async function sendSms(text: string, recipients: string[]): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) return false;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  // Truncate for SMS limits (~1600 chars)
  const smsText = text.length > 1550 ? text.slice(0, 1550) + "\n..." : text;

  const results = await Promise.allSettled(
    recipients.map(async (to) => {
      const body = new URLSearchParams({ From: from, To: to, Body: smsText });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    }),
  );

  return results.some((r) => r.status === "fulfilled" && r.value === true);
}

async function sendBriefingEmail(
  text: string,
  html: string,
  recipients: string[],
  generatedAt: string,
): Promise<boolean> {
  const date = new Date(generatedAt).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const result = await sendEmail({
    to: recipients,
    subject: `${getInstanceName()} Morning Briefing — ${date}`,
    body: text,
    htmlBody: html,
  });

  return result.ok;
}

async function sendWhatsApp(text: string, recipients: string[]): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;

  const client = getWhatsAppClient();
  if (!client) return false;

  // Truncate for WhatsApp (1600 char limit)
  const waText = text.length > 1550 ? text.slice(0, 1550) + "\n..." : text;

  const results = await Promise.allSettled(
    recipients.map((to) => client.sendMessage(to, waText)),
  );

  return results.some(
    (r) => r.status === "fulfilled" && r.value.ok === true,
  );
}

// ─── Timer ────────────────────────────────────────────────────────────────────

/**
 * Periodic check: if it's past the briefing hour and we haven't sent today, run it.
 */
async function checkAndSend(): Promise<void> {
  if (!activeStore) return;

  // No channels configured — nothing to do (don't generate or log)
  if (!hasConfiguredChannels(activeConfig)) return;

  const now = new Date();
  const hour = activeConfig.briefingHour ?? BRIEFING_HOUR;

  // Only send after the configured hour
  if (now.getHours() < hour) return;

  const today = now.toISOString().slice(0, 10); // "2026-02-27"
  if (lastBriefingDate === today) return;

  // Mark today before async work to prevent concurrent duplicate sends
  lastBriefingDate = today;
  dailyRetryCount = 0;

  try {
    const briefing = await generateBriefing(activeStore);
    const result = await deliverBriefing(briefing, activeConfig);
    if (!result) {
      // No channels configured — treat as permanent for today, don't retry
      log.warn("Briefing generated but no channels configured — skipping delivery for today");
      persistLastBriefingDate(today);
    } else {
      persistLastBriefingDate(today);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({ source: "system", summary: `Morning briefing error: ${msg}` });
    dailyRetryCount++;
    if (dailyRetryCount >= MAX_DAILY_RETRIES) {
      log.warn(`Morning briefing failed ${MAX_DAILY_RETRIES} times — giving up for today`);
      persistLastBriefingDate(today);
    } else {
      // Allow retry on next interval (transient failure)
      lastBriefingDate = null;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the morning briefing timer. Idempotent.
 * Checks every 15 minutes whether it's time to send.
 *
 * Config resolution: explicit config arg → env vars → briefing-channels.json.
 * At least one delivery channel must be configured or the timer is a no-op.
 */
export function startBriefingTimer(store: QueueStore, config?: BriefingConfig, intervalMs?: number): void {
  if (timer) return;

  activeStore = store;

  // Merge: explicit config takes priority, then fall back to config file
  const fileConfig = loadBriefingChannelsFile();
  const merged: BriefingConfig = { ...fileConfig, ...config };
  // Strip undefined/empty-array keys from explicit config so file config can fill gaps
  if (!merged.emailTo?.length) merged.emailTo = fileConfig.emailTo;
  if (!merged.smsTo?.length) merged.smsTo = fileConfig.smsTo;
  if (!merged.whatsappTo?.length) merged.whatsappTo = fileConfig.whatsappTo;
  if (merged.briefingHour == null) merged.briefingHour = fileConfig.briefingHour;
  activeConfig = merged;

  const interval = intervalMs ?? CHECK_INTERVAL_MS;

  // Log configured channels for diagnostics
  const channels: string[] = [];
  if (activeConfig.emailTo?.length) channels.push(`email(${activeConfig.emailTo.join(",")})`);
  if (activeConfig.smsTo?.length) channels.push(`sms(${activeConfig.smsTo.join(",")})`);
  if (activeConfig.whatsappTo?.length) channels.push(`whatsapp(${activeConfig.whatsappTo.join(",")})`);

  if (channels.length === 0) {
    log.warn("Morning briefing: no delivery channels configured — timer will idle");
  }

  // Restore last-sent date from disk so restarts don't re-fire today's briefing
  lastBriefingDate = loadLastBriefingDate();

  // Check immediately on start (catches restarts after briefing hour)
  checkAndSend();

  timer = setInterval(checkAndSend, interval);
  const hour = activeConfig.briefingHour ?? BRIEFING_HOUR;
  log.info(`Morning briefing: daily at ${hour}:00 (checking every ${Math.round(interval / 60_000)} min), channels: ${channels.length > 0 ? channels.join(", ") : "none"}`);
}

/** Stop the morning briefing timer. */
export function stopBriefingTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  activeStore = null;
}

/** Check if the briefing timer is running. */
export function isBriefingTimerRunning(): boolean {
  return timer !== null;
}

/** Get the last generated briefing, if any. */
export function getLastBriefing(): MorningBriefing | null {
  return lastBriefing;
}

/** Get the last delivery result, if any. */
export function getLastDeliveryResult(): BriefingDeliveryResult | null {
  return lastDelivery;
}

/**
 * Update briefing configuration at runtime (e.g. recipients, hour).
 */
export function updateBriefingConfig(config: Partial<BriefingConfig>): void {
  activeConfig = { ...activeConfig, ...config };
}

/**
 * Force an immediate briefing (e.g. from API endpoint or chat command).
 * Ignores the time-of-day and daily dedup checks.
 * Returns null if the timer isn't started or no channels are configured.
 */
export async function triggerBriefing(): Promise<{
  briefing: MorningBriefing;
  delivery: BriefingDeliveryResult | null;
} | null> {
  if (!activeStore) return null;
  if (!hasConfiguredChannels(activeConfig)) {
    log.warn("triggerBriefing: no delivery channels configured — skipping");
    return null;
  }

  const briefing = await generateBriefing(activeStore);
  const delivery = await deliverBriefing(briefing, activeConfig);
  if (delivery) {
    const today = new Date().toISOString().slice(0, 10);
    lastBriefingDate = today;
    persistLastBriefingDate(today);
  }
  return { briefing, delivery };
}
