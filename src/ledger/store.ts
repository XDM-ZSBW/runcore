/**
 * Ledger store — append-only JSONL interaction log.
 *
 * Records entity interactions at brain/ledger/interactions.jsonl.
 * Supports filtered queries by entity, type, and time range.
 * Never deletes — uses status:"archived" for soft removal.
 */

import { join } from "node:path";
import {
  readBrainLines,
  appendBrainLine,
  ensureBrainJsonl,
} from "../lib/brain-io.js";
import { BRAIN_DIR } from "../lib/paths.js";
import type { InteractionType, InteractionLedgerEntry } from "./types.js";

const LEDGER_DIR = join(BRAIN_DIR, "ledger");
const LEDGER_FILE = join(LEDGER_DIR, "interactions.jsonl");

const SCHEMA_LINE = JSON.stringify({
  _schema: "interaction-ledger",
  _version: "1.0",
  _description:
    "Append-only interaction log for entity relationships. One JSON object per line.",
});

// ── In-memory cache ──────────────────────────────────────────────────────────

let entries: InteractionLedgerEntry[] = [];
let loaded = false;

// ── Internal helpers ─────────────────────────────────────────────────────────

function isInteractionLedgerEntry(obj: unknown): obj is InteractionLedgerEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.timestamp === "string" &&
    typeof e.type === "string" &&
    typeof e.entity === "string" &&
    typeof e.summary === "string"
  );
}

async function hydrate(): Promise<void> {
  await ensureBrainJsonl(LEDGER_FILE, SCHEMA_LINE);
  const lines = await readBrainLines(LEDGER_FILE);
  entries = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "_schema" in parsed) continue;
      if (!isInteractionLedgerEntry(parsed)) continue;
      if (parsed.status !== "archived") {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  loaded = true;
}

async function ensureLoaded(): Promise<void> {
  if (!loaded) await hydrate();
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Initialize the ledger. Call once at startup. */
export async function loadLedger(): Promise<void> {
  await hydrate();
}

/** Record a new interaction. Appends to JSONL and updates cache. */
export async function recordInteraction(
  type: InteractionType,
  entity: string,
  summary: string,
  meta?: Record<string, string>,
): Promise<InteractionLedgerEntry> {
  await ensureLoaded();
  const entry: InteractionLedgerEntry = {
    timestamp: new Date().toISOString(),
    type,
    entity,
    summary,
    status: "active",
    ...(meta ? { meta } : {}),
  };
  await appendBrainLine(LEDGER_FILE, JSON.stringify(entry));
  entries.push(entry);
  return entry;
}

/** Get all interactions for a specific entity. */
export async function getEntityInteractions(
  entity: string,
): Promise<InteractionLedgerEntry[]> {
  await ensureLoaded();
  return entries.filter((e) => e.entity === entity);
}

/** Get all interactions of a specific type. */
export async function getInteractionsByType(
  type: InteractionType,
): Promise<InteractionLedgerEntry[]> {
  await ensureLoaded();
  return entries.filter((e) => e.type === type);
}

/** Get interactions within a time range. */
export async function getInteractionsInRange(
  since: Date,
  until?: Date,
): Promise<InteractionLedgerEntry[]> {
  await ensureLoaded();
  const sinceMs = since.getTime();
  const untilMs = until?.getTime() ?? Date.now();
  return entries.filter((e) => {
    const ts = new Date(e.timestamp).getTime();
    return ts >= sinceMs && ts <= untilMs;
  });
}

/** Get all unique entity identifiers in the ledger. */
export async function listEntities(): Promise<string[]> {
  await ensureLoaded();
  return Array.from(new Set(entries.map((e) => e.entity)));
}

/** Get all active entries (for distance calculation). */
export async function getAllEntries(): Promise<InteractionLedgerEntry[]> {
  await ensureLoaded();
  return [...entries];
}

/** Get the most recent interaction with an entity. */
export async function getLastInteraction(
  entity: string,
): Promise<InteractionLedgerEntry | null> {
  await ensureLoaded();
  const entityEntries = entries.filter((e) => e.entity === entity);
  if (entityEntries.length === 0) return null;
  return entityEntries[entityEntries.length - 1]!;
}

/** Count interactions by entity. Returns a map of entity → count. */
export async function countByEntity(): Promise<Map<string, number>> {
  await ensureLoaded();
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.entity, (counts.get(e.entity) ?? 0) + 1);
  }
  return counts;
}
