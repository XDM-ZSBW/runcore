/**
 * In-memory TTL cache with configurable size limits and LRU eviction.
 * Generic over value type. No external dependencies.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("cache.memory");

export interface MemoryCacheConfig {
  /** Maximum number of cached entries. Default: 256. */
  maxSize?: number;
  /** Default TTL in milliseconds. Default: 5 minutes. */
  defaultTTLMs?: number;
  /** Set false to disable the cache (get always returns undefined, set is a no-op). */
  enabled?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  /** Hit rate as a fraction (0–1). 0 when no lookups have occurred. */
  hitRate: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

const DEFAULT_MAX_SIZE = 256;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory TTL cache.
 *
 * - Entries expire after their TTL.
 * - When the cache is full, the oldest entry (by creation time) is evicted.
 * - Stats track hits, misses, and evictions for observability.
 */
export class MemoryCache<T = string> {
  private cache = new Map<string, CacheEntry<T>>();
  private _stats = { hits: 0, misses: 0, evictions: 0 };
  private readonly maxSize: number;
  private readonly defaultTTLMs: number;
  private readonly enabled: boolean;

  constructor(config: MemoryCacheConfig = {}) {
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
    this.defaultTTLMs = config.defaultTTLMs ?? DEFAULT_TTL_MS;
    this.enabled = config.enabled ?? true;
  }

  /** Retrieve a value by key. Returns undefined on miss or expiry. */
  get(key: string): T | undefined {
    if (!this.enabled) return undefined;

    const entry = this.cache.get(key);
    if (!entry) {
      this._stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this._stats.misses++;
      log.debug("expired", { key: key.slice(0, 12) });
      return undefined;
    }
    this._stats.hits++;
    log.debug("hit", { key: key.slice(0, 12) });
    return entry.value;
  }

  /** Store a value. Evicts the oldest entry when at capacity. */
  set(key: string, value: T, ttlMs?: number): void {
    if (!this.enabled) return;

    // Evict if at capacity and this is a new key
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTTLMs),
      createdAt: Date.now(),
    });
  }

  /** Remove a specific key. Returns true if the key existed. */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Check if a non-expired entry exists for the key. */
  has(key: string): boolean {
    if (!this.enabled) return false;
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /** Remove all entries and reset statistics. */
  clear(): void {
    this.cache.clear();
    this._stats = { hits: 0, misses: 0, evictions: 0 };
    log.debug("cleared");
  }

  /** Current number of entries (including expired but not yet reaped). */
  get size(): number {
    return this.cache.size;
  }

  /** Return a snapshot of cache statistics. */
  stats(): CacheStats {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this._stats.hits / total : 0,
    };
  }

  /** Evict the oldest entry by creation time. */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.cache) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this._stats.evictions++;
      log.debug("evicted", { key: oldestKey.slice(0, 12) });
    }
  }
}
