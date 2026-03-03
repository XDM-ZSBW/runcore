/**
 * LLM response cache — interface, two-tier implementation, and factory.
 *
 * Architecture:
 *   L1 = in-memory TTL cache (fast, bounded)
 *   L2 = optional file-backed cache (persistent across restarts)
 *
 * On `get`: check L1 → on miss, check L2 → promote hit to L1.
 * On `set`: write to both L1 and L2.
 */

import { createLogger } from "../utils/logger.js";
import { MemoryCache } from "./memory.js";
import type { MemoryCacheConfig, CacheStats } from "./memory.js";
import { FileCache } from "./file.js";
import type { FileCacheConfig } from "./file.js";

const log = createLogger("cache");

// ── Public interface ──────────────────────────────────────────────────────────

/** Minimal cache store contract. */
export interface CacheStore {
  get(key: string): string | undefined;
  set(key: string, value: string, ttlMs?: number): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  clear(): void;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface LLMCacheConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** In-memory (L1) settings. */
  memory?: MemoryCacheConfig;
  /** File persistence (L2) settings. Omit to use memory-only. */
  file?: FileCacheConfig;
}

// ── Two-tier cache ────────────────────────────────────────────────────────────

/**
 * Two-tier cache: memory (L1) + optional file persistence (L2).
 *
 * When file persistence is configured, call `init()` once to load from disk,
 * and `dispose()` before shutdown to flush pending writes.
 */
export class TieredCache implements CacheStore {
  private readonly memory: MemoryCache<string>;
  private readonly file: FileCache | null;
  private readonly _enabled: boolean;

  constructor(config: LLMCacheConfig = {}) {
    this._enabled = config.enabled ?? true;
    this.memory = new MemoryCache<string>(config.memory);
    this.file = config.file ? new FileCache(config.file) : null;
  }

  /** Load file-backed cache from disk. No-op when file persistence is disabled. */
  async init(): Promise<void> {
    if (this.file) await this.file.init();
  }

  get(key: string): string | undefined {
    if (!this._enabled) return undefined;

    // L1
    const memResult = this.memory.get(key);
    if (memResult !== undefined) return memResult;

    // L2
    if (this.file) {
      const fileResult = this.file.get(key);
      if (fileResult !== undefined) {
        // Promote to L1
        this.memory.set(key, fileResult);
        return fileResult;
      }
    }
    return undefined;
  }

  set(key: string, value: string, ttlMs?: number): void {
    if (!this._enabled) return;
    this.memory.set(key, value, ttlMs);
    if (this.file) this.file.set(key, value, ttlMs);
  }

  delete(key: string): boolean {
    const memDel = this.memory.delete(key);
    const fileDel = this.file ? this.file.delete(key) : false;
    return memDel || fileDel;
  }

  has(key: string): boolean {
    if (!this._enabled) return false;
    return this.memory.has(key) || (this.file?.has(key) ?? false);
  }

  clear(): void {
    this.memory.clear();
    if (this.file) this.file.clear();
  }

  /** Whether the cache is enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Return L1 (memory) cache statistics. */
  stats(): CacheStats {
    return this.memory.stats();
  }

  /** Force an immediate flush of the file-backed cache. */
  async flush(): Promise<void> {
    if (this.file) await this.file.flush();
  }

  /** Flush pending writes and release timers. Call before shutdown. */
  async dispose(): Promise<void> {
    if (this.file) await this.file.dispose();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a cache with sensible defaults. */
export function createCache(config: LLMCacheConfig = {}): TieredCache {
  log.debug("creating cache", {
    enabled: config.enabled ?? true,
    hasFile: !!config.file,
  });
  return new TieredCache(config);
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export { MemoryCache } from "./memory.js";
export type { MemoryCacheConfig, CacheStats } from "./memory.js";
export { FileCache } from "./file.js";
export type { FileCacheConfig } from "./file.js";
export { generateCacheKey, hashString } from "./keys.js";
export type { CacheKeyInput } from "./keys.js";
