/**
 * Access Manifest Loader — per-instance access control for brain paths.
 *
 * Reads brain/.access/<instance>.yaml files that define which brain paths
 * each agent instance can read/write. Evaluation order:
 *   1. Deny globs — if path matches any deny pattern → denied
 *   2. Read/write globs — if path matches → allowed for that operation
 *   3. Default deny — if no pattern matches → denied
 *
 * Hand-rolled YAML parser (no external deps).
 */

import { readFile, readdir } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { matchAnyGlob } from "../lib/glob-match.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("access.manifest");

const BRAIN_DIR = resolve(process.cwd(), "brain");
const ACCESS_DIR = join(BRAIN_DIR, ".access");

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessManifest {
  /** Instance name (from filename). */
  instance: string;
  /** Agent role (e.g. "chief-of-staff", "administration"). */
  role: string;
  /** Glob patterns for denied paths (checked first). */
  deny: string[];
  /** Glob patterns for readable paths. */
  read: string[];
  /** Glob patterns for writable paths. */
  write: string[];
  /** Guest override — more restricted access for guest/delegation contexts. */
  guestOverride?: {
    deny: string[];
    read: string[];
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, AccessManifest>();
let allLoaded = false;

// ── YAML parser ──────────────────────────────────────────────────────────────

/**
 * Parse an access manifest YAML. Expected format:
 *
 *   role: administration
 *   deny:
 *     - memory/**
 *     - ops/audit.jsonl
 *   read:
 *     - operations/**
 *     - calendar/**
 *   write:
 *     - operations/todos.md
 *   guest_override:
 *     deny:
 *       - operations/goals.yaml
 *     read:
 *       - calendar/**
 */
function parseManifest(raw: string, instanceName: string): AccessManifest {
  const lines = raw.split("\n");

  let role = "";
  const deny: string[] = [];
  const read: string[] = [];
  const write: string[] = [];
  const guestDeny: string[] = [];
  const guestRead: string[] = [];

  // State machine: track which list we're appending to
  type ListTarget = "deny" | "read" | "write" | "guest_deny" | "guest_read" | null;
  let currentList: ListTarget = null;
  let inGuestOverride = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.match(/^\s*#/)) continue;

    // Detect indentation level
    const indent = (line.match(/^(\s*)/) ?? ["", ""])[1].length;

    // Top-level key: value
    if (indent === 0) {
      const kv = trimmed.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (kv) {
        const [, key, val] = kv;
        const unquoted = val.replace(/^["']|["']$/g, "").trim();
        if (key === "role") role = unquoted;
        currentList = null;
        inGuestOverride = false;
        continue;
      }

      // Section headers (key: with no value)
      const section = trimmed.match(/^(\w[\w_]*)\s*:\s*$/);
      if (section) {
        const key = section[1];
        if (key === "deny") { currentList = "deny"; inGuestOverride = false; }
        else if (key === "read") { currentList = "read"; inGuestOverride = false; }
        else if (key === "write") { currentList = "write"; inGuestOverride = false; }
        else if (key === "guest_override") { inGuestOverride = true; currentList = null; }
        else { currentList = null; inGuestOverride = false; }
        continue;
      }
    }

    // Nested section under guest_override (indent 2)
    if (inGuestOverride && indent >= 2) {
      const nested = trimmed.trim().match(/^(\w+)\s*:\s*$/);
      if (nested) {
        if (nested[1] === "deny") currentList = "guest_deny";
        else if (nested[1] === "read") currentList = "guest_read";
        continue;
      }
    }

    // List item
    const listItem = trimmed.match(/^\s+-\s+(.+)$/);
    if (listItem && currentList) {
      const pattern = listItem[1].replace(/^["']|["']$/g, "").trim();
      switch (currentList) {
        case "deny": deny.push(pattern); break;
        case "read": read.push(pattern); break;
        case "write": write.push(pattern); break;
        case "guest_deny": guestDeny.push(pattern); break;
        case "guest_read": guestRead.push(pattern); break;
      }
    }
  }

  const manifest: AccessManifest = { instance: instanceName, role, deny, read, write };
  if (guestDeny.length > 0 || guestRead.length > 0) {
    manifest.guestOverride = { deny: guestDeny, read: guestRead };
  }

  return manifest;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load a specific instance's access manifest.
 */
export async function loadManifest(instanceName: string): Promise<AccessManifest | null> {
  if (cache.has(instanceName)) return cache.get(instanceName)!;

  const filePath = join(ACCESS_DIR, `${instanceName}.yaml`);
  try {
    const raw = await readFile(filePath, "utf-8");
    const manifest = parseManifest(raw, instanceName);
    cache.set(instanceName, manifest);
    log.info("Access manifest loaded", {
      instance: instanceName,
      role: manifest.role,
      deny: manifest.deny.length,
      read: manifest.read.length,
      write: manifest.write.length,
    });
    return manifest;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log.debug(`No access manifest for ${instanceName}`);
    } else {
      log.warn(`Failed to parse manifest for ${instanceName}`, { error: err.message });
    }
    return null;
  }
}

/**
 * Load all access manifests from brain/.access/.
 */
export async function loadAllManifests(): Promise<Map<string, AccessManifest>> {
  try {
    const files = await readdir(ACCESS_DIR);
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const name = basename(file, ".yaml");
      await loadManifest(name);
    }
    allLoaded = true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log.debug("No .access/ directory found");
    } else {
      log.warn("Failed to read .access/ directory", { error: err.message });
    }
  }
  return cache;
}

/**
 * Check if an instance can read a brain-relative path.
 *
 * Evaluation:
 *   1. Deny globs → denied (guest_override.deny checked if isGuest)
 *   2. Read globs → allowed (guest_override.read checked if isGuest)
 *   3. Default → denied
 */
export function canRead(
  manifest: AccessManifest,
  relPath: string,
  isGuest = false,
): boolean {
  const normalized = relPath.replace(/\\/g, "/");

  // 1. Check deny list
  if (matchAnyGlob(manifest.deny, normalized)) return false;
  if (isGuest && manifest.guestOverride) {
    if (matchAnyGlob(manifest.guestOverride.deny, normalized)) return false;
  }

  // 2. Check read list
  if (matchAnyGlob(manifest.read, normalized)) return true;
  if (isGuest && manifest.guestOverride) {
    if (matchAnyGlob(manifest.guestOverride.read, normalized)) return true;
    // Guest only gets guest_override.read, not the full read list
    return false;
  }

  // 3. Default deny
  return false;
}

/**
 * Check if an instance can write a brain-relative path.
 * Guests cannot write (always denied).
 */
export function canWrite(
  manifest: AccessManifest,
  relPath: string,
  isGuest = false,
): boolean {
  if (isGuest) return false;

  const normalized = relPath.replace(/\\/g, "/");

  // 1. Check deny list
  if (matchAnyGlob(manifest.deny, normalized)) return false;

  // 2. Check write list
  if (matchAnyGlob(manifest.write, normalized)) return true;

  // 3. Default deny
  return false;
}

/**
 * Force reload all manifests.
 */
export async function reloadManifests(): Promise<Map<string, AccessManifest>> {
  cache.clear();
  allLoaded = false;
  return loadAllManifests();
}

/**
 * Get a cached manifest (returns null if not loaded).
 */
export function getManifest(instanceName: string): AccessManifest | null {
  return cache.get(instanceName) ?? null;
}
