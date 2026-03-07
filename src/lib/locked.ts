/**
 * Centralized .locked file enforcement for brain paths.
 *
 * Shared by both MCP server (stdio) and direct file access (brain-io).
 * Ensures locked paths are consistently protected regardless of access channel.
 *
 * Lock rules:
 * - Exact path match (e.g. "identity/human.json")
 * - Filename-only match (e.g. ".session-key" matches "identity/.session-key")
 * - Directory prefix match (e.g. "identity/" matches "identity/foo.md")
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { BRAIN_DIR } from "./paths.js";
const LOCKED_FILE = join(BRAIN_DIR, ".locked");

/** Hardcoded minimum locked paths (always locked even without .locked file). */
const HARDCODED_LOCKED = [".session-key", "human.json"];

/** Cached locked paths (relative to brain/, forward slashes). */
let lockedPaths: string[] = [];
let loaded = false;

/**
 * Read brain/.locked and merge with hardcoded minimums. Caches result.
 * Safe to call multiple times — returns cached paths after first load.
 */
export async function loadLockedPaths(): Promise<string[]> {
  const paths = new Set<string>(HARDCODED_LOCKED);
  try {
    const raw = await readFile(LOCKED_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      paths.add(trimmed.replace(/\\/g, "/"));
    }
  } catch {
    // .locked file doesn't exist — use hardcoded only
  }
  lockedPaths = Array.from(paths);
  loaded = true;
  return lockedPaths;
}

/**
 * Synchronous variant — reads .locked file on first call, caches after.
 */
export function loadLockedPathsSync(): string[] {
  if (loaded) return lockedPaths;
  const paths = new Set<string>(HARDCODED_LOCKED);
  try {
    if (existsSync(LOCKED_FILE)) {
      const raw = readFileSync(LOCKED_FILE, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        paths.add(trimmed.replace(/\\/g, "/"));
      }
    }
  } catch {
    // .locked file doesn't exist — use hardcoded only
  }
  lockedPaths = Array.from(paths);
  loaded = true;
  return lockedPaths;
}

/** Force reload of locked paths (e.g. when listing current locks). */
export async function reloadLockedPaths(): Promise<string[]> {
  loaded = false;
  return loadLockedPaths();
}

/** Get the currently cached locked paths. Loads synchronously if not yet cached. */
export function getLockedPaths(): string[] {
  if (!loaded) loadLockedPathsSync();
  return lockedPaths;
}

/**
 * Check if a brain-relative path (forward slashes) is locked.
 * Matches exact paths, filename-only, and directory prefixes.
 */
export function isLocked(relPath: string): boolean {
  if (!loaded) loadLockedPathsSync();
  const normalized = relPath.replace(/\\/g, "/");
  for (const locked of lockedPaths) {
    // Exact match
    if (normalized === locked) return true;
    // Filename-only match (e.g. ".session-key" matches "identity/.session-key")
    const filename = normalized.split("/").pop() ?? "";
    if (filename === locked) return true;
    // Directory prefix match (e.g. locked="identity/" matches "identity/foo.md")
    if (locked.endsWith("/") && normalized.startsWith(locked)) return true;
  }
  return false;
}

/**
 * Convert an absolute file path to a brain-relative path.
 * Returns null if the path is not under brain/.
 */
export function toBrainRelativePath(absolutePath: string): string | null {
  try {
    const rel = relative(BRAIN_DIR, absolutePath);
    // Escapes brain/ — not a brain path
    if (rel.startsWith("..") || rel.startsWith("/")) return null;
    return rel.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

/**
 * Assert that an absolute path is not locked. Throws if locked.
 * No-op for paths outside brain/.
 */
export function assertNotLocked(absolutePath: string): void {
  const rel = toBrainRelativePath(absolutePath);
  if (rel === null) return; // Not a brain path — no lock applies
  if (isLocked(rel)) {
    throw new Error(`🔒 Locked: ${rel} — access denied`);
  }
}
