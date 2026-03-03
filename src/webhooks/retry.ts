/**
 * Retry logic and error handling for webhook processing.
 *
 * Provides exponential backoff with jitter for transient failures,
 * dead-letter tracking for permanently failed events, and
 * error classification utilities.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logActivity } from "../activity/log.js";
import type { WebhookRetryOpts, WebhookResult } from "./types.js";

// ── Retry with exponential backoff ───────────────────────────────────────────

/**
 * Execute a function with retry logic.
 * Retries on thrown errors, stops on success or exhaustion.
 * Uses exponential backoff with jitter:
 *   delay = min(baseDelay × 2^(attempt-1), maxDelay) × random(0.5–1.5)
 */
export async function withWebhookRetry<T>(
  fn: () => Promise<T>,
  opts?: WebhookRetryOpts & { label?: string },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 500;
  const maxDelay = opts?.maxDelayMs ?? 10_000;
  const label = opts?.label ?? "webhook";
  const retryStart = performance.now();
  let lastError: unknown;
  let totalSleepMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = performance.now();
    try {
      const result = await fn();
      const attemptMs = performance.now() - attemptStart;
      if (attempt > 1) {
        const totalMs = performance.now() - retryStart;
        logActivity({
          source: "system",
          summary: `[perf] ${label}: succeeded on attempt ${attempt}/${maxAttempts} — attempt:${attemptMs.toFixed(1)}ms, totalRetry:${totalMs.toFixed(1)}ms, totalSleep:${totalSleepMs.toFixed(0)}ms`,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const attemptMs = performance.now() - attemptStart;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errKind = classifyError(err);

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        totalSleepMs += jitter;
        logActivity({
          source: "system",
          summary: `${label}: attempt ${attempt}/${maxAttempts} failed (${errKind}, ${attemptMs.toFixed(1)}ms: ${errMsg}), retrying in ${Math.round(jitter)}ms`,
        });
        await new Promise((resolve) => setTimeout(resolve, jitter));
      } else {
        const totalMs = performance.now() - retryStart;
        logActivity({
          source: "system",
          summary: `[perf] ${label}: exhausted ${maxAttempts} attempts — total:${totalMs.toFixed(1)}ms, sleep:${totalSleepMs.toFixed(0)}ms, lastAttempt:${attemptMs.toFixed(1)}ms, error:${errKind}:${errMsg}`,
        });
      }
    }
  }

  opts?.onExhausted?.(lastError, maxAttempts);
  throw lastError;
}

// ── Error classification ─────────────────────────────────────────────────────

/** Error classification for webhook processing failures. */
export type WebhookErrorKind = "transient" | "permanent" | "auth";

/** A classified webhook error with metadata. */
export interface WebhookError {
  kind: WebhookErrorKind;
  message: string;
  provider: string;
  timestamp: string;
  attempt?: number;
  cause?: unknown;
}

/**
 * Classify an error for retry decisions.
 * - Network errors, 429, 5xx → transient (retry)
 * - 400, 404, validation → permanent (don't retry)
 * - 401, 403 → auth (don't retry, flag for re-auth)
 */
export function classifyError(err: unknown): WebhookErrorKind {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    // Auth errors
    if (msg.includes("unauthorized") || msg.includes("forbidden")) {
      return "auth";
    }
    if (msg.includes("401") || msg.includes("403")) {
      return "auth";
    }

    // Transient errors
    if (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("503") ||
      msg.includes("502") ||
      msg.includes("504")
    ) {
      return "transient";
    }
  }

  return "permanent";
}

/**
 * Create a WebhookError from a caught exception.
 */
export function createWebhookError(
  err: unknown,
  provider: string,
  attempt?: number,
): WebhookError {
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: classifyError(err),
    message,
    provider,
    timestamp: new Date().toISOString(),
    attempt,
    cause: err,
  };
}

// ── Dead-letter queue ────────────────────────────────────────────────────────

/** A failed webhook event stored for later inspection or replay. */
export interface DeadLetterEntry {
  id: string;
  provider: string;
  payload: unknown;
  error: WebhookError;
  receivedAt: string;
  exhaustedAt: string;
  attempts: number;
}

/**
 * Dead-letter queue for failed webhook events.
 * Stores events that exhausted all retries for manual inspection or replay.
 * Optionally persists to a JSON file to survive process restarts.
 */
export class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];
  private maxSize: number;
  private filePath: string | null;
  private dirty = false;

  /**
   * @param maxSize Maximum entries to keep in the queue.
   * @param filePath Optional file path for persistence. If provided, entries
   *                 are loaded on construction and saved on mutation.
   */
  constructor(maxSize = 100, filePath?: string) {
    this.maxSize = maxSize;
    this.filePath = filePath ?? null;

    if (this.filePath) {
      this.loadFromFile();
    }
  }

  /** Add a failed event to the dead-letter queue. */
  add(entry: Omit<DeadLetterEntry, "id" | "exhaustedAt">): void {
    const dlEntry: DeadLetterEntry = {
      ...entry,
      id: `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      exhaustedAt: new Date().toISOString(),
    };

    this.entries.push(dlEntry);

    // Evict oldest entries if over capacity
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize);
    }

    logActivity({
      source: "system",
      summary: `Dead-letter: ${entry.provider} event added (${entry.error.message})`,
    });

    this.persist();
  }

  /** Get all entries, optionally filtered by provider. */
  list(provider?: string): DeadLetterEntry[] {
    if (provider) {
      return this.entries.filter((e) => e.provider === provider);
    }
    return [...this.entries];
  }

  /** Remove an entry by ID. Returns true if found. */
  remove(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.persist();
    return true;
  }

  /** Remove all entries, optionally for a specific provider. */
  clear(provider?: string): number {
    if (provider) {
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e.provider !== provider);
      const removed = before - this.entries.length;
      if (removed > 0) this.persist();
      return removed;
    }
    const count = this.entries.length;
    this.entries = [];
    if (count > 0) this.persist();
    return count;
  }

  /** Number of entries in the queue. */
  get size(): number {
    return this.entries.length;
  }

  /** Whether the queue has a file-backed persistence path configured. */
  get persistent(): boolean {
    return this.filePath !== null;
  }

  // ── File persistence ────────────────────────────────────────────────────────

  /** Load entries from the persistence file. Silently skips if file doesn't exist. */
  private loadFromFile(): void {
    if (!this.filePath) return;
    try {
      const resolved = path.resolve(this.filePath);
      if (!fs.existsSync(resolved)) return;

      const content = fs.readFileSync(resolved, "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.entries = parsed.slice(-this.maxSize);
        logActivity({
          source: "system",
          summary: `DLQ: loaded ${this.entries.length} entries from ${this.filePath}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({
        source: "system",
        summary: `DLQ: failed to load from ${this.filePath}: ${msg}`,
      });
    }
  }

  /** Persist current entries to the file. Debounced to avoid excessive writes. */
  private persist(): void {
    if (!this.filePath) return;
    if (this.dirty) return; // already scheduled
    this.dirty = true;

    // Debounce: write on next tick to batch rapid mutations
    queueMicrotask(() => {
      this.dirty = false;
      this.writeToFile();
    });
  }

  private writeToFile(): void {
    if (!this.filePath) return;
    try {
      const resolved = path.resolve(this.filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Exclude non-serializable `cause` from errors before writing
      const serializable = this.entries.map((e) => ({
        ...e,
        error: { ...e.error, cause: undefined },
      }));
      fs.writeFileSync(resolved, JSON.stringify(serializable, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({
        source: "system",
        summary: `DLQ: failed to persist to ${this.filePath}: ${msg}`,
      });
    }
  }
}

// ── Retry-wrapped handler factory ────────────────────────────────────────────

/**
 * Wrap a webhook handler with retry logic.
 * Useful for handlers that call external APIs that may transiently fail.
 */
export function withRetryHandler(
  source: string,
  fn: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>,
  retryOpts?: { maxAttempts?: number; baseDelayMs?: number },
): (
  payload: unknown,
  ctx?: Record<string, unknown>,
) => Promise<WebhookResult> {
  return async (payload, ctx) => {
    return withWebhookRetry(() => fn(payload, ctx), {
      label: source,
      ...retryOpts,
    });
  };
}
