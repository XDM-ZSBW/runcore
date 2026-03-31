/**
 * Email capability — send via Resend API.
 * Resend is the runtime-level messaging channel.
 * Application-specific email (Gmail, Outlook) belongs in Coreline.
 */

import { logActivity } from "../../activity/log.js";
import { pushNotification } from "../../goals/notifications.js";
import { getInstanceName, getAlertEmailFrom, resolveEnv } from "../../instance.js";
import { createLogger } from "../../utils/logger.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult } from "../types.js";

const log = createLogger("capability.email");

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

const reason = (ctx: ActionContext) => {
  switch (ctx.origin) {
    case "email": return `${getInstanceName()} email triggered send`;
    case "autonomous": return "planner sent email";
    default: return "AI sent email via chat";
  }
};

/** Send email via Resend API. Returns { ok, message, id? }. */
async function sendViaResend(opts: {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
}): Promise<{ ok: boolean; message: string; id?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, message: "RESEND_API_KEY not configured" };

  const from = opts.from ?? `${getInstanceName()} <${getAlertEmailFrom()}>`;
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];

  // Use CORE_ALERT_EMAIL_TO as default recipient if "to" is generic
  if (toArr.length === 0) {
    const defaultTo = resolveEnv("ALERT_EMAIL_TO");
    if (defaultTo) toArr.push(defaultTo);
    else return { ok: false, message: "No recipient and CORE_ALERT_EMAIL_TO not set" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: toArr,
        subject: opts.subject,
        text: opts.body,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data = await res.json() as { id?: string };
      return { ok: true, message: `Sent (${data.id ?? "ok"})`, id: data.id };
    }

    const text = await res.text();
    return { ok: false, message: `Resend ${res.status}: ${text}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const emailCapability: ActionBlockCapability = {
  id: "email",
  pattern: "action",
  tag: "EMAIL_ACTION",
  keywords: ["email", "send", "notify", "message"],

  getPromptInstructions(ctx) {
    const name = ctx.name ?? "the user";
    const defaultTo = resolveEnv("ALERT_EMAIL_TO") ?? "owner";
    return [
      `## Email (send via [EMAIL_ACTION] blocks)`,
      `To send an email, include an [EMAIL_ACTION] block in your response.`,
      `Default recipient: ${defaultTo}`,
      ``,
      `[EMAIL_ACTION]`,
      `{"action": "send", "to": "${defaultTo}", "subject": "Subject line", "body": "Email body text"}`,
      `[/EMAIL_ACTION]`,
      ``,
      `Fields: to (email or array), subject, body (plain text).`,
      `If "to" is omitted, sends to the owner (${defaultTo}).`,
      `Confirm with ${name} before emailing new recipients. Owner emails need no confirmation.`,
    ].join("\n");
  },

  getPromptOverride(origin) {
    if (origin === "autonomous") {
      return [
        `Send an email:`,
        `[EMAIL_ACTION]`,
        `{"action": "send", "to": "owner", "subject": "Subject", "body": "Email body"}`,
        `[/EMAIL_ACTION]`,
        `"to": "owner" sends to the configured owner email.`,
      ].join("\n");
    }
    return null;
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const req = payload as Record<string, any>;
    const label = actionLabel(ctx);

    if (!req.subject || !req.body) {
      return { capabilityId: "email", ok: false, message: "Missing required fields (subject, body)" };
    }

    // Resolve "owner" to CORE_ALERT_EMAIL_TO
    let to = req.to;
    if (!to || to === "owner") {
      to = resolveEnv("ALERT_EMAIL_TO");
      if (!to) return { capabilityId: "email", ok: false, message: "CORE_ALERT_EMAIL_TO not configured" };
    }

    const result = await sendViaResend({
      to,
      subject: req.subject,
      body: req.body,
    });

    const toStr = Array.isArray(to) ? to.join(", ") : to;

    if (result.ok) {
      logActivity({ source: "resend", summary: `Email sent to ${toStr}: "${req.subject}"`, actionLabel: label, reason: reason(ctx) });
      pushNotification({ timestamp: new Date().toISOString(), source: "resend", message: `Email sent to **${toStr}**: "${req.subject}"` });
      return { capabilityId: "email", ok: true, message: `Email sent to ${toStr}` };
    }

    log.warn(`Email send failed: ${result.message}`);
    logActivity({ source: "resend", summary: `Failed to send email: ${result.message}`, actionLabel: label, reason: reason(ctx) });
    return { capabilityId: "email", ok: false, message: result.message };
  },
};
