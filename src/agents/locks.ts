/**
 * File-level locking system for agent concurrency control.
 *
 * Prevents concurrent agents from editing the same files by maintaining
 * a lock registry persisted to brain/agents/locks.json.
 *
 * Features:
 * - Atomic lock acquisition (all-or-nothing for a set of files)
 * - Consistent lock ordering (sorted by path) to prevent deadlocks
 * - Lock timeout (default 30 min) for crashed agent cleanup
 * - Auto-cleanup on agent completion/failure
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("file-locks");

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileLock {
  /** Absolute or relative file path being locked. */
  filePath: string;
  /** Agent task ID holding the lock. */
  agentId: string;
  /** Agent label (for display). */
  agentLabel: string;
  /** ISO timestamp when the lock was acquired. */
  acquiredAt: string;
  /** Lock timeout in ms. After this duration, the lock is considered stale. */
  timeoutMs: number;
}

export interface LockState {
  locks: FileLock[];
  lastUpdated: string;
}

export interface LockConflict {
  filePath: string;
  heldBy: {
    agentId: string;
    agentLabel: string;
    acquiredAt: string;
  };
}

export interface AcquireResult {
  acquired: boolean;
  conflicts: LockConflict[];
}

// ── Constants ────────────────────────────────────────────────────────────────

import { BRAIN_DIR } from "../lib/paths.js";
const LOCKS_FILE = join(BRAIN_DIR, "agents", "locks.json");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── In-memory mutex for serializing lock file access ─────────────────────────

let writeLock: Promise<void> = Promise.resolve();

/**
 * Serialize access to the lock file to prevent race conditions
 * between concurrent lock/unlock operations within this process.
 */
function withLockFile<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function readLockState(): Promise<LockState> {
  try {
    const raw = await readFile(LOCKS_FILE, "utf-8");
    return JSON.parse(raw) as LockState;
  } catch {
    return { locks: [], lastUpdated: new Date().toISOString() };
  }
}

async function writeLockState(state: LockState): Promise<void> {
  state.lastUpdated = new Date().toISOString();
  await mkdir(dirname(LOCKS_FILE), { recursive: true });
  await writeFile(LOCKS_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ── Staleness ────────────────────────────────────────────────────────────────

function isLockStale(lock: FileLock): boolean {
  const elapsed = Date.now() - new Date(lock.acquiredAt).getTime();
  return elapsed > lock.timeoutMs;
}

/** Remove expired locks from state. Returns the cleaned state. */
function pruneStale(state: LockState): { state: LockState; pruned: FileLock[] } {
  const pruned: FileLock[] = [];
  const kept: FileLock[] = [];
  for (const lock of state.locks) {
    if (isLockStale(lock)) {
      pruned.push(lock);
    } else {
      kept.push(lock);
    }
  }
  return { state: { ...state, locks: kept }, pruned };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire locks on a set of files for an agent.
 *
 * Uses consistent ordering (sorted paths) to prevent deadlocks.
 * Acquisition is all-or-nothing: either all files are locked or none.
 * Stale locks are automatically cleaned before checking.
 */
export async function acquireLocks(
  agentId: string,
  agentLabel: string,
  filePaths: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AcquireResult> {
  if (filePaths.length === 0) {
    return { acquired: true, conflicts: [] };
  }

  return withLockFile(async () => {
    let state = await readLockState();

    // Prune stale locks first
    const { state: cleaned, pruned } = pruneStale(state);
    state = cleaned;
    if (pruned.length > 0) {
      log.info(`Pruned ${pruned.length} stale lock(s): ${pruned.map((l) => l.filePath).join(", ")}`);
    }

    // Sort paths for consistent ordering (deadlock prevention)
    const sortedPaths = [...new Set(filePaths)].sort();

    // Check for conflicts (files locked by a different agent)
    const conflicts: LockConflict[] = [];
    for (const fp of sortedPaths) {
      const existing = state.locks.find((l) => l.filePath === fp && l.agentId !== agentId);
      if (existing) {
        conflicts.push({
          filePath: fp,
          heldBy: {
            agentId: existing.agentId,
            agentLabel: existing.agentLabel,
            acquiredAt: existing.acquiredAt,
          },
        });
      }
    }

    if (conflicts.length > 0) {
      log.warn(`Lock conflict for agent "${agentLabel}" (${agentId}): ${conflicts.map((c) => `${c.filePath} held by ${c.heldBy.agentId}`).join(", ")}`);
      await writeLockState(state); // persist stale pruning even on conflict
      return { acquired: false, conflicts };
    }

    // All clear — acquire all locks atomically
    const now = new Date().toISOString();
    for (const fp of sortedPaths) {
      // Remove any existing lock by this same agent on this file (re-acquire)
      state.locks = state.locks.filter((l) => !(l.filePath === fp && l.agentId === agentId));
      state.locks.push({
        filePath: fp,
        agentId,
        agentLabel,
        acquiredAt: now,
        timeoutMs,
      });
    }

    await writeLockState(state);
    log.info(`Acquired ${sortedPaths.length} lock(s) for agent "${agentLabel}" (${agentId}): ${sortedPaths.join(", ")}`);
    return { acquired: true, conflicts: [] };
  });
}

/**
 * Release all locks held by an agent.
 * Called on agent completion, failure, or cancellation.
 */
export async function releaseLocks(agentId: string): Promise<number> {
  return withLockFile(async () => {
    const state = await readLockState();
    const before = state.locks.length;
    state.locks = state.locks.filter((l) => l.agentId !== agentId);
    const released = before - state.locks.length;

    if (released > 0) {
      await writeLockState(state);
      log.info(`Released ${released} lock(s) for agent ${agentId}`);
    }
    return released;
  });
}

/**
 * Release a lock on a specific file held by a specific agent.
 */
export async function releaseFileLock(agentId: string, filePath: string): Promise<boolean> {
  return withLockFile(async () => {
    const state = await readLockState();
    const idx = state.locks.findIndex((l) => l.agentId === agentId && l.filePath === filePath);
    if (idx === -1) return false;

    state.locks.splice(idx, 1);
    await writeLockState(state);
    log.info(`Released lock on "${filePath}" for agent ${agentId}`);
    return true;
  });
}

/**
 * Force-release a lock on a file regardless of which agent holds it.
 * Use for manual intervention / admin cleanup.
 */
export async function forceReleaseLock(filePath: string): Promise<boolean> {
  return withLockFile(async () => {
    const state = await readLockState();
    const idx = state.locks.findIndex((l) => l.filePath === filePath);
    if (idx === -1) return false;

    const lock = state.locks[idx];
    state.locks.splice(idx, 1);
    await writeLockState(state);
    log.info(`Force-released lock on "${filePath}" (was held by ${lock.agentId})`);
    return true;
  });
}

/**
 * List all active (non-stale) locks. Prunes stale locks as a side effect.
 */
export async function listLocks(): Promise<FileLock[]> {
  return withLockFile(async () => {
    const state = await readLockState();
    const { state: cleaned, pruned } = pruneStale(state);

    if (pruned.length > 0) {
      await writeLockState(cleaned);
      log.info(`Pruned ${pruned.length} stale lock(s) during list`);
    }

    return cleaned.locks;
  });
}

/**
 * Get all locks held by a specific agent.
 */
export async function getLocksForAgent(agentId: string): Promise<FileLock[]> {
  const state = await readLockState();
  return state.locks.filter((l) => l.agentId === agentId && !isLockStale(l));
}

/**
 * Check if specific files are locked (by any agent).
 * Returns conflicts for locked files, empty array if all clear.
 */
export async function checkLocks(filePaths: string[]): Promise<LockConflict[]> {
  const state = await readLockState();
  const conflicts: LockConflict[] = [];

  for (const fp of filePaths) {
    const lock = state.locks.find((l) => l.filePath === fp && !isLockStale(l));
    if (lock) {
      conflicts.push({
        filePath: fp,
        heldBy: {
          agentId: lock.agentId,
          agentLabel: lock.agentLabel,
          acquiredAt: lock.acquiredAt,
        },
      });
    }
  }

  return conflicts;
}

/**
 * Prune all stale locks and persist. Called periodically by the agent monitor.
 * Returns the number of locks pruned.
 */
export async function pruneAllStaleLocks(): Promise<number> {
  return withLockFile(async () => {
    const state = await readLockState();
    const { state: cleaned, pruned } = pruneStale(state);

    if (pruned.length > 0) {
      await writeLockState(cleaned);
      log.info(`Pruned ${pruned.length} stale lock(s): ${pruned.map((l) => `${l.filePath} (agent ${l.agentId})`).join(", ")}`);
    }

    return pruned.length;
  });
}
