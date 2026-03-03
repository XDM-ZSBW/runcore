/**
 * Twilio webhook signature verification and WhatsApp message processing.
 * Follows src/slack/webhooks.ts + src/linear/webhooks.ts patterns.
 *
 * Webhook setup: Configure in Twilio Console → Messaging → WhatsApp sandbox/sender.
 * URL: https://<your-domain>/api/twilio/whatsapp
 * Method: POST
 *
 * Twilio sends:
 * - X-Twilio-Signature: HMAC-SHA1 of URL + sorted POST params
 * - POST body: URL-encoded form data (From, To, Body, MessageSid, etc.)
 */

import { logActivity } from "../activity/log.js";
import { getClient } from "../channels/whatsapp.js";
import { hmacSha1Base64, timingSafeCompare } from "./registry.js";
import { createTwilioStyleProvider, safeHandler } from "./handlers.js";

// ── Twilio webhook payload types ─────────────────────────────────────────────

export interface TwilioWhatsAppPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;       // "whatsapp:+1234567890"
  To: string;         // "whatsapp:+0987654321"
  Body: string;
  NumMedia: string;
  NumSegments: string;
  SmsStatus: string;
  ApiVersion: string;
  ProfileName?: string;
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Verify a Twilio webhook signature.
 * https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Twilio signs requests with HMAC-SHA1:
 * 1. Start with the full webhook URL
 * 2. Sort POST params alphabetically by key
 * 3. Append each key+value (no separators)
 * 4. HMAC-SHA1 the result with the auth token
 * 5. Base64-encode the digest
 *
 * Uses generic signature helpers from webhooks/registry.
 */
export function verifySignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  // Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = hmacSha1Base64(data, authToken);
  return timingSafeCompare(signature, expected);
}

/**
 * Parse URL-encoded form body into a key-value record.
 */
export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = body.split("&");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
    const value = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
    params[key] = value;
  }
  return params;
}

/**
 * Strip the "whatsapp:" prefix from a Twilio WhatsApp number.
 */
function stripWhatsAppPrefix(number: string): string {
  return number.replace(/^whatsapp:/, "");
}

// ── Message processing ───────────────────────────────────────────────────────

/**
 * Process an incoming WhatsApp message from Twilio.
 * Stores in message history and updates contacts.
 * Returns structured result, never throws.
 */
export async function processIncomingMessage(
  payload: TwilioWhatsAppPayload,
): Promise<{ handled: boolean; message: string }> {
  const from = stripWhatsAppPrefix(payload.From);
  const to = stripWhatsAppPrefix(payload.To);
  const body = payload.Body?.trim() ?? "";

  if (!body) {
    return { handled: true, message: "Empty message, skipped" };
  }

  logActivity({
    source: "whatsapp",
    summary: `WhatsApp from ${from}: "${body.slice(0, 80)}"`,
    detail: `sid=${payload.MessageSid} profileName=${payload.ProfileName ?? "unknown"}`,
  });

  // Store inbound message in history
  const client = getClient();
  if (client) {
    await client.appendHistory({
      sid: payload.MessageSid,
      from,
      to,
      body,
      direction: "inbound",
      timestamp: new Date().toISOString(),
    });

    // Update contact with sender info
    await client.upsertContact({
      phone: from,
      name: payload.ProfileName,
      lastMessageAt: new Date().toISOString(),
    });
  }

  return { handled: true, message: `Received from ${from}: "${body.slice(0, 40)}"` };
}

/**
 * Generate an empty TwiML response (acknowledge receipt without replying).
 * Twilio requires a valid TwiML response to avoid retries.
 */
export function emptyTwimlResponse(): string {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>";
}

/**
 * Generate a TwiML response with a reply message.
 */
export function replyTwiml(message: string): string {
  // Escape XML entities to prevent injection
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

// ── Registry integration ────────────────────────────────────────────────────

/** Twilio/WhatsApp webhook provider (deferred registration). */
export const twilioProvider = createTwilioStyleProvider({
  name: "twilio",
  process: safeHandler("twilio", async (payload) => {
    return processIncomingMessage(payload as TwilioWhatsAppPayload);
  }),
});
