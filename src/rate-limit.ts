/**
 * In-memory sliding-window rate limiter middleware for Hono.
 *
 * Tracks request counts per key (IP by default) in a time window.
 * Returns standard rate limit headers on every response.
 * Returns 429 when the limit is exceeded.
 */

import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitConfig {
  /** Time window in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
  /** Maximum requests allowed per window. Default: 60. */
  max?: number;
  /** Extract the rate-limit key from the request. Default: client IP. */
  keyFn?: (c: Context) => string;
  /** Custom message or JSON returned on 429. Default: { error: "Too many requests" }. */
  message?: string | Record<string, unknown>;
}

interface WindowEntry {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
}

/**
 * Creates a rate limiter middleware with its own isolated store.
 *
 * Usage:
 *   app.use("/api/auth/*", rateLimit({ windowMs: 60_000, max: 5 }));
 */
export function rateLimit(config: RateLimitConfig = {}): MiddlewareHandler {
  const {
    windowMs = 60_000,
    max = 60,
    keyFn = defaultKeyFn,
    message = { error: "Too many requests" },
  } = config;

  // Per-middleware isolated store keyed by rate-limit key.
  const store = new Map<string, WindowEntry>();

  // Periodic cleanup to prevent unbounded memory growth.
  // Runs every 5 windows or 5 minutes, whichever is larger.
  const cleanupInterval = Math.max(windowMs * 5, 5 * 60_000);
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, cleanupInterval);
  // Don't keep the process alive just for cleanup.
  if (timer.unref) timer.unref();

  return async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create entry.
    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Slide the window: drop timestamps outside the current window.
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const remaining = Math.max(0, max - entry.timestamps.length);
    const resetAt = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0]! + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    // Set headers on every response.
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));
    c.header("X-RateLimit-Reset", String(resetAt));

    if (entry.timestamps.length >= max) {
      const retryAfterSec = Math.ceil((entry.timestamps[0]! + windowMs - now) / 1000);
      c.header("Retry-After", String(Math.max(1, retryAfterSec)));
      const body = typeof message === "string" ? { error: message } : message;
      return c.json(body, 429);
    }

    // Record this request.
    entry.timestamps.push(now);

    // Update remaining after recording.
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - entry.timestamps.length)));

    await next();
  };
}

/** Default key: extract client IP from Hono context. */
function defaultKeyFn(c: Context): string {
  // Hono's c.req.header() returns the first value.
  // Check common proxy headers, fall back to remote address.
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    (c.env as Record<string, any>)?.incoming?.socket?.remoteAddress ||
    "unknown"
  );
}
