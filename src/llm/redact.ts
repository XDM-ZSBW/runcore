/**
 * Sensitive data redaction for outbound LLM requests.
 * Pattern-based detection — if it looks like a secret, redact it before network egress.
 * Runs inside the fetch guard, after message assembly, before the wire.
 *
 * When a PrivacyMembrane is active, delegates to it for reversible typed-placeholder
 * redaction. Falls back to one-way [REDACTED:category] replacement otherwise.
 */

import type { PrivacyMembrane } from "./membrane.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.redact");

// --- Active membrane (singleton, set at startup) ---

let activeMembrane: PrivacyMembrane | null = null;

/** Set the active PrivacyMembrane for reversible redaction. */
export function setActiveMembrane(membrane: PrivacyMembrane): void {
  activeMembrane = membrane;
  log.info("PrivacyMembrane activated");
}

/** Get the active membrane (or null if none). */
export function getActiveMembrane(): PrivacyMembrane | null {
  return activeMembrane;
}

/**
 * Rehydrate placeholders in an LLM response back to original values.
 * No-op if no membrane is active.
 */
export function rehydrateResponse(text: string): string {
  if (!activeMembrane) {
    if (text.includes("<<") && text.includes(">>")) {
      log.warn("rehydrateResponse called but no active membrane!", { snippet: text.slice(0, 100) });
    }
    return text;
  }
  return activeMembrane.rehydrate(text);
}

// --- One-way fallback (original behavior) ---

/** Placeholder for redacted content. Includes the category so the LLM knows what was removed. */
function placeholder(category: string): string {
  return `[REDACTED:${category}]`;
}

/**
 * Redaction rules: [pattern, category, description].
 * Order matters — more specific patterns first to avoid partial matches.
 */
const RULES: Array<[RegExp, string]> = [
  // SSN: 123-45-6789 or 123 45 6789
  [/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, "SSN"],

  // Credit card: 13-19 digits, optionally grouped by spaces or dashes
  [/\b(?:\d[ -]*?){13,19}\b/g, "CARD"],

  // API keys: common prefixes (sk-, pk-, api-, key-, token_)
  [/\b(?:sk|pk|api|key|token)[_-][A-Za-z0-9_-]{20,}\b/g, "API_KEY"],

  // Bearer tokens in content (not headers — those are legitimate)
  [/\bBearer\s+[A-Za-z0-9_.-]{20,}\b/g, "BEARER_TOKEN"],

  // AWS access keys: AKIA + 16 alphanumeric
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS_KEY"],

  // Private keys (PEM blocks)
  [/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, "PRIVATE_KEY"],

  // Generic long hex/base64 secrets (40+ chars, likely tokens)
  [/\b[A-Fa-f0-9]{40,}\b/g, "HEX_SECRET"],
];

/** Track redaction stats per request for audit logging. */
interface RedactionStats {
  totalRedactions: number;
  categories: Record<string, number>;
}

/**
 * Redact sensitive patterns from a string (one-way fallback).
 * Returns the cleaned string and stats about what was redacted.
 */
export function redactSensitive(text: string): { cleaned: string; stats: RedactionStats } {
  const stats: RedactionStats = { totalRedactions: 0, categories: {} };
  let cleaned = text;

  for (const [pattern, category] of RULES) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = cleaned.match(pattern);
    if (matches) {
      // Filter out false positives: skip short numeric sequences for CARD rule
      const validMatches = category === "CARD"
        ? matches.filter((m) => m.replace(/[\s-]/g, "").length >= 13)
        : matches;

      if (validMatches.length > 0) {
        for (const match of validMatches) {
          cleaned = cleaned.replace(match, placeholder(category));
        }
        stats.totalRedactions += validMatches.length;
        stats.categories[category] = (stats.categories[category] ?? 0) + validMatches.length;
      }
    }
    pattern.lastIndex = 0;
  }

  return { cleaned, stats };
}

/**
 * Redact sensitive data from an LLM request body (JSON string).
 * When a membrane is active, delegates to it for reversible redaction.
 * Otherwise falls back to one-way pattern replacement.
 */
export function redactRequestBody(bodyStr: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return bodyStr; // not JSON, pass through
  }

  // Only process if it looks like an LLM API request (has messages array)
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return bodyStr;

  // Delegate to membrane when active (reversible typed placeholders)
  if (activeMembrane) {
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        msg.content = activeMembrane.apply(msg.content);
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            block.text = activeMembrane.apply(block.text);
          }
        }
      }
    }
    return JSON.stringify(parsed);
  }

  // Fallback: one-way redaction
  let totalRedactions = 0;
  const allCategories: Record<string, number> = {};

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      const { cleaned, stats } = redactSensitive(msg.content);
      if (stats.totalRedactions > 0) {
        msg.content = cleaned;
        totalRedactions += stats.totalRedactions;
        for (const [cat, count] of Object.entries(stats.categories)) {
          allCategories[cat] = (allCategories[cat] ?? 0) + count;
        }
      }
    }
    // Handle Anthropic-style content blocks: [{ type: "text", text: "..." }]
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const { cleaned, stats } = redactSensitive(block.text);
          if (stats.totalRedactions > 0) {
            block.text = cleaned;
            totalRedactions += stats.totalRedactions;
            for (const [cat, count] of Object.entries(stats.categories)) {
              allCategories[cat] = (allCategories[cat] ?? 0) + count;
            }
          }
        }
      }
    }
  }

  if (totalRedactions > 0) {
    log.warn("Redacted sensitive data from outbound LLM request", {
      redactions: totalRedactions,
      categories: allCategories,
    });
  }

  return JSON.stringify(parsed);
}
