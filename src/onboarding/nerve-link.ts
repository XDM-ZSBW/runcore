/**
 * Nerve Link — cross-device setup during onboarding.
 *
 * Generates a spawn URL for connecting a second device immediately
 * after bootstrap. Thin wrapper that provides the onboarding-specific
 * offer/skip flow.
 *
 * Portable: NerveLinkManager is an interface — inject your spawner.
 */

import { createLogger } from "../utils/logger.js";
import type { NerveLinkOffer, NerveProfile } from "./types.js";

const log = createLogger("onboarding:nerve-link");

// ── Nerve link manager ─────────────────────────────────────────────────────

/**
 * Interface for nerve link management during onboarding.
 * Implement this to wrap your nerve spawner.
 */
export interface NerveLinkManager {
  generateUrl(hintProfile?: NerveProfile): NerveLinkOffer;
}

/**
 * Generate a nerve link offer during onboarding.
 * Called when the user accepts the nerve link step.
 */
export function offerNerveLink(
  manager: NerveLinkManager,
  hintProfile?: NerveProfile,
): NerveLinkOffer {
  const offer = manager.generateUrl(hintProfile);
  log.info("Nerve link URL generated for onboarding", {
    expiresAt: offer.expiresAt,
    hintProfile,
  });
  return offer;
}
