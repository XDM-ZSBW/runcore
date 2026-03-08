/**
 * WhatsApp chat service — routes inbound WhatsApp messages through the Brain + LLM pipeline.
 * Maintains per-phone-number conversation sessions and sends responses back via Twilio.
 *
 * Follows the same pattern as the main /api/chat route but non-streaming,
 * since WhatsApp replies are sent via Twilio API (not SSE).
 */

import { Brain } from "../brain.js";
import { FileSystemLongTermMemory } from "../memory/file-backed.js";
import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveChatModel } from "../settings.js";
import { getClient } from "../channels/whatsapp.js";
import { logActivity } from "../activity/log.js";
import type { ContextMessage } from "../types.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getEncryptionKey } from "../lib/key-store.js";
import { getInstanceName } from "../instance.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WhatsAppChatSession {
  phone: string;
  name: string;
  history: ContextMessage[];
  brain: Brain;
  lastActiveAt: string;
}

export interface WhatsAppChatResult {
  ok: boolean;
  reply?: string;
  error?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

import { BRAIN_DIR } from "../lib/paths.js";
const MEMORY_DIR = join(BRAIN_DIR, "memory");
const PERSONALITY_PATH = join(BRAIN_DIR, "identity", "personality.md");

/** WhatsApp message body limit (Twilio truncates at 1600 chars). */
const WHATSAPP_MAX_LENGTH = 1600;

/** Max conversation history entries per phone session. */
const MAX_HISTORY = 20;

/** Session TTL: 24 hours of inactivity before session is cleared. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ── Session store ────────────────────────────────────────────────────────────

const sessions = new Map<string, WhatsAppChatSession>();

/**
 * Get or create a conversation session for a phone number.
 */
async function getOrCreateSession(phone: string, profileName?: string): Promise<WhatsAppChatSession> {
  const existing = sessions.get(phone);
  if (existing) {
    existing.lastActiveAt = new Date().toISOString();
    if (profileName && profileName !== existing.name) {
      existing.name = profileName;
    }
    return existing;
  }

  // Read personality for system prompt
  let personality = "";
  try {
    personality = (await readFile(PERSONALITY_PATH, "utf-8")).trim();
  } catch {}

  const name = profileName || "User";
  const ltm = new FileSystemLongTermMemory(MEMORY_DIR, getEncryptionKey() ?? undefined);
  const brain = new Brain(
    {
      systemPrompt: [
        `You are ${getInstanceName()}, a personal AI agent communicating via WhatsApp.`,
        `You are chatting with ${name}. Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
        ``,
        `CRITICAL RULES:`,
        `- Keep responses concise — this is WhatsApp, not a long-form chat.`,
        `- Use plain text only. No markdown, no rich formatting, no code blocks.`,
        `- Use line breaks for readability. Avoid walls of text.`,
        `- NEVER invent information. If you don't know, say so.`,
        `- Be warm, direct, and helpful. Have personality.`,
        ...(personality ? [``, personality] : []),
      ].join("\n"),
    },
    ltm,
  );

  const session: WhatsAppChatSession = {
    phone,
    name,
    history: [],
    brain,
    lastActiveAt: new Date().toISOString(),
  };

  sessions.set(phone, session);
  return session;
}

// ── Phone validation ─────────────────────────────────────────────────────────

/** E.164 format: + followed by 1-15 digits. */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/**
 * Validate and normalize a phone number to E.164 format.
 * Returns null if invalid.
 */
export function validatePhoneNumber(phone: string): string | null {
  const cleaned = phone.replace(/[\s\-()]/g, "");
  if (E164_REGEX.test(cleaned)) return cleaned;
  return null;
}

// ── Core chat processing ─────────────────────────────────────────────────────

/**
 * Process an inbound WhatsApp message through the chat pipeline.
 * Returns the AI response (already sent back via WhatsApp if client is available).
 */
export async function handleWhatsAppMessage(
  phone: string,
  body: string,
  profileName?: string,
): Promise<WhatsAppChatResult> {
  try {
    const session = await getOrCreateSession(phone, profileName);

    // Add user message to history
    session.history.push({ role: "user", content: body });

    // Trim history to prevent unbounded growth
    if (session.history.length > MAX_HISTORY * 2) {
      session.history = session.history.slice(-MAX_HISTORY * 2);
    }

    // Build context from Brain (retrieves LTM, assembles system prompt)
    const ctx = await session.brain.getContextForTurn({
      userInput: body,
      conversationHistory: session.history.slice(0, -1),
    });

    // Generate response via non-streaming LLM
    const provider = resolveProvider();
    const model = resolveChatModel();
    const reply = await completeChat({
      messages: ctx.messages,
      model,
      provider,
    });

    // Format for WhatsApp: strip markdown, truncate
    const formatted = formatForWhatsApp(reply);

    // Add assistant response to history
    session.history.push({ role: "assistant", content: formatted });

    // Send response back via WhatsApp
    const client = getClient();
    if (client) {
      const sendResult = await client.sendMessage(phone, formatted);
      if (!sendResult.ok) {
        logActivity({
          source: "whatsapp",
          summary: `Failed to reply to ${phone}: ${sendResult.message}`,
        });
        return { ok: false, error: `Reply send failed: ${sendResult.message}` };
      }
    }

    logActivity({
      source: "whatsapp",
      summary: `WhatsApp reply to ${phone}: "${formatted.slice(0, 60)}"`,
    });

    return { ok: true, reply: formatted };
  } catch (err: any) {
    logActivity({
      source: "whatsapp",
      summary: `WhatsApp chat error for ${phone}: ${err.message}`,
    });
    return { ok: false, error: err.message };
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format an LLM response for WhatsApp delivery.
 * Strips markdown formatting and truncates to WhatsApp limits.
 */
export function formatForWhatsApp(text: string): string {
  let result = text
    // Remove markdown headers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```\w*\n?/g, "").replace(/```/g, "").trim();
    })
    // Remove link formatting, keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate to WhatsApp limit
  if (result.length > WHATSAPP_MAX_LENGTH) {
    result = result.slice(0, WHATSAPP_MAX_LENGTH - 3) + "...";
  }

  return result;
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * Clean up stale sessions (called periodically).
 */
export function cleanupStaleSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [phone, session] of sessions) {
    if (now - new Date(session.lastActiveAt).getTime() > SESSION_TTL_MS) {
      sessions.delete(phone);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Get the number of active WhatsApp chat sessions.
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}
