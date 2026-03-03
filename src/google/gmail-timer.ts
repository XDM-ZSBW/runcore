/**
 * Background inbox polling timer.
 * Checks for new messages every 5 minutes.
 * Pushes notifications for new unread messages.
 * Emails with the instance name in the subject are processed as chat and replied to automatically.
 * Follows src/goals/timer.ts pattern: module-level state, idempotent start/stop.
 */

import { getRecentMessages, getMessage, isGmailAvailable } from "./gmail.js";
import type { GmailMessage } from "./gmail.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { getInstanceName, getInstanceNameLower } from "../instance.js";

const log = createLogger("gmail");

const DEFAULT_INTERVAL_MS = parseInt(process.env.GMAIL_POLL_INTERVAL_MS ?? "", 10) || 5 * 60 * 1000; // default 5 min, override with GMAIL_POLL_INTERVAL_MS

let timer: ReturnType<typeof setInterval> | null = null;
const seenMessageIds = new Set<string>(); // Track seen messages to avoid duplicates
let initialized = false;

/**
 * Callback for processing emails addressed to this instance.
 * Receives the full message (with body) and should return the reply text.
 */
export type DashEmailHandler = (message: GmailMessage) => Promise<string | null>;

let dashEmailHandler: DashEmailHandler | null = null;

/** The subject-line pattern that triggers instance email processing. */
const DASH_SUBJECT_PATTERN = new RegExp(`\\b${getInstanceNameLower()}\\b`, "i");

/**
 * Register a handler for instance-addressed emails.
 * When the timer finds new unread emails with the instance name in the subject,
 * it fetches the full body and calls this handler.
 */
export function onDashEmail(handler: DashEmailHandler): void {
  dashEmailHandler = handler;
}

/** Alias for onDashEmail — preferred name for generic instances. */
export const onInstanceEmail = onDashEmail;

/**
 * Start the Gmail polling timer. Idempotent.
 */
export function startGmailTimer(intervalMs?: number): void {
  if (timer) return;

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;

  // Run an initial check to seed the seen set (don't notify on first run)
  (async () => {
    if (!isGmailAvailable()) return;
    try {
      const result = await getRecentMessages(1);
      if (result.ok && result.messages) {
        for (const msg of result.messages) {
          seenMessageIds.add(msg.id);
        }
      }
      initialized = true;
    } catch {
      initialized = true; // Continue even if initial seed fails
    }
  })();

  timer = setInterval(async () => {
    if (!isGmailAvailable() || !initialized) return;

    try {
      const result = await getRecentMessages(1); // Last hour
      if (!result.ok || !result.messages) return;

      const newMessages = result.messages.filter(
        (m) => m.isUnread && !seenMessageIds.has(m.id),
      );

      // Track all seen IDs
      for (const msg of result.messages) {
        seenMessageIds.add(msg.id);
      }

      if (newMessages.length > 0) {
        // Separate instance-addressed emails from regular notifications
        const dashEmails: GmailMessage[] = [];
        const regularEmails: GmailMessage[] = [];

        for (const m of newMessages) {
          if (DASH_SUBJECT_PATTERN.test(m.subject)) {
            dashEmails.push(m);
          } else {
            regularEmails.push(m);
          }
        }

        // Process instance-addressed emails (fetch body, run through AI, reply)
        if (dashEmails.length > 0 && dashEmailHandler) {
          for (const m of dashEmails) {
            processDashEmail(m).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.error(`Failed to process ${getInstanceName()} email`, { messageId: m.id, error: errMsg });
              logActivity({ source: "gmail", summary: `Failed to process ${getInstanceName()} email from ${m.from}: ${errMsg}` });
            });
          }
        }

        // Fetch full body for regular emails and push rich notifications
        if (regularEmails.length > 0) {
          for (const m of regularEmails) {
            fetchAndNotify(m).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.warn("Failed to fetch email body for notification", { messageId: m.id, error: errMsg });
              // Fall back to snippet-only notification
              pushNotification({
                timestamp: new Date().toISOString(),
                source: "gmail",
                message: `New email from ${m.from}: "${m.subject}"\n${m.snippet}`,
              });
            });
          }

          logActivity({
            source: "gmail",
            summary: `${regularEmails.length} new unread email(s)`,
          });
        }

        // Separate log for instance-addressed emails
        if (dashEmails.length > 0) {
          logActivity({
            source: "gmail",
            summary: `${dashEmails.length} ${getInstanceName()}-addressed email(s) detected — processing`,
          });
        }
      }

      // Prune old seen IDs (keep max 500)
      if (seenMessageIds.size > 500) {
        const arr = [...seenMessageIds];
        const toRemove = arr.slice(0, arr.length - 500);
        for (const id of toRemove) seenMessageIds.delete(id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "gmail", summary: `Poll error: ${msg}` });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Gmail poll: every ${mins} min`);
}

/**
 * Fetch full email body and push a rich notification so the instance can reason about it in chat.
 * Truncates body to keep notification size reasonable.
 */
async function fetchAndNotify(m: GmailMessage): Promise<void> {
  const full = await getMessage(m.id);
  const body = full.ok && full.message?.body?.trim()
    ? full.message.body.trim()
    : m.snippet;

  // Truncate body to ~500 chars for notification context
  const truncated = body.length > 500 ? body.slice(0, 500) + "..." : body;
  const senderName = m.from.split("<")[0].trim();

  pushNotification({
    timestamp: new Date().toISOString(),
    source: "gmail",
    message: [
      `New email from ${senderName}: "${m.subject}" [threadId: ${m.threadId}]`,
      truncated,
    ].join("\n"),
  });
}

/**
 * Fetch full email body and run through the instance email handler.
 */
async function processDashEmail(m: GmailMessage): Promise<void> {
  if (!dashEmailHandler) return;

  // Fetch full message with body
  const full = await getMessage(m.id);
  if (!full.ok || !full.message) {
    log.error(`Failed to fetch full ${getInstanceName()} email`, { messageId: m.id });
    return;
  }

  const emailBody = full.message.body?.trim();
  if (!emailBody) {
    log.warn(`${getInstanceName()} email has no body`, { messageId: m.id, subject: m.subject });
    return;
  }

  log.info(`Processing ${getInstanceName()} email`, { from: m.from, subject: m.subject, bodyLength: emailBody.length });

  const reply = await dashEmailHandler(full.message);
  if (!reply) {
    log.warn(`${getInstanceName()} email handler returned no reply`, { messageId: m.id });
    return;
  }

  // Send reply via sendEmail (imported dynamically to avoid circular deps)
  const { sendEmail } = await import("./gmail-send.js");
  const senderEmail = extractEmail(m.from);
  const subject = m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`;

  const result = await sendEmail({
    to: senderEmail,
    subject,
    body: reply,
    threadId: m.threadId,
    inReplyTo: m.rfc822MessageId,
  });

  if (result.ok) {
    log.info(`Replied to ${getInstanceName()} email`, { to: senderEmail, subject });
    logActivity({ source: "gmail", summary: `${getInstanceName()} replied to email from ${senderEmail}: "${m.subject}"`, actionLabel: "AUTONOMOUS", reason: `${getInstanceName()}-addressed email auto-reply` });
    pushNotification({
      timestamp: new Date().toISOString(),
      source: "gmail",
      message: `Replied to email from **${m.from.split("<")[0].trim()}**: "${m.subject}"`,
    });
  } else {
    log.error(`Failed to reply to ${getInstanceName()} email`, { to: senderEmail, error: result.message });
    logActivity({ source: "gmail", summary: `Failed to reply to ${getInstanceName()} email: ${result.message}`, actionLabel: "AUTONOMOUS", reason: `${getInstanceName()}-addressed email auto-reply failed` });
  }
}

/** Extract email address from "Name <email>" format. */
function extractEmail(from: string): string {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from.trim();
}

/**
 * Stop the Gmail polling timer.
 */
export function stopGmailTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  seenMessageIds.clear();
  initialized = false;
}

/**
 * Check if the Gmail timer is running.
 */
export function isGmailTimerRunning(): boolean {
  return timer !== null;
}
