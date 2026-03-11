/**
 * LLM-specific caching layer.
 *
 * Delegates to the generic cache system in src/cache/.
 * Provides backward-compatible function exports and the `completeChatCached` wrapper.
 */

import { TieredCache, generateCacheKey as genericCacheKey } from "../cache/index.js";
import type { LLMCacheConfig, CacheStats } from "../cache/index.js";
import type { ContextMessage } from "../types.js";
import type { CompleteChatOptions } from "./complete.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm-cache");

// ── Module-level singleton ────────────────────────────────────────────────────

let cache = new TieredCache();

/**
 * Configure (or reconfigure) the LLM cache.
 * Replaces the module-level cache instance.
 *
 * Call `initCache()` after this if file persistence is configured.
 */
export function configureCache(config: LLMCacheConfig): void {
  cache = new TieredCache(config);
}

/**
 * Initialise file-backed persistence (if configured).
 * No-op when using memory-only caching.
 */
export async function initCache(): Promise<void> {
  await cache.init();
}

/** Return the underlying TieredCache instance for advanced use. */
export function getCacheInstance(): TieredCache {
  return cache;
}

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Generate a cache key from LLM request parameters.
 * Key is a SHA-256 hash of provider + model + serialised messages.
 */
export function generateCacheKey(options: CompleteChatOptions): string {
  return genericCacheKey({
    provider: options.provider,
    model: options.model ?? "",
    messages: options.messages.map(normaliseMessage),
  });
}

/** Normalise a ContextMessage to a stable {role, content} form. */
function normaliseMessage(m: ContextMessage): { role: string; content: string } {
  const content =
    m.content == null
      ? ""
      : typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => ("text" in b ? b.text : b.image_url.url))
            .join("|");
  return { role: m.role, content };
}

// ── Get / Set / Stats ─────────────────────────────────────────────────────────

/** Look up a cached response. Returns undefined on miss or expiry. */
export function cacheGet(key: string): string | undefined {
  return cache.get(key);
}

/** Store a response in the cache. */
export function cacheSet(key: string, response: string, ttlMs?: number): void {
  cache.set(key, response, ttlMs);
}

/** Return current cache statistics. */
export function getCacheStats(): CacheStats {
  return cache.stats();
}

/** Clear all cached entries and reset statistics. */
export function clearCache(): void {
  cache.clear();
  log.debug("cleared");
}

// ── Cached completion wrapper ─────────────────────────────────────────────────

/**
 * Cached wrapper around any completeChat function.
 * Checks cache before calling the underlying function; stores the result on miss.
 */
export async function completeChatCached(
  options: CompleteChatOptions,
  completeFn: (opts: CompleteChatOptions) => Promise<string>,
  ttlMs?: number,
): Promise<string> {
  const key = generateCacheKey(options);
  const cached = cacheGet(key);
  if (cached !== undefined) {
    log.info("cache hit", {
      key: key.slice(0, 12),
      model: options.model ?? "default",
      provider: options.provider,
      responseLength: cached.length,
    });
    return cached;
  }

  log.info("cache miss — calling LLM", {
    key: key.slice(0, 12),
    model: options.model ?? "default",
    provider: options.provider,
  });
  const start = Date.now();
  const response = await completeFn(options);
  const durationMs = Date.now() - start;
  cacheSet(key, response, ttlMs);
  log.debug("cached LLM response", {
    key: key.slice(0, 12),
    responseLength: response.length,
    durationMs,
  });
  return response;
}
