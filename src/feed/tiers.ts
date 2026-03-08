/**
 * Tier detection and feature gating.
 * Reads tier from local config; never phones home to validate.
 */

import type { FeedTier, FeedSignalType, TierCapabilities } from "./types.js";

const FREE_SIGNALS: FeedSignalType[] = [
  "dictionary_update",
  "security_patch",
  "release_notes",
  "community_signal",
  "protocol_update",
  "compost",
];

const PAID_SIGNALS: FeedSignalType[] = [
  ...FREE_SIGNALS,
  "pattern_intelligence",
  "curated_model",
  "deep_dictionary",
  "federation_signal",
  "early_access",
];

const TIER_MAP: Record<FeedTier, TierCapabilities> = {
  free: {
    tier: "free",
    signalTypes: FREE_SIGNALS,
    relayPriority: "standard",
    envelopeTtlDays: 30,
    maxHosts: 1,
    sseEnabled: false,
    priceMonthly: 0,
  },
  personal: {
    tier: "personal",
    signalTypes: PAID_SIGNALS,
    relayPriority: "priority",
    envelopeTtlDays: 90,
    maxHosts: 5,
    sseEnabled: true,
    priceMonthly: 900,    // $9/month
  },
  family: {
    tier: "family",
    signalTypes: PAID_SIGNALS,
    relayPriority: "priority",
    envelopeTtlDays: 90,
    maxHosts: 20,
    sseEnabled: true,
    priceMonthly: 1900,   // $19/month
  },
  host: {
    tier: "host",
    signalTypes: PAID_SIGNALS,
    relayPriority: "priority",
    envelopeTtlDays: 180,
    maxHosts: Infinity,
    sseEnabled: true,
    priceMonthly: 4900,   // $49/month
  },
};

const TIER_ORDER: FeedTier[] = ["free", "personal", "family", "host"];

export function getTierCapabilities(tier: FeedTier): TierCapabilities {
  return TIER_MAP[tier];
}

/** Check if a tier meets the minimum required tier. */
export function tierMeetsMinimum(current: FeedTier, minimum: FeedTier): boolean {
  return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(minimum);
}

/** Filter feed items to only those the current tier can access. */
export function filterByTier<T extends { minTier: FeedTier }>(items: T[], currentTier: FeedTier): T[] {
  return items.filter(item => tierMeetsMinimum(currentTier, item.minTier));
}

/** Check if a specific signal type is available at the given tier. */
export function isSignalAvailable(signalType: FeedSignalType, tier: FeedTier): boolean {
  return TIER_MAP[tier].signalTypes.includes(signalType);
}
