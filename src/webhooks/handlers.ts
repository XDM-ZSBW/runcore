/**
 * Common webhook handler patterns.
 * Provides safe-execution wrappers, logging, provider factory helpers,
 * and reusable building blocks for processing webhook events.
 */

import * as crypto from "node:crypto";
import { logActivity } from "../activity/log.js";
import type {
  WebhookResult,
  WebhookProvider,
  VerifyContext,
  WebhookEvent,
  EventHandler,
} from "./types.js";
import { registerProvider } from "./registry.js";
import {
  hmacSha256Hex,
  hmacSha256Base64,
  hmacSha1Base64,
  timingSafeCompare,
  isTimestampFresh,
} from "./verify.js";
import { createWebhookEvent } from "./router.js";

// ── Re-export EventHandler type for backward compatibility ───────────────────

export type { EventHandler } from "./types.js";

// ── Safe execution wrapper ───────────────────────────────────────────────────

/**
 * Wrap a webhook handler so it never throws.
 * Catches errors and returns a structured WebhookResult instead.
 */
export function safeHandler(
  source: string,
  fn: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>,
): (
  payload: unknown,
  ctx?: Record<string, unknown>,
) => Promise<WebhookResult> {
  return async (payload, ctx) => {
    try {
      return await fn(payload, ctx);
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

// ── Event router builder (re-exported from router.ts) ────────────────────────

export { createEventRouter } from "./router.js";

// ── Provider factory helpers ─────────────────────────────────────────────────

/**
 * Create a provider that uses HMAC-SHA256 hex signature verification (without registering).
 * Used by services like Linear and GitHub.
 * Call registerProvider/registerProviders separately to complete registration.
 */
export function createHmacSha256HexProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  /** If true, strip a "sha256=" prefix from the signature before comparing (GitHub-style). Default: false. */
  stripPrefix?: boolean;
}): WebhookProvider {
  return {
    name: opts.name,
    verify(ctx: VerifyContext): boolean {
      const sig = opts.stripPrefix
        ? ctx.signature.replace(/^sha256=/, "")
        : ctx.signature;
      const expected = hmacSha256Hex(ctx.rawBody, ctx.secret);
      return timingSafeCompare(sig, expected);
    },
    process: opts.process,
  };
}

/**
 * Create and register a provider that uses HMAC-SHA256 hex signature verification.
 * Used by services like Linear and GitHub.
 * @deprecated Use createHmacSha256HexProvider + registerProviders for batch registration.
 */
export function registerHmacSha256HexProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  stripPrefix?: boolean;
}): WebhookProvider {
  const provider = createHmacSha256HexProvider(opts);
  registerProvider(provider);
  return provider;
}

/**
 * Create a provider that uses HMAC-SHA256 base64 signature verification (without registering).
 */
export function createHmacSha256Base64Provider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  stripPrefix?: boolean;
}): WebhookProvider {
  return {
    name: opts.name,
    verify(ctx: VerifyContext): boolean {
      const sig = opts.stripPrefix
        ? ctx.signature.replace(/^sha256=/, "")
        : ctx.signature;
      const expected = hmacSha256Base64(ctx.rawBody, ctx.secret);
      return timingSafeCompare(sig, expected);
    },
    process: opts.process,
  };
}

/**
 * Create and register a provider that uses HMAC-SHA256 base64 signature verification.
 * @deprecated Use createHmacSha256Base64Provider + registerProviders for batch registration.
 */
export function registerHmacSha256Base64Provider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  stripPrefix?: boolean;
}): WebhookProvider {
  const provider = createHmacSha256Base64Provider(opts);
  registerProvider(provider);
  return provider;
}

/**
 * Create a provider that uses Slack's v0 signature scheme (without registering).
 * v0={HMAC-SHA256 of "v0:{timestamp}:{body}"} with timestamp freshness check.
 */
export function createSlackStyleProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  maxAgeSeconds?: number;
}): WebhookProvider {
  return {
    name: opts.name,
    verify(ctx: VerifyContext): boolean {
      const timestamp = ctx.headers?.["timestamp"] ?? "";
      const ts = parseInt(timestamp, 10);
      if (!isTimestampFresh(ts, opts.maxAgeSeconds ?? 300)) return false;

      const baseString = `v0:${timestamp}:${ctx.rawBody}`;
      const computed = `v0=${hmacSha256Hex(baseString, ctx.secret)}`;
      return timingSafeCompare(ctx.signature, computed);
    },
    process: opts.process,
  };
}

/**
 * Create and register a provider that uses Slack's v0 signature scheme.
 * @deprecated Use createSlackStyleProvider + registerProviders for batch registration.
 */
export function registerSlackStyleProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  maxAgeSeconds?: number;
}): WebhookProvider {
  const provider = createSlackStyleProvider(opts);
  registerProvider(provider);
  return provider;
}

/**
 * Create a provider that uses Twilio's signature scheme (without registering).
 * HMAC-SHA1 of URL + sorted POST params, base64 encoded.
 */
export function createTwilioStyleProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
}): WebhookProvider {
  return {
    name: opts.name,
    verify(ctx: VerifyContext): boolean {
      if (!ctx.url || !ctx.params) return false;

      const sortedKeys = Object.keys(ctx.params).sort();
      let data = ctx.url;
      for (const key of sortedKeys) {
        data += key + ctx.params[key];
      }
      const expected = hmacSha1Base64(data, ctx.secret);
      return timingSafeCompare(ctx.signature, expected);
    },
    process: opts.process,
  };
}

/**
 * Create and register a provider that uses Twilio's signature scheme.
 * @deprecated Use createTwilioStyleProvider + registerProviders for batch registration.
 */
export function registerTwilioStyleProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
}): WebhookProvider {
  const provider = createTwilioStyleProvider(opts);
  registerProvider(provider);
  return provider;
}

/**
 * Create a provider that uses Svix-style signature verification (without registering).
 * Used by Resend and other Svix-powered webhook services.
 * HMAC-SHA256 of "{svix-id}.{svix-timestamp}.{rawBody}" with base64-decoded secret.
 */
export function createSvixStyleProvider(opts: {
  name: string;
  process: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>;
  maxAgeSeconds?: number;
}): WebhookProvider {
  return {
    name: opts.name,
    verify(ctx: VerifyContext): boolean {
      const svixId = ctx.headers?.["svix-id"] ?? "";
      const svixTimestamp = ctx.headers?.["svix-timestamp"] ?? "";
      const svixSignature = ctx.signature; // svix-signature header value

      if (!svixId || !svixTimestamp || !svixSignature) return false;

      // Check timestamp freshness
      const ts = parseInt(svixTimestamp, 10);
      if (!isTimestampFresh(ts, opts.maxAgeSeconds ?? 300)) return false;

      // Decode secret: strip "whsec_" prefix if present, then base64-decode
      let secretKey: Buffer;
      try {
        const rawSecret = ctx.secret.startsWith("whsec_")
          ? ctx.secret.slice(6)
          : ctx.secret;
        secretKey = Buffer.from(rawSecret, "base64");
      } catch {
        return false;
      }

      // Compute expected signature
      const signPayload = `${svixId}.${svixTimestamp}.${ctx.rawBody}`;
      const computed = crypto
        .createHmac("sha256", secretKey)
        .update(signPayload)
        .digest("base64");

      // Compare against each space-separated signature group ("v1,<base64>")
      const sigGroups = svixSignature.split(" ");
      for (const group of sigGroups) {
        const commaIdx = group.indexOf(",");
        if (commaIdx === -1) continue;
        const version = group.slice(0, commaIdx);
        const candidate = group.slice(commaIdx + 1);
        if (version === "v1" && timingSafeCompare(candidate, computed)) {
          return true;
        }
      }

      return false;
    },
    process: opts.process,
  };
}

// ── Re-export from retry.ts for backward compatibility ───────────────────────

export { withRetryHandler } from "./retry.js";

// ── Logging helper ───────────────────────────────────────────────────────────

/**
 * Log a webhook event and delegate to a handler.
 * Adds structured logging before and after processing.
 */
export function withLogging(
  source: string,
  fn: (
    payload: unknown,
    ctx?: Record<string, unknown>,
  ) => Promise<WebhookResult>,
): (
  payload: unknown,
  ctx?: Record<string, unknown>,
) => Promise<WebhookResult> {
  return async (payload, ctx) => {
    logActivity({
      source: "system",
      summary: `Webhook received: ${source}`,
    });

    const result = await fn(payload, ctx);

    if (!result.handled) {
      logActivity({
        source: "system",
        summary: `Webhook not handled (${source}): ${result.message}`,
      });
    }

    return result;
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
