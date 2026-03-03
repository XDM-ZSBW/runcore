/**
 * Webhook event routing and dispatching.
 *
 * Provides middleware composition, request validation, deduplication,
 * event-type routing, and high-level request dispatching that ties
 * together the registry, verification, and retry subsystems.
 */

import { logActivity } from "../activity/log.js";
import { getProvider, recordSuccess, recordFailure } from "./registry.js";
import type {
  WebhookResult,
  WebhookEvent,
  WebhookRequestContext,
  WebhookMiddleware,
  VerifyContext,
  DeduplicationOpts,
  EventHandler,
} from "./types.js";

// ── Event envelope ───────────────────────────────────────────────────────────

/** Create a WebhookEvent envelope from a raw payload. */
export function createWebhookEvent<T>(
  source: string,
  payload: T,
  opts?: { eventType?: string; deliveryId?: string },
): WebhookEvent<T> {
  return {
    source,
    receivedAt: new Date().toISOString(),
    payload,
    eventType: opts?.eventType,
    deliveryId: opts?.deliveryId,
  };
}

// ── Core routing ─────────────────────────────────────────────────────────────

/**
 * Route a webhook event through the registry.
 * Looks up the provider by name, verifies the signature, and processes the payload.
 */
export async function routeWebhook(
  providerName: string,
  payload: unknown,
  verifyCtx?: VerifyContext,
  processorCtx?: Record<string, unknown>,
): Promise<WebhookResult> {
  const provider = getProvider(providerName);
  if (!provider) {
    return {
      handled: false,
      message: `Unknown webhook provider: ${providerName}`,
    };
  }

  // Verify signature if context is provided
  if (verifyCtx) {
    const valid = provider.verify(verifyCtx);
    if (!valid) {
      logActivity({
        source: "system",
        summary: `Webhook signature verification failed for ${providerName}`,
      });
      return { handled: false, message: "Invalid webhook signature" };
    }
  }

  // Process the payload
  try {
    const result = await provider.process(payload, processorCtx);
    if (result.handled) {
      recordSuccess(providerName);
    } else {
      recordFailure(providerName, result.message);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(providerName, msg);
    logActivity({
      source: "system",
      summary: `Webhook processing error (${providerName}): ${msg}`,
    });
    return { handled: false, message: `Processing error: ${msg}` };
  }
}

// ── Middleware composition ────────────────────────────────────────────────────

/**
 * Compose multiple middleware functions into a single middleware.
 * Middleware executes in order, each calling next() to continue the chain.
 */
export function composeMiddleware(
  ...middlewares: WebhookMiddleware[]
): WebhookMiddleware {
  return async (ctx, next) => {
    let index = -1;

    async function dispatch(i: number): Promise<WebhookResult> {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;

      if (i >= middlewares.length) {
        return next();
      }

      return middlewares[i](ctx, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}

// ── Request validation middleware ─────────────────────────────────────────────

/**
 * Middleware that validates basic request properties.
 * Rejects requests with wrong method, missing body, or missing required headers.
 */
export function validateRequest(opts?: {
  /** Allowed HTTP methods. Default: ["POST"]. */
  allowedMethods?: string[];
  /** Required header names (lowercase). */
  requiredHeaders?: string[];
  /** Minimum body length. Default: 1. */
  minBodyLength?: number;
}): WebhookMiddleware {
  const methods = opts?.allowedMethods ?? ["POST"];
  const required = opts?.requiredHeaders ?? [];
  const minBody = opts?.minBodyLength ?? 1;

  return async (ctx, next) => {
    if (!methods.includes(ctx.method.toUpperCase())) {
      return { handled: false, message: `Method ${ctx.method} not allowed` };
    }

    if (ctx.body.length < minBody) {
      return { handled: false, message: "Empty request body" };
    }

    for (const header of required) {
      if (!ctx.headers[header.toLowerCase()]) {
        return {
          handled: false,
          message: `Missing required header: ${header}`,
        };
      }
    }

    return next();
  };
}

// ── Deduplication middleware ──────────────────────────────────────────────────

/**
 * Middleware that prevents duplicate webhook deliveries.
 * Tracks delivery IDs extracted from headers and rejects events already seen.
 * Uses a bounded LRU-style map with TTL expiration.
 */
export function deduplicateRequests(
  opts?: DeduplicationOpts & {
    /** Header name containing the delivery/request ID (lowercase). Default: "x-request-id". */
    idHeader?: string;
  },
): WebhookMiddleware {
  const maxSize = opts?.maxSize ?? 1000;
  const ttlMs = opts?.ttlMs ?? 300_000;
  const idHeader = opts?.idHeader ?? "x-request-id";
  const seen = new Map<string, number>(); // deliveryId → timestamp

  return async (ctx, next) => {
    const deliveryId = ctx.headers[idHeader];
    if (!deliveryId) {
      // No delivery ID header — pass through (can't deduplicate)
      return next();
    }

    // Evict expired entries when map grows large
    if (seen.size >= maxSize) {
      const now = Date.now();
      for (const [id, ts] of seen) {
        if (now - ts > ttlMs) seen.delete(id);
      }
      // If still too large after eviction, drop oldest quarter
      if (seen.size >= maxSize) {
        const entries = [...seen.entries()];
        const toDrop = Math.floor(maxSize / 4);
        for (let i = 0; i < toDrop && i < entries.length; i++) {
          seen.delete(entries[i][0]);
        }
      }
    }

    const now = Date.now();
    const existingTs = seen.get(deliveryId);
    if (existingTs !== undefined && now - existingTs < ttlMs) {
      return {
        handled: true,
        message: `Duplicate delivery ignored: ${deliveryId}`,
      };
    }

    seen.set(deliveryId, now);
    return next();
  };
}

// ── Rate-limiting middleware ──────────────────────────────────────────────────

/**
 * Middleware that rate-limits webhook requests per provider.
 * Uses a sliding-window counter.
 */
export function rateLimitRequests(opts?: {
  /** Maximum requests per window. Default: 100. */
  maxRequests?: number;
  /** Window duration in ms. Default: 60_000 (1 minute). */
  windowMs?: number;
}): WebhookMiddleware {
  const maxReqs = opts?.maxRequests ?? 100;
  const windowMs = opts?.windowMs ?? 60_000;
  const windows = new Map<string, number[]>(); // provider → timestamps

  return async (ctx, next) => {
    const now = Date.now();
    const cutoff = now - windowMs;

    let timestamps = windows.get(ctx.provider);
    if (!timestamps) {
      timestamps = [];
      windows.set(ctx.provider, timestamps);
    }

    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxReqs) {
      return {
        handled: false,
        message: `Rate limit exceeded for ${ctx.provider} (${maxReqs}/${windowMs}ms)`,
      };
    }

    timestamps.push(now);
    return next();
  };
}

// ── High-level request routing ───────────────────────────────────────────────

/**
 * Route an incoming HTTP-like request through the full webhook pipeline:
 * 1. Look up provider
 * 2. Run middleware chain
 * 3. Verify signature
 * 4. Process payload
 *
 * Higher-level alternative to routeWebhook() for HTTP server integrations.
 */
export async function routeWebhookRequest(
  ctx: WebhookRequestContext,
  opts?: {
    /** Secret for signature verification. */
    secret?: string;
    /** Header name containing the signature (lowercase). */
    signatureHeader?: string;
    /** Additional context passed to the processor. */
    processorCtx?: Record<string, unknown>;
    /** Middleware to run before processing. */
    middleware?: WebhookMiddleware[];
  },
): Promise<WebhookResult> {
  const provider = getProvider(ctx.provider);
  if (!provider) {
    return {
      handled: false,
      message: `Unknown webhook provider: ${ctx.provider}`,
    };
  }

  const process = async (): Promise<WebhookResult> => {
    // Verify signature if secret provided
    if (opts?.secret) {
      const sigHeader = opts.signatureHeader ?? "x-signature";
      const verifyCtx: VerifyContext = {
        rawBody: ctx.body,
        signature: ctx.headers[sigHeader] ?? "",
        secret: opts.secret,
        headers: ctx.headers,
        url: ctx.url,
      };

      const valid = provider.verify(verifyCtx);
      if (!valid) {
        recordFailure(ctx.provider, "Signature verification failed");
        logActivity({
          source: "system",
          summary: `Webhook signature verification failed for ${ctx.provider}`,
        });
        return { handled: false, message: "Invalid webhook signature" };
      }
    }

    const payload = ctx.parsed ?? ctx.body;
    const result = await provider.process(payload, opts?.processorCtx);
    if (result.handled) {
      recordSuccess(ctx.provider);
    } else {
      recordFailure(ctx.provider, result.message);
    }
    return result;
  };

  // Apply middleware if provided
  if (opts?.middleware && opts.middleware.length > 0) {
    const composed = composeMiddleware(...opts.middleware);
    return composed(ctx, process);
  }

  return process();
}

// ── Event-type router builder ────────────────────────────────────────────────

/**
 * Build an event-routing processor from a map of event types to handlers.
 * The typeExtractor pulls the event type string from the payload.
 * Optionally provide a defaultHandler for unmatched event types.
 */
export function createEventRouter<T = unknown>(opts: {
  source: string;
  typeExtractor: (payload: T) => string;
  handlers: Record<string, EventHandler<T>>;
  /** Fallback handler for event types not in the handlers map. */
  defaultHandler?: EventHandler<T>;
}): (
  payload: unknown,
  ctx?: Record<string, unknown>,
) => Promise<WebhookResult> {
  const { source, typeExtractor, handlers, defaultHandler } = opts;

  // Import safeHandler inline to avoid circular dep — handlers.ts imports from router.ts
  return async (payload, ctx) => {
    try {
      const eventType = typeExtractor(payload as T);
      const handler = handlers[eventType];
      if (!handler) {
        if (defaultHandler) {
          return defaultHandler(payload as T, ctx);
        }
        return {
          handled: false,
          message: `Unhandled ${source} event type: ${eventType}`,
        };
      }
      return handler(payload as T, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({
        source: "system",
        summary: `Webhook handler error (${source}): ${msg}`,
      });
      return { handled: false, message: `Handler error: ${msg}` };
    }
  };
}

// ── Event normalization ──────────────────────────────────────────────────────

/**
 * Wrap a raw payload into a typed WebhookEvent envelope.
 * Useful for handlers that want a normalized event shape.
 */
export function normalizeToEvent<T>(
  source: string,
  payload: T,
  opts?: {
    typeExtractor?: (p: T) => string;
    idExtractor?: (p: T) => string;
  },
): WebhookEvent<T> {
  return createWebhookEvent(source, payload, {
    eventType: opts?.typeExtractor?.(payload),
    deliveryId: opts?.idExtractor?.(payload),
  });
}
