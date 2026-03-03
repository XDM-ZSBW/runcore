/**
 * Open Loop Protocol — type definitions.
 * Implements Layers 1 & 2 of the OLP spec (brain/knowledge/notes/open-loop-protocol.md).
 */

export type OpenLoopState = "active" | "resonant" | "dormant" | "expired";

export interface OpenLoopPacket {
  id: string;               // "ol_" + 8 hex
  createdAt: string;         // ISO timestamp
  anchor: string;            // Entity name — the "who/what"
  dissonance: string;        // The specific question/contradiction
  searchHeuristic: string[]; // Semantic "magnets" for scanning
  expiresAt: string;         // ISO timestamp — relevance threshold
  state: OpenLoopState;
  salience?: number;         // 0.0–1.0, exponential decay (DASH-94). Absent = 1.0.
  resolvedBy?: string;       // traceId when the loop closes
  triadId?: string;          // Link back to the originating Triad
}

export interface Triad {
  id: string;                 // "tr_" + 8 hex
  createdAt: string;          // ISO timestamp
  anchor: string;             // Core subject of the branch
  vectorShift: string;        // How understanding changed (the delta)
  residualTensions: string[]; // Open loop IDs
  openLoopIds: string[];      // IDs of created OpenLoopPackets
  sourceTraceId?: string;     // Activity trace that triggered fold-back
  sessionId?: string;         // Chat session that was folded back
}

export interface ResonanceMatch {
  loopId: string;
  matchedActivityId: number;
  matchedSource: string;
  matchedSummary: string;
  similarity: number;
  explanation: string;
}

export interface ScanRunSummary {
  ranAt: string;
  activeLoopsScanned: number;
  newEntriesScanned: number;
  resonancesFound: number;
}

export interface ResolutionMatch {
  loopId: string;
  signalId: string;           // "commit:<short-hash>" or activity entry id
  signalType: "commit" | "activity";
  signalSummary: string;
  similarity: number;
  confidence: "high" | "medium";
  explanation: string;
}

export interface ResolutionScanSummary {
  ranAt: string;
  resonantLoopsScanned: number;
  commitsScanned: number;
  activitiesScanned: number;
  resolutionsFound: number;
}

// ─── Loop Lifecycle types ───────────────────────────────────────────────────

export interface LoopImpactAction {
  loopId: string;
  action: "close" | "merge" | "flag";
  reason: string;
  mergeWith?: string;  // for merge action
}

export type LifecycleAction =
  | { type: "closed"; loopId: string; reason: string }
  | { type: "merged"; sourceIds: string[]; newLoopId: string; reason: string }
  | { type: "archived"; loopId: string; reason: string }
  | { type: "flagged"; loopId: string; reason: string };

export interface LifecycleConfig {
  staleDays: number;
  similarityThreshold: number;
  minConfidenceForArchive: number;
}

export interface LifecycleRunSummary {
  ranAt: string;
  reflectionActions: number;
  staleArchived: number;
  mergesPerformed: number;
  actions: LifecycleAction[];
}
