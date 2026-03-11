/**
 * Email capability — send and reply via Gmail.
 * Includes placeholder threadId/inReplyTo sanitization.
 */

import { logActivity } from "../../activity/log.js";

// Lazy-loaded byok-tier module
let _gmailSend: typeof import("../../google/gmail-send.js") | null = null;
async function getGmailSend() {
  if (!_gmailSend) { try { _gmailSend = await import("../../google/gmail-send.js"); } catch { _gmailSend = null; } }
  return _gmailSend;
}
import { pushNotification } from "../../goals/notifications.js";
import { getInstanceName } from "../../instance.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult } from "../types.js";

/** Regex that catches common placeholder/hallucinated threadId values. */
const PLACEHOLDER_RE = /placeholder|from.context|example|<use real/i;

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

const reason = (ctx: ActionContext) => {
  switch (ctx.origin) {
    case "email": return `${getInstanceName()} email triggered send`;
    case "autonomous": return "planner sent email";
    default: return "AI sent email via chat";
  }
};

export const emailCapability: ActionBlockCapability = {
  id: "email",
  pattern: "action",
  tag: "EMAIL_ACTION",
  keywords: ["email", "send", "inbox", "reply", "notify", "gmail", "message"],

  getPromptInstructions(ctx) {
    const name = ctx.name ?? "the user";
    return [
      `## Gmail (send/reply via [EMAIL_ACTION] blocks)`,
      `To send an email or reply to a thread, include an [EMAIL_ACTION] block in your response.`,
      ``,
      `Send a new email:`,
      `[EMAIL_ACTION]`,
      `{"action": "send", "to": "someone@example.com", "subject": "Meeting notes", "body": "Hi,\\n\\nHere are the notes from today's meeting..."}`,
      `[/EMAIL_ACTION]`,
      ``,
      `Reply to a thread (keeps it in the same Gmail conversation):`,
      `[EMAIL_ACTION]`,
      `{"action": "reply", "to": "someone@example.com", "subject": "Re: Meeting notes", "body": "Thanks for the follow-up!", "threadId": "<use real threadId from Gmail data>", "inReplyTo": "<use real Message-ID from Gmail data>"}`,
      `[/EMAIL_ACTION]`,
      ``,
      `Fields: to (email or array), subject, body (plain text). Optional: cc, bcc, threadId (for replies), inReplyTo (Message-ID header of the email being replied to).`,
      `IMPORTANT: For replies, you MUST use real threadId and inReplyTo values from the Gmail data in your context. Do NOT use placeholder values — if you don't have the real IDs, omit threadId/inReplyTo and send as a new email instead.`,
      `Reply in existing threads (when threadId is present) without confirmation — just send and mention what you did. Confirm with ${name} before sending new emails to new recipients.`,
    ].join("\n");
  },

  getPromptOverride(origin) {
    if (origin === "autonomous") {
      return [
        `Send an email:`,
        `[EMAIL_ACTION]`,
        `{"action": "send", "to": "someone@example.com", "subject": "Subject", "body": "Email body"}`,
        `[/EMAIL_ACTION]`,
      ].join("\n");
    }
    // Email handler doesn't include dedicated email instructions (it's already replying)
    return null;
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const req = payload as Record<string, any>;
    const label = actionLabel(ctx);

    if (!req.to || !req.subject || !req.body) {
      return { capabilityId: "email", ok: false, message: "Missing required fields (to, subject, body)" };
    }

    // Sanitize placeholder threadId/inReplyTo values the LLM sometimes hallucinates
    const threadId = req.threadId && !PLACEHOLDER_RE.test(req.threadId) ? req.threadId : undefined;
    const inReplyTo = req.inReplyTo && !PLACEHOLDER_RE.test(req.inReplyTo) ? req.inReplyTo : undefined;

    const gmailSend = await getGmailSend();
    if (!gmailSend) return { capabilityId: "email", ok: false, message: "Gmail send module not available (byok tier required)" };

    const result = await gmailSend.sendEmail({
      to: req.to,
      cc: req.cc,
      bcc: req.bcc,
      subject: req.subject,
      body: req.body,
      threadId,
      inReplyTo,
      references: req.references,
    });

    const toStr = Array.isArray(req.to) ? req.to.join(", ") : req.to;

    if (result.ok) {
      logActivity({ source: "gmail", summary: `Email sent${ctx.origin === "email" ? " via email handler" : ""} to ${toStr}: "${req.subject}"`, actionLabel: label, reason: reason(ctx) });
      if (ctx.origin === "chat") {
        pushNotification({ timestamp: new Date().toISOString(), source: "gmail", message: `Email sent to **${toStr}**: "${req.subject}"` });
      }
      if (ctx.origin === "autonomous") {
        pushNotification({ timestamp: new Date().toISOString(), source: "gmail", message: `Email sent to **${toStr}**: "${req.subject}"` });
      }
      return { capabilityId: "email", ok: true, message: `Email sent to ${toStr}` };
    }

    logActivity({ source: "gmail", summary: `Failed to send email: ${result.message}`, actionLabel: label, reason: reason(ctx) });
    if (ctx.origin === "chat") {
      pushNotification({ timestamp: new Date().toISOString(), source: "gmail", message: `Failed to send email to ${toStr}: ${result.message}` });
    }
    return { capabilityId: "email", ok: false, message: result.message };
  },
};
