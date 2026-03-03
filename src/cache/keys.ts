/**
 * Cache key generation for LLM responses.
 * Produces deterministic SHA-256 keys from model, messages, and parameters.
 * No external dependencies.
 */

import { createHash } from "node:crypto";

export interface CacheKeyInput {
  /** LLM provider (e.g. "openrouter", "ollama"). */
  provider?: string;
  /** Model identifier. */
  model?: string;
  /** Chat messages — normalised for stable hashing. */
  messages?: ReadonlyArray<{ role: string; content: string | unknown[] }>;
  /** Additional parameters that affect the response (temperature, etc.). */
  params?: Record<string, unknown>;
}

/**
 * Generate a deterministic SHA-256 cache key from structured input.
 * Normalises messages and sorts parameter keys for stability.
 */
export function generateCacheKey(input: CacheKeyInput): string {
  const normalized: Record<string, unknown> = {};
  if (input.provider != null) normalized.provider = input.provider;
  if (input.model != null) normalized.model = input.model;
  if (input.messages) {
    normalized.messages = input.messages.map(normalizeMessage);
  }
  if (input.params) normalized.params = sortKeys(input.params);

  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

/**
 * Generate a SHA-256 cache key from a raw string.
 * Useful when you already have a pre-formatted key source.
 */
export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Flatten multimodal content blocks into a stable string form. */
function normalizeMessage(m: { role: string; content: string | unknown[] }): {
  role: string;
  content: string;
} {
  const content =
    typeof m.content === "string"
      ? m.content
      : (m.content as Array<Record<string, unknown>>)
          .map((b) =>
            "text" in b
              ? (b as { text: string }).text
              : (b as { image_url: { url: string } }).image_url.url,
          )
          .join("|");
  return { role: m.role, content };
}

/** Sort object keys for deterministic serialisation. */
function sortKeys(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}
