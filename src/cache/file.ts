/**
 * File-backed cache for persistent LLM response caching across restarts.
 * Stores entries in a single JSON file with debounced writes.
 * No external dependencies.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cache.file");

export interface FileCacheConfig {
  /** Absolute path to the cache file. */
  filePath: string;
  /** Default TTL in milliseconds. Default: 30 minutes. */
  defaultTTLMs?: number;
  /** Maximum entries before pruning. Default: 1024. */
  maxSize?: number;
  /** Debounce interval for writes in milliseconds. Default: 2000. */
  writeDebounceMs?: number;
}

interface StoredEntry {
  value: string;
  expiresAt: number;
  createdAt: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, StoredEntry>;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SIZE = 1024;
const DEFAULT_DEBOUNCE_MS = 2000;

/**
 * File-backed cache.
 *
 * - Loads all entries from disk on `init()`.
 * - Writes are debounced to avoid excessive disk I/O.
 * - Expired entries are pruned on load and when capacity is reached.
 * - Call `dispose()` to flush pending writes before shutdown.
 */
export class FileCache {
  private entries = new Map<string, StoredEntry>();
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;
  private readonly defaultTTLMs: number;
  private readonly maxSize: number;
  private readonly writeDebounceMs: number;

  constructor(config: FileCacheConfig) {
    this.filePath = config.filePath;
    this.defaultTTLMs = config.defaultTTLMs ?? DEFAULT_TTL_MS;
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
    this.writeDebounceMs = config.writeDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Load cache from disk. Call once before use. Expired entries are pruned. */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as CacheFile;
      if (data.version !== 1) return;

      const now = Date.now();
      for (const [key, entry] of Object.entries(data.entries)) {
        if (entry.expiresAt > now) {
          this.entries.set(key, entry);
        }
      }
      log.debug("loaded from disk", { entries: this.entries.size });
    } catch {
      // File doesn't exist or is corrupt — start fresh
      log.debug("no cache file, starting fresh");
    }
  }

  /** Retrieve a value by key. Returns undefined on miss or expiry. */
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.scheduleSave();
      return undefined;
    }
    return entry.value;
  }

  /** Store a value. Prunes when at capacity. */
  set(key: string, value: string, ttlMs?: number): void {
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      this.prune();
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTTLMs),
      createdAt: Date.now(),
    });
    this.scheduleSave();
  }

  /** Remove a specific key. Returns true if it existed. */
  delete(key: string): boolean {
    const result = this.entries.delete(key);
    if (result) this.scheduleSave();
    return result;
  }

  /** Check if a non-expired entry exists. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.scheduleSave();
      return false;
    }
    return true;
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
    this.scheduleSave();
  }

  /** Current number of stored entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Force an immediate write to disk. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.saveToDisk();
  }

  /** Flush pending writes and release timers. Call before shutdown. */
  async dispose(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) {
      await this.saveToDisk();
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.saveToDisk().catch((err) => {
        log.error("failed to save cache", { error: String(err) });
      });
    }, this.writeDebounceMs);
  }

  private async saveToDisk(): Promise<void> {
    const data: CacheFile = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(data), "utf-8");
      this.dirty = false;
      log.debug("saved to disk", { entries: this.entries.size });
    } catch (err) {
      log.error("disk write failed", { error: String(err) });
    }
  }

  /** Remove expired entries, then oldest entries if still over capacity. */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size >= this.maxSize) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.entries) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.entries.delete(oldestKey);
      else break;
    }
  }
}
