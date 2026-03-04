/**
 * Signature verification utilities for webhooks.
 *
 * Provides cryptographic primitives and timing-safe comparison
 * used by all webhook providers for request authentication.
 */

import * as crypto from "node:crypto";

// ── HMAC digest helpers ──────────────────────────────────────────────────────

/**
 * HMAC-SHA256 hex digest. Used by Linear and similar services.
 */
export function hmacSha256Hex(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * HMAC-SHA256 base64 digest.
 */
export function hmacSha256Base64(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

/**
 * HMAC-SHA1 base64 digest. Used by Twilio.
 */
export function hmacSha1Base64(data: string, secret: string): string {
  return crypto.createHmac("sha1", secret).update(data).digest("base64");
}

// ── Comparison & freshness ───────────────────────────────────────────────────

/**
 * Timing-safe string comparison. Returns false on length mismatch.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false; // Different lengths
  }
}

/**
 * Check that a timestamp is within an acceptable window (replay attack prevention).
 * @param timestamp Unix timestamp in seconds
 * @param maxAgeSeconds Maximum age allowed. Default: 300 (5 minutes).
 */
export function isTimestampFresh(
  timestamp: number,
  maxAgeSeconds = 300,
): boolean {
  if (isNaN(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= maxAgeSeconds;
}

// ── High-level verification schemes ──────────────────────────────────────────

import type { VerifyContext } from "./types.js";

/**
 * Verify an HMAC-SHA256 hex signature (Linear-style).
 * Compares `HMAC-SHA256(rawBody, secret)` against the provided signature.
 */
export function verifyHmacSha256Hex(ctx: VerifyContext): boolean {
  const expected = hmacSha256Hex(ctx.rawBody, ctx.secret);
  return timingSafeCompare(ctx.signature, expected);
}

/**
 * Verify an HMAC-SHA256 base64 signature.
 * Optionally strips a "sha256=" prefix (GitHub-style).
 */
export function verifyHmacSha256Base64(
  ctx: VerifyContext,
  stripPrefix = false,
): boolean {
  const sig = stripPrefix
    ? ctx.signature.replace(/^sha256=/, "")
    : ctx.signature;
  const expected = hmacSha256Base64(ctx.rawBody, ctx.secret);
  return timingSafeCompare(sig, expected);
}

/**
 * Verify a Slack v0 signature.
 * Format: `v0={HMAC-SHA256("v0:{timestamp}:{body}", secret)}`
 * Also validates timestamp freshness.
 */
export function verifySlackV0(
  ctx: VerifyContext,
  maxAgeSeconds = 300,
): boolean {
  const timestamp = ctx.headers?.["timestamp"] ?? "";
  const ts = parseInt(timestamp, 10);
  if (!isTimestampFresh(ts, maxAgeSeconds)) return false;

  const baseString = `v0:${timestamp}:${ctx.rawBody}`;
  const computed = `v0=${hmacSha256Hex(baseString, ctx.secret)}`;
  return timingSafeCompare(ctx.signature, computed);
}

/**
 * Verify a Svix-style signature (used by Resend).
 * Secret is base64-encoded (with optional "whsec_" prefix).
 * Sign string: "{svix-id}.{svix-timestamp}.{rawBody}"
 * HMAC-SHA256, base64-encoded result. Multiple comma-separated sigs in header (v1,... prefix).
 * Any match = valid. Also checks timestamp freshness.
 */
export function verifySvix(
  ctx: VerifyContext,
  maxAgeSeconds = 300,
): boolean {
  const svixId = ctx.headers?.["svix-id"] ?? "";
  const svixTimestamp = ctx.headers?.["svix-timestamp"] ?? "";
  const svixSignature = ctx.signature; // svix-signature header value

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Check timestamp freshness
  const ts = parseInt(svixTimestamp, 10);
  if (!isTimestampFresh(ts, maxAgeSeconds)) return false;

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
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(signPayload)
    .digest("base64");

  // Compare against each comma-separated signature (strip "v1," prefix)
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const parts = sig.split(",");
    // Format: "v1,<base64>" — we only support v1
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith("v1,")) {
        const candidate = trimmed.slice(3);
        if (timingSafeCompare(candidate, expected)) return true;
      } else if (parts.length === 2 && parts[0] === "v1") {
        // "v1,<base64>" split by comma gives ["v1", "<base64>"]
        if (timingSafeCompare(parts[1], expected)) return true;
        break;
      }
    }
  }

  return false;
}

/**
 * Verify a Twilio signature.
 * HMAC-SHA1 of URL + sorted POST params, base64 encoded.
 */
export function verifyTwilio(ctx: VerifyContext): boolean {
  if (!ctx.url || !ctx.params) return false;

  const sortedKeys = Object.keys(ctx.params).sort();
  let data = ctx.url;
  for (const key of sortedKeys) {
    data += key + ctx.params[key];
  }
  const expected = hmacSha1Base64(data, ctx.secret);
  return timingSafeCompare(ctx.signature, expected);
}
