/**
 * Canonical path constants for the Core runtime.
 * All brain path references import from here — no file defines its own BRAIN_DIR.
 *
 * Packages are code only, no data ever. The brain lives outside the package,
 * configured via CORE_BRAIN_DIR (or DASH_BRAIN_DIR) environment variable.
 * Default: process.cwd() + "brain" for backward compatibility.
 *
 * Brain structure (v2 — simplified):
 *   brain/
 *     log/      ← append-only JSONL. The trail. Never rewrite.
 *     files/    ← everything else. Searchable. Flat or shallow.
 *     .config/  ← settings, access policies, locked paths. Plumbing.
 *
 * Legacy paths (memory/, ops/, knowledge/, identity/, etc.) are resolved
 * with fallback for backward compatibility during migration.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { resolveEnv } from "../instance.js";

/** Absolute path to the brain data directory. */
export const BRAIN_DIR: string = resolve(
  resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"),
);

// ── v2 structure ──────────────────────────────────────────────────────────────

/** Append-only JSONL — the audit trail, memory, activity, metrics. */
export const LOG_DIR: string = join(BRAIN_DIR, "log");

/** Everything else — notes, research, identity, templates, contacts. Searchable. */
export const FILES_DIR: string = join(BRAIN_DIR, "files");

/** Settings, access policies, locked paths. Plumbing. */
export const CONFIG_DIR: string = join(BRAIN_DIR, ".config");

// ── Legacy path resolution ────────────────────────────────────────────────────

/** Map of legacy directory names to their v2 parent. */
const LEGACY_TO_LOG = ["memory", "ops", "metrics", "ledger"] as const;
const LEGACY_TO_FILES = [
  "identity", "knowledge", "content", "operations", "skills",
  "templates", "contacts", "calendar", "scheduling", "training",
  "agents", "library", "dictionary", "browser", "sessions",
  "registry", "channels", "vault", "files", "runtime",
  "calibration", "compliance", "membrane", "inference", "db",
  "compost",
] as const;

/**
 * Resolve a brain subdirectory, checking v2 structure first, falling back to legacy.
 * Use this for any path that might exist under old OR new layout.
 *
 * Example: resolveBrainDir("memory") → brain/log (if migrated) or brain/memory (legacy)
 */
export function resolveBrainDir(subdir: string): string {
  // Check v2 structure first
  if ((LEGACY_TO_LOG as readonly string[]).includes(subdir)) {
    const v2 = join(LOG_DIR, subdir);
    if (existsSync(v2)) return v2;
    // Fall back to legacy flat path
    const legacy = join(BRAIN_DIR, subdir);
    if (existsSync(legacy)) return legacy;
    return v2; // default to v2 for new files
  }

  if ((LEGACY_TO_FILES as readonly string[]).includes(subdir)) {
    const v2 = join(FILES_DIR, subdir);
    if (existsSync(v2)) return v2;
    const legacy = join(BRAIN_DIR, subdir);
    if (existsSync(legacy)) return legacy;
    return v2;
  }

  // Unknown subdir — check under brain/ directly
  return join(BRAIN_DIR, subdir);
}

/**
 * Detect whether this brain uses v2 structure.
 * True if brain/log/ exists. False means legacy layout.
 */
export function isBrainV2(): boolean {
  return existsSync(LOG_DIR);
}
