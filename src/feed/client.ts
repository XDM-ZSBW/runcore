/**
 * FeedClient — consumes public/paid feed streams from runcore.sh.
 * Supports batch polling (free) and SSE (paid tiers).
 * Gracefully degrades when feed is unavailable.
 */

import type { FeedConfig, FeedItem, FeedStatus, FeedTier } from "./types.js";
import { getTierCapabilities, filterByTier } from "./tiers.js";

export class FeedClient {
  private config: FeedConfig;
  private cache: FeedItem[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private connected = false;
  private lastReceivedAt: string | null = null;
  private listeners: Array<(items: FeedItem[]) => void> = [];

  constructor(config: FeedConfig) {
    this.config = {
      pollIntervalMs: 3_600_000, // 1 hour default
      maxCachedItems: 500,
      useSSE: false,
      ...config,
    };
  }

  /** Start consuming the feed. Chooses SSE or polling based on tier. */
  start(): void {
    const caps = getTierCapabilities(this.config.tier);
    if (this.config.useSSE && caps.sseEnabled) {
      this.startSSE();
    } else {
      this.startPolling();
    }
  }

  /** Stop consuming the feed. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
  }

  /** Register a listener for new feed items (after tier filtering). */
  onItems(listener: (items: FeedItem[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Get cached feed items, optionally filtered by signal type. */
  getCachedItems(signalType?: string): FeedItem[] {
    const now = Date.now();
    // Prune expired items
    this.cache = this.cache.filter(item => {
      if (item.ttl === 0) return true;
      const age = now - new Date(item.receivedAt).getTime();
      return age < item.ttl * 1000;
    });
    if (signalType) {
      return this.cache.filter(item => item.type === signalType);
    }
    return [...this.cache];
  }

  /** Current feed status for health/metrics. */
  getStatus(): FeedStatus {
    return {
      connected: this.connected,
      tier: this.config.tier,
      lastReceivedAt: this.lastReceivedAt,
      itemsCached: this.cache.length,
      insightsGenerated: 0, // tracked by MixingEngine
      avgRelevance: 0,
    };
  }

  /** Update tier (e.g. after subscription change). */
  setTier(tier: FeedTier): void {
    const wasSSE = this.config.useSSE && getTierCapabilities(this.config.tier).sseEnabled;
    this.config.tier = tier;
    const nowSSE = this.config.useSSE && getTierCapabilities(tier).sseEnabled;
    // Restart if transport mode changed
    if (this.connected && wasSSE !== nowSSE) {
      this.stop();
      this.start();
    }
  }

  // --- Private ---

  private startPolling(): void {
    this.poll(); // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const since = this.lastReceivedAt ?? new Date(0).toISOString();
      const url = new URL("/feed/poll", this.config.feedUrl);
      url.searchParams.set("since", since);
      url.searchParams.set("tier", this.config.tier);
      if (this.config.hostFingerprint) {
        url.searchParams.set("host", this.config.hostFingerprint);
      }

      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        this.connected = false;
        return; // graceful degradation — feed unavailable is not fatal
      }

      const data = await res.json() as { items: FeedItem[] };
      this.connected = true;
      this.ingestItems(data.items);
    } catch {
      // Network error, timeout, etc. — degrade gracefully
      this.connected = false;
    }
  }

  private startSSE(): void {
    this.abortController = new AbortController();
    this.consumeSSE(this.abortController.signal);
  }

  private async consumeSSE(signal: AbortSignal): Promise<void> {
    const url = new URL("/feed/stream", this.config.feedUrl);
    url.searchParams.set("tier", this.config.tier);
    if (this.config.hostFingerprint) {
      url.searchParams.set("host", this.config.hostFingerprint);
    }

    try {
      const res = await fetch(url.toString(), {
        headers: { "Accept": "text/event-stream" },
        signal,
      });

      if (!res.ok || !res.body) {
        this.connected = false;
        // Fall back to polling
        this.startPolling();
        return;
      }

      this.connected = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const block of lines) {
          const dataLine = block.split("\n").find(l => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const item = JSON.parse(dataLine.slice(5).trim()) as FeedItem;
            this.ingestItems([item]);
          } catch {
            // skip malformed events
          }
        }
      }
    } catch {
      this.connected = false;
      // If SSE fails and not aborted, fall back to polling
      if (!signal.aborted) {
        this.startPolling();
      }
    }
  }

  private ingestItems(items: FeedItem[]): void {
    if (items.length === 0) return;

    // Stamp receivedAt and filter by tier
    const stamped = items.map(item => ({
      ...item,
      receivedAt: item.receivedAt || new Date().toISOString(),
    }));
    const filtered = filterByTier(stamped, this.config.tier);

    // Deduplicate by id
    const existingIds = new Set(this.cache.map(i => i.id));
    const newItems = filtered.filter(i => !existingIds.has(i.id));

    if (newItems.length === 0) return;

    this.cache.push(...newItems);
    this.lastReceivedAt = newItems[newItems.length - 1].receivedAt;

    // Enforce cache size limit
    const max = this.config.maxCachedItems ?? 500;
    if (this.cache.length > max) {
      this.cache = this.cache.slice(-max);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(newItems);
      } catch {
        // listener errors don't break the feed
      }
    }
  }
}
