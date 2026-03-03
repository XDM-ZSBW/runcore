/**
 * Relay webhook verification and processing.
 *
 * Handles incoming messages relayed from the Cloudflare Worker (whatsapp-relay).
 * The Worker has already verified the Twilio signature — this module verifies
 * the relay's own HMAC-SHA256 signature to ensure the request is authentic.
 *
 * Relay signature scheme:
 *   HMAC-SHA256("{timestamp}.{body}", RELAY_SECRET) → hex
 *   Sent in X-Relay-Signature header, timestamp in X-Relay-Timestamp.
 *   Replays rejected if timestamp is older than 5 minutes.
 */

import { hmacSha256Hex, timingSafeCompare, isTimestampFresh } from "./verify.js";
import { logActivity } from "../activity/log.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum age (seconds) for relay timestamps. Default: 300 (5 min). */
const MAX_RELAY_TIMESTAMP_AGE = 300;

// ── Verification ─────────────────────────────────────────────────────────────

export interface RelayVerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify a relay request from the Cloudflare Worker.
 *
 * @param rawBody   The raw request body (URL-encoded form data)
 * @param headers   Request headers (lowercase keys)
 * @param secret    The shared relay secret (RELAY_SECRET env var)
 */
export function verifyRelaySignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): RelayVerifyResult {
  if (!secret) {
    return { valid: false, error: "RELAY_SECRET not configured" };
  }

  const signature = headers["x-relay-signature"];
  if (!signature) {
    return { valid: false, error: "Missing X-Relay-Signature header" };
  }

  const timestamp = headers["x-relay-timestamp"];
  if (!timestamp) {
    return { valid: false, error: "Missing X-Relay-Timestamp header" };
  }

  const ts = parseInt(timestamp, 10);
  if (!isTimestampFresh(ts, MAX_RELAY_TIMESTAMP_AGE)) {
    return { valid: false, error: "Relay timestamp expired or invalid" };
  }

  // The Worker signs: "{timestamp}.{body}"
  const payload = `${timestamp}.${rawBody}`;
  const expected = hmacSha256Hex(payload, secret);

  if (!timingSafeCompare(signature, expected)) {
    return { valid: false, error: "Invalid relay signature" };
  }

  logActivity({
    source: "system",
    summary: "Relay webhook verified (whatsapp-relay worker)",
  });

  return { valid: true };
}
