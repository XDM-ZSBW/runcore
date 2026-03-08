/**
 * Runtime Lock — PID file with port for instance discovery.
 *
 * On startup: writes brain/runtime/instance.json with pid, port, name, startedAt.
 * On shutdown: deletes it.
 * Discovery: other processes read the file to find running instances.
 *
 * Stale lock detection: if the PID in the file isn't running, the lock is stale
 * and gets cleaned up automatically.
 */

import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_DIR } from "./lib/paths.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("runtime-lock");

const RUNTIME_DIR = join(BRAIN_DIR, "runtime");
const LOCK_FILE = join(RUNTIME_DIR, "instance.json");

export interface RuntimeLock {
  pid: number;
  port: number;
  name: string;
  brainDir: string;
  startedAt: string;
}

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the runtime lock file. Call after the server starts
 * and the actual port is known.
 */
export function acquireLock(port: number, name: string): RuntimeLock {
  mkdirSync(RUNTIME_DIR, { recursive: true });

  // Check for existing lock — might be stale
  const existing = readLock();
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      log.warn(`Another instance is already running (pid=${existing.pid}, port=${existing.port}, name=${existing.name})`);
      // Don't block — multiple instances are valid (different brains, or intentional)
    } else {
      log.info(`Cleaning stale lock from pid=${existing.pid}`);
    }
  }

  const lock: RuntimeLock = {
    pid: process.pid,
    port,
    name,
    brainDir: BRAIN_DIR,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
  log.info(`Lock acquired: pid=${lock.pid}, port=${lock.port}, name=${lock.name}`);

  return lock;
}

/**
 * Release the runtime lock file. Call during graceful shutdown.
 * Only deletes if the lock belongs to this process (prevents
 * a shutting-down instance from deleting a freshly-started one's lock).
 */
export function releaseLock(): void {
  try {
    const existing = readLock();
    if (existing && existing.pid === process.pid) {
      unlinkSync(LOCK_FILE);
      log.info("Lock released");
    }
  } catch {
    // File already gone or unreadable — fine
  }
}

/**
 * Read the current lock file. Returns null if no lock exists
 * or the file is malformed.
 */
export function readLock(): RuntimeLock | null {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    const raw = readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(raw) as RuntimeLock;
  } catch {
    return null;
  }
}

/**
 * Discover a running instance from the lock file.
 * Returns the lock if the process is alive, null otherwise.
 * Cleans up stale locks automatically.
 */
export function discoverRunning(): RuntimeLock | null {
  const lock = readLock();
  if (!lock) return null;

  if (isProcessAlive(lock.pid)) {
    return lock;
  }

  // Stale — clean up
  try {
    unlinkSync(LOCK_FILE);
    log.info(`Cleaned stale lock: pid=${lock.pid}`);
  } catch { /* already gone */ }

  return null;
}

/**
 * Get the port from the last runtime lock, regardless of whether
 * the process is still alive. Used for sticky port on restart.
 * Returns 0 if no previous lock found.
 */
export function getLastPort(): number {
  const lock = readLock();
  return lock?.port ?? 0;
}

/**
 * Discover running instances across multiple brain directories.
 * Useful for finding all Core instances on this machine.
 */
export function discoverAll(brainDirs: string[]): RuntimeLock[] {
  const running: RuntimeLock[] = [];

  for (const dir of brainDirs) {
    const lockPath = join(dir, "runtime", "instance.json");
    try {
      if (!existsSync(lockPath)) continue;
      const raw = readFileSync(lockPath, "utf-8");
      const lock = JSON.parse(raw) as RuntimeLock;

      if (isProcessAlive(lock.pid)) {
        running.push(lock);
      } else {
        // Stale — clean up
        try { unlinkSync(lockPath); } catch { /* ok */ }
      }
    } catch {
      // Skip unreadable
    }
  }

  return running;
}
