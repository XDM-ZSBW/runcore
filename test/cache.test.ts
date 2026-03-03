/**
 * Tests for the LLM response caching system.
 * Covers: key generation, in-memory TTL cache, file-backed cache, tiered cache, and LLM wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateCacheKey, hashString } from "../src/cache/keys.js";
import { MemoryCache } from "../src/cache/memory.js";
import { FileCache } from "../src/cache/file.js";
import { TieredCache, createCache } from "../src/cache/index.js";

// ─── Cache Key Generation ─────────────────────────────────────────────────────

describe("generateCacheKey", () => {
  it("produces deterministic keys for the same input", () => {
    const input = {
      provider: "openrouter",
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    };
    const k1 = generateCacheKey(input);
    const k2 = generateCacheKey(input);
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64); // SHA-256 hex
  });

  it("produces different keys for different models", () => {
    const base = { provider: "openrouter", messages: [{ role: "user", content: "hi" }] };
    const k1 = generateCacheKey({ ...base, model: "gpt-4" });
    const k2 = generateCacheKey({ ...base, model: "claude-3" });
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different messages", () => {
    const base = { provider: "openrouter", model: "gpt-4" };
    const k1 = generateCacheKey({ ...base, messages: [{ role: "user", content: "hello" }] });
    const k2 = generateCacheKey({ ...base, messages: [{ role: "user", content: "world" }] });
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different providers", () => {
    const base = { model: "llama3", messages: [{ role: "user", content: "hi" }] };
    const k1 = generateCacheKey({ ...base, provider: "ollama" });
    const k2 = generateCacheKey({ ...base, provider: "openrouter" });
    expect(k1).not.toBe(k2);
  });

  it("normalises multimodal content blocks", () => {
    const text = { provider: "or", messages: [{ role: "user", content: "hello|world" }] };
    const blocks = {
      provider: "or",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "world" } },
        ],
      }],
    };
    expect(generateCacheKey(text)).toBe(generateCacheKey(blocks));
  });

  it("sorts params keys for stability", () => {
    const k1 = generateCacheKey({ params: { a: 1, b: 2 } });
    const k2 = generateCacheKey({ params: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
  });
});

describe("hashString", () => {
  it("produces a 64-char hex string", () => {
    const h = hashString("test input");
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("is deterministic", () => {
    expect(hashString("same")).toBe(hashString("same"));
  });

  it("different inputs yield different hashes", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
  });
});

// ─── In-Memory TTL Cache ──────────────────────────────────────────────────────

describe("MemoryCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves values", () => {
    const c = new MemoryCache();
    c.set("k1", "v1");
    expect(c.get("k1")).toBe("v1");
  });

  it("returns undefined for missing keys", () => {
    const c = new MemoryCache();
    expect(c.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const c = new MemoryCache({ defaultTTLMs: 1000 });
    c.set("k1", "v1");
    expect(c.get("k1")).toBe("v1");

    vi.advanceTimersByTime(1001);
    expect(c.get("k1")).toBeUndefined();
  });

  it("respects per-entry TTL override", () => {
    const c = new MemoryCache({ defaultTTLMs: 10_000 });
    c.set("short", "v", 500);
    c.set("long", "v", 5000);

    vi.advanceTimersByTime(600);
    expect(c.get("short")).toBeUndefined();
    expect(c.get("long")).toBe("v");
  });

  it("evicts oldest entry when at capacity", () => {
    const c = new MemoryCache({ maxSize: 2 });
    c.set("a", "1");
    vi.advanceTimersByTime(1); // ensure different createdAt
    c.set("b", "2");
    vi.advanceTimersByTime(1);
    c.set("c", "3"); // should evict "a"

    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
    expect(c.stats().evictions).toBe(1);
  });

  it("does not evict when updating an existing key", () => {
    const c = new MemoryCache({ maxSize: 2 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("a", "updated"); // update, not new entry

    expect(c.get("a")).toBe("updated");
    expect(c.get("b")).toBe("2");
    expect(c.stats().evictions).toBe(0);
  });

  it("tracks hit/miss/eviction stats", () => {
    const c = new MemoryCache({ maxSize: 1 });
    c.set("a", "1");
    c.get("a"); // hit
    c.get("b"); // miss
    c.set("b", "2"); // evicts "a"

    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.evictions).toBe(1);
    expect(s.hitRate).toBe(0.5);
    expect(s.size).toBe(1);
    expect(s.maxSize).toBe(1);
  });

  it("clear resets entries and stats", () => {
    const c = new MemoryCache();
    c.set("a", "1");
    c.get("a");
    c.clear();

    expect(c.size).toBe(0);
    const s = c.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.size).toBe(0);
  });

  it("delete removes a specific key", () => {
    const c = new MemoryCache();
    c.set("a", "1");
    expect(c.delete("a")).toBe(true);
    expect(c.get("a")).toBeUndefined();
    expect(c.delete("a")).toBe(false);
  });

  it("has returns correct state", () => {
    const c = new MemoryCache({ defaultTTLMs: 1000 });
    c.set("a", "1");
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(c.has("a")).toBe(false);
  });

  it("disabled cache always returns undefined", () => {
    const c = new MemoryCache({ enabled: false });
    c.set("a", "1");
    expect(c.get("a")).toBeUndefined();
    expect(c.has("a")).toBe(false);
  });

  it("works with generic types", () => {
    const c = new MemoryCache<{ count: number }>();
    c.set("k", { count: 42 });
    expect(c.get("k")).toEqual({ count: 42 });
  });
});

// ─── File-Backed Cache ────────────────────────────────────────────────────────

describe("FileCache", () => {
  let tmpDir: string;
  let cacheFile: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "dash-cache-test-"));
    cacheFile = join(tmpDir, "cache.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves values", () => {
    const c = new FileCache({ filePath: cacheFile });
    c.set("k1", "v1");
    expect(c.get("k1")).toBe("v1");
  });

  it("returns undefined for missing keys", () => {
    const c = new FileCache({ filePath: cacheFile });
    expect(c.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const c = new FileCache({ filePath: cacheFile, defaultTTLMs: 1000 });
    c.set("k1", "v1");

    vi.advanceTimersByTime(1001);
    expect(c.get("k1")).toBeUndefined();
  });

  it("persists to disk and reloads", async () => {
    vi.useRealTimers(); // need real timers for flush

    const c1 = new FileCache({ filePath: cacheFile, defaultTTLMs: 60_000 });
    c1.set("persisted", "hello");
    await c1.flush();

    const raw = await readFile(cacheFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.entries.persisted.value).toBe("hello");

    // New instance loads from disk
    const c2 = new FileCache({ filePath: cacheFile });
    await c2.init();
    expect(c2.get("persisted")).toBe("hello");
  });

  it("does not load expired entries from disk", async () => {
    vi.useRealTimers();

    const c1 = new FileCache({ filePath: cacheFile, defaultTTLMs: 100 });
    c1.set("short-lived", "value");
    await c1.flush();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    const c2 = new FileCache({ filePath: cacheFile });
    await c2.init();
    expect(c2.get("short-lived")).toBeUndefined();
  });

  it("init works when cache file does not exist", async () => {
    const c = new FileCache({ filePath: join(tmpDir, "nonexistent.json") });
    await c.init(); // should not throw
    expect(c.size).toBe(0);
  });

  it("prunes when at capacity", () => {
    const c = new FileCache({ filePath: cacheFile, maxSize: 2 });
    c.set("a", "1");
    vi.advanceTimersByTime(1);
    c.set("b", "2");
    vi.advanceTimersByTime(1);
    c.set("c", "3"); // should prune oldest

    expect(c.has("a")).toBe(false);
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
  });

  it("clear removes all entries", () => {
    const c = new FileCache({ filePath: cacheFile });
    c.set("a", "1");
    c.set("b", "2");
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("delete removes a specific key", () => {
    const c = new FileCache({ filePath: cacheFile });
    c.set("a", "1");
    expect(c.delete("a")).toBe(true);
    expect(c.get("a")).toBeUndefined();
    expect(c.delete("a")).toBe(false);
  });

  it("dispose flushes pending writes", async () => {
    vi.useRealTimers();

    const c = new FileCache({ filePath: cacheFile, writeDebounceMs: 60_000 });
    c.set("pending", "data");
    await c.dispose();

    const raw = await readFile(cacheFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.entries.pending.value).toBe("data");
  });
});

// ─── Tiered Cache ─────────────────────────────────────────────────────────────

describe("TieredCache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dash-tiered-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("works as memory-only by default", () => {
    const c = new TieredCache();
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  it("disabled cache always returns undefined", () => {
    const c = new TieredCache({ enabled: false });
    c.set("k", "v");
    expect(c.get("k")).toBeUndefined();
    expect(c.has("k")).toBe(false);
  });

  it("promotes L2 hits to L1", async () => {
    const filePath = join(tmpDir, "cache.json");

    // Populate L2
    const c1 = new TieredCache({
      file: { filePath, defaultTTLMs: 60_000 },
    });
    await c1.init();
    c1.set("promoted", "value");
    await c1.flush();

    // New tiered cache — L1 is empty, L2 has the entry
    const c2 = new TieredCache({
      file: { filePath, defaultTTLMs: 60_000 },
    });
    await c2.init();

    // First get: comes from L2, promoted to L1
    expect(c2.get("promoted")).toBe("value");
    // Second get: should come from L1 (verified by stats)
    expect(c2.get("promoted")).toBe("value");
    expect(c2.stats().hits).toBe(1); // one L1 hit (second call)
  });

  it("delete removes from both tiers", async () => {
    const filePath = join(tmpDir, "cache.json");
    const c = new TieredCache({
      file: { filePath, defaultTTLMs: 60_000 },
    });
    await c.init();
    c.set("k", "v");
    expect(c.delete("k")).toBe(true);
    expect(c.get("k")).toBeUndefined();
  });

  it("clear removes from both tiers", async () => {
    const filePath = join(tmpDir, "cache.json");
    const c = new TieredCache({
      file: { filePath, defaultTTLMs: 60_000 },
    });
    await c.init();
    c.set("a", "1");
    c.set("b", "2");
    c.clear();
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("has checks both tiers", async () => {
    const filePath = join(tmpDir, "cache.json");
    const c = new TieredCache({
      file: { filePath, defaultTTLMs: 60_000 },
    });
    await c.init();
    c.set("k", "v");
    expect(c.has("k")).toBe(true);
    expect(c.has("missing")).toBe(false);
  });

  it("stats returns L1 statistics", () => {
    const c = new TieredCache();
    c.set("k", "v");
    c.get("k");
    c.get("miss");
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });
});

// ─── Factory ──────────────────────────────────────────────────────────────────

describe("createCache", () => {
  it("returns a TieredCache instance", () => {
    const c = createCache();
    expect(c).toBeInstanceOf(TieredCache);
  });

  it("respects configuration", () => {
    const c = createCache({ enabled: false });
    c.set("k", "v");
    expect(c.get("k")).toBeUndefined();
    expect(c.enabled).toBe(false);
  });

  it("creates file-backed cache when configured", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dash-factory-test-"));
    try {
      const c = createCache({
        file: { filePath: join(tmpDir, "cache.json") },
      });
      await c.init();
      c.set("k", "v");
      expect(c.get("k")).toBe("v");
      await c.dispose();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── LLM Cache Wrapper ───────────────────────────────────────────────────────

describe("LLM cache wrapper (src/llm/cache.ts)", () => {
  // Dynamic import to avoid module-level side effects interfering between tests
  it("completeChatCached returns cached result on hit", async () => {
    const { completeChatCached, clearCache } = await import("../src/llm/cache.js");
    clearCache();

    let callCount = 0;
    const fakeLLM = async () => {
      callCount++;
      return "response";
    };

    const opts = {
      provider: "openrouter" as const,
      model: "test",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    const r1 = await completeChatCached(opts, fakeLLM);
    const r2 = await completeChatCached(opts, fakeLLM);

    expect(r1).toBe("response");
    expect(r2).toBe("response");
    expect(callCount).toBe(1); // LLM called only once
  });

  it("generateCacheKey produces stable keys for CompleteChatOptions", async () => {
    const { generateCacheKey } = await import("../src/llm/cache.js");
    const opts = {
      provider: "ollama" as const,
      model: "llama3",
      messages: [{ role: "user" as const, content: "test" }],
    };
    expect(generateCacheKey(opts)).toBe(generateCacheKey(opts));
    expect(generateCacheKey(opts)).toHaveLength(64);
  });

  it("getCacheStats reflects usage", async () => {
    const { cacheGet, cacheSet, getCacheStats, clearCache } = await import("../src/llm/cache.js");
    clearCache();

    cacheSet("test-key", "value");
    cacheGet("test-key"); // hit
    cacheGet("missing");  // miss

    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });
});
