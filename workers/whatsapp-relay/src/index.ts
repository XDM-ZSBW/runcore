/**
 * Cloudflare Worker: WhatsApp Relay
 *
 * Receives Twilio WhatsApp webhook events at the edge, verifies the
 * Twilio HMAC-SHA1 signature, and relays the payload to the Dash server.
 * Returns TwiML to Twilio immediately so the 15-second response window
 * is never exceeded — the Dash server processes and replies asynchronously
 * via the Twilio REST API.
 *
 * Architecture:
 *   WhatsApp User → Twilio → [this Worker] → Dash Server → Brain/LLM → Twilio API → User
 *
 * Environment bindings (set via `wrangler secret put`):
 *   TWILIO_AUTH_TOKEN  — Twilio auth token for signature verification
 *   RELAY_SECRET       — Shared secret between this Worker and the Dash server
 *   DASH_SERVER_URL    — Origin of the Dash server (e.g. https://dash.example.com)
 */

export interface Env {
  TWILIO_AUTH_TOKEN: string;
  RELAY_SECRET: string;
  DASH_SERVER_URL: string;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "whatsapp-relay" });
    }

    // Only accept POST to the webhook path
    if (request.method !== "POST" || url.pathname !== "/api/twilio/whatsapp") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const rawBody = await request.text();

      // ── Verify Twilio signature ─────────────────────────────────────────
      const twilioSignature = request.headers.get("x-twilio-signature") ?? "";
      if (!twilioSignature) {
        return new Response("Missing signature", { status: 401 });
      }

      // Build the full URL Twilio used to compute the signature.
      // Twilio signs against the URL as configured in the console, which
      // should match this Worker's public URL.
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      const host = request.headers.get("host") ?? url.host;
      const webhookUrl = `${proto}://${host}/api/twilio/whatsapp`;

      const params = parseFormBody(rawBody);
      const valid = await verifyTwilioSignature(
        webhookUrl,
        params,
        twilioSignature,
        env.TWILIO_AUTH_TOKEN,
      );

      if (!valid) {
        return new Response("Invalid signature", { status: 401 });
      }

      // ── Relay to Dash server ────────────────────────────────────────────
      // Fire-and-forget via waitUntil: respond to Twilio immediately with
      // empty TwiML and let the Dash server process + reply via Twilio API.
      const relayUrl = `${env.DASH_SERVER_URL.replace(/\/$/, "")}/api/relay/whatsapp`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const relaySig = await computeRelaySignature(
        timestamp + "." + rawBody,
        env.RELAY_SECRET,
      );

      const relayPromise = fetch(relayUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Relay-Signature": relaySig,
          "X-Relay-Timestamp": timestamp,
        },
        body: rawBody,
        signal: AbortSignal.timeout(14_000),
      }).catch((err) => {
        console.error("Relay failed:", err);
      });

      ctx.waitUntil(relayPromise);

      // ── Respond to Twilio with empty TwiML ──────────────────────────────
      return new Response(EMPTY_TWIML, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    } catch (err) {
      console.error("WhatsApp relay error:", err);
      // Always return valid TwiML so Twilio doesn't retry
      return new Response(EMPTY_TWIML, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
  },
} satisfies ExportedHandler<Env>;

// ── Twilio signature verification (Web Crypto API) ──────────────────────────

/**
 * Verify a Twilio webhook signature using the Web Crypto API.
 * Twilio signs: HMAC-SHA1( URL + sorted(key+value pairs), authToken )
 * then base64-encodes the result.
 */
async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): Promise<boolean> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return timingSafeEqual(signature, expected);
}

/**
 * Compute a relay HMAC-SHA256 hex signature for the Dash server.
 * Signs: "{timestamp}.{body}" with the shared relay secret.
 */
async function computeRelaySignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse URL-encoded form body into key-value pairs. */
function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
    const value = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
    params[key] = value;
  }
  return params;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    b = a; // compare against self to maintain constant time
  }
  let mismatch = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
