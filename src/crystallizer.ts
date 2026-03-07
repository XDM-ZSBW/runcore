/**
 * Crystallizer — open loops as standing queries against the memory stream.
 *
 * An open loop is a question with a shape. Every new memory entry flows
 * past all active loops. If the entry's content matches the loop's query
 * geometry (word boundaries, concentration, co-occurrence), it sticks as
 * evidence. When enough evidence accumulates, the loop precipitates —
 * surfacing as a notification.
 *
 * The loop doesn't scan. It filters. The river moves. The net holds still.
 */

import { join } from "node:path";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "./lib/brain-io.js";
import type { MemoryEntry } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenLoop {
  id: string;
  query: string;              // The shape — search terms that define the net
  context: string;            // Why this loop exists
  evidence: EvidenceHit[];    // Memory IDs that stuck
  threshold: number;          // How many hits before precipitation
  minScore: number;           // Minimum match score to count as evidence
  status: "open" | "precipitated" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceHit {
  memoryId: string;
  score: number;
  snippet: string;            // First 200 chars of matching content
  matchedAt: string;
}

export interface PrecipitationEvent {
  loopId: string;
  query: string;
  context: string;
  evidenceCount: number;
  evidence: EvidenceHit[];
}

// ── Scoring (shared geometry with memory_retrieve) ───────────────────────────

export function scoreEntry(queryTerms: string[], queryLower: string, text: string): number {
  if (!text) return 0;

  // Word boundary matching
  const matched = queryTerms.filter((t) => {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return re.test(text);
  });
  if (matched.length === 0) return 0;

  const termScore = matched.length / queryTerms.length;
  const allTerms = matched.length === queryTerms.length ? 0.3 : 0;
  const phraseBonus = text.includes(queryLower) ? 0.5 : 0;
  const concentration = Math.min(1, 200 / Math.max(text.length, 1)) * 0.4;

  let proximityBonus = 0;
  if (matched.length >= 2) {
    const positions = matched.map((t) => text.indexOf(t));
    const span = Math.max(...positions) - Math.min(...positions);
    if (span < 100) proximityBonus = 0.2;
    else if (span < 300) proximityBonus = 0.1;
  }

  return termScore + allTerms + phraseBonus + concentration + proximityBonus;
}

// ── Crystallizer ─────────────────────────────────────────────────────────────

const SCHEMA_LINE = JSON.stringify({ _schema: "open-loops", _version: "1.0" });

function generateLoopId(): string {
  return `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class Crystallizer {
  private loops: OpenLoop[] = [];
  private filePath: string;
  private onPrecipitate?: (event: PrecipitationEvent) => void;

  constructor(memoryDir: string, onPrecipitate?: (event: PrecipitationEvent) => void) {
    this.filePath = join(memoryDir, "open-loops.jsonl");
    this.onPrecipitate = onPrecipitate;
  }

  /** Load all open loops from disk. Call once at startup. */
  async init(): Promise<void> {
    await ensureBrainJsonl(this.filePath, SCHEMA_LINE);
    const lines = await readBrainLines(this.filePath);
    this.loops = [];

    // Build latest state: later lines override earlier ones (same id)
    const loopMap = new Map<string, OpenLoop>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.id) loopMap.set(obj.id, obj as OpenLoop);
      } catch { continue; }
    }
    this.loops = Array.from(loopMap.values());
  }

  /** Create a new open loop. Returns the loop. */
  async open(query: string, context: string, threshold = 3, minScore = 0.4): Promise<OpenLoop> {
    const loop: OpenLoop = {
      id: generateLoopId(),
      query,
      context,
      evidence: [],
      threshold,
      minScore,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await appendBrainLine(this.filePath, JSON.stringify(loop));
    this.loops.push(loop);
    return loop;
  }

  /** Test a new memory entry against all open loops. Returns any precipitations. */
  async test(entry: MemoryEntry): Promise<PrecipitationEvent[]> {
    const precipitations: PrecipitationEvent[] = [];
    const activeLoops = this.loops.filter((l) => l.status === "open");

    for (const loop of activeLoops) {
      // Already have this memory as evidence?
      if (loop.evidence.some((e) => e.memoryId === entry.id)) continue;

      const queryLower = loop.query.toLowerCase();
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 1);
      if (terms.length === 0) continue;

      const text = [
        entry.content ?? "",
        entry.meta ? JSON.stringify(entry.meta) : "",
        (entry as any).summary ?? "",
        (entry as any).title ?? "",
      ].join(" ").toLowerCase();

      const score = scoreEntry(terms, queryLower, text);

      if (score >= loop.minScore) {
        const hit: EvidenceHit = {
          memoryId: entry.id,
          score,
          snippet: text.slice(0, 200),
          matchedAt: new Date().toISOString(),
        };
        loop.evidence.push(hit);
        loop.updatedAt = new Date().toISOString();

        // Check precipitation
        if (loop.evidence.length >= loop.threshold) {
          loop.status = "precipitated";
          const event: PrecipitationEvent = {
            loopId: loop.id,
            query: loop.query,
            context: loop.context,
            evidenceCount: loop.evidence.length,
            evidence: loop.evidence,
          };
          precipitations.push(event);
          this.onPrecipitate?.(event);
        }

        // Persist updated loop state
        await appendBrainLine(this.filePath, JSON.stringify(loop));
      }
    }

    return precipitations;
  }

  /** Manually resolve a loop (close it). */
  async resolve(loopId: string): Promise<OpenLoop | null> {
    const loop = this.loops.find((l) => l.id === loopId);
    if (!loop) return null;
    loop.status = "resolved";
    loop.updatedAt = new Date().toISOString();
    await appendBrainLine(this.filePath, JSON.stringify(loop));
    return loop;
  }

  /** List loops by status. */
  list(status?: "open" | "precipitated" | "resolved"): OpenLoop[] {
    if (status) return this.loops.filter((l) => l.status === status);
    return [...this.loops];
  }

  /** Get a specific loop by ID. */
  get(loopId: string): OpenLoop | null {
    return this.loops.find((l) => l.id === loopId) ?? null;
  }
}
