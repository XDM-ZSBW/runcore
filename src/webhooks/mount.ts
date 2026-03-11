/**
 * Webhook route mounting for Hono.
 *
 * Provides helpers to mount webhook endpoints on a Hono app:
 * - `mountWebhookAdmin(app)` — Admin/management endpoints for listing providers,
 *   checking health, viewing stats, and managing configuration.
 * - `createWebhookMiddleware(providerName)` — Reusable verification middleware
 *   that routes can compose with provider-specific response handling.
 */

import type { Hono, Context } from "hono";
import { badRequest, unauthorized, notFound } from "../middleware/error-handler.js";
import { logActivity } from "../activity/log.js";
import {
  getProvider,
  listProviders,
  getProviderStats,
  getAllProviderStats,
  getProviderHealth,
  getAllProviderHealth,
} from "./registry.js";
import {
  routeWebhook,
  routeWebhookRequest,
  composeMiddleware,
  validateRequest,
  deduplicateRequests,
  rateLimitRequests,
} from "./router.js";
import {
  getProviderConfig,
  setProviderConfig,
  getProviderSecret,
  isProviderEnabled,
  validateConfig,
  listConfiguredProviders,
} from "./config.js";
import { DeadLetterQueue } from "./retry.js";
import {
  getRecentEvents,
  getEventLogSummary,
  clearEventLog,
  startEventTimer,
} from "./event-log.js";
import type { VerifyContext, WebhookResult, WebhookMiddleware } from "./types.js";

// ── Shared dead-letter queue (lazy-initialized) ─────────────────────────────

let dlq: DeadLetterQueue | null = null;

/** Get the shared dead-letter queue instance. Lazy-initializes on first access
 *  to avoid sync file I/O + logActivity() at module import time. */
export function getDeadLetterQueue(): DeadLetterQueue {
  if (!dlq) {
    dlq = new DeadLetterQueue(200, "brain/webhooks/dlq.json");
  }
  return dlq;
}

// ── Verification helper ──────────────────────────────────────────────────────

/**
 * Verify a webhook request for a given provider.
 * Looks up the provider in the registry, resolves the secret, and calls verify().
 * Returns { valid, error? } — does not throw.
 */
export function verifyWebhookRequest(
  providerName: string,
  rawBody: string,
  headers: Record<string, string>,
  opts?: { url?: string; params?: Record<string, string> },
): { valid: boolean; error?: string; durationMs?: number } {
  const start = performance.now();

  const provider = getProvider(providerName);
  if (!provider) {
    return { valid: false, error: `Unknown provider: ${providerName}`, durationMs: performance.now() - start };
  }

  if (!isProviderEnabled(providerName)) {
    return { valid: false, error: `Provider ${providerName} is disabled`, durationMs: performance.now() - start };
  }

  const secret = getProviderSecret(providerName);
  if (!secret) {
    // No secret configured — allow in dev mode
    return { valid: true, durationMs: performance.now() - start };
  }

  const config = getProviderConfig(providerName);
  const sigHeader = config?.signatureHeader ?? "x-signature";
  const signature = headers[sigHeader] ?? "";

  const ctx: VerifyContext = {
    rawBody,
    signature,
    secret,
    headers,
    url: opts?.url,
    params: opts?.params,
  };

  const verifyStart = performance.now();
  const valid = provider.verify(ctx);
  const verifyMs = performance.now() - verifyStart;
  const totalMs = performance.now() - start;

  if (totalMs > 100) {
    logActivity({
      source: "system",
      summary: `[perf] verifyWebhookRequest(${providerName}) took ${totalMs.toFixed(1)}ms (verify:${verifyMs.toFixed(1)}ms)`,
    });
  }

  if (!valid) {
    return { valid: false, error: "Invalid webhook signature", durationMs: totalMs };
  }

  return { valid: true, durationMs: totalMs };
}

// ── Route processing helper ──────────────────────────────────────────────────

/**
 * Process a verified webhook payload through the registry.
 * Call this after verification succeeds. Handles error wrapping and DLQ.
 */
export async function processVerifiedWebhook(
  providerName: string,
  payload: unknown,
  ctx?: Record<string, unknown>,
): Promise<WebhookResult> {
  const start = performance.now();
  const result = await routeWebhook(providerName, payload, undefined, ctx);
  const routeMs = performance.now() - start;

  if (!result.handled) {
    const dlqStart = performance.now();
    getDeadLetterQueue().add({
      provider: providerName,
      payload,
      error: {
        kind: "permanent",
        message: result.message,
        provider: providerName,
        timestamp: new Date().toISOString(),
      },
      receivedAt: new Date().toISOString(),
      attempts: 1,
    });
    const dlqMs = performance.now() - dlqStart;

    if (dlqMs > 50) {
      logActivity({
        source: "system",
        summary: `[perf] DLQ add for ${providerName} took ${dlqMs.toFixed(1)}ms`,
      });
    }
  }

  const totalMs = performance.now() - start;
  if (totalMs > 500) {
    logActivity({
      source: "system",
      summary: `[perf] processVerifiedWebhook(${providerName}) took ${totalMs.toFixed(1)}ms (route:${routeMs.toFixed(1)}ms)`,
    });
  }

  return result;
}

// ── Admin route mounting ─────────────────────────────────────────────────────

/**
 * Mount webhook admin/management endpoints on a Hono app.
 * Adds routes under `/api/webhooks/` for provider management, health, stats,
 * configuration, and dead-letter queue inspection.
 *
 * Routes:
 * - GET  /api/webhooks/providers        — List registered providers
 * - GET  /api/webhooks/providers/:name   — Get provider detail (config + stats + health)
 * - GET  /api/webhooks/health            — Health summary for all providers
 * - GET  /api/webhooks/stats             — Stats for all providers
 * - GET  /api/webhooks/config/validate   — Validate webhook configuration
 * - POST /api/webhooks/config/:name      — Update provider configuration
 * - GET  /api/webhooks/dlq               — List dead-letter queue entries
 * - DELETE /api/webhooks/dlq/:id         — Remove a DLQ entry
 * - POST /api/webhooks/dlq/:id/retry     — Retry a DLQ entry
 * - GET  /api/webhooks/events            — Recent event log (debugging)
 * - GET  /api/webhooks/events/summary    — Event log summary statistics
 * - DELETE /api/webhooks/events          — Clear event log
 * - POST /api/webhooks/test/:name        — Send a test payload to a provider
 */
export function mountWebhookAdmin(app: Hono): void {
  const mountStart = performance.now();

  // List all registered providers
  app.get("/api/webhooks/providers", (c) => {
    const providers = listProviders();
    const configured = listConfiguredProviders();
    return c.json({
      providers: providers.map((name) => ({
        name,
        registered: true,
        configured: configured.includes(name),
        enabled: isProviderEnabled(name),
      })),
    });
  });

  // Get detail for a specific provider
  app.get("/api/webhooks/providers/:name", (c) => {
    const name = c.req.param("name");
    const provider = getProvider(name);
    if (!provider) {
      return notFound(`Provider "${name}" not found`);
    }

    const stats = getProviderStats(name);
    const health = getProviderHealth(name);
    const config = getProviderConfig(name);

    return c.json({
      name,
      enabled: isProviderEnabled(name),
      config: config
        ? { ...config, secret: config.secret ? "***" : undefined }
        : null,
      stats: stats ?? null,
      health: health ?? null,
    });
  });

  // Health summary for all providers
  app.get("/api/webhooks/health", (c) => {
    const threshold = parseFloat(c.req.query("threshold") ?? "0.5");
    const health = getAllProviderHealth(threshold);
    return c.json({ providers: health });
  });

  // Stats for all providers
  app.get("/api/webhooks/stats", (c) => {
    const stats = getAllProviderStats();
    return c.json({ providers: stats });
  });

  // Validate configuration
  app.get("/api/webhooks/config/validate", (c) => {
    const issues = validateConfig();
    const hasIssues = Object.keys(issues).length > 0;
    return c.json({ valid: !hasIssues, issues });
  });

  // Update provider configuration
  app.post("/api/webhooks/config/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();

    setProviderConfig({ name, ...body });

    logActivity({
      source: "system",
      summary: `Webhook config updated for ${name}`,
    });

    return c.json({ ok: true, message: `Configuration updated for ${name}` });
  });

  // Dead-letter queue: list entries
  app.get("/api/webhooks/dlq", (c) => {
    const provider = c.req.query("provider");
    const entries = getDeadLetterQueue().list(provider ?? undefined);
    return c.json({ size: entries.length, entries });
  });

  // Dead-letter queue: remove entry
  app.delete("/api/webhooks/dlq/:id", (c) => {
    const id = c.req.param("id");
    const removed = getDeadLetterQueue().remove(id);
    if (!removed) {
      return notFound(`DLQ entry "${id}" not found`);
    }
    return c.json({ ok: true, message: `Removed DLQ entry ${id}` });
  });

  // Dead-letter queue: retry an entry
  app.post("/api/webhooks/dlq/:id/retry", async (c) => {
    const id = c.req.param("id");
    const queue = getDeadLetterQueue();
    const entries = queue.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      return notFound(`DLQ entry "${id}" not found`);
    }

    const result = await routeWebhook(entry.provider, entry.payload);
    if (result.handled) {
      queue.remove(id);
    }

    return c.json({
      ok: result.handled,
      message: result.message,
      removed: result.handled,
    });
  });

  // ── Event log endpoints ───────────────────────────────────────────────────

  // Recent event log (debugging)
  app.get("/api/webhooks/events", (c) => {
    const provider = c.req.query("provider") ?? undefined;
    const successStr = c.req.query("success");
    const success = successStr === "true" ? true : successStr === "false" ? false : undefined;
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const since = c.req.query("since") ?? undefined;

    const events = getRecentEvents({ provider, success, limit, since });
    return c.json({ count: events.length, events });
  });

  // Event log summary
  app.get("/api/webhooks/events/summary", (c) => {
    const summary = getEventLogSummary();
    return c.json(summary);
  });

  // Clear event log
  app.delete("/api/webhooks/events", (c) => {
    const provider = c.req.query("provider") ?? undefined;
    const cleared = clearEventLog(provider);
    return c.json({ ok: true, cleared });
  });

  // ── Test endpoint ────────────────────────────────────────────────────────

  // Send a test payload to a provider (bypasses signature verification)
  app.post("/api/webhooks/test/:name", async (c) => {
    const name = c.req.param("name");
    const provider = getProvider(name);
    if (!provider) {
      return notFound(`Provider "${name}" not found`);
    }

    if (!isProviderEnabled(name)) {
      return badRequest(`Provider "${name}" is disabled`);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const finish = startEventTimer(name, { eventType: "test" });
    try {
      const result = await provider.process(payload);
      finish({
        success: result.handled,
        message: result.message,
      });
      return c.json({ ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ success: false, message: msg, error: msg });
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  const routesMs = (performance.now() - mountStart).toFixed(1);

  const logStart = performance.now();
  logActivity({
    source: "system",
    summary: `Webhook admin routes mounted at /api/webhooks/ (routes:${routesMs}ms)`,
  });
  const logMs = (performance.now() - logStart).toFixed(1);

  const totalMs = (performance.now() - mountStart).toFixed(1);

  if (parseFloat(logMs) > 5) {
    logActivity({
      source: "system",
      summary: `[perf] mountWebhookAdmin logActivity took ${logMs}ms`,
    });
  }
  if (parseFloat(totalMs) > 50) {
    logActivity({
      source: "system",
      summary: `[perf] mountWebhookAdmin total: ${totalMs}ms (routes:${routesMs}ms, log:${logMs}ms)`,
    });
  }
}

// ── Generic webhook route helper ─────────────────────────────────────────────

/** Options for creating a generic webhook route handler. */
export interface WebhookRouteOpts {
  /** Provider name in the registry. */
  provider: string;
  /** Additional context passed to the processor (e.g., { store }). */
  processorCtx?: Record<string, unknown>;
  /** Middleware to apply before processing. */
  middleware?: WebhookMiddleware[];
  /** Custom response transformer. Return null to use default JSON response. */
  transformResponse?: (
    result: WebhookResult,
    c: Context,
  ) => Response | null;
}

/**
 * Create a Hono route handler that verifies and processes webhooks
 * through the generic registry. Use this to replace inline verification code.
 *
 * Usage:
 *   app.post("/api/my-service/webhooks", createWebhookRoute({
 *     provider: "my-service",
 *     processorCtx: { store: myStore },
 *   }));
 */
export function createWebhookRoute(
  opts: WebhookRouteOpts,
): (c: Context) => Promise<Response> {
  return async (c: Context): Promise<Response> => {
    const rawBody = await c.req.text();

    // Build headers map (lowercase keys)
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Build URL for providers that need it (e.g., Twilio)
    const proto = headers["x-forwarded-proto"] ?? "https";
    const host = headers["host"] ?? "localhost";
    const pathName = new URL(c.req.url).pathname;
    const fullUrl = `${proto}://${host}${pathName}`;

    // Start event timer for the event log
    const deliveryId = headers["x-request-id"] ?? headers["x-github-delivery"] ?? undefined;
    const finish = startEventTimer(opts.provider, { deliveryId });

    // Verify signature
    const verification = verifyWebhookRequest(opts.provider, rawBody, headers, {
      url: fullUrl,
    });

    if (!verification.valid) {
      finish({
        success: false,
        message: verification.error ?? "Signature verification failed",
        error: verification.error,
        statusCode: 401,
      });
      return unauthorized(verification.error ?? "Signature verification failed");
    }

    // Parse body
    let parsed: unknown;
    const contentType = headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        finish({ success: false, message: "Invalid JSON body", statusCode: 400 });
        return badRequest("Invalid JSON body");
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const params: Record<string, string> = {};
      const pairs = rawBody.split("&");
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const key = decodeURIComponent(
          pair.slice(0, eqIdx).replace(/\+/g, " "),
        );
        const value = decodeURIComponent(
          pair.slice(eqIdx + 1).replace(/\+/g, " "),
        );
        params[key] = value;
      }
      parsed = params;
    } else {
      parsed = rawBody;
    }

    // Route through the middleware pipeline
    const result = await routeWebhookRequest(
      {
        method: c.req.method,
        url: fullUrl,
        headers,
        body: rawBody,
        parsed,
        provider: opts.provider,
      },
      {
        processorCtx: opts.processorCtx,
        middleware: opts.middleware,
      },
    );

    // Log the event
    finish({
      success: result.handled,
      message: result.message,
      statusCode: 200,
    });

    // Custom response transformation
    if (opts.transformResponse) {
      const custom = opts.transformResponse(result, c);
      if (custom) return custom;
    }

    return c.json(result);
  };
}
