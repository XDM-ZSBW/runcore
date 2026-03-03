/**
 * High-level LLM response cache orchestrator.
 *
 * Configures file-backed persistence in .core/cache/, records hit/miss
 * metrics, and provides cache-warming utilities. Call `initLLMCache()`
 * once at boot (after settings are loaded) and `shutdownLLMCache()`
 * during graceful shutdown.
 */

import { join } from "node:path";
import { configureCache, initCache, getCacheInstance, getCacheStats, clearCache } from "../llm/cache.js";
import { createLogger } from "../utils/logger.js";
import type { MetricsStore } from "../metrics/store.js";
import type { CompleteChatOptions } from "../llm/complete.js";
import { completeChatCached, generateCacheKey, cacheGet, cacheSet } from "../llm/cache.js";

const log = createLogger("llm-cache");

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_TTL_MS = 60 * 60 * 1000;  // 1 hour
const DEFAULT_FILE_TTL_MS = 60 * 60 * 1000;    // 1 hour
const DEFAULT_MEMORY_MAX_SIZE = 512;
const DEFAULT_FILE_MAX_SIZE = 2048;
const DEFAULT_WRITE_DEBOUNCE_MS = 3000;
const METRICS_FLUSH_INTERVAL_MS = 60 * 1000;    // Log metrics every 60s

// ── State ─────────────────────────────────────────────────────────────────────

let metricsStore: MetricsStore | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let lastStats = { hits: 0, misses: 0, evictions: 0 };

// ── Configuration ─────────────────────────────────────────────────────────────

export interface LLMCacheOptions {
  /** Project root directory (for resolving .core/cache/). */
  projectRoot?: string;
  /** Memory cache TTL in ms. Default: 1 hour. */
  memoryTTLMs?: number;
  /** File cache TTL in ms. Default: 1 hour. */
  fileTTLMs?: number;
  /** Max in-memory entries. Default: 512. */
  memoryMaxSize?: number;
  /** Max file-backed entries. Default: 2048. */
  fileMaxSize?: number;
  /** Debounce interval for file writes in ms. Default: 3000. */
  writeDebounceMs?: number;
  /** MetricsStore instance for recording cache metrics. */
  metrics?: MetricsStore;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Configure and initialize the LLM response cache with file persistence.
 * Call once during boot, after settings are loaded.
 */
export async function initLLMCache(options: LLMCacheOptions = {}): Promise<void> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const cacheFilePath = join(projectRoot, ".core", "cache", "llm-responses.json");

  configureCache({
    enabled: true,
    memory: {
      maxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
      defaultTTLMs: options.memoryTTLMs ?? DEFAULT_MEMORY_TTL_MS,
    },
    file: {
      filePath: cacheFilePath,
      maxSize: options.fileMaxSize ?? DEFAULT_FILE_MAX_SIZE,
      defaultTTLMs: options.fileTTLMs ?? DEFAULT_FILE_TTL_MS,
      writeDebounceMs: options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS,
    },
  });

  await initCache();

  // Set up metrics recording
  if (options.metrics) {
    metricsStore = options.metrics;
    startMetricsFlush();
  }

  const stats = getCacheStats();
  log.info("LLM cache initialized", {
    cacheFile: cacheFilePath,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
    fileMaxSize: options.fileMaxSize ?? DEFAULT_FILE_MAX_SIZE,
    ttlMs: options.memoryTTLMs ?? DEFAULT_MEMORY_TTL_MS,
    existingEntries: stats.size,
  });
}

/**
 * Flush pending writes and stop metrics timer. Call during graceful shutdown.
 */
export async function shutdownLLMCache(): Promise<void> {
  stopMetricsFlush();
  // Flush any final metrics
  await flushMetrics();

  const cache = getCacheInstance();
  await cache.dispose();
  log.info("LLM cache shut down");
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Record cache hit/miss/eviction deltas to the MetricsStore.
 * Called periodically by the flush timer.
 */
async function flushMetrics(): Promise<void> {
  if (!metricsStore) return;

  const stats = getCacheStats();
  const now = new Date().toISOString();

  const deltaHits = stats.hits - lastStats.hits;
  const deltaMisses = stats.misses - lastStats.misses;
  const deltaEvictions = stats.evictions - lastStats.evictions;

  // Only record if there's been activity
  if (deltaHits > 0 || deltaMisses > 0 || deltaEvictions > 0) {
    await metricsStore.recordBatch([
      { timestamp: now, name: "llm.cache.hits", value: deltaHits, unit: "count", tags: { layer: "memory" } },
      { timestamp: now, name: "llm.cache.misses", value: deltaMisses, unit: "count", tags: { layer: "memory" } },
      { timestamp: now, name: "llm.cache.evictions", value: deltaEvictions, unit: "count", tags: { layer: "memory" } },
      { timestamp: now, name: "llm.cache.size", value: stats.size, unit: "count" },
      { timestamp: now, name: "llm.cache.hit_rate", value: Math.round(stats.hitRate * 100), unit: "%" },
    ]);

    log.debug("cache metrics flushed", {
      hits: deltaHits,
      misses: deltaMisses,
      evictions: deltaEvictions,
      size: stats.size,
      hitRate: `${Math.round(stats.hitRate * 100)}%`,
    });
  }

  lastStats = { hits: stats.hits, misses: stats.misses, evictions: stats.evictions };
}

function startMetricsFlush(): void {
  if (metricsTimer) return;
  metricsTimer = setInterval(() => {
    flushMetrics().catch((err) => {
      log.error("metrics flush failed", { error: String(err) });
    });
  }, METRICS_FLUSH_INTERVAL_MS);
}

function stopMetricsFlush(): void {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

// ── Cache warming ─────────────────────────────────────────────────────────────

export interface WarmEntry {
  /** The CompleteChatOptions that would generate this cache key. */
  options: CompleteChatOptions;
  /** The known-good response to pre-populate. */
  response: string;
  /** Optional TTL override in ms. */
  ttlMs?: number;
}

/**
 * Pre-populate the cache with known prompt/response pairs.
 * Useful for common system prompts or frequently-used templates.
 */
export function warmCache(entries: WarmEntry[]): number {
  let warmed = 0;
  for (const entry of entries) {
    const key = generateCacheKey(entry.options);
    // Only warm if not already cached (don't overwrite fresher entries)
    if (cacheGet(key) === undefined) {
      cacheSet(key, entry.response, entry.ttlMs);
      warmed++;
    }
  }
  if (warmed > 0) {
    log.info("cache warmed", { requested: entries.length, added: warmed });
  }
  return warmed;
}

// ── Status / diagnostics ──────────────────────────────────────────────────────

export interface CacheDiagnostics {
  enabled: boolean;
  memoryEntries: number;
  memoryMaxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: string;
}

/** Return a snapshot of cache health for dashboards or /api/health. */
export function getCacheDiagnostics(): CacheDiagnostics {
  const cache = getCacheInstance();
  const stats = getCacheStats();
  return {
    enabled: cache.enabled,
    memoryEntries: stats.size,
    memoryMaxSize: stats.maxSize,
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
    hitRate: `${Math.round(stats.hitRate * 100)}%`,
  };
}

/**
 * Invalidate all cached entries. Resets statistics.
 * Use sparingly — prefer natural TTL expiry.
 */
export { clearCache as invalidateAll } from "../llm/cache.js";

/**
 * Invalidate a specific cache entry by its options.
 * Returns true if the entry existed and was removed.
 */
export function invalidateEntry(options: CompleteChatOptions): boolean {
  const key = generateCacheKey(options);
  return getCacheInstance().delete(key);
}
