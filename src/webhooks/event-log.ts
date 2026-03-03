/**
 * Webhook event log — ring buffer of recent webhook events for debugging.
 *
 * Tracks the last N webhook events (successes and failures) with timing data,
 * provider info, and error details. Useful for debugging webhook integrations
 * without needing to dig through activity logs.
 *
 * Usage:
 *   import { logWebhookEvent, getRecentEvents } from "./event-log.js";
 *   logWebhookEvent({ provider: "slack-events", eventType: "message", ... });
 *   const recent = getRecentEvents({ provider: "slack-events", limit: 10 });
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A recorded webhook event for debugging. */
export interface WebhookEventLogEntry {
  id: string;
  provider: string;
  eventType?: string;
  deliveryId?: string;
  receivedAt: string;
  /** Processing duration in ms. */
  durationMs: number;
  success: boolean;
  message: string;
  /** HTTP status code returned (if applicable). */
  statusCode?: number;
  /** Error details on failure. */
  error?: string;
  /** Signature verification result. */
  signatureValid?: boolean;
}

/** Filter options for querying the event log. */
export interface EventLogFilter {
  /** Filter by provider name. */
  provider?: string;
  /** Filter by success/failure. */
  success?: boolean;
  /** Maximum number of entries to return (most recent first). Default: 50. */
  limit?: number;
  /** Only return entries after this ISO timestamp. */
  since?: string;
}

/** Summary statistics from the event log. */
export interface EventLogSummary {
  total: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  byProvider: Record<string, { count: number; failures: number; avgDurationMs: number }>;
  oldestEntry: string | null;
  newestEntry: string | null;
}

// ── Ring buffer ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_SIZE = 500;
let maxSize = DEFAULT_MAX_SIZE;
let buffer: WebhookEventLogEntry[] = [];

/** Configure the maximum number of entries to keep. */
export function setEventLogMaxSize(size: number): void {
  maxSize = Math.max(10, size);
  if (buffer.length > maxSize) {
    buffer = buffer.slice(-maxSize);
  }
}

/** Get current max size. */
export function getEventLogMaxSize(): number {
  return maxSize;
}

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Record a webhook event in the log.
 * Automatically generates an ID and trims the buffer if over capacity.
 */
export function logWebhookEvent(
  entry: Omit<WebhookEventLogEntry, "id">,
): WebhookEventLogEntry {
  const full: WebhookEventLogEntry = {
    ...entry,
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };

  buffer.push(full);

  if (buffer.length > maxSize) {
    buffer = buffer.slice(-maxSize);
  }

  return full;
}

/**
 * Create a timing wrapper that records start time and returns a function
 * to finalize the log entry with duration and result.
 *
 * Usage:
 *   const finish = startEventTimer("slack-events", { eventType: "message" });
 *   // ... process webhook ...
 *   finish({ success: true, message: "OK" });
 */
export function startEventTimer(
  provider: string,
  meta?: { eventType?: string; deliveryId?: string; signatureValid?: boolean },
): (result: { success: boolean; message: string; error?: string; statusCode?: number }) => WebhookEventLogEntry {
  const startTime = performance.now();
  const receivedAt = new Date().toISOString();

  return (result) => {
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    return logWebhookEvent({
      provider,
      eventType: meta?.eventType,
      deliveryId: meta?.deliveryId,
      signatureValid: meta?.signatureValid,
      receivedAt,
      durationMs,
      ...result,
    });
  };
}

// ── Querying ─────────────────────────────────────────────────────────────────

/** Get recent webhook events, most recent first. */
export function getRecentEvents(filter?: EventLogFilter): WebhookEventLogEntry[] {
  let entries = [...buffer];

  if (filter?.provider) {
    entries = entries.filter((e) => e.provider === filter.provider);
  }

  if (filter?.success !== undefined) {
    entries = entries.filter((e) => e.success === filter.success);
  }

  if (filter?.since) {
    entries = entries.filter((e) => e.receivedAt >= filter.since!);
  }

  // Most recent first
  entries.reverse();

  const limit = filter?.limit ?? 50;
  return entries.slice(0, limit);
}

/** Get a summary of the event log. */
export function getEventLogSummary(): EventLogSummary {
  const byProvider: Record<string, { count: number; failures: number; totalMs: number }> = {};
  let totalMs = 0;

  for (const entry of buffer) {
    totalMs += entry.durationMs;

    if (!byProvider[entry.provider]) {
      byProvider[entry.provider] = { count: 0, failures: 0, totalMs: 0 };
    }
    byProvider[entry.provider].count++;
    byProvider[entry.provider].totalMs += entry.durationMs;
    if (!entry.success) {
      byProvider[entry.provider].failures++;
    }
  }

  const successes = buffer.filter((e) => e.success).length;
  const providerSummary: Record<string, { count: number; failures: number; avgDurationMs: number }> = {};
  for (const [name, stats] of Object.entries(byProvider)) {
    providerSummary[name] = {
      count: stats.count,
      failures: stats.failures,
      avgDurationMs: stats.count > 0 ? Math.round((stats.totalMs / stats.count) * 100) / 100 : 0,
    };
  }

  return {
    total: buffer.length,
    successes,
    failures: buffer.length - successes,
    avgDurationMs: buffer.length > 0 ? Math.round((totalMs / buffer.length) * 100) / 100 : 0,
    byProvider: providerSummary,
    oldestEntry: buffer.length > 0 ? buffer[0].receivedAt : null,
    newestEntry: buffer.length > 0 ? buffer[buffer.length - 1].receivedAt : null,
  };
}

/** Clear the event log. Optionally filter by provider. */
export function clearEventLog(provider?: string): number {
  if (provider) {
    const before = buffer.length;
    buffer = buffer.filter((e) => e.provider !== provider);
    return before - buffer.length;
  }
  const count = buffer.length;
  buffer = [];
  return count;
}
