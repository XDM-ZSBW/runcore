/**
 * Open Loop Protocol — JSONL persistence.
 * Append-only, follows src/memory/file-backed.ts pattern.
 * Two files: brain/memory/open-loops.jsonl, brain/memory/triads.jsonl.
 * All encrypted at rest via brain-io.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import type { OpenLoopPacket, OpenLoopState, Triad } from "./types.js";

const log = createLogger("open-loop-store");

function loopsFile(): string {
  return join(process.cwd(), "brain", "memory", "open-loops.jsonl");
}
function triadsFile(): string {
  return join(process.cwd(), "brain", "memory", "triads.jsonl");
}

const LOOPS_SCHEMA = {
  _schema: "open-loops",
  _version: "1.0",
  _description: "Append-only open loop packets. Last line per ID wins for state transitions.",
};

const TRIADS_SCHEMA = {
  _schema: "triads",
  _version: "1.0",
  _description: "Append-only triads from branch fold-back.",
};

function generateLoopId(): string {
  return "ol_" + randomBytes(4).toString("hex");
}

function generateTriadId(): string {
  return "tr_" + randomBytes(4).toString("hex");
}

/** Create a new open loop and write to JSONL. Salience initialized to 1.0 (DASH-94). */
export async function createLoop(opts: {
  anchor: string;
  dissonance: string;
  searchHeuristic: string[];
  expiresAt?: string;
  triadId?: string;
}): Promise<OpenLoopPacket> {
  const now = new Date();
  const packet: OpenLoopPacket = {
    id: generateLoopId(),
    createdAt: now.toISOString(),
    anchor: opts.anchor,
    dissonance: opts.dissonance,
    searchHeuristic: opts.searchHeuristic,
    expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    state: "active",
    salience: 1.0,
    triadId: opts.triadId,
  };

  await ensureBrainJsonl(loopsFile(), JSON.stringify(LOOPS_SCHEMA));
  await appendBrainLine(loopsFile(), JSON.stringify(packet));
  log.info(`Created loop ${packet.id}: "${packet.dissonance}"`);
  return packet;
}

/**
 * Load all loops, collapsing by ID (last line wins for state transitions).
 * Schema lines and malformed lines are skipped.
 */
export async function loadLoops(): Promise<OpenLoopPacket[]> {
  const lines = await readBrainLines(loopsFile());
  const byId = new Map<string, OpenLoopPacket>();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj._schema) continue;
      if (typeof obj.id === "string" && obj.id.startsWith("ol_")) {
        byId.set(obj.id, obj as unknown as OpenLoopPacket);
      }
    } catch {
      continue;
    }
  }

  return Array.from(byId.values());
}

/** Load loops filtered by state. */
export async function loadLoopsByState(state: OpenLoopState): Promise<OpenLoopPacket[]> {
  const all = await loadLoops();
  return all.filter((l) => l.state === state);
}

/**
 * Transition a loop to a new state. Appends a new line (old line stays).
 * Returns the updated packet, or null if the loop is already in the target state.
 */
export async function transitionLoop(
  id: string,
  newState: OpenLoopState,
  resolvedBy?: string,
): Promise<OpenLoopPacket | null> {
  const all = await loadLoops();
  const existing = all.find((l) => l.id === id);
  if (!existing) {
    log.warn(`Loop ${id} not found for transition`);
    return null;
  }

  // State guard: skip if already in target state (prevents duplicate appends)
  if (existing.state === newState) {
    log.info(`Loop ${id}: already ${newState} — skipping duplicate transition`);
    return existing;
  }

  const updated: OpenLoopPacket = {
    ...existing,
    state: newState,
    resolvedBy: resolvedBy ?? existing.resolvedBy,
  };

  await appendBrainLine(loopsFile(), JSON.stringify(updated));
  log.info(`Loop ${id}: ${existing.state} → ${newState}`);
  return updated;
}

/** Update a loop's salience value (DASH-94). Appends a new line with updated salience. */
export async function updateLoopSalience(
  id: string,
  salience: number,
): Promise<OpenLoopPacket | null> {
  const all = await loadLoops();
  const existing = all.find((l) => l.id === id);
  if (!existing) {
    log.warn(`Loop ${id} not found for salience update`);
    return null;
  }

  const updated: OpenLoopPacket = { ...existing, salience };
  await appendBrainLine(loopsFile(), JSON.stringify(updated));
  log.info(`Loop ${id}: salience → ${salience.toFixed(3)}`);
  return updated;
}

/** Create a new triad and write to JSONL. */
export async function createTriad(opts: {
  anchor: string;
  vectorShift: string;
  residualTensions: string[];
  openLoopIds: string[];
  sourceTraceId?: string;
  sessionId?: string;
}): Promise<Triad> {
  const triad: Triad = {
    id: generateTriadId(),
    createdAt: new Date().toISOString(),
    anchor: opts.anchor,
    vectorShift: opts.vectorShift,
    residualTensions: opts.residualTensions,
    openLoopIds: opts.openLoopIds,
    sourceTraceId: opts.sourceTraceId,
    sessionId: opts.sessionId,
  };

  await ensureBrainJsonl(triadsFile(), JSON.stringify(TRIADS_SCHEMA));
  await appendBrainLine(triadsFile(), JSON.stringify(triad));
  log.info(`Created triad ${triad.id}: anchor="${triad.anchor}"`);
  return triad;
}

/** Load all triads from JSONL. */
export async function loadTriads(): Promise<Triad[]> {
  const lines = await readBrainLines(triadsFile());
  const triads: Triad[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj._schema) continue;
      if (typeof obj.id === "string" && obj.id.startsWith("tr_")) {
        triads.push(obj as unknown as Triad);
      }
    } catch {
      continue;
    }
  }

  return triads;
}
