/**
 * Vault Policy Loader — classifies brain paths into access tiers.
 *
 * Reads brain/vault.policy.yaml and caches on first load.
 * Tiers: open | community | secured. Default from `default_tier` field.
 *
 * Hand-rolled YAML parser (no external deps). Reuses pattern from
 * sensitive-registry.ts.
 */

import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchAnyGlob } from "../lib/glob-match.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("vault.policy");

import { BRAIN_DIR } from "../lib/paths.js";
const POLICY_FILE = join(BRAIN_DIR, "vault.policy.yaml");

// ── Types ────────────────────────────────────────────────────────────────────

export type VaultTier = "open" | "community" | "secured";

export interface VaultPolicy {
  owner: string;
  tiers: {
    open: string[];
    community: string[];
    secured: string[];
  };
  defaultTier: VaultTier;
}

// ── Cache ────────────────────────────────────────────────────────────────────

let cached: VaultPolicy | null = null;

// ── YAML parser ──────────────────────────────────────────────────────────────

/**
 * Parse the vault.policy.yaml format. Expects:
 *   owner: <string>
 *   tiers:
 *     open:
 *       - pattern
 *     community:
 *       - pattern
 *     secured:
 *       - pattern
 *   default_tier: <tier>
 */
function parseVaultPolicy(raw: string): VaultPolicy {
  const lines = raw.split("\n");

  let owner = "";
  let defaultTier: VaultTier = "community";
  const tiers: VaultPolicy["tiers"] = { open: [], community: [], secured: [] };

  let currentTier: VaultTier | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip comments and empty lines
    if (!trimmed || trimmed.match(/^\s*#/)) continue;

    // Top-level key: value
    const topKv = trimmed.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (topKv) {
      const [, key, val] = topKv;
      const unquoted = val.replace(/^["']|["']$/g, "").trim();
      if (key === "owner") owner = unquoted;
      else if (key === "default_tier") {
        if (unquoted === "open" || unquoted === "community" || unquoted === "secured") {
          defaultTier = unquoted;
        }
      }
      currentTier = null;
      continue;
    }

    // Tier header (indented under tiers:)
    const tierHeader = trimmed.match(/^\s+(open|community|secured)\s*:\s*$/);
    if (tierHeader) {
      currentTier = tierHeader[1] as VaultTier;
      continue;
    }

    // List item under a tier
    const listItem = trimmed.match(/^\s+-\s+(.+)$/);
    if (listItem && currentTier) {
      const pattern = listItem[1].replace(/^["']|["']$/g, "").trim();
      tiers[currentTier].push(pattern);
      continue;
    }

    // "tiers:" header line (no value)
    if (trimmed.match(/^tiers\s*:\s*$/)) {
      currentTier = null;
      continue;
    }
  }

  return { owner, tiers, defaultTier };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and cache the vault policy. Returns cached on subsequent calls.
 */
export async function loadVaultPolicy(): Promise<VaultPolicy> {
  if (cached) return cached;
  try {
    const raw = await readFile(POLICY_FILE, "utf-8");
    cached = parseVaultPolicy(raw);
    log.info("Vault policy loaded", {
      owner: cached.owner,
      open: cached.tiers.open.length,
      community: cached.tiers.community.length,
      secured: cached.tiers.secured.length,
    });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log.warn("No vault.policy.yaml found — defaulting all paths to community");
    } else {
      log.warn("Failed to parse vault.policy.yaml", { error: err.message });
    }
    cached = { owner: "", tiers: { open: [], community: [], secured: [] }, defaultTier: "community" };
  }
  return cached;
}

/**
 * Synchronous load — for use where async is not available.
 */
export function loadVaultPolicySync(): VaultPolicy {
  if (cached) return cached;
  try {
    if (existsSync(POLICY_FILE)) {
      const raw = readFileSync(POLICY_FILE, "utf-8");
      cached = parseVaultPolicy(raw);
    } else {
      cached = { owner: "", tiers: { open: [], community: [], secured: [] }, defaultTier: "community" };
    }
  } catch {
    cached = { owner: "", tiers: { open: [], community: [], secured: [] }, defaultTier: "community" };
  }
  return cached;
}

/**
 * Get the cached policy (loads synchronously if not yet cached).
 */
export function getVaultPolicy(): VaultPolicy {
  if (!cached) loadVaultPolicySync();
  return cached!;
}

/**
 * Classify a brain-relative path into a vault tier.
 * Checks secured first (most restrictive), then open, then community.
 * Falls back to default_tier if no pattern matches.
 */
export function classifyPath(relPath: string): VaultTier {
  const policy = getVaultPolicy();

  // Check most restrictive first
  if (matchAnyGlob(policy.tiers.secured, relPath)) return "secured";
  if (matchAnyGlob(policy.tiers.open, relPath)) return "open";
  if (matchAnyGlob(policy.tiers.community, relPath)) return "community";

  return policy.defaultTier;
}

/**
 * Force reload of vault policy (e.g. after policy file changes).
 */
export async function reloadVaultPolicy(): Promise<VaultPolicy> {
  cached = null;
  return loadVaultPolicy();
}
