/**
 * Agent Bootstrap — initializes the brain after onboarding.
 *
 * Creates the human identity, ensures brain directories exist,
 * assigns the Founder archetype, and initializes pulse dots at zero.
 * This is the automatic phase — no user input required.
 *
 * Portable: identity pairing is injectable via IdentityPairer interface
 * instead of importing a specific auth/identity module.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BRAIN_DIR } from "../lib/paths.js";
import { getCurrentCalibration } from "../calibration/store.js";
import { DEFAULT_THRESHOLDS, DEFAULT_DOT_THRESHOLDS } from "../calibration/types.js";
import { createLogger } from "../utils/logger.js";
import type { BootstrapResult } from "./types.js";
import { INITIAL_PULSE_DOTS } from "./types.js";

const log = createLogger("onboarding:bootstrap");

// ── Brain directory structure ──────────────────────────────────────────────

/** Directories that must exist for a functioning brain. */
const REQUIRED_DIRS = [
  "identity",
  "memory",
  "content",
  "operations",
  "knowledge",
  "calibration",
  "vault",
  "agents",
  "bonds",
] as const;

// ── Identity pairer (injectable) ──────────────────────────────────────────

/** Result of a successful identity pairing. */
export interface PairResult {
  session: { id: string };
}

/**
 * Interface for identity pairing during bootstrap.
 * Inject an implementation that wraps your auth/identity.pair function.
 */
export interface IdentityPairer {
  pair(input: {
    code: string;
    name: string;
    safeWord: string;
    skipCodeCheck: boolean;
    recoveryQuestion?: string;
    recoveryAnswer?: string;
  }): Promise<PairResult | { error: string }>;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

export interface BootstrapInput {
  name: string;
  safeWord: string;
  pairingCode?: string | null;
  recoveryQuestion?: string | null;
  recoveryAnswer?: string | null;
  identityPairer?: IdentityPairer;
}

/**
 * Bootstrap the agent after onboarding conversation completes.
 *
 * 1. Ensures brain directory structure exists
 * 2. Creates human identity (via identity pairer if provided)
 * 3. Reads calibration results (already saved by CalibrationRunner)
 * 4. Returns the bootstrap result with archetype, thresholds, and pulse dots
 */
export async function bootstrapAgent(input: BootstrapInput): Promise<BootstrapResult> {
  log.info("Starting agent bootstrap", { name: input.name });

  // 1. Ensure brain directories
  const createdDirs: string[] = [];
  for (const dir of REQUIRED_DIRS) {
    const fullPath = join(BRAIN_DIR, dir);
    try {
      await mkdir(fullPath, { recursive: true });
      createdDirs.push(dir);
    } catch {
      // Directory already exists
    }
  }
  log.info("Brain directories ensured", { count: createdDirs.length });

  // 2. Create human identity via pairing (if pairer provided)
  if (input.identityPairer) {
    const pairResult = await input.identityPairer.pair({
      code: input.pairingCode ?? "",
      name: input.name,
      safeWord: input.safeWord,
      skipCodeCheck: !input.pairingCode,
      recoveryQuestion: input.recoveryQuestion ?? undefined,
      recoveryAnswer: input.recoveryAnswer ?? undefined,
    });

    if ("error" in pairResult) {
      log.error("Pairing failed during bootstrap", { error: pairResult.error });
      throw new Error(`Bootstrap pairing failed: ${pairResult.error}`);
    }

    log.info("Human identity created", { name: input.name, sessionId: pairResult.session.id });
  } else {
    log.info("No identity pairer provided — skipping pairing step");
  }

  // 3. Read calibration results (saved by CalibrationRunner during calibration phase)
  const calibration = await getCurrentCalibration();
  const thresholds = calibration?.thresholds ?? DEFAULT_THRESHOLDS;
  const dotThresholds = calibration?.derived ?? DEFAULT_DOT_THRESHOLDS;

  // 4. Build result
  const result: BootstrapResult = {
    archetype: "founder",
    thresholds,
    dotThresholds,
    brainDirs: REQUIRED_DIRS.map(d => join(BRAIN_DIR, d)),
    pulseDots: INITIAL_PULSE_DOTS,
  };

  log.info("Agent bootstrap complete", {
    archetype: result.archetype,
    calibrated: !!calibration,
  });

  return result;
}
