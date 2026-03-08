/**
 * Chain Length Literacy — computes brain maturity from accumulated JSONL chains.
 *
 * Chain length = total non-schema, non-archived lines across all memory JSONL files.
 * This is the brain's "page count" — how much it has written and experienced.
 *
 * Literacy = derived tier from chain length. Higher literacy → richer membrane
 * resolution (more retrieved items, deeper context extraction, better pattern
 * recognition). New instances start with base literacy from composted templates
 * rather than zero.
 *
 * The key insight: chain length IS literacy IS ability to read the membrane/goo.
 * A brain with 10 chains can barely parse its environment. A brain with 5000
 * chains reads the membrane like a native language.
 */

import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createLogger } from "./utils/logger.js";
import { BRAIN_DIR } from "./lib/paths.js";

const log = createLogger("literacy");

// ─── Literacy tiers ──────────────────────────────────────────────────────────

export type LiteracyTier = "embryonic" | "nascent" | "literate" | "fluent" | "native";

export interface LiteracyProfile {
  /** Raw chain count across all JSONL files. */
  chainLength: number;
  /** Computed literacy tier. */
  tier: LiteracyTier;
  /** Multiplier applied to membrane resolution (retrieval depth, token budget). */
  resolutionMultiplier: number;
  /** Max LTM entries to retrieve per turn (scaled by literacy). */
  maxRetrieved: number;
  /** Token budget multiplier for supporting content in context assembly. */
  supportingTokenBudget: number;
  /** Timestamp of last computation. */
  computedAt: string;
}

/** Tier thresholds and their resolution characteristics. */
const TIER_TABLE: Array<{
  maxChains: number;
  tier: LiteracyTier;
  resolutionMultiplier: number;
  maxRetrieved: number;
  supportingTokenBudget: number;
}> = [
  { maxChains: 50,    tier: "embryonic", resolutionMultiplier: 0.5, maxRetrieved: 5,  supportingTokenBudget: 500 },
  { maxChains: 200,   tier: "nascent",   resolutionMultiplier: 0.75, maxRetrieved: 8,  supportingTokenBudget: 1000 },
  { maxChains: 1000,  tier: "literate",  resolutionMultiplier: 1.0,  maxRetrieved: 12, supportingTokenBudget: 2000 },
  { maxChains: 5000,  tier: "fluent",    resolutionMultiplier: 1.25, maxRetrieved: 18, supportingTokenBudget: 3000 },
  { maxChains: Infinity, tier: "native", resolutionMultiplier: 1.5,  maxRetrieved: 25, supportingTokenBudget: 4000 },
];

/** Base chain length from composted templates — new instances don't start at zero. */
const COMPOSTED_BASE_CHAINS = 25;

// ─── JSONL directories to scan ───────────────────────────────────────────────

/** All brain subdirectories that contain JSONL chain data (relative to BRAIN_DIR). */
const CHAIN_SUBDIRS = [
  "memory",
  "operations",
  "ops",
  "training",
];

// ─── Chain counting ──────────────────────────────────────────────────────────

/**
 * Count non-schema, non-empty lines across all JSONL files in a directory.
 * Each line represents one link in the chain — an experience, decision,
 * insight, or observation the brain has accumulated.
 */
function countJsonlLines(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;

  let count = 0;
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(dirPath, file), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Skip schema headers and archived markers
        try {
          const obj = JSON.parse(trimmed);
          if (obj._schema) continue;
          if (obj.status === "archived") continue;
          count++;
        } catch {
          // Encrypted lines still count as chain links — the brain wrote them
          count++;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return count;
}

/**
 * Compute the total chain length across all brain JSONL storage.
 * Includes the composted base to ensure new instances have base literacy.
 */
export function computeChainLength(brainRoot?: string): number {
  const root = brainRoot ?? BRAIN_DIR;
  let total = COMPOSTED_BASE_CHAINS;

  for (const subdir of CHAIN_SUBDIRS) {
    total += countJsonlLines(join(root, subdir));
  }

  return total;
}

/**
 * Resolve a chain length to its literacy tier and resolution parameters.
 */
export function resolveTier(chainLength: number): Omit<LiteracyProfile, "chainLength" | "computedAt"> {
  for (const row of TIER_TABLE) {
    if (chainLength <= row.maxChains) {
      return {
        tier: row.tier,
        resolutionMultiplier: row.resolutionMultiplier,
        maxRetrieved: row.maxRetrieved,
        supportingTokenBudget: row.supportingTokenBudget,
      };
    }
  }
  // Fallback to native (shouldn't reach here due to Infinity)
  const native = TIER_TABLE[TIER_TABLE.length - 1];
  return {
    tier: native.tier,
    resolutionMultiplier: native.resolutionMultiplier,
    maxRetrieved: native.maxRetrieved,
    supportingTokenBudget: native.supportingTokenBudget,
  };
}

/**
 * Compute the full literacy profile for the current brain instance.
 * This is the primary API — call it to get the brain's current literacy.
 */
export function computeLiteracy(brainRoot?: string): LiteracyProfile {
  const chainLength = computeChainLength(brainRoot);
  const tier = resolveTier(chainLength);

  const profile: LiteracyProfile = {
    chainLength,
    ...tier,
    computedAt: new Date().toISOString(),
  };

  log.info(
    `Chain length: ${chainLength} → ${profile.tier} (×${profile.resolutionMultiplier} resolution, ${profile.maxRetrieved} max retrieved)`,
  );

  return profile;
}

/**
 * Get the composted base chain count. Used when seeding new instances
 * from templates so they start with embryonic literacy rather than zero.
 */
export function getCompostedBaseChains(): number {
  return COMPOSTED_BASE_CHAINS;
}
