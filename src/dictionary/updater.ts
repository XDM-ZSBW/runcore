/**
 * Dictionary Protocol — Update checker.
 *
 * Timer-based wrapper around DictionaryClient:
 * - Boot sync on startup (forced check)
 * - Periodic checks (configurable interval, default 24h)
 * - Graceful offline handling
 *
 * Sidecar/timer pattern: module-level state, idempotent start/stop.
 */

import { DictionaryClient } from "./client.js";
import type { SyncResult } from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dictionary");

const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface DictionaryUpdaterConfig {
  brainDir: string;
  apiBase?: string;
  checkIntervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let client: DictionaryClient | null = null;
let lastResult: SyncResult | null = null;

function logSyncResult(result: SyncResult, context: string): void {
  switch (result.status) {
    case "updated":
      log.info(`${context}: updated ${result.localVersion}`, {
        remote: result.remoteVersion,
        changes: result.changes?.summary,
      });
      break;
    case "current":
      log.info(`${context}: current at ${result.localVersion}`);
      break;
    case "offline":
      log.warn(`${context}: offline — using cached dictionary ${result.localVersion}`);
      break;
  }
}

export async function startDictionaryUpdater(
  config: DictionaryUpdaterConfig,
): Promise<SyncResult> {
  if (timer) {
    return lastResult ?? { status: "current", localVersion: "0.0.0" };
  }

  client = new DictionaryClient({
    brainDir: config.brainDir,
    apiBase: config.apiBase,
    syncIntervalMs: config.checkIntervalMs,
  });

  const bootResult = await client.bootSync();
  lastResult = bootResult;
  logSyncResult(bootResult, "Boot sync");

  const interval =
    config.checkIntervalMs ??
    (parseInt(process.env.DICTIONARY_CHECK_INTERVAL_MS ?? "", 10) || DEFAULT_CHECK_INTERVAL_MS);

  timer = setInterval(async () => {
    if (!client) return;
    try {
      const result = await client.tickCheck();
      lastResult = result;
      if (result.status === "updated") {
        logSyncResult(result, "Periodic sync");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Dictionary check failed: ${msg}`);
    }
  }, interval);

  const hrs = Math.round(interval / 3_600_000);
  log.info(`Dictionary updater started: checking every ${hrs}h`);

  return bootResult;
}

export function stopDictionaryUpdater(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  client = null;
  lastResult = null;
}

export function isDictionaryUpdaterRunning(): boolean {
  return timer !== null;
}

export function getLastSyncResult(): SyncResult | null {
  return lastResult;
}

export function getDictionaryClient(): DictionaryClient | null {
  return client;
}
