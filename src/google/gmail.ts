/**
 * Gmail API client.
 * Raw fetch via googleGet/googlePost — no SDK.
 * All functions return { ok, data?, message } — never throw.
 */

import { googleGet, googlePost, isGoogleAuthenticated } from "./auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("google.gmail");

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

// --- Types ---

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body?: string;
  labels: string[];
  isUnread: boolean;
  /** RFC 822 Message-ID header, used for inReplyTo when replying */
  rfc822MessageId?: string;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
  subject: string;
}

export type SenderCategory =
  | "direct"       // Personal email addressed directly to you
  | "notification" // Automated notifications (noreply, no-reply, etc.)
  | "newsletter"   // Mailing lists, marketing
  | "social"       // Social media notifications
  | "promotion"    // Promotional / marketing
  | "forum"        // Forums, groups
  | "update"       // Transactional updates (receipts, shipping, etc.)
  | "unknown";

export interface CategorizedMessage extends GmailMessage {
  priority: "high" | "normal" | "low";
  senderCategory: SenderCategory;
}

export interface InboxSummary {
  unreadCount: number;
  recentMessages: CategorizedMessage[];
  byCategory: Record<SenderCategory, number>;
  highPriority: CategorizedMessage[];
}

interface GoogleMessageHeader {
  name: string;
  value: string;
}

interface GoogleMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GoogleMessagePart[];
}

interface GoogleMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: GoogleMessageHeader[];
    mimeType?: string;
    body?: { data?: string; size?: number };
    parts?: GoogleMessagePart[];
  };
  internalDate?: string;
}

interface GoogleMessageList {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

interface GoogleThread {
  id: string;
  messages?: GoogleMessage[];
}

// --- Helpers ---

function getHeader(msg: GoogleMessage, name: string): string {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64 — replace chars and pad
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractTextBody(part: GoogleMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractTextBody(sub);
      if (text) return text;
    }
  }
  return "";
}

function parseMessage(msg: GoogleMessage): GmailMessage {
  const labels = msg.labelIds ?? [];
  const rfc822MessageId = getHeader(msg, "Message-ID") || undefined;
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: getHeader(msg, "Subject") || "(no subject)",
    from: getHeader(msg, "From"),
    to: getHeader(msg, "To"),
    date: getHeader(msg, "Date") || (msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : ""),
    snippet: msg.snippet ?? "",
    labels,
    isUnread: labels.includes("UNREAD"),
    rfc822MessageId,
  };
}

function parseMessageWithBody(msg: GoogleMessage): GmailMessage {
  const parsed = parseMessage(msg);

  // Extract plain text body
  if (msg.payload) {
    let body = "";
    if (msg.payload.body?.data) {
      body = decodeBase64Url(msg.payload.body.data);
    } else if (msg.payload.parts) {
      for (const part of msg.payload.parts) {
        body = extractTextBody(part);
        if (body) break;
      }
    }
    parsed.body = body;
  }

  return parsed;
}

// --- Public API ---

/**
 * Check if Gmail is ready (Google authenticated).
 */
export function isGmailAvailable(): boolean {
  return isGoogleAuthenticated();
}

/**
 * Get recent messages from the last N hours (headers + snippet, no body).
 */
export async function getRecentMessages(hours: number = 24): Promise<{
  ok: boolean;
  messages?: GmailMessage[];
  message: string;
}> {
  log.debug("Fetching recent messages", { hours });
  const afterEpoch = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
  const query = `after:${afterEpoch}`;

  const listResult = await googleGet<GoogleMessageList>(
    `${GMAIL_API}/messages`,
    { q: query, maxResults: "30" },
  );

  if (!listResult.ok) {
    log.error("Failed to list recent messages", { hours, error: listResult.message });
    return { ok: false, message: listResult.message };
  }

  const ids = listResult.data?.messages ?? [];
  if (ids.length === 0) {
    log.debug("No recent messages found", { hours });
    return { ok: true, messages: [], message: "No recent messages" };
  }

  // Fetch each message metadata (parallel, limit to 20)
  const fetches = ids.slice(0, 20).map(async ({ id }) => {
    const r = await googleGet<GoogleMessage>(
      `${GMAIL_API}/messages/${id}`,
      { format: "metadata", metadataHeaders: ["Subject", "From", "To", "Date"] },
    );
    return r.ok && r.data ? parseMessage(r.data) : null;
  });

  const results = await Promise.all(fetches);
  const messages = results.filter((m): m is GmailMessage => m !== null);

  log.info("Fetched recent messages", { hours, count: messages.length });
  return { ok: true, messages, message: `${messages.length} messages in last ${hours}h` };
}

/**
 * Get a single message with full body.
 */
export async function getMessage(id: string): Promise<{
  ok: boolean;
  message?: GmailMessage;
  status: string;
}> {
  log.debug("Fetching message", { messageId: id });
  const result = await googleGet<GoogleMessage>(
    `${GMAIL_API}/messages/${id}`,
    { format: "full" },
  );

  if (!result.ok) {
    log.error("Failed to fetch message", { messageId: id, error: result.message });
    return { ok: false, status: result.message };
  }

  log.debug("Message fetched", { messageId: id });
  return {
    ok: true,
    message: parseMessageWithBody(result.data!),
    status: "OK",
  };
}

/**
 * Get a full conversation thread.
 */
export async function getThread(threadId: string): Promise<{
  ok: boolean;
  thread?: GmailThread;
  message: string;
}> {
  log.debug("Fetching thread", { threadId });
  const result = await googleGet<GoogleThread>(
    `${GMAIL_API}/threads/${threadId}`,
    { format: "full" },
  );

  if (!result.ok) {
    log.error("Failed to fetch thread", { threadId, error: result.message });
    return { ok: false, message: result.message };
  }

  const rawMessages = result.data?.messages ?? [];
  const messages = rawMessages.map(parseMessageWithBody);
  const subject = messages[0]?.subject ?? "(no subject)";

  log.debug("Thread fetched", { threadId, messageCount: messages.length });
  return {
    ok: true,
    thread: { id: threadId, messages, subject },
    message: `Thread with ${messages.length} messages`,
  };
}

/**
 * Search messages using Gmail search syntax.
 */
export async function searchMessages(query: string, maxResults: number = 10): Promise<{
  ok: boolean;
  messages?: GmailMessage[];
  message: string;
}> {
  log.debug("Searching messages", { query, maxResults });
  const listResult = await googleGet<GoogleMessageList>(
    `${GMAIL_API}/messages`,
    { q: query, maxResults: String(maxResults) },
  );

  if (!listResult.ok) {
    log.error("Failed to search messages", { query, error: listResult.message });
    return { ok: false, message: listResult.message };
  }

  const ids = listResult.data?.messages ?? [];
  if (ids.length === 0) {
    log.debug("No messages matched search", { query });
    return { ok: true, messages: [], message: `No messages matching: ${query}` };
  }

  const fetches = ids.map(async ({ id }) => {
    const r = await googleGet<GoogleMessage>(
      `${GMAIL_API}/messages/${id}`,
      { format: "metadata", metadataHeaders: ["Subject", "From", "To", "Date"] },
    );
    return r.ok && r.data ? parseMessage(r.data) : null;
  });

  const results = await Promise.all(fetches);
  const messages = results.filter((m): m is GmailMessage => m !== null);

  log.debug("Search complete", { query, resultCount: messages.length });
  return { ok: true, messages, message: `${messages.length} results for: ${query}` };
}

/**
 * Get unread message count.
 */
export async function getUnreadCount(): Promise<{
  ok: boolean;
  count?: number;
  message: string;
}> {
  log.debug("Fetching unread count");
  const listResult = await googleGet<GoogleMessageList>(
    `${GMAIL_API}/messages`,
    { q: "is:unread", maxResults: "1" },
  );

  if (!listResult.ok) {
    log.error("Failed to fetch unread count", { error: listResult.message });
    return { ok: false, message: listResult.message };
  }

  const count = listResult.data?.resultSizeEstimate ?? 0;
  log.debug("Unread count fetched", { count });
  return {
    ok: true,
    count,
    message: `${count} unread`,
  };
}

/**
 * Format messages as a readable text block for LLM context injection.
 */
export function formatMessagesForContext(messages: GmailMessage[]): string {
  if (messages.length === 0) return "No messages.";

  return messages
    .map((m) => {
      const unread = m.isUnread ? " [UNREAD]" : "";
      const date = m.date
        ? new Date(m.date).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      const msgId = m.rfc822MessageId ? `, messageId: ${m.rfc822MessageId}` : "";
      return `- ${date}: ${m.from} — "${m.subject}"${unread} [threadId: ${m.threadId}${msgId}]\n  ${m.snippet}`;
    })
    .join("\n");
}

// --- Label modification (mark read/unread) ---

interface GoogleModifyResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/**
 * Mark a message as read (remove UNREAD label).
 */
export async function markAsRead(messageId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  log.debug("Marking message as read", { messageId });
  const result = await googlePost<GoogleModifyResponse>(
    `${GMAIL_API}/messages/${messageId}/modify`,
    { removeLabelIds: ["UNREAD"] },
  );

  if (!result.ok) {
    log.error("Failed to mark message as read", { messageId, error: result.message });
    return { ok: false, message: result.message };
  }
  log.debug("Message marked as read", { messageId });
  return { ok: true, message: `Marked ${messageId} as read` };
}

/**
 * Mark a message as unread (add UNREAD label).
 */
export async function markAsUnread(messageId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  log.debug("Marking message as unread", { messageId });
  const result = await googlePost<GoogleModifyResponse>(
    `${GMAIL_API}/messages/${messageId}/modify`,
    { addLabelIds: ["UNREAD"] },
  );

  if (!result.ok) {
    log.error("Failed to mark message as unread", { messageId, error: result.message });
    return { ok: false, message: result.message };
  }
  log.debug("Message marked as unread", { messageId });
  return { ok: true, message: `Marked ${messageId} as unread` };
}

/**
 * Batch mark multiple messages as read.
 */
export async function batchMarkAsRead(messageIds: string[]): Promise<{
  ok: boolean;
  succeeded: number;
  failed: number;
  message: string;
}> {
  const results = await Promise.all(messageIds.map(markAsRead));
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return {
    ok: failed === 0,
    succeeded,
    failed,
    message: `Marked ${succeeded}/${results.length} as read`,
  };
}

/**
 * Batch mark multiple messages as unread.
 */
export async function batchMarkAsUnread(messageIds: string[]): Promise<{
  ok: boolean;
  succeeded: number;
  failed: number;
  message: string;
}> {
  const results = await Promise.all(messageIds.map(markAsUnread));
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return {
    ok: failed === 0,
    succeeded,
    failed,
    message: `Marked ${succeeded}/${results.length} as unread`,
  };
}

// --- Sender categorization & priority detection ---

const NOREPLY_PATTERNS = [
  /^no-?reply@/i,
  /^noreply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^mailer-daemon@/i,
  /^notifications?@/i,
  /^alert(s)?@/i,
  /^info@/i,
];

const SOCIAL_DOMAINS = [
  "facebookmail.com", "linkedin.com", "twitter.com", "x.com",
  "instagram.com", "tiktok.com", "pinterest.com", "reddit.com",
  "discord.com", "slack.com", "medium.com",
];

const NEWSLETTER_PATTERNS = [
  /^newsletter@/i,
  /^digest@/i,
  /^updates?@/i,
  /^weekly@/i,
  /^daily@/i,
  /^news@/i,
  /^subscribe@/i,
];

/**
 * Extract email address from a "Name <email>" formatted From header.
 */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

/**
 * Extract domain from an email address.
 */
function extractDomain(email: string): string {
  const parts = email.split("@");
  return parts.length > 1 ? parts[1] : "";
}

/**
 * Categorize a sender based on email address and Gmail labels.
 */
export function categorizeSender(from: string, labels: string[]): SenderCategory {
  // Gmail category labels take precedence
  if (labels.includes("CATEGORY_SOCIAL")) return "social";
  if (labels.includes("CATEGORY_PROMOTIONS")) return "promotion";
  if (labels.includes("CATEGORY_FORUMS")) return "forum";
  if (labels.includes("CATEGORY_UPDATES")) return "update";

  const email = extractEmail(from);
  const domain = extractDomain(email);

  // Social domain check
  if (SOCIAL_DOMAINS.some((d) => domain.endsWith(d))) return "social";

  // Newsletter patterns
  if (NEWSLETTER_PATTERNS.some((p) => p.test(email))) return "newsletter";

  // Noreply / notification patterns
  if (NOREPLY_PATTERNS.some((p) => p.test(email))) return "notification";

  // CATEGORY_PRIMARY or no category label → direct
  if (labels.includes("CATEGORY_PRIMARY")) return "direct";

  return "unknown";
}

/**
 * Detect message priority from Gmail labels and headers.
 * High: IMPORTANT label or STARRED.
 * Low:  promotions, social, forums.
 * Normal: everything else.
 */
export function detectPriority(
  labels: string[],
  senderCategory: SenderCategory,
): "high" | "normal" | "low" {
  if (labels.includes("IMPORTANT") || labels.includes("STARRED")) return "high";
  if (senderCategory === "promotion" || senderCategory === "social" || senderCategory === "forum") return "low";
  return "normal";
}

/**
 * Enrich a GmailMessage with priority and sender category.
 */
export function categorizeMessage(msg: GmailMessage): CategorizedMessage {
  const senderCategory = categorizeSender(msg.from, msg.labels);
  const priority = detectPriority(msg.labels, senderCategory);
  return { ...msg, priority, senderCategory };
}

// --- Batch triage helpers ---

/**
 * Categorize an array of messages by sender type.
 * Returns messages grouped by category, sorted with direct first.
 */
export async function categorizeMessages(hours: number = 24): Promise<{
  ok: boolean;
  categorized?: CategorizedMessage[];
  byCategory?: Record<SenderCategory, CategorizedMessage[]>;
  message: string;
}> {
  const result = await getRecentMessages(hours);
  if (!result.ok) return { ok: false, message: result.message };

  const categorized = (result.messages ?? []).map(categorizeMessage);

  const byCategory: Record<SenderCategory, CategorizedMessage[]> = {
    direct: [], notification: [], newsletter: [], social: [],
    promotion: [], forum: [], update: [], unknown: [],
  };
  for (const msg of categorized) {
    byCategory[msg.senderCategory].push(msg);
  }

  return {
    ok: true,
    categorized,
    byCategory,
    message: `${categorized.length} messages categorized`,
  };
}

/**
 * Return messages scored and sorted by priority (high → normal → low).
 * Within each tier, messages are in reverse-chronological order.
 */
export async function prioritizeInbox(hours: number = 24): Promise<{
  ok: boolean;
  messages?: CategorizedMessage[];
  counts?: { high: number; normal: number; low: number };
  message: string;
}> {
  const result = await getRecentMessages(hours);
  if (!result.ok) return { ok: false, message: result.message };

  const categorized = (result.messages ?? []).map(categorizeMessage);

  const priorityOrder = { high: 0, normal: 1, low: 2 };
  const sorted = categorized.sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
  );

  const counts = { high: 0, normal: 0, low: 0 };
  for (const m of sorted) counts[m.priority]++;

  return {
    ok: true,
    messages: sorted,
    counts,
    message: `${counts.high} high, ${counts.normal} normal, ${counts.low} low priority`,
  };
}

/**
 * Alias for fetchInboxSummary — provides complete triage overview.
 */
export const getInboxSummary = fetchInboxSummary;

// --- Inbox summary ---

/**
 * Fetch a triage-ready inbox summary: unread count, categorized recent messages,
 * category breakdown, and high-priority items.
 */
export async function fetchInboxSummary(hours: number = 24): Promise<{
  ok: boolean;
  summary?: InboxSummary;
  message: string;
}> {
  // Fetch unread count and recent messages in parallel
  const [unreadResult, recentResult] = await Promise.all([
    getUnreadCount(),
    getRecentMessages(hours),
  ]);

  if (!unreadResult.ok) return { ok: false, message: `Unread count failed: ${unreadResult.message}` };
  if (!recentResult.ok) return { ok: false, message: `Recent messages failed: ${recentResult.message}` };

  const categorized = (recentResult.messages ?? []).map(categorizeMessage);

  // Build category counts
  const byCategory: Record<SenderCategory, number> = {
    direct: 0, notification: 0, newsletter: 0, social: 0,
    promotion: 0, forum: 0, update: 0, unknown: 0,
  };
  for (const msg of categorized) {
    byCategory[msg.senderCategory]++;
  }

  const highPriority = categorized.filter((m) => m.priority === "high");

  return {
    ok: true,
    summary: {
      unreadCount: unreadResult.count ?? 0,
      recentMessages: categorized,
      byCategory,
      highPriority,
    },
    message: `${unreadResult.count ?? 0} unread, ${categorized.length} recent, ${highPriority.length} high priority`,
  };
}

/**
 * Format an inbox summary as a readable text block for LLM context injection.
 */
export function formatInboxSummaryForContext(summary: InboxSummary): string {
  const lines: string[] = [];

  lines.push(`📬 Inbox: ${summary.unreadCount} unread`);

  // Category breakdown (only non-zero)
  const cats = Object.entries(summary.byCategory)
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(", ");
  if (cats) lines.push(`Categories: ${cats}`);

  // High priority
  if (summary.highPriority.length > 0) {
    lines.push(`\nHigh priority (${summary.highPriority.length}):`);
    for (const m of summary.highPriority) {
      const unread = m.isUnread ? " [UNREAD]" : "";
      lines.push(`  ⚡ ${m.from} — "${m.subject}"${unread}`);
    }
  }

  // Recent messages
  if (summary.recentMessages.length > 0) {
    lines.push(`\nRecent (${summary.recentMessages.length}):`);
    for (const m of summary.recentMessages) {
      const unread = m.isUnread ? " [UNREAD]" : "";
      const pri = m.priority === "high" ? "⚡" : m.priority === "low" ? "↓" : "·";
      const date = m.date
        ? new Date(m.date).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      lines.push(`  ${pri} ${date}: ${m.from} — "${m.subject}"${unread} [${m.senderCategory}]`);
    }
  }

  return lines.join("\n");
}
