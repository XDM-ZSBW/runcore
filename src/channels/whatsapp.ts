/**
 * WhatsApp messaging client via Twilio API.
 * Raw fetch, no SDK. Follows src/twilio/call.ts + src/slack/client.ts patterns.
 *
 * Credentials read from process.env (hydrated by vault):
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_PHONE_NUMBER (WhatsApp-enabled sender)
 *
 * Never throws in public methods — returns { ok, data?, error? }.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logActivity } from "../activity/log.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WhatsAppMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  status: string;
  direction: "inbound" | "outbound";
  timestamp: string;
}

export interface WhatsAppContact {
  phone: string;
  name?: string;
  lastMessageAt?: string;
}

export interface SendResult {
  ok: boolean;
  sid?: string;
  message: string;
}

export interface MessageHistoryEntry {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: "inbound" | "outbound";
  timestamp: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;

const HISTORY_DIR = "brain/channels/whatsapp";
const HISTORY_FILE = "messages.jsonl";
const CONTACTS_FILE = "contacts.json";

// ── Lazy singleton ───────────────────────────────────────────────────────────

let _client: WhatsAppClient | null = null;
let _lastSid = "";

/**
 * Get or create the singleton WhatsApp client.
 * Returns null if Twilio credentials are not configured.
 */
export function getClient(): WhatsAppClient | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid) return null;
  if (sid !== _lastSid) {
    _client = new WhatsAppClient();
    _lastSid = sid;
  }
  return _client;
}

/**
 * Check if WhatsApp is configured (all required vault keys present).
 */
export function isWhatsAppConfigured(): boolean {
  return REQUIRED_VARS.every((v) => !!process.env[v]);
}

// ── Client class ─────────────────────────────────────────────────────────────

export class WhatsAppClient {
  lastErrorMessage: string | null = null;

  private get accountSid(): string { return process.env.TWILIO_ACCOUNT_SID!; }
  private get authToken(): string { return process.env.TWILIO_AUTH_TOKEN!; }
  private get fromNumber(): string { return process.env.TWILIO_PHONE_NUMBER!; }
  private get auth(): string {
    return Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  // ── Send message ─────────────────────────────────────────────────────────

  /**
   * Send a WhatsApp message via Twilio API.
   * Phone numbers must include country code (e.g., +1234567890).
   */
  async sendMessage(to: string, body: string): Promise<SendResult> {
    try {
      const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
      if (missing.length > 0) {
        return { ok: false, message: `Missing vault keys: ${missing.join(", ")}` };
      }

      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
      const params = new URLSearchParams({
        From: `whatsapp:${this.fromNumber}`,
        To: `whatsapp:${to}`,
        Body: body,
      });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        this.lastErrorMessage = `Twilio error (${res.status}): ${errBody}`;
        return { ok: false, message: this.lastErrorMessage };
      }

      const data = (await res.json()) as { sid?: string; status?: string };

      // Store outbound message in history
      await this.appendHistory({
        sid: data.sid ?? "",
        from: this.fromNumber,
        to,
        body,
        direction: "outbound",
        timestamp: new Date().toISOString(),
      });

      // Update contact
      await this.upsertContact({ phone: to, lastMessageAt: new Date().toISOString() });

      logActivity({
        source: "whatsapp",
        summary: `WhatsApp sent to ${to}: "${body.slice(0, 60)}"`,
        detail: `sid=${data.sid}`,
      });

      this.lastErrorMessage = null;
      return { ok: true, sid: data.sid, message: `Message sent to ${to}` };
    } catch (err: any) {
      this.lastErrorMessage = err.message;
      return { ok: false, message: `Send failed: ${err.message}` };
    }
  }

  // ── Contact management ───────────────────────────────────────────────────

  /**
   * List all known WhatsApp contacts.
   */
  async listContacts(): Promise<WhatsAppContact[]> {
    try {
      const filePath = join(HISTORY_DIR, CONTACTS_FILE);
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as WhatsAppContact[];
    } catch {
      return [];
    }
  }

  /**
   * Add or update a contact.
   */
  async upsertContact(contact: WhatsAppContact): Promise<void> {
    const contacts = await this.listContacts();
    const idx = contacts.findIndex((c) => c.phone === contact.phone);
    if (idx >= 0) {
      contacts[idx] = { ...contacts[idx], ...contact };
    } else {
      contacts.push(contact);
    }
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(join(HISTORY_DIR, CONTACTS_FILE), JSON.stringify(contacts, null, 2));
  }

  /**
   * Remove a contact by phone number.
   */
  async removeContact(phone: string): Promise<boolean> {
    const contacts = await this.listContacts();
    const filtered = contacts.filter((c) => c.phone !== phone);
    if (filtered.length === contacts.length) return false;
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(join(HISTORY_DIR, CONTACTS_FILE), JSON.stringify(filtered, null, 2));
    return true;
  }

  // ── Message history ──────────────────────────────────────────────────────

  /**
   * Append a message to the JSONL history file.
   */
  async appendHistory(entry: MessageHistoryEntry): Promise<void> {
    await mkdir(HISTORY_DIR, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    const filePath = join(HISTORY_DIR, HISTORY_FILE);
    // Append-only — matches brain/memory JSONL pattern
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, line);
  }

  /**
   * Get message history, optionally filtered by phone number.
   * Returns most recent messages first.
   */
  async getHistory(opts?: { phone?: string; limit?: number }): Promise<MessageHistoryEntry[]> {
    try {
      const filePath = join(HISTORY_DIR, HISTORY_FILE);
      const raw = await readFile(filePath, "utf-8");
      let entries = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MessageHistoryEntry);

      if (opts?.phone) {
        entries = entries.filter(
          (e) => e.from === opts.phone || e.to === opts.phone,
        );
      }

      // Most recent first
      entries.reverse();

      if (opts?.limit && opts.limit > 0) {
        entries = entries.slice(0, opts.limit);
      }

      return entries;
    } catch {
      return [];
    }
  }

  // ── Health ───────────────────────────────────────────────────────────────

  getHealth(): { available: boolean; lastError: string | null } {
    return {
      available: isWhatsAppConfigured(),
      lastError: this.lastErrorMessage,
    };
  }
}
