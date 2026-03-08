/**
 * MixingEngine — the core of the feed business model.
 * Combines public/paid feed signal with private local brain data.
 *
 * KEY INVARIANT: Private data never leaves this host.
 * The mix is computed locally. runcore.sh never sees the result.
 *
 * Portability: ResonanceComputer is injectable. The compost/field system
 * injects the concrete implementation at runtime. Without it, compost
 * signals are simply skipped — all other strategies work standalone.
 */

import type { FeedItem, MixedInsight, FeedSignalType } from "./types.js";
import type { MemoryEntry, WorkingMemory } from "../types.js";
import type { LongTermMemoryStore } from "../memory/long-term.js";

// ─── Injectable resonance interface ─────────────────────────────────────────

/** Shape of a field — opaque to the mixer, interpreted by the resonance computer. */
export type FieldShape = Record<string, number>;

/** Compost signal extracted from a feed item payload. */
export interface CompostSignal {
  id: string;
  signalType: string;
  pattern: Record<string, unknown>;
  originShape: FieldShape;
  producedAt: string;
  receivedAt: string;
}

/** Result of computing resonance between a compost signal and a local field. */
export interface ResonanceResult {
  score: number;
  shouldSurface: boolean;
  dimensions: Array<{ dimension: string; similarity: number }>;
}

/** Injectable interface for computing compost resonance. */
export interface ResonanceComputer {
  compute(signal: CompostSignal, localShape: FieldShape): ResonanceResult;
}

// ─── Strategy interface ─────────────────────────────────────────────────────

/** Strategy for mixing a specific signal type with local data. */
export interface MixStrategy {
  signalType: FeedSignalType;
  /** Compute a mixed insight from a feed item + local context. Returns null if not relevant. */
  mix(item: FeedItem, localContext: LocalContext): MixedInsight | null;
}

/** Local context snapshot provided to mix strategies. Never transmitted. */
export interface LocalContext {
  recentMemories: MemoryEntry[];
  workingMemory: WorkingMemory | null;
  /** Summary stats about the brain (counts, not content). */
  brainStats: BrainStats;
}

export interface BrainStats {
  totalMemories: number;
  episodicCount: number;
  semanticCount: number;
  proceduralCount: number;
  activeGoal: string | null;
  agentCount: number;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class MixingEngine {
  private strategies: Map<FeedSignalType, MixStrategy> = new Map();
  private insights: MixedInsight[] = [];
  private maxInsights = 100;
  private fieldShape: FieldShape | null = null;
  private resonanceComputer: ResonanceComputer | null = null;

  constructor() {
    // Register built-in strategies
    this.registerStrategy(patternIntelligenceStrategy);
    this.registerStrategy(securityPatchStrategy);
    this.registerStrategy(dictionaryUpdateStrategy);
    this.registerStrategy(communitySignalStrategy);
    this.registerStrategy(this.createCompostStrategy());
  }

  /** Set the local field shape for compost resonance filtering. */
  setFieldShape(shape: FieldShape): void {
    this.fieldShape = shape;
  }

  /** Set the resonance computer for compost signal processing. */
  setResonanceComputer(computer: ResonanceComputer): void {
    this.resonanceComputer = computer;
  }

  private createCompostStrategy(): MixStrategy {
    return {
      signalType: "compost",
      mix: (item: FeedItem, _ctx: LocalContext): MixedInsight | null => {
        if (!this.fieldShape || !this.resonanceComputer) return null;

        // Extract compost signal from feed item payload
        const signal: CompostSignal = {
          id: item.id,
          signalType: (item.payload["signalType"] as string) ?? "unknown",
          pattern: (item.payload["pattern"] as Record<string, unknown>) ?? {},
          originShape: item.payload["originShape"] as FieldShape,
          producedAt: item.publishedAt,
          receivedAt: item.receivedAt,
        };

        if (!signal.originShape) return null;

        const result = this.resonanceComputer!.compute(signal, this.fieldShape!);

        if (!result.shouldSurface) return null;

        return {
          feedItemId: item.id,
          feedSignalType: "compost",
          insight: `Compost pattern "${item.title}" resonates with your field (${(result.score * 100).toFixed(0)}%). Signal type: ${signal.signalType}.`,
          relevance: result.score,
          localSources: result.dimensions
            .filter(d => d.similarity > 0.7)
            .map(d => d.dimension),
          mixedAt: new Date().toISOString(),
        };
      },
    };
  }

  /** Register a custom mix strategy for a signal type. */
  registerStrategy(strategy: MixStrategy): void {
    this.strategies.set(strategy.signalType, strategy);
  }

  /**
   * Mix a batch of feed items with local brain context.
   * Returns only the insights that are relevant (relevance > 0).
   */
  async mix(items: FeedItem[], ltm: LongTermMemoryStore, workingMemory: WorkingMemory | null): Promise<MixedInsight[]> {
    const localContext = await this.buildLocalContext(ltm, workingMemory);
    const newInsights: MixedInsight[] = [];

    for (const item of items) {
      const strategy = this.strategies.get(item.type);
      if (!strategy) continue;

      const insight = strategy.mix(item, localContext);
      if (insight && insight.relevance > 0) {
        newInsights.push(insight);
      }
    }

    // Store insights
    this.insights.push(...newInsights);
    if (this.insights.length > this.maxInsights) {
      this.insights = this.insights.slice(-this.maxInsights);
    }

    return newInsights;
  }

  /** Get recent mixed insights, sorted by relevance. */
  getInsights(limit = 10): MixedInsight[] {
    return [...this.insights]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  /** Get insights relevant to a query (simple keyword match on insight text). */
  getRelevantInsights(query: string, limit = 5): MixedInsight[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return this.getInsights(limit);

    return this.insights
      .filter(i => terms.some(t => i.insight.toLowerCase().includes(t)))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  /** Total insights generated (for metrics). */
  get insightCount(): number {
    return this.insights.length;
  }

  /** Average relevance of stored insights. */
  get avgRelevance(): number {
    if (this.insights.length === 0) return 0;
    const sum = this.insights.reduce((acc, i) => acc + i.relevance, 0);
    return sum / this.insights.length;
  }

  private async buildLocalContext(ltm: LongTermMemoryStore, workingMemory: WorkingMemory | null): Promise<LocalContext> {
    const [episodic, semantic, procedural] = await Promise.all([
      ltm.list("episodic"),
      ltm.list("semantic"),
      ltm.list("procedural"),
    ]);

    const allMemories = [...episodic, ...semantic, ...procedural];
    const recentMemories = allMemories
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50); // last 50 for mix context

    return {
      recentMemories,
      workingMemory,
      brainStats: {
        totalMemories: allMemories.length,
        episodicCount: episodic.length,
        semanticCount: semantic.length,
        proceduralCount: procedural.length,
        activeGoal: workingMemory?.activeGoal ?? null,
        agentCount: 0, // populated by caller if needed
      },
    };
  }
}

// --- Built-in mix strategies ---

const patternIntelligenceStrategy: MixStrategy = {
  signalType: "pattern_intelligence",
  mix(item: FeedItem, ctx: LocalContext): MixedInsight | null {
    const pattern = item.payload["pattern"] as string | undefined;
    if (!pattern) return null;

    // Check if pattern is relevant to local brain state
    const patternTerms = pattern.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const matchingMemories = ctx.recentMemories.filter(m =>
      patternTerms.some(t => m.content.toLowerCase().includes(t))
    );

    if (matchingMemories.length === 0) return null;

    const relevance = Math.min(1, matchingMemories.length / 5);
    const localSources = [...new Set(matchingMemories.map(m => m.type))];

    return {
      feedItemId: item.id,
      feedSignalType: item.type,
      insight: `Field pattern "${item.title}" may apply to your brain. ${matchingMemories.length} local memories relate to this pattern.`,
      relevance,
      localSources,
      mixedAt: new Date().toISOString(),
    };
  },
};

const securityPatchStrategy: MixStrategy = {
  signalType: "security_patch",
  mix(item: FeedItem, _ctx: LocalContext): MixedInsight | null {
    // Security patches are always relevant
    return {
      feedItemId: item.id,
      feedSignalType: item.type,
      insight: `Security update: ${item.title}. Apply immediately.`,
      relevance: 1.0,
      localSources: ["membrane"],
      mixedAt: new Date().toISOString(),
    };
  },
};

const dictionaryUpdateStrategy: MixStrategy = {
  signalType: "dictionary_update",
  mix(item: FeedItem, ctx: LocalContext): MixedInsight | null {
    const topics = (item.payload["topics"] as string[] | undefined) ?? [];
    if (topics.length === 0) {
      return {
        feedItemId: item.id,
        feedSignalType: item.type,
        insight: `Dictionary update: ${item.title}.`,
        relevance: 0.5,
        localSources: [],
        mixedAt: new Date().toISOString(),
      };
    }

    // Check overlap with local procedural/semantic knowledge
    const matchCount = ctx.recentMemories.filter(m =>
      topics.some(t => m.content.toLowerCase().includes(t.toLowerCase()))
    ).length;

    const relevance = matchCount > 0 ? Math.min(1, 0.3 + matchCount * 0.15) : 0.3;

    return {
      feedItemId: item.id,
      feedSignalType: item.type,
      insight: `Dictionary update: ${item.title}. ${matchCount > 0 ? `Touches ${matchCount} areas of your existing knowledge.` : "New area for your brain."}`,
      relevance,
      localSources: matchCount > 0 ? ["semantic", "procedural"] : [],
      mixedAt: new Date().toISOString(),
    };
  },
};

const communitySignalStrategy: MixStrategy = {
  signalType: "community_signal",
  mix(item: FeedItem, ctx: LocalContext): MixedInsight | null {
    const trend = item.payload["trend"] as string | undefined;
    if (!trend) return null;

    // Light relevance based on brain size — more active brains benefit more from community signal
    const relevance = ctx.brainStats.totalMemories > 100 ? 0.6 :
                      ctx.brainStats.totalMemories > 10  ? 0.4 : 0.2;

    return {
      feedItemId: item.id,
      feedSignalType: item.type,
      insight: `Community trend: ${item.title}. ${trend}`,
      relevance,
      localSources: ["aggregate"],
      mixedAt: new Date().toISOString(),
    };
  },
};
