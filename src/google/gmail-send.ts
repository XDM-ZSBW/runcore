/**
 * Gmail send client.
 * Composes RFC 2822 messages and sends via Gmail API.
 * Raw fetch via googlePost — no SDK.
 * All functions return { ok, data?, message } — never throw.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAccessToken, isGoogleAuthenticated } from "./auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("google.gmail-send");

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";
const DEFAULT_FROM = process.env.GMAIL_FROM ?? "noreply@example.com";

// --- Types ---

export interface EmailAttachment {
  /** File name shown to recipient (e.g. "report.pdf") */
  filename: string;
  /** MIME type (e.g. "application/pdf", "image/png") */
  mimeType: string;
  /** Raw file content as a Buffer */
  content: Buffer;
}

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  htmlBody?: string;
  from?: string;
  attachments?: EmailAttachment[];
  /** Thread ID for replies — keeps the email in the same conversation */
  threadId?: string;
  /** Message-ID header of the email being replied to */
  inReplyTo?: string;
  /** References header chain for threading */
  references?: string;
}

interface GmailSendResponse {
  id: string;
  threadId: string;
  labelIds: string[];
}

export interface SendEmailResult {
  ok: boolean;
  data?: { id: string; threadId: string; labelIds: string[] };
  message: string;
}

// --- Helpers ---

/**
 * Encode a Buffer to URL-safe base64 (Gmail's required format).
 */
function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Join an address list into a comma-separated string.
 */
function joinAddresses(addr: string | string[]): string {
  return Array.isArray(addr) ? addr.join(", ") : addr;
}

/**
 * Generate a MIME boundary string.
 */
function generateBoundary(): string {
  return `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a complete RFC 2822 message as a string.
 * Supports plain text, HTML alternative, and file attachments.
 */
function buildRfc2822(options: SendEmailOptions): string {
  const from = options.from ?? DEFAULT_FROM;
  const to = joinAddresses(options.to);
  const headers: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${options.subject}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
  ];

  if (options.cc) headers.push(`Cc: ${joinAddresses(options.cc)}`);
  if (options.bcc) headers.push(`Bcc: ${joinAddresses(options.bcc)}`);
  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) headers.push(`References: ${options.references}`);

  const hasAttachments = options.attachments && options.attachments.length > 0;
  const hasHtml = !!options.htmlBody;

  // Simple plain text — no MIME parts needed
  if (!hasAttachments && !hasHtml) {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: 7bit`);
    return headers.join("\r\n") + "\r\n\r\n" + options.body;
  }

  // With HTML but no attachments — multipart/alternative
  if (!hasAttachments && hasHtml) {
    const altBoundary = generateBoundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    const parts = [
      `--${altBoundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${options.body}`,
      `--${altBoundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${options.htmlBody}`,
      `--${altBoundary}--`,
    ];
    return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
  }

  // With attachments — multipart/mixed
  const mixedBoundary = generateBoundary();
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts: string[] = [];

  // Text body (or alternative text+html)
  if (hasHtml) {
    const altBoundary = generateBoundary();
    parts.push(
      `--${mixedBoundary}\r\nContent-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n` +
      `--${altBoundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${options.body}\r\n` +
      `--${altBoundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${options.htmlBody}\r\n` +
      `--${altBoundary}--`,
    );
  } else {
    parts.push(
      `--${mixedBoundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${options.body}`,
    );
  }

  // Attachments
  for (const att of options.attachments!) {
    const encoded = att.content.toString("base64");
    parts.push(
      `--${mixedBoundary}\r\n` +
      `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n` +
      `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      encoded,
    );
  }

  parts.push(`--${mixedBoundary}--`);
  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

// --- Public API ---

/**
 * Check if Gmail sending is ready (Google authenticated).
 */
export function isGmailSendAvailable(): boolean {
  return isGoogleAuthenticated();
}

/**
 * Send an email via Gmail API.
 * Builds an RFC 2822 message, base64url-encodes it, and POSTs to the send endpoint.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  if (!isGoogleAuthenticated()) {
    log.warn("Send attempted without authentication");
    return { ok: false, message: "Google not authenticated — connect Google first" };
  }

  // Validate required fields
  if (!options.to || (Array.isArray(options.to) && options.to.length === 0)) {
    return { ok: false, message: "No recipient specified" };
  }
  if (!options.subject) {
    return { ok: false, message: "No subject specified" };
  }
  if (!options.body) {
    return { ok: false, message: "No body specified" };
  }

  const toStr = joinAddresses(options.to);
  log.info("Sending email", { to: toStr, subject: options.subject, hasAttachments: !!(options.attachments?.length), threadId: options.threadId });

  try {
    const raw = buildRfc2822(options);
    const encoded = toBase64Url(Buffer.from(raw, "utf-8"));

    const payload: Record<string, string> = { raw: encoded };
    if (options.threadId) payload.threadId = options.threadId;

    // Use raw fetch instead of googlePost because the Gmail send endpoint
    // returns the created message directly and we need tight control
    const auth = await getAccessToken();
    if (!auth.ok) return { ok: false, message: auth.message };

    const res = await fetch(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000), // Longer timeout for attachments
    });

    if (!res.ok) {
      const text = await res.text();
      log.error("Email send failed", { to: toStr, status: res.status, error: text });
      return { ok: false, message: `Gmail send error (${res.status}): ${text}` };
    }

    const data = (await res.json()) as GmailSendResponse;
    log.info("Email sent successfully", { to: toStr, messageId: data.id, threadId: data.threadId });
    return {
      ok: true,
      data: { id: data.id, threadId: data.threadId, labelIds: data.labelIds },
      message: `Email sent to ${toStr} — ID: ${data.id}`,
    };
  } catch (err: any) {
    log.error("Email send exception", { to: toStr, error: err.message });
    return { ok: false, message: `Gmail send failed: ${err.message}` };
  }
}

/**
 * Load a file from disk and return it as an EmailAttachment.
 * Infers MIME type from extension.
 */
export async function attachmentFromFile(filePath: string): Promise<{
  ok: boolean;
  attachment?: EmailAttachment;
  message: string;
}> {
  try {
    log.debug("Loading attachment from file", { filePath });
    const content = await readFile(filePath);
    const filename = basename(filePath);
    const mimeType = inferMimeType(filename);

    log.debug("Attachment loaded", { filename, mimeType, sizeBytes: content.length });
    return {
      ok: true,
      attachment: { filename, mimeType, content },
      message: `Loaded ${filename} (${content.length} bytes)`,
    };
  } catch (err: any) {
    log.error("Failed to read attachment", { filePath, error: err.message });
    return { ok: false, message: `Failed to read attachment: ${err.message}` };
  }
}

/**
 * Infer MIME type from file extension.
 */
function inferMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    json: "application/json",
    zip: "application/zip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wav: "audio/wav",
  };
  return types[ext] ?? "application/octet-stream";
}
