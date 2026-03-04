/**
 * Integration gate — central kill switch for token flow.
 *
 * Controls which secrets get hydrated into process.env at startup.
 * Master switch (`integrations.enabled`) kills ALL external token flow.
 * Per-service toggles (`integrations.services.<name>`) disable individual integrations.
 *
 * Keys with no matching prefix (e.g. CORE_PORT, SAFE_WORD) always pass through.
 */

import { getSettings } from "../settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("integrations.gate");

/** Maps env var prefixes to integration service names. */
const ENV_PREFIX_MAP: Record<string, string> = {
  GOOGLE_: "google",
  GMAIL_: "google",
  GITHUB_: "github",
  SLACK_: "slack",
  TWILIO_: "twilio",
  RESEND_: "resend",
  RELAY_: "resend",
  OPENAI_: "openai",
  ANTHROPIC_: "anthropic",
  OPENROUTER_: "openrouter",
  PERPLEXITY_: "perplexity",
  BRIEFING_: "twilio",
};

// Sorted longest-first so OPENROUTER_ matches before OPEN* would (if added)
const SORTED_PREFIXES = Object.keys(ENV_PREFIX_MAP).sort((a, b) => b.length - a.length);

/**
 * Resolve which service an env var belongs to, or null if it's not an integration key.
 */
export function resolveService(envVarName: string): string | null {
  for (const prefix of SORTED_PREFIXES) {
    if (envVarName.startsWith(prefix)) {
      return ENV_PREFIX_MAP[prefix];
    }
  }
  return null;
}

/**
 * Check if a specific integration service is enabled.
 * Returns false if the master switch is off or the service is explicitly disabled.
 */
export function isIntegrationEnabled(service: string): boolean {
  const settings = getSettings();

  // privateMode → all integrations disabled (network isolation)
  if (settings.privateMode) return false;

  const integrations = settings.integrations;

  // No integrations block at all → everything enabled (backwards compat)
  if (!integrations) return true;

  // Master kill switch
  if (integrations.enabled === false) return false;

  // Per-service toggle (default: enabled if not listed)
  const services = integrations.services;
  if (!services) return true;

  return services[service] !== false;
}

/**
 * Should this env var be hydrated into process.env?
 * Non-integration keys (no matching prefix) always pass through.
 * Integration keys are checked against the gate.
 */
export function shouldHydrateKey(envVarName: string): boolean {
  const service = resolveService(envVarName);

  // Not an integration key → always hydrate
  if (!service) return true;

  return isIntegrationEnabled(service);
}

/**
 * Returns list of all known service names and their enabled status.
 */
export function getIntegrationStatus(): Array<{ service: string; enabled: boolean }> {
  const allServices = [...new Set(Object.values(ENV_PREFIX_MAP))].sort();
  return allServices.map((service) => ({
    service,
    enabled: isIntegrationEnabled(service),
  }));
}

/**
 * Returns only enabled service names.
 */
export function getEnabledServices(): string[] {
  return getIntegrationStatus()
    .filter((s) => s.enabled)
    .map((s) => s.service);
}

/**
 * Check if the master integration switch is off (air-gap mode).
 */
export function isAirGapped(): boolean {
  const settings = getSettings();
  return settings.integrations?.enabled === false;
}
