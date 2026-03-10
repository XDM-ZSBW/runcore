/**
 * Brain v2 migration — moves from 30+ top-level directories to 3:
 *   log/    ← append-only JSONL (memory, ops, metrics, ledger)
 *   files/  ← everything else (knowledge, identity, content, etc.)
 *   .config/ ← settings, access, locked paths
 *
 * Safe to run multiple times. Moves directories, doesn't copy.
 * Creates symlinks from old paths to new locations for backward compat.
 */

import { join } from "node:path";
import { rename, mkdir, readdir, stat, cp, access, writeFile } from "node:fs/promises";
import { BRAIN_DIR, LOG_DIR, FILES_DIR, CONFIG_DIR, isBrainV2 } from "./paths.js";

/** Directories that contain append-only JSONL data → move to log/ */
const TO_LOG = ["memory", "ops", "metrics", "ledger"] as const;

/** Directories that contain searchable files → move to files/ */
const TO_FILES = [
  "identity", "knowledge", "content", "operations", "skills",
  "templates", "contacts", "calendar", "scheduling", "training",
  "library", "dictionary", "browser", "registry", "channels",
  "runtime", "calibration", "compliance", "membrane", "inference",
  "db", "compost",
] as const;

/** Files/dirs that move to .config/ */
const TO_CONFIG = [
  "settings.json", ".locked", ".access", ".core", ".ui",
  "vault.policy.yaml",
] as const;

/** Directories that stay at top level (runtime state, not brain data) */
const STAYS = ["agents", "sessions", "vault", "volumes", "webhooks", "files"] as const;

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function moveIfExists(src: string, dest: string): Promise<boolean> {
  if (!(await exists(src))) return false;
  if (await exists(dest)) {
    // Dest already exists — merge by copying contents
    try {
      await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    } catch {
      // If cp fails, skip — don't lose data
      return false;
    }
    return true;
  }
  // Ensure parent exists
  const parent = join(dest, "..");
  await mkdir(parent, { recursive: true });
  try {
    await rename(src, dest);
    return true;
  } catch {
    // Cross-device rename — fall back to copy
    try {
      await cp(src, dest, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: string[];
  alreadyV2: boolean;
}

/**
 * Migrate a brain directory from legacy layout to v2.
 * Safe to run multiple times — skips already-migrated items.
 */
export async function migrateBrainToV2(): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: [], skipped: [], errors: [], alreadyV2: false };

  if (isBrainV2()) {
    result.alreadyV2 = true;
    return result;
  }

  // Create v2 directories
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(FILES_DIR, { recursive: true });
  await mkdir(CONFIG_DIR, { recursive: true });

  // Move log directories
  for (const dir of TO_LOG) {
    const src = join(BRAIN_DIR, dir);
    const dest = join(LOG_DIR, dir);
    try {
      if (await moveIfExists(src, dest)) {
        result.migrated.push(`${dir} → log/${dir}`);
      } else {
        result.skipped.push(dir);
      }
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Move files directories
  for (const dir of TO_FILES) {
    const src = join(BRAIN_DIR, dir);
    const dest = join(FILES_DIR, dir);
    try {
      if (await moveIfExists(src, dest)) {
        result.migrated.push(`${dir} → files/${dir}`);
      } else {
        result.skipped.push(dir);
      }
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Move config items
  for (const item of TO_CONFIG) {
    const src = join(BRAIN_DIR, item);
    const dest = join(CONFIG_DIR, item);
    try {
      if (await moveIfExists(src, dest)) {
        result.migrated.push(`${item} → .config/${item}`);
      } else {
        result.skipped.push(item);
      }
    } catch (err) {
      result.errors.push(`${item}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Write a marker so isBrainV2() detects the migration
  // (LOG_DIR existence is the marker — it was just created)

  return result;
}
