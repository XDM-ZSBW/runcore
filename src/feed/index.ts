/**
 * Feed module — public API.
 * Wires FeedClient + MixingEngine + Metrics into a single facade.
 *
 * Portability: Field/compost resonance is injectable via ResonanceComputer.
 * Without it, the feed works — compost signals are simply skipped.
 */

import { FeedClient } from "./client.js";
import { MixingEngine, type ResonanceComputer, type FieldShape } from "./mixer.js";
import { FeedMetricsCollector } from "./metrics.js";
import type { FeedConfig, FeedItem, FeedTier, MixedInsight, FeedStatus } from "./types.js";
import type { LongTermMemoryStore } from "../memory/long-term.js";
import type { WorkingMemory } from "../types.js";

export interface FeedOptions {
  config: FeedConfig;
  ltm: LongTermMemoryStore;
  /** Optional resonance computer for compost signal filtering. */
  resonanceComputer?: ResonanceComputer;
  /** Optional initial field shape for compost resonance. */
  fieldShape?: FieldShape;
}

export class Feed {
  private client: FeedClient;
  private mixer: MixingEngine;
  private metricsCollector: FeedMetricsCollector;
  private ltm: LongTermMemoryStore;
  private workingMemory: WorkingMemory | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: FeedOptions) {
    this.client = new FeedClient(options.config);
    this.mixer = new MixingEngine();
    this.metricsCollector = new FeedMetricsCollector(options.config.tier);
    this.ltm = options.ltm;

    if (options.resonanceComputer) {
      this.mixer.setResonanceComputer(options.resonanceComputer);
    }
    if (options.fieldShape) {
      this.mixer.setFieldShape(options.fieldShape);
    }
  }

  /** Start the feed. Brain/agents/nerves work without this — it's additive. */
  start(): void {
    this.unsubscribe = this.client.onItems(items => this.handleNewItems(items));
    this.client.start();
  }

  /** Stop the feed. Everything else keeps working. */
  stop(): void {
    this.client.stop();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Update working memory reference (call each turn so mixer has fresh context). */
  setWorkingMemory(wm: WorkingMemory): void {
    this.workingMemory = wm;
  }

  /** Update the local field shape (refreshes resonance in the mixer). */
  setFieldShape(shape: FieldShape): void {
    this.mixer.setFieldShape(shape);
  }

  /** Set the resonance computer for compost signal processing. */
  setResonanceComputer(computer: ResonanceComputer): void {
    this.mixer.setResonanceComputer(computer);
  }

  /** Get mixed insights relevant to a query, for injection into context assembly. */
  getInsightsForContext(query: string, limit = 3): MixedInsight[] {
    const insights = this.mixer.getRelevantInsights(query, limit);
    for (const _ of insights) {
      this.metricsCollector.recordInsightSurfaced();
    }
    return insights;
  }

  /** Get all recent insights sorted by relevance. */
  getInsights(limit = 10): MixedInsight[] {
    return this.mixer.getInsights(limit);
  }

  /** Format insights as a context block for injection into supporting content. */
  formatInsightsForContext(query: string, limit = 3): string {
    const insights = this.getInsightsForContext(query, limit);
    if (insights.length === 0) return "";

    const lines = insights.map(i =>
      `- [${i.feedSignalType}] ${i.insight} (relevance: ${(i.relevance * 100).toFixed(0)}%)`
    );
    return `Feed insights:\n${lines.join("\n")}`;
  }

  /** Current tier. */
  get tier(): FeedTier {
    return this.client.getStatus().tier;
  }

  /** Update subscription tier. */
  setTier(tier: FeedTier): void {
    this.client.setTier(tier);
    this.metricsCollector.setTier(tier);
  }

  /** Feed health status. */
  getStatus(): FeedStatus {
    const clientStatus = this.client.getStatus();
    return {
      ...clientStatus,
      insightsGenerated: this.mixer.insightCount,
      avgRelevance: this.mixer.avgRelevance,
    };
  }

  /** Feed metrics for dashboards/reporting. */
  getMetrics() {
    return this.metricsCollector.getMetrics();
  }

  /** Access the mixing engine for custom strategy registration. */
  getMixer(): MixingEngine {
    return this.mixer;
  }

  // --- Private ---

  private async handleNewItems(items: FeedItem[]): Promise<void> {
    this.metricsCollector.setConnected(true);
    this.metricsCollector.recordItemsReceived(
      items.length,
      items.map(i => i.type),
    );

    const insights = await this.mixer.mix(items, this.ltm, this.workingMemory);
    if (insights.length > 0) {
      this.metricsCollector.recordInsights(insights);
    }
  }
}

// Re-export public types and utilities
export type {
  FeedConfig,
  FeedItem,
  FeedTier,
  FeedSignalType,
  FeedStatus,
  MixedInsight,
  TierCapabilities,
} from "./types.js";
export { FeedClient } from "./client.js";
export { MixingEngine, type MixStrategy, type LocalContext, type BrainStats, type ResonanceComputer, type FieldShape, type CompostSignal, type ResonanceResult } from "./mixer.js";
export { FeedMetricsCollector, type FeedMetrics } from "./metrics.js";
export { getTierCapabilities, tierMeetsMinimum, filterByTier, isSignalAvailable } from "./tiers.js";
