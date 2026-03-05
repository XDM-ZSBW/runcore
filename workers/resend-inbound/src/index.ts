/**
 * Cloudflare Worker: Resend Inbound Email
 *
 * Receives Resend webhook events at the edge, verifies the Svix signature,
 * fetches the full email body from Resend API, and stores in KV for Core
 * to pull on its next activity cycle. No tunnel required — Core pulls
 * when it's awake and doing work.
 *
 * Architecture:
 *   Sender → Resend MX → Resend → [this Worker] → KV
 *   Core (on activity) → GET /inbox → processes → replies via Resend API
 *
 * Endpoints:
 *   POST /api/resend/webhooks  — Resend webhook (Svix-signed)
 *   GET  /inbox                — Core pulls pending emails (RELAY_SECRET auth)
 *   DELETE /inbox/:id          — Core acknowledges processed email
 *   GET  /health               — Health check
 *
 * Environment bindings (set via `wrangler secret put`):
 *   RESEND_API_KEY         — Resend API key for fetching email content
 *   RESEND_WEBHOOK_SECRET  — Svix signing secret from Resend dashboard
 *   RELAY_SECRET           — Shared secret for Core ↔ Worker auth
 *
 * KV namespace binding (in wrangler.toml):
 *   INBOX — KV namespace for pending emails
 */

export interface Env {
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  RELAY_SECRET: string;
  INBOX: KVNamespace;
}

/** TTL for emails in KV: 24 hours. Unprocessed emails expire. */
const EMAIL_TTL_SECONDS = 86_400;

/** KV key prefix for inbox emails. */
const INBOX_PREFIX = "email:";

/** KV key for the inbox index (list of pending email IDs). */
const INDEX_KEY = "inbox:index";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "resend-inbound" });
    }

    // ── Resend webhook endpoint ───────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/resend/webhooks") {
      return handleWebhook(request, env);
    }

    // ── Inbox endpoints (Core pulls these) ────────────────────────────────
    if (url.pathname === "/api/resend/inbox" || url.pathname.startsWith("/api/resend/inbox/")) {
      // Authenticate with RELAY_SECRET
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${env.RELAY_SECRET}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (request.method === "GET" && url.pathname === "/api/resend/inbox") {
        return handleInboxList(env);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/resend/inbox/")) {
        const id = url.pathname.slice("/api/resend/inbox/".length);
        return handleInboxAck(id, env);
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Webhook handler ─────────────────────────────────────────────────────────

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const rawBody = await request.text();

    // Verify Svix signature
    const svixId = request.headers.get("svix-id") ?? "";
    const svixTimestamp = request.headers.get("svix-timestamp") ?? "";
    const svixSignature = request.headers.get("svix-signature") ?? "";

    if (!svixId || !svixTimestamp || !svixSignature) {
      return Response.json({ error: "Missing Svix headers" }, { status: 401 });
    }

    const valid = await verifySvixSignature(
      svixId, svixTimestamp, rawBody, svixSignature, env.RESEND_WEBHOOK_SECRET,
    );

    if (!valid) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Parse payload
    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (event.type !== "email.received") {
      return Response.json({ ok: true, message: `Ignored event: ${event.type}` });
    }

    const { email_id, from, to, subject, message_id, created_at } = event.data;

    // Fetch full email content from Resend API
    const content = await fetchEmailContent(email_id, env.RESEND_API_KEY);

    // Build inbox entry
    const inboxEntry: InboxEmail = {
      id: email_id,
      from,
      to,
      subject,
      message_id,
      created_at,
      body: content?.text || content?.html?.replace(/<[^>]+>/g, " ") || "",
      html: content?.html || "",
      received_at: new Date().toISOString(),
    };

    // Store in KV
    await env.INBOX.put(
      `${INBOX_PREFIX}${email_id}`,
      JSON.stringify(inboxEntry),
      { expirationTtl: EMAIL_TTL_SECONDS },
    );

    // Update index (append email_id)
    await appendToIndex(env, email_id);

    return Response.json({
      ok: true,
      message: `Stored email from ${from}: "${subject}"`,
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return Response.json({ ok: false, error: "Internal error" }, { status: 200 });
  }
}

// ── Inbox list: Core pulls pending emails ───────────────────────────────────

async function handleInboxList(env: Env): Promise<Response> {
  const index = await getIndex(env);
  if (index.length === 0) {
    return Response.json({ emails: [], count: 0 });
  }

  // Fetch all pending emails from KV
  const emails: InboxEmail[] = [];
  const staleIds: string[] = [];

  for (const id of index) {
    const raw = await env.INBOX.get(`${INBOX_PREFIX}${id}`);
    if (raw) {
      try {
        emails.push(JSON.parse(raw));
      } catch {
        staleIds.push(id);
      }
    } else {
      // Expired or already deleted
      staleIds.push(id);
    }
  }

  // Clean stale entries from index
  if (staleIds.length > 0) {
    const cleaned = index.filter((id) => !staleIds.includes(id));
    await env.INBOX.put(INDEX_KEY, JSON.stringify(cleaned));
  }

  return Response.json({ emails, count: emails.length });
}

// ── Inbox ack: Core confirms it processed an email ──────────────────────────

async function handleInboxAck(id: string, env: Env): Promise<Response> {
  // Remove from KV
  await env.INBOX.delete(`${INBOX_PREFIX}${id}`);

  // Remove from index
  const index = await getIndex(env);
  const updated = index.filter((eid) => eid !== id);
  await env.INBOX.put(INDEX_KEY, JSON.stringify(updated));

  return Response.json({ ok: true, message: `Acknowledged ${id}` });
}

// ── KV index helpers ────────────────────────────────────────────────────────

async function getIndex(env: Env): Promise<string[]> {
  const raw = await env.INBOX.get(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function appendToIndex(env: Env, emailId: string): Promise<void> {
  const index = await getIndex(env);
  if (!index.includes(emailId)) {
    index.push(emailId);
    await env.INBOX.put(INDEX_KEY, JSON.stringify(index));
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ResendWebhookEvent {
  type: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    message_id: string;
    created_at: string;
    attachments?: Array<{ filename: string; content_type: string }>;
  };
}

interface ResendEmailContent {
  html?: string;
  text?: string;
  headers?: Array<{ name: string; value: string }>;
  raw?: string;
}

interface InboxEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  message_id: string;
  created_at: string;
  body: string;
  html: string;
  received_at: string;
}

// ── Svix signature verification (Web Crypto API) ────────────────────────────

async function verifySvixSignature(
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  const ts = parseInt(svixTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 300) return false;

  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: ArrayBuffer;
  try {
    keyBytes = base64ToArrayBuffer(rawSecret);
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const signPayload = `${svixId}.${svixTimestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signPayload));
  const expected = arrayBufferToBase64(sig);

  const groups = svixSignature.split(" ");
  for (const group of groups) {
    const commaIdx = group.indexOf(",");
    if (commaIdx === -1) continue;
    const version = group.slice(0, commaIdx);
    const candidate = group.slice(commaIdx + 1);
    if (version === "v1" && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }

  return false;
}

// ── Resend API ──────────────────────────────────────────────────────────────

async function fetchEmailContent(
  emailId: string,
  apiKey: string,
): Promise<ResendEmailContent | null> {
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Resend API error: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json() as ResendEmailContent;
  } catch (err) {
    console.error("Failed to fetch email content:", err);
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    b = a;
  }
  let mismatch = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
