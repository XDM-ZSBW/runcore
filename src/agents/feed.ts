/**
 * Agent Runtime Feed — per-agent live activity stream.
 *
 * Bridges lifecycle events, activity log entries, and agent runtime output
 * into a per-agent SSE stream. Each feed entry matches the spec types:
 * llm, tool, memory, decision, error, state.
 *
 * Observation without disturbance — subscribing to a feed has zero effect
 * on the running agent.
 *
 * Portability: StreamEmitter is injectable. The server injects the concrete
 * implementation at runtime if live stream bridging is desired.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-feed");

// ---------------------------------------------------------------------------
// Feed entry types (from spec)
// ---------------------------------------------------------------------------

export type FeedEntryType = "llm" | "tool" | "memory" | "decision" | "error" | "state";

export interface FeedEntry {
  timestamp: string;
  agentId: string;
  type: FeedEntryType;
  summary: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Injectable stream bridge
// ---------------------------------------------------------------------------

/** Interface for bridging feed entries to an SSE stream layer. */
export interface StreamBridge {
  emit(entry: {
    agentId: string;
    type: string;
    summary: string;
    detail?: Record<string, unknown>;
  }): void;
}

/** Map feed entry types to stream action types. */
const FEED_TO_STREAM_TYPE: Record<FeedEntryType, string> = {
  llm: "work",
  tool: "work",
  memory: "memory",
  decision: "decision",
  error: "error",
  state: "state",
};

// ---------------------------------------------------------------------------
// Per-agent feed
// ---------------------------------------------------------------------------

type FeedListener = (entry: FeedEntry) => void;

interface AgentFeed {
  listeners: Set<FeedListener>;
  /** Ring buffer of recent entries for late-joining clients. */
  recent: FeedEntry[];
}

const MAX_RECENT = 200;

class AgentFeedManager {
  private feeds = new Map<string, AgentFeed>();
  private readonly emitter = new EventEmitter();
  private streamBridge: StreamBridge | null = null;

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  /** Register a stream bridge for SSE forwarding. */
  setStreamBridge(bridge: StreamBridge): void {
    this.streamBridge = bridge;
  }

  /**
   * Push a feed entry for a specific agent.
   * Called by instrumentation hooks throughout the agent lifecycle.
   */
  push(entry: FeedEntry, skipStreamBridge = false): void {
    const feed = this.getOrCreateFeed(entry.agentId);

    // Store in ring buffer
    feed.recent.push(entry);
    if (feed.recent.length > MAX_RECENT) {
      feed.recent.shift();
    }

    // Broadcast to per-agent listeners
    for (const listener of feed.listeners) {
      try {
        listener(entry);
      } catch {
        feed.listeners.delete(listener);
      }
    }

    // Broadcast to global listeners
    this.emitter.emit("*", entry);

    // Bridge to live stream so feed events appear in the SSE stream pane.
    // Skip when caller already emitted via logActivity (avoids duplicates).
    if (!skipStreamBridge && this.streamBridge) {
      try {
        this.streamBridge.emit({
          agentId: entry.agentId,
          type: FEED_TO_STREAM_TYPE[entry.type] ?? "work",
          summary: entry.summary,
          detail: entry.detail,
        });
      } catch {
        // Stream bridge not ready — skip silently
      }
    }
  }

  /**
   * Subscribe to a specific agent's feed. Returns unsubscribe function.
   * On subscribe, replays recent entries for "just missed it" context.
   */
  subscribe(agentId: string, listener: FeedListener): () => void {
    const feed = this.getOrCreateFeed(agentId);
    feed.listeners.add(listener);

    // Replay recent entries
    for (const entry of feed.recent) {
      try {
        listener(entry);
      } catch {
        feed.listeners.delete(listener);
        return () => {};
      }
    }

    return () => {
      feed.listeners.delete(listener);
      // Clean up empty feeds
      if (feed.listeners.size === 0 && feed.recent.length === 0) {
        this.feeds.delete(agentId);
      }
    };
  }

  /**
   * Subscribe to ALL agents' feeds (global observer).
   * Useful for the operations view "all activity" stream.
   */
  subscribeAll(listener: FeedListener): () => void {
    const handler = (entry: FeedEntry) => listener(entry);
    this.emitter.on("*", handler);

    // Replay recent from all active feeds
    for (const [, feed] of this.feeds) {
      for (const entry of feed.recent) {
        try {
          listener(entry);
        } catch {
          this.emitter.off("*", handler);
          return () => {};
        }
      }
    }

    return () => {
      this.emitter.off("*", handler);
    };
  }

  /** Get active listener count for an agent. */
  getListenerCount(agentId: string): number {
    return this.feeds.get(agentId)?.listeners.size ?? 0;
  }

  /** Get recent entries for an agent (snapshot). */
  getRecent(agentId: string): FeedEntry[] {
    return [...(this.feeds.get(agentId)?.recent ?? [])];
  }

  /** Get all agent IDs with active feeds. */
  getActiveFeedIds(): string[] {
    return [...this.feeds.keys()];
  }

  /** Clean up a finished agent's feed (after all listeners disconnect). */
  cleanup(agentId: string): void {
    const feed = this.feeds.get(agentId);
    if (feed && feed.listeners.size === 0) {
      this.feeds.delete(agentId);
    }
  }

  private getOrCreateFeed(agentId: string): AgentFeed {
    let feed = this.feeds.get(agentId);
    if (!feed) {
      feed = { listeners: new Set(), recent: [] };
      this.feeds.set(agentId, feed);
    }
    return feed;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AgentFeedManager | null = null;

export function getAgentFeedManager(): AgentFeedManager {
  if (!instance) {
    instance = new AgentFeedManager();
  }
  return instance;
}

// ---------------------------------------------------------------------------
// Convenience: emit a feed entry
// ---------------------------------------------------------------------------

export function emitFeedEntry(
  agentId: string,
  type: FeedEntryType,
  summary: string,
  detail?: Record<string, unknown>,
  /** Set true when caller already emitted via logActivity (avoids duplicate stream actions). */
  skipStreamBridge = false,
): void {
  getAgentFeedManager().push({
    timestamp: new Date().toISOString(),
    agentId,
    type,
    summary,
    detail,
  }, skipStreamBridge);
}
