/**
 * Correlation ID management for distributed request tracking.
 *
 * Provides a per-request correlation context using Node.js AsyncLocalStorage.
 * The correlation ID flows automatically through async operations within
 * a request lifecycle — no manual threading required.
 *
 * Usage:
 *   withCorrelation(correlationId, async () => { ... })
 *   getCorrelationId() // returns current ID or undefined
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrelationContext {
  /** Unique request/operation correlation ID. */
  correlationId: string;
  /** Optional parent correlation ID for nested operations. */
  parentCorrelationId?: string;
  /** Arbitrary key-value baggage propagated with the context. */
  baggage: Record<string, string>;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage instance
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<CorrelationContext>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate a new correlation ID. Format: `cor_<timestamp>_<random>`. */
export function generateCorrelationId(): string {
  return `cor_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/**
 * Run a function within a correlation context.
 * The correlation ID is available to all async code within the callback
 * via `getCorrelationId()`.
 */
export function withCorrelation<T>(
  correlationId: string,
  fn: () => T,
  baggage?: Record<string, string>,
): T {
  const parentCtx = storage.getStore();
  const ctx: CorrelationContext = {
    correlationId,
    parentCorrelationId: parentCtx?.correlationId,
    baggage: { ...parentCtx?.baggage, ...baggage },
  };
  return storage.run(ctx, fn);
}

/** Get the current correlation ID, or undefined if not in a correlation context. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Get the full correlation context, or undefined. */
export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/** HTTP header name for correlation ID propagation. */
export const CORRELATION_HEADER = "x-correlation-id";
