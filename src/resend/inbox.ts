/**
 * Resend inbound email inbox — pull-on-activity pattern.
 *
 * Instead of a timer, Core checks for pending emails whenever it's
 * already doing work. The check is debounced: at most once every 2 minutes.
 * Emails are pulled from the Cloudflare Worker's KV-backed inbox,
 * processed through the Brain pipeline, and acknowledged.
 *
 * Call `checkResendInbox()` from any activity hook — it's cheap when
 * there's nothing to do (single GET, empty array).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { processInboundEmail, sendResendReply } from "./webhooks.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("resend.inbox");

/** Minimum interval between inbox checks (ms). */
const CHECK_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes

/** Last time we checked the inbox. */
let lastCheckAt = 0;

/** Whether a check is currently in flight (prevents overlapping). */
let checking = false;

/** Resolved worker URL (cached after first call). */
let workerUrl: string | null = null;

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

interface InboxResponse {
  emails: InboxEmail[];
  count: number;
}

interface AgentEntry {
  address: string;
  label: string;
}

interface AgentRegistry {
  agents: Record<string, AgentEntry>;
  catchAll: string;
  humanNotifyEmail: string | null;
}

let agentRegistryCache: AgentRegistry | null = null;

async function loadAgentRegistry(): Promise<AgentRegistry> {
  if (agentRegistryCache) return agentRegistryCache;
  try {
    const raw = await readFile(
      join(BRAIN_DIR, "identity", "email-agents.json"),
      "utf-8",
    );
    agentRegistryCache = JSON.parse(raw) as AgentRegistry;
    return agentRegistryCache;
  } catch {
    // Fallback — single default agent
    return {
      agents: { agent: { address: "agent@pqrsystems.com", label: "Core" } },
      catchAll: "agent",
      humanNotifyEmail: null,
    };
  }
}

function resolveAgent(
  registry: AgentRegistry,
  toAddresses: string[],
): AgentEntry {
  for (const addr of toAddresses) {
    const local = addr.toLowerCase().split("@")[0];
    if (registry.agents[local]) return registry.agents[local];
  }
  // Catch-all
  return registry.agents[registry.catchAll] ?? { address: "agent@pqrsystems.com", label: "Core" };
}

function getWorkerUrl(): string | null {
  if (workerUrl !== null) return workerUrl;
  const url = process.env.RESEND_WORKER_URL;
  if (!url) return null;
  workerUrl = url.replace(/\/$/, "");
  return workerUrl;
}

function getRelaySecret(): string | null {
  return process.env.RELAY_SECRET || null;
}

/**
 * Check the Resend Worker inbox for pending emails.
 * Debounced — returns immediately if checked recently.
 * Safe to call frequently from any activity path.
 */
export async function checkResendInbox(): Promise<void> {
  // Debounce
  const now = Date.now();
  if (now - lastCheckAt < CHECK_DEBOUNCE_MS) return;
  if (checking) return;

  const url = getWorkerUrl();
  const secret = getRelaySecret();
  if (!url || !secret) return; // Not configured — silently skip

  checking = true;
  lastCheckAt = now;

  try {
    // Pull pending emails
    const res = await fetch(`${url}/api/resend/inbox`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log.warn("Inbox check failed", { status: res.status });
      return;
    }

    const data = (await res.json()) as InboxResponse;
    if (data.count === 0) return;

    log.info(`${data.count} pending email(s) in inbox`);

    // Process each email
    for (const email of data.emails) {
      try {
        await processEmail(email, url, secret);
      } catch (err) {
        log.error("Failed to process inbox email", {
          id: email.id,
          from: email.from,
          error: String(err),
        });
      }
    }
  } catch (err) {
    // Network error, Worker down, etc. — not critical, try next time
    log.debug("Inbox check error", { error: String(err) });
  } finally {
    checking = false;
  }
}

async function processEmail(
  email: InboxEmail,
  workerUrl: string,
  secret: string,
): Promise<void> {
  if (!email.body?.trim()) {
    // Empty email — just ack it
    await ackEmail(email.id, workerUrl, secret);
    return;
  }

  // Resolve which agent identity should handle this email
  const registry = await loadAgentRegistry();
  const agent = resolveAgent(registry, email.to);

  logActivity({
    source: "resend",
    summary: `Processing inbound email from ${email.from} → ${agent.label}: "${email.subject}"`,
  });

  const reply = await processInboundEmail({
    from: email.from,
    subject: email.subject,
    body: email.body,
    date: email.created_at || email.received_at,
    agentName: agent.label,
  });

  if (reply) {
    const sent = await sendResendReply({
      to: email.from,
      subject: email.subject,
      body: reply,
      inReplyTo: email.message_id,
      from: `${agent.label} <${agent.address}>`,
    });

    logActivity({
      source: "resend",
      summary: sent
        ? `${agent.label} replied to ${email.from}: "${email.subject}" (${reply.length} chars)`
        : `${agent.label} failed to reply to ${email.from}: "${email.subject}"`,
    });
  }

  // Acknowledge — remove from Worker KV regardless of reply success
  await ackEmail(email.id, workerUrl, secret);
}

async function ackEmail(
  id: string,
  workerUrl: string,
  secret: string,
): Promise<void> {
  try {
    await fetch(`${workerUrl}/api/resend/inbox/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log.warn("Failed to ack email", { id, error: String(err) });
  }
}

/**
 * Force an immediate inbox check, bypassing the debounce.
 * Useful for manual triggers (e.g., "check email" command).
 */
export async function forceCheckResendInbox(): Promise<number> {
  lastCheckAt = 0;
  checking = false;

  const url = getWorkerUrl();
  const secret = getRelaySecret();
  if (!url || !secret) return 0;

  // Quick count check before full processing
  try {
    const res = await fetch(`${url}/api/resend/inbox`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as InboxResponse;
    if (data.count === 0) return 0;

    await checkResendInbox();
    return data.count;
  } catch {
    return 0;
  }
}
