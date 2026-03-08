/**
 * Calibration Store — append-only JSONL history + current thresholds file.
 *
 * Storage layout:
 *   brain/calibration/history.jsonl  — every calibration, append-only
 *   brain/calibration/current.json   — current active thresholds (JSON)
 *
 * Uses brain-io for transparent encryption support.
 */

import { join } from "node:path";
import {
  appendBrainLine,
  readBrainLines,
  ensureBrainFileSync,
  ensureDirSync,
  readBrainFile,
  writeBrainFile,
} from "../lib/brain-io.js";
import { createLogger } from "../utils/logger.js";
import type {
  CalibrationResult,
  CalibrationThresholds,
  CalibrationDelta,
  DotThresholds,
  CalibrationSource,
} from "./types.js";

const log = createLogger("calibration:store");

// ── File paths ───────────────────────────────────────────────────────────────

const SCHEMA_LINE = '{"_schema":"calibration","version":1,"fields":["version","date","thresholds","derived","source","delta"]}';

let historyPath: string | null = null;
let currentPath: string | null = null;

export function initCalibrationStore(brainDir: string): void {
  const calibrationDir = join(brainDir, "calibration");
  ensureDirSync(calibrationDir);
  historyPath = join(calibrationDir, "history.jsonl");
  currentPath = join(calibrationDir, "current.json");
  ensureBrainFileSync(historyPath, SCHEMA_LINE);
  log.info("Calibration store initialized", { historyPath, currentPath });
}

function getHistoryPath(): string {
  if (!historyPath) throw new Error("Calibration store not initialized — call initCalibrationStore first");
  return historyPath;
}

function getCurrentPath(): string {
  if (!currentPath) throw new Error("Calibration store not initialized — call initCalibrationStore first");
  return currentPath;
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Save a completed calibration result.
 * Appends to history and overwrites current.
 */
export async function saveCalibration(result: CalibrationResult): Promise<void> {
  await appendBrainLine(getHistoryPath(), JSON.stringify(result));
  await writeBrainFile(getCurrentPath(), JSON.stringify(result, null, 2));
  log.info("Calibration saved", { version: result.version, source: result.source });
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get the current active calibration, or null if never calibrated.
 */
export async function getCurrentCalibration(): Promise<CalibrationResult | null> {
  try {
    const content = await readBrainFile(getCurrentPath());
    return JSON.parse(content) as CalibrationResult;
  } catch {
    return null;
  }
}

/**
 * Get the full calibration history, oldest first.
 */
export async function getCalibrationHistory(): Promise<CalibrationResult[]> {
  const lines = await readBrainLines(getHistoryPath());
  const results: CalibrationResult[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed._schema) continue;
      if (parsed.version !== undefined && parsed.thresholds) {
        results.push(parsed as CalibrationResult);
      }
    } catch { /* skip malformed */ }
  }
  return results;
}

/**
 * Get the latest calibration version number, or 0 if never calibrated.
 */
export async function getLatestVersion(): Promise<number> {
  const current = await getCurrentCalibration();
  return current?.version ?? 0;
}

// ── Delta computation ────────────────────────────────────────────────────────

/**
 * Compute the delta between two threshold sets.
 * Returns only changed fields.
 */
export function computeDelta(
  previous: CalibrationThresholds,
  next: CalibrationThresholds,
): CalibrationDelta | undefined {
  const delta: CalibrationDelta = {};
  for (const key of Object.keys(next) as (keyof CalibrationThresholds)[]) {
    if (previous[key] !== next[key]) {
      delta[key] = { from: previous[key], to: next[key] };
    }
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a CalibrationResult from thresholds, computing version and delta.
 */
export async function buildCalibrationResult(
  thresholds: CalibrationThresholds,
  derived: DotThresholds,
  source: CalibrationSource,
): Promise<CalibrationResult> {
  const previous = await getCurrentCalibration();
  const version = (previous?.version ?? 0) + 1;
  const delta = previous ? computeDelta(previous.thresholds, thresholds) : undefined;

  return {
    version,
    date: new Date().toISOString().split("T")[0],
    thresholds,
    derived,
    source,
    ...(delta ? { delta } : {}),
  };
}

/**
 * Check if the store has ever been calibrated.
 */
export async function isCalibrated(): Promise<boolean> {
  const current = await getCurrentCalibration();
  return current !== null;
}

// ── Trigger counter persistence ──────────────────────────────────────────────

export interface TriggerCounters {
  interactions: number;
  tickCycles: number;
  savedAt: string;
}

function getCountersPath(): string {
  if (!currentPath) throw new Error("Calibration store not initialized");
  return currentPath.replace("current.json", "counters.json");
}

export async function saveTriggerCounters(counters: TriggerCounters): Promise<void> {
  await writeBrainFile(getCountersPath(), JSON.stringify(counters, null, 2));
}

export async function loadTriggerCounters(): Promise<TriggerCounters | null> {
  try {
    const content = await readBrainFile(getCountersPath());
    return JSON.parse(content) as TriggerCounters;
  } catch {
    return null;
  }
}
