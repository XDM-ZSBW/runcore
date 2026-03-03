/**
 * FIFO notification queue for goal loop → chat turn communication.
 * Background goal checks push messages here; the next chat turn drains them.
 * Persisted to encrypted JSONL so notifications survive server restarts.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import {
  readBrainLinesSync,
  appendBrainLine,
  appendBrainLineSync,
  ensureBrainFileSync,
  writeBrainLines,
} from "../lib/brain-io.js";

const log = createLogger("notifications");

// ─── File path ───────────────────────────────────────────────────────────────

const OPS_DIR = join(process.cwd(), "brain", "operations");
const NOTIF_FILE = join(OPS_DIR, "notifications.jsonl");
const SCHEMA_LINE = JSON.stringify({ _schema: "notifications", _version: "1.0" });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GoalNotification {
  id?: string;        // generated if not provided — existing callers unchanged
  timestamp: string;  // ISO
  source: string;
  message: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

const queue: GoalNotification[] = [];
let hydrated = false;

// ─── Persistence ─────────────────────────────────────────────────────────────

/** Load existing notifications from disk. Called once, lazily. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;

  try {
    ensureBrainFileSync(NOTIF_FILE, SCHEMA_LINE);
    const lines = readBrainLinesSync(NOTIF_FILE);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue; // skip schema header
        if (obj.timestamp && obj.source && obj.message) {
          queue.push(obj as GoalNotification);
        }
      } catch {
        // skip malformed lines
      }
    }

    if (queue.length > 0) {
      log.info(`Hydrated ${queue.length} pending notification(s) from disk`);
    }
  } catch (err) {
    log.warn(`Failed to hydrate notifications: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Persist a single notification to disk. Fire-and-forget.
 * Uses async I/O with sync fallback, matching activity/log.ts pattern.
 */
function persistEntry(entry: GoalNotification): void {
  try {
    ensureBrainFileSync(NOTIF_FILE, SCHEMA_LINE);
    const json = JSON.stringify(entry);
    appendBrainLine(NOTIF_FILE, json).catch((err) => {
      try {
        appendBrainLineSync(NOTIF_FILE, json);
      } catch {
        log.warn(`Failed to persist notification: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch (err) {
    log.warn(`Failed to persist notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Add a notification for the user's next chat turn. */
export function pushNotification(notification: GoalNotification): void {
  hydrate();
  const entry: GoalNotification = {
    ...notification,
    id: notification.id ?? randomBytes(4).toString("hex"),
  };
  queue.push(entry);
  persistEntry(entry);
}

/** Return and clear all pending notifications, compacting the file. */
export async function drainNotifications(): Promise<GoalNotification[]> {
  hydrate();
  const drained = queue.splice(0, queue.length);

  if (drained.length > 0) {
    // Compact: rewrite file with just the schema line (queue is empty)
    writeBrainLines(NOTIF_FILE, [SCHEMA_LINE]).catch((err) => {
      log.warn(`Failed to compact notifications file: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return drained;
}

/** Check if there are pending notifications without consuming them. */
export function hasPendingNotifications(): boolean {
  return queue.length > 0;
}

/** Pre-warm: hydrate from disk during server startup. Returns count of loaded notifications. */
export async function initNotifications(): Promise<number> {
  hydrate();
  return queue.length;
}
