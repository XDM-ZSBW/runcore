/**
 * Flywheel Tier System.
 *
 * The flywheel is a three-body system: Sense (Core), Work (GMR), Joy (BragBin).
 * All three dots must reach the same level for the flywheel to advance a tier.
 * The weakest dot determines the overall tier — no dot can be left behind.
 *
 * Tiers represent trust maturity (ICI reduction), not gamification:
 *   Tier 0 — Dormant: no signal from one or more dots
 *   Tier 1 — Stirring: all dots have signal, high instinct cost
 *   Tier 2 — Spinning: all dots flowing, trust building, UI fading
 *   Tier 3 — Instinct: all dots deep green, system disappears
 *
 * Sundial principle: no numbers, no countdowns, no anxiety triggers.
 * Tier changes are felt through color deepening and capability shifts.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** The state of a single dot (sense, work, or joy). */
export type DotState = "green" | "blue" | "amber";

/** Dot-level tier: how mature this dot's signal is. */
export type DotTier = 0 | 1 | 2 | 3;

/** Flywheel tier — the system-wide tier (min of all three dots). */
export type FlywheelTier = 0 | 1 | 2 | 3;

/** Which product maps to which dot. */
export type DotName = "sense" | "work" | "joy";

/** Product → dot mapping. */
export const DOT_PRODUCT_MAP: Record<DotName, string> = {
  sense: "Core",
  work: "GMReports",
  joy: "BragBin",
};

/** Color palette that deepens with tier. No sharp transitions. */
export const TIER_COLORS: Record<FlywheelTier, { hue: string; depth: string }> = {
  0: { hue: "neutral", depth: "faint" },
  1: { hue: "warm", depth: "soft" },
  2: { hue: "warm", depth: "medium" },
  3: { hue: "warm", depth: "deep" },
};

export interface DotStatus {
  name: DotName;
  state: DotState;
  tier: DotTier;
  why: string;
}

export interface FlywheelStatus {
  tier: FlywheelTier;
  dots: Record<DotName, DotStatus>;
  color: { hue: string; depth: string };
  /** Quiet narrative — no metrics, just a sentence about the flywheel's state. */
  narrative: string;
}

// ─── Dot tier calculation ───────────────────────────────────────────────────

/**
 * Map a dot's instantaneous state to a tier level.
 *
 *   green  → 3 (flowing / aligned / active)
 *   blue   → 2 (calm / present but not urgent)
 *   amber  → 1 (attention needed / signal present but strained)
 *
 * A dot with no data at all gets state "amber" from the pulse endpoint,
 * so tier 0 (dormant) only applies when explicitly passed.
 */
export function dotStateToTier(state: DotState): DotTier {
  switch (state) {
    case "green": return 3;
    case "blue": return 2;
    case "amber": return 1;
    default: return 0;
  }
}

// ─── Flywheel tier calculation ──────────────────────────────────────────────

/**
 * Calculate the flywheel tier from three dot states.
 *
 * The flywheel tier is the MINIMUM of all three dot tiers.
 * All three must be at the same level to advance — the weakest dot
 * determines the overall tier. This prevents lopsided growth.
 */
export function calculateFlywheelTier(
  sense: DotState,
  work: DotState,
  joy: DotState,
): FlywheelStatus {
  const senseTier = dotStateToTier(sense);
  const workTier = dotStateToTier(work);
  const joyTier = dotStateToTier(joy);

  const tier = Math.min(senseTier, workTier, joyTier) as FlywheelTier;

  const dots: Record<DotName, DotStatus> = {
    sense: { name: "sense", state: sense, tier: senseTier, why: dotNarrative("sense", sense) },
    work: { name: "work", state: work, tier: workTier, why: dotNarrative("work", work) },
    joy: { name: "joy", state: joy, tier: joyTier, why: dotNarrative("joy", joy) },
  };

  return {
    tier,
    dots,
    color: TIER_COLORS[tier],
    narrative: flywheelNarrative(tier, senseTier, workTier, joyTier),
  };
}

// ─── Narratives (sundial: no numbers, no anxiety) ───────────────────────────

function dotNarrative(dot: DotName, state: DotState): string {
  const label = DOT_PRODUCT_MAP[dot];
  switch (state) {
    case "green": return `${label} is flowing`;
    case "blue": return `${label} is present`;
    case "amber": return `${label} needs attention`;
    default: return `${label} is quiet`;
  }
}

function flywheelNarrative(
  tier: FlywheelTier,
  sense: DotTier,
  work: DotTier,
  joy: DotTier,
): string {
  if (tier === 3) return "The flywheel is spinning on instinct.";
  if (tier === 2) return "The flywheel is building momentum.";
  if (tier === 1) {
    // Identify which dot(s) are holding back progress
    const lagging: string[] = [];
    if (sense === 1) lagging.push("Sense");
    if (work === 1) lagging.push("Work");
    if (joy === 1) lagging.push("Joy");
    if (lagging.length === 3) return "All three dots are stirring. The flywheel is waking up.";
    return `The flywheel is stirring. ${lagging.join(" and ")} ${lagging.length === 1 ? "needs" : "need"} warmth.`;
  }
  return "The flywheel is still.";
}
