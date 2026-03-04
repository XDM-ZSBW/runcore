/**
 * Resend inbound email webhook provider.
 *
 * Handles email.received events from Resend via Svix-signed webhooks.
 * Fetches full email body from Resend API, processes through the email Brain
 * pipeline, and replies via Resend API with proper threading headers.
 */

import { createSvixStyleProvider, safeHandler } from "../webhooks/handlers.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { Brain } from "../brain.js";
import { FileSystemLongTermMemory } from "../memory/file-backed.js";
import { getInstanceName } from "../instance.js";
import { getProvider as getLLMProvider } from "../llm/providers/index.js";
import { resolveProvider, resolveChatModel } from "../settings.js";
import { readHuman } from "../auth/identity.js";
import { getCapabilityRegistry } from "../capabilities/index.js";

const log = createLogger("resend.webhooks");

const RESEND_API = "https://api.resend.com";
const MEMORY_DIR = "brain/memory";

// ── Resend API types ─────────────────────────────────────────────────────────

/** Resend email.received webhook payload. */
interface ResendEmailReceivedPayload {
  type: "email.received";
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

/** Full email content from Resend receiving API. */
interface ResendEmailContent {
  html?: string;
  text?: string;
  headers?: Array<{ name: string; value: string }>;
  raw?: string;
  attachments?: Array<{
    filename: string;
    content_type: string;
    content: string;
  }>;
}

// ── Resend API helpers ──────────────────────────────────────────────────────

/**
 * Fetch the full email content from Resend's receiving API.
 * The webhook only includes metadata — the body must be fetched separately.
 */
async function fetchEmailContent(
  emailId: string,
): Promise<ResendEmailContent | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("RESEND_API_KEY not set — cannot fetch email content");
    return null;
  }

  try {
    const res = await fetch(`${RESEND_API}/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      log.error("Resend API error fetching email", {
        emailId,
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }

    return (await res.json()) as ResendEmailContent;
  } catch (err) {
    log.error("Failed to fetch email from Resend", {
      emailId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Send a reply via Resend API with proper threading headers.
 */
export async function sendResendReply(opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("RESEND_API_KEY not set — cannot send reply");
    return false;
  }

  const from = `${getInstanceName()} <agent@pqrsystems.com>`;

  const payload: Record<string, unknown> = {
    from,
    to: [opts.to],
    subject: opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`,
    text: opts.body,
  };

  // Threading headers
  if (opts.inReplyTo) {
    payload.headers = {
      "In-Reply-To": opts.inReplyTo,
      References: opts.inReplyTo,
    };
  }

  try {
    const res = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error("Resend send failed", {
        status: res.status,
        to: opts.to,
        error: text,
      });
      return false;
    }

    log.info("Resend reply sent", { to: opts.to, subject: opts.subject });
    return true;
  } catch (err) {
    log.error("Resend send exception", { to: opts.to, error: String(err) });
    return false;
  }
}

// ── Email processing (shared Brain pipeline) ────────────────────────────────

/**
 * Process an inbound email through the Brain + LLM + capability pipeline.
 * Reuses the same logic as the Gmail email handler in server.ts.
 */
export async function processInboundEmail(opts: {
  from: string;
  subject: string;
  body: string;
  date: string;
}): Promise<string | null> {
  const human = await readHuman();
  const name = human?.name ?? "Human";

  if (!opts.body.trim()) return null;

  // Build a lightweight Brain for email context
  const ltm = new FileSystemLongTermMemory(MEMORY_DIR);
  await ltm.init();
  const emailBrain = new Brain(
    {
      systemPrompt: [
        `You are ${getInstanceName()}, a personal AI agent paired with ${name}. You run locally on ${name}'s machine.`,
        `You are responding to an email that was sent to you at agent@pqrsystems.com. This is a working email channel — you received this email and your reply will be sent back automatically.`,
        ``,
        `Your capabilities — USE THEM when the email requests action:`,
        `- Google Calendar: CREATE, UPDATE, DELETE events using [CALENDAR_ACTION] blocks.`,
        `- Gmail: SEND emails and REPLY to threads using [EMAIL_ACTION] blocks.`,
        `- Google Docs & Sheets: CREATE documents using [DOC_ACTION] blocks.`,
        `- Task board for tracking work.`,
        `- Long-term memory of past conversations and learned facts.`,
        ``,
        ...(getCapabilityRegistry()?.getPromptInstructions({ origin: "email", name }) ?? "").split("\n"),
        ``,
        `Rules for email replies:`,
        `- Write a natural, helpful reply as plain text (no markdown).`,
        `- Be warm and direct — you have personality, you're not a corporate assistant.`,
        `- Keep it concise and appropriate for email.`,
        `- Do not include a subject line. Just write the body of the reply.`,
        `- NEVER claim you can't do something you clearly just did (you ARE sending this email).`,
        `- When someone asks you to DO something (schedule, create, send), DO IT with the appropriate action block — don't just acknowledge it.`,
        `- Action blocks will be stripped from the email reply automatically. The recipient only sees your text.`,
        `- Sign off as "— ${getInstanceName()}"`,
      ].join("\n"),
    },
    ltm,
  );

  const ctx = await emailBrain.getContextForTurn({
    userInput: opts.body,
    conversationHistory: [],
  });

  // Inject email metadata so the agent knows the context
  ctx.messages.splice(1, 0, {
    role: "system" as const,
    content: [
      `--- Incoming email ---`,
      `From: ${opts.from}`,
      `Subject: ${opts.subject}`,
      `Date: ${opts.date}`,
      `--- End email metadata ---`,
    ].join("\n"),
  });

  // Add the email body as the "user" message
  ctx.messages.push({ role: "user", content: opts.body });

  const provider = getLLMProvider(resolveProvider());
  const model = resolveChatModel();
  let reply = await provider.completeChat(ctx.messages, model ?? undefined);

  if (!reply?.trim()) return null;

  // Process action blocks from the AI response via capability registry
  const capReg = getCapabilityRegistry();
  if (capReg) {
    const { cleaned } = await capReg.processResponse(reply, { origin: "email", name });
    reply = cleaned;
  }

  // Guard: if stripping action blocks left only a signature, don't send
  const signaturePattern = new RegExp(
    `[\\s\\n]*[—\\-]+\\s*${getInstanceName()}[\\s.!]*$`,
    "i",
  );
  const withoutSignature = reply.replace(signaturePattern, "").trim();
  if (!withoutSignature) {
    log.warn("Email reply was empty after stripping action blocks — not sending", {
      from: opts.from,
      subject: opts.subject,
    });
    return null;
  }

  return reply.trim();
}

// ── Webhook provider ─────────────────────────────────────────────────────────

export const resendProvider = createSvixStyleProvider({
  name: "resend",
  process: safeHandler("resend", async (payload) => {
    const event = payload as ResendEmailReceivedPayload;

    if (event?.type !== "email.received") {
      return {
        handled: false,
        message: `Unhandled event type: ${(event as { type?: string })?.type ?? "unknown"}`,
      };
    }

    const { email_id, from, subject, message_id, created_at } = event.data;

    log.info("Resend inbound email received", { email_id, from, subject });

    logActivity({
      source: "resend",
      summary: `Inbound email from ${from}: "${subject}"`,
    });

    // Fetch full email content (webhook only has metadata)
    const content = await fetchEmailContent(email_id);
    if (!content) {
      return {
        handled: false,
        message: `Failed to fetch email content for ${email_id}`,
      };
    }

    const body = content.text || content.html?.replace(/<[^>]+>/g, " ") || "";
    if (!body.trim()) {
      return { handled: true, message: "Empty email body — skipped" };
    }

    // Process through Brain pipeline
    const reply = await processInboundEmail({
      from,
      subject,
      body,
      date: created_at || new Date().toISOString(),
    });

    if (!reply) {
      return { handled: true, message: "No reply generated — skipped" };
    }

    // Send reply via Resend with threading
    const sent = await sendResendReply({
      to: from,
      subject,
      body: reply,
      inReplyTo: message_id,
    });

    logActivity({
      source: "resend",
      summary: sent
        ? `Replied to ${from}: "${subject}" (${reply.length} chars)`
        : `Failed to reply to ${from}: "${subject}"`,
    });

    return {
      handled: true,
      message: sent
        ? `Processed and replied to email from ${from}`
        : `Processed email from ${from} but reply send failed`,
    };
  }),
});
