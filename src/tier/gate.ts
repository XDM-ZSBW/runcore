/**
 * Capability gate — checks tier before allowing features.
 */

import { type TierName, TIER_LEVEL, TIER_CAPS } from "./types.js";

export function meetsMinimum(current: TierName, required: TierName): boolean {
  return TIER_LEVEL[current] >= TIER_LEVEL[required];
}

export function canServe(tier: TierName): boolean {
  return TIER_CAPS[tier].server;
}

export function canMesh(tier: TierName): boolean {
  return TIER_CAPS[tier].mesh;
}

export function canSpawn(tier: TierName): boolean {
  return TIER_CAPS[tier].spawning;
}

export function canAlert(tier: TierName): boolean {
  return TIER_CAPS[tier].alerting;
}

export function requireTier(current: TierName, required: TierName): void {
  if (!meetsMinimum(current, required)) {
    throw new Error(
      `Tier "${required}" required (current: "${current}"). Run \`runcore register\` to upgrade.`
    );
  }
}
