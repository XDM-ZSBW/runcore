/**
 * Activity log — in-memory with JSONL persistence.
 * Appends to brain/ops/activity.jsonl so history survives restarts.
 * Hydrates from disk on first access (lazy).
 * All entries encrypted at rest via brain-io.
 */

import { join } from "node:path";
import { createReadStream, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import {
  appendBrainLineSync,
  appendBrainLine,
  ensureBrainFileSync,
} from "../lib/brain-io.js";
import { getPressureIntegrator } from "../pulse/pressure.js";
import { BRAIN_DIR } from "../lib/paths.js";

// --- SSE subscribers ---
type ActivityListener = (entry: ActivityEntry) => void;
const activityListeners = new Set<ActivityListener>();
export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn);
  return () => { activityListeners.delete(fn); };
}

const log = createLogger("activity");

/** Generate a short, unique trace ID: ts_ + 12 hex chars. */
export function generateTraceId(): string {
  return "ts_" + randomBytes(6).toString("hex");
}

export type ActionLabel = "PROMPTED" | "AUTONOMOUS" | "REFLECTIVE";

export interface ActivityEntry {
  id: number;
  timestamp: string;
  source: "goal-loop" | "ingest" | "learn" | "search" | "browse" | "system" | "agent" | "avatar" | "board" | "google" | "calendar" | "gmail" | "tasks" | "slack" | "whatsapp" | "resend" | "autonomous" | "open-loop" | "scheduling";
  summary: string;
  detail?: string;
  traceId: string;
  backref?: string;
  actionLabel?: ActionLabel;
  reason?: string;
}

// ─── File path ───────────────────────────────────────────────────────────────

const OPS_DIR = join(BRAIN_DIR, "ops");
const ACTIVITY_FILE = join(OPS_DIR, "activity.jsonl");
const SCHEMA_LINE = JSON.stringify({ _schema: "activity", _version: "1.0" });

// ─── State ───────────────────────────────────────────────────────────────────

const RETENTION_MS = 24 * 60 * 60 * 1000; // 24-hour retention window
const MAX_IN_MEMORY = 15_000; // safety cap (~40h at peak rates)
const EVICT_CHECK_INTERVAL = 50; // run time-based eviction every N inserts

let entries: ActivityEntry[] = [];
let nextId = 1;
let hydrated = false;
let writeReady = false;
let fileEnsured = false;
let insertsSinceEvict = 0;

// ─── Logger cache ────────────────────────────────────────────────────────────

const loggerCache = new Map<string, ReturnType<typeof createLogger>>();

function getCachedLogger(source: string): ReturnType<typeof createLogger> {
  let cached = loggerCache.get(source);
  if (!cached) {
    cached = createLogger(source);
    loggerCache.set(source, cached);
  }
  return cached;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureFile(): void {
  if (fileEnsured) return;
  ensureBrainFileSync(ACTIVITY_FILE, SCHEMA_LINE);
  fileEnsured = true;
}

/**
 * Cheap write-readiness check. Reads only the last ~8KB of the file
 * (enough for ~30 JSON lines) to determine `nextId`.
 * Called by logActivity() during startup instead of full hydrate(),
 * so provider registrations don't pay the full-file-read cost.
 */
function ensureWriteReady(): void {
  if (writeReady || hydrated) return;
  writeReady = true;

  try {
    ensureFile();

    let fd: number;
    try {
      fd = openSync(ACTIVITY_FILE, "r");
    } catch {
      return; // file doesn't exist yet — nextId stays at 1
    }

    try {
      const stat = fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize === 0) return;

      // Read only the tail — 8KB is plenty for ~30 JSON lines
      const TAIL_BYTES = 8192;
      const readStart = Math.max(0, fileSize - TAIL_BYTES);
      const readLen = fileSize - readStart;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, readStart);
      const tail = buf.toString("utf-8");

      // Scan tail lines (last 30 non-empty) for the highest id
      const lines = tail.split("\n");
      const TAIL_SIZE = 30;
      let scanned = 0;
      for (let i = lines.length - 1; i >= 0 && scanned < TAIL_SIZE; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        scanned++;
        try {
          const obj = JSON.parse(line);
          if (obj._schema) continue;
          if (typeof obj.id === "number" && obj.id >= nextId) {
            nextId = obj.id + 1;
          }
        } catch {
          // skip malformed / partial lines (first line may be truncated)
        }
      }
      log.debug(`Write-ready: nextId=${nextId} (scanned ${scanned} tail lines, read ${readLen}B of ${fileSize}B)`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    log.warn(`Failed to init write-ready: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Load existing entries from disk using a streaming line reader.
 * Processes the JSONL file incrementally via readline — never loads the
 * entire file into a single string, keeping memory pressure low even for
 * 10k+ line files. Called once, lazily — only by read paths.
 */
let hydratePromise: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = doHydrate();
  return hydratePromise;
}

async function doHydrate(): Promise<void> {
  hydrated = true;
  writeReady = true; // full hydrate subsumes write-ready

  try {
    ensureFile();
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const recent: ActivityEntry[] = [];

    const rl = createInterface({
      input: createReadStream(ACTIVITY_FILE, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;

      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue; // skip schema header
        if (obj.id && obj.timestamp && obj.source) {
          if (obj.id >= nextId) nextId = obj.id + 1;
          // Only collect entries within the 24h window
          if (obj.timestamp >= cutoff) {
            recent.push(obj as ActivityEntry);
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Cap at MAX_IN_MEMORY (keep most recent)
    entries = recent.length > MAX_IN_MEMORY
      ? recent.slice(recent.length - MAX_IN_MEMORY)
      : recent;

    if (entries.length > 0) {
      nextId = Math.max(nextId, entries[entries.length - 1].id + 1);
    }

    log.info(`Hydrated ${entries.length} activity entries from disk (streaming)`);
  } catch (err) {
    log.warn(`Failed to hydrate activity log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Append a single entry to the JSONL file. Fire-and-forget.
 * Uses async I/O to avoid blocking the event loop during startup
 * (webhook provider registration triggers multiple logActivity calls).
 * Falls back to sync I/O if the async write fails.
 */
function persistEntry(entry: ActivityEntry): void {
  try {
    ensureFile();
    const json = JSON.stringify(entry);
    // Use async append — fire-and-forget to unblock the event loop.
    // This is safe because in-memory entries[] is the source of truth;
    // disk is only for persistence across restarts.
    appendBrainLine(ACTIVITY_FILE, json).catch((err) => {
      // Async write failed — fall back to sync as last resort
      try {
        appendBrainLineSync(ACTIVITY_FILE, json);
      } catch {
        log.warn(`Failed to persist activity entry: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch (err) {
    log.warn(`Failed to persist activity entry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Append an activity entry, persist to disk, and echo to console. */
export function logActivity(opts: {
  source: ActivityEntry["source"];
  summary: string;
  detail?: string;
  traceId?: string;
  backref?: string;
  actionLabel?: ActionLabel;
  reason?: string;
}): ActivityEntry {
  ensureWriteReady();

  const entry: ActivityEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    source: opts.source,
    summary: opts.summary,
    detail: opts.detail,
    traceId: opts.traceId ?? generateTraceId(),
    backref: opts.backref,
    actionLabel: opts.actionLabel,
    reason: opts.reason,
  };
  entries.push(entry);

  // Time-based eviction: periodically trim entries older than 24h.
  // Amortised across inserts so we don't scan on every call.
  insertsSinceEvict++;
  if (insertsSinceEvict >= EVICT_CHECK_INTERVAL) {
    insertsSinceEvict = 0;
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    // entries are chronologically sorted — find first entry within window
    let trimIndex = 0;
    while (trimIndex < entries.length && entries[trimIndex].timestamp < cutoff) {
      trimIndex++;
    }
    if (trimIndex > 0) {
      entries = entries.slice(trimIndex);
    }
  }

  // Hard safety cap (shouldn't normally trigger with time-based eviction)
  if (entries.length > MAX_IN_MEMORY) {
    entries = entries.slice(entries.length - MAX_IN_MEMORY);
  }
  persistEntry(entry);
  getCachedLogger(entry.source).info(entry.summary);

  // Feed event into pressure integrator (if initialized)
  getPressureIntegrator()?.addTension(entry.source, entry.summary);

  // Notify SSE subscribers
  for (const fn of activityListeners) {
    try { fn(entry); } catch {}
  }

  return entry;
}

/** Return entries with id > since (for efficient polling). */
export async function getActivities(since?: number): Promise<ActivityEntry[]> {
  await hydrate();
  if (since == null) return [...entries];
  return entries.filter((e) => e.id > since);
}

/** Return entries matching the given IDs (for branch context). */
export async function getActivitiesByIds(ids: number[]): Promise<ActivityEntry[]> {
  await hydrate();
  const idSet = new Set(ids);
  return entries.filter((e) => idSet.has(e.id));
}

/** Return entries matching the given trace IDs. */
export async function getActivitiesByTraceIds(traceIds: string[]): Promise<ActivityEntry[]> {
  await hydrate();
  const idSet = new Set(traceIds);
  return entries.filter((e) => idSet.has(e.traceId));
}
