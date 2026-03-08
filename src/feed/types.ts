/**
 * Feed types — public/paid signal streams from runcore.sh
 * mixed locally with private brain data.
 */

/** Subscription tier levels. */
export type FeedTier = "free" | "personal" | "family" | "host";

/** Categories of feed signal. */
export type FeedSignalType =
  | "dictionary_update"    // spec/pattern changes
  | "security_patch"       // membrane rule updates
  | "release_notes"        // open source releases
  | "community_signal"     // anonymized aggregate trends
  | "protocol_update"      // tunnel/relay spec changes
  | "pattern_intelligence" // paid: aggregated cross-field patterns
  | "curated_model"        // paid: fine-tuned model weights/prompts
  | "deep_dictionary"      // paid: extended specs/guides
  | "federation_signal"    // paid: network activity shape
  | "early_access"         // paid: pre-release capabilities
  | "compost";             // cross-field compost signals (resonance-filtered locally)

/** A single item from the feed stream. */
export interface FeedItem {
  id: string;
  type: FeedSignalType;
  /** Minimum tier required to receive this item. */
  minTier: FeedTier;
  /** ISO timestamp from runcore.sh. */
  publishedAt: string;
  /** ISO timestamp when received locally. */
  receivedAt: string;
  /** Human-readable title. */
  title: string;
  /** The signal payload — structure varies by type. */
  payload: Record<string, unknown>;
  /** TTL in seconds; 0 = never expires. */
  ttl: number;
}

/** Result of mixing a feed item with local brain context. */
export interface MixedInsight {
  /** The feed item that triggered this insight. */
  feedItemId: string;
  feedSignalType: FeedSignalType;
  /** The locally-generated insight text. */
  insight: string;
  /** Relevance score 0-1 (how applicable to this brain). */
  relevance: number;
  /** Which local data contributed (type only, never content). */
  localSources: string[];
  /** ISO timestamp of mix computation. */
  mixedAt: string;
}

/** Feed client configuration. */
export interface FeedConfig {
  /** runcore.sh feed endpoint URL. */
  feedUrl: string;
  /** Host registration fingerprint for auth. */
  hostFingerprint?: string;
  /** Current subscription tier. */
  tier: FeedTier;
  /** Poll interval in ms for batch mode. Default 3600000 (1 hour). */
  pollIntervalMs?: number;
  /** Max items to cache locally. Default 500. */
  maxCachedItems?: number;
  /** Whether to use SSE for real-time updates (paid tiers). */
  useSSE?: boolean;
}

/** Tier capability map — what each tier unlocks. */
export interface TierCapabilities {
  tier: FeedTier;
  signalTypes: FeedSignalType[];
  relayPriority: "standard" | "priority";
  envelopeTtlDays: number;
  maxHosts: number;
  sseEnabled: boolean;
  /** Monthly price in USD cents. 0 = free tier. */
  priceMonthly: number;
}

/** Feed health/status for metrics. */
export interface FeedStatus {
  connected: boolean;
  tier: FeedTier;
  lastReceivedAt: string | null;
  itemsCached: number;
  insightsGenerated: number;
  /** Average relevance of recent mixed insights. */
  avgRelevance: number;
}
