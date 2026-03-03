/**
 * Generic webhook registry.
 *
 * Provider registration, lookup, stats tracking, and health monitoring.
 * Signature verification, routing, retry, and configuration live in
 * their own modules — this file re-exports them for backward compatibility.
 */

import { createLogger } from "../utils/logger.js";
import type {
  WebhookProvider,
  ProviderStats,
  ProviderHealth,
  ProviderHealthSummary,
} from "./types.js";

const log = createLogger("webhooks.registry");

// ── Re-exports for backward compatibility ────────────────────────────────────
// Consumers that imported from registry.ts continue to work unchanged.

export type {
  WebhookResult,
  VerifyContext,
  WebhookRetryOpts,
  WebhookProvider,
  WebhookEvent,
  WebhookRequestContext,
  WebhookMiddleware,
  ProviderStats,
  ProviderHealth,
  ProviderHealthSummary,
  DeduplicationOpts,
} from "./types.js";

export {
  hmacSha256Hex,
  hmacSha256Base64,
  hmacSha1Base64,
  timingSafeCompare,
  isTimestampFresh,
} from "./verify.js";

export { withWebhookRetry } from "./retry.js";

export {
  routeWebhook,
  routeWebhookRequest,
  composeMiddleware,
  validateRequest,
  deduplicateRequests,
  createWebhookEvent,
} from "./router.js";

// ── Registry ─────────────────────────────────────────────────────────────────

const providers = new Map<string, WebhookProvider>();

/**
 * Register a webhook provider.
 * Skips re-registration if a provider with the same name is already registered.
 * Uses debug logging instead of activity log to prevent the trace insight engine
 * from flagging normal startup registrations as bottlenecks (DASH-61, DASH-62).
 */
export function registerProvider(provider: WebhookProvider): void {
  if (providers.has(provider.name)) return;
  providers.set(provider.name, provider);
  log.debug(`Webhook provider registered: ${provider.name}`);
}

/**
 * Register multiple providers in a single batch.
 * Skips providers that are already registered by name, avoiding duplicate
 * registrations across watch-mode restarts or repeated calls.
 * Uses debug logging instead of activity log to prevent the trace insight
 * engine from flagging normal startup registrations as bottlenecks (DASH-61, DASH-62).
 */
export function registerProviders(list: WebhookProvider[]): void {
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const provider of list) {
    if (providers.has(provider.name)) {
      skipped.push(provider.name);
      continue;
    }
    providers.set(provider.name, provider);
    registered.push(provider.name);
  }

  if (registered.length > 0) {
    log.debug(`Webhook providers registered: [${registered.join(", ")}]`);
  }
  if (skipped.length > 0) {
    log.debug(`Webhook providers skipped (already registered): [${skipped.join(", ")}]`);
  }
}

/** Get a registered provider by name. */
export function getProvider(name: string): WebhookProvider | undefined {
  return providers.get(name);
}

/** List all registered provider names. */
export function listProviders(): string[] {
  return [...providers.keys()];
}

/** Remove a provider by name. */
export function removeProvider(name: string): boolean {
  return providers.delete(name);
}

// ── Provider Stats ──────────────────────────────────────────────────────────

const statsMap = new Map<string, ProviderStats>();

function getOrCreateStats(name: string): ProviderStats {
  let stats = statsMap.get(name);
  if (!stats) {
    stats = {
      name,
      invocations: 0,
      successes: 0,
      failures: 0,
      lastInvokedAt: null,
      lastErrorAt: null,
      lastError: null,
    };
    statsMap.set(name, stats);
  }
  return stats;
}

/** Record a successful webhook invocation. */
export function recordSuccess(providerName: string): void {
  const stats = getOrCreateStats(providerName);
  stats.invocations++;
  stats.successes++;
  stats.lastInvokedAt = new Date().toISOString();
}

/** Record a failed webhook invocation. */
export function recordFailure(providerName: string, error: string): void {
  const stats = getOrCreateStats(providerName);
  stats.invocations++;
  stats.failures++;
  stats.lastInvokedAt = new Date().toISOString();
  stats.lastErrorAt = new Date().toISOString();
  stats.lastError = error;
}

/** Get stats for a specific provider. */
export function getProviderStats(name: string): ProviderStats | undefined {
  return statsMap.get(name);
}

/** Get stats for all providers. */
export function getAllProviderStats(): ProviderStats[] {
  return [...statsMap.values()];
}

/** Reset stats (useful in tests). Pass a name to reset one provider, or omit to reset all. */
export function resetProviderStats(name?: string): void {
  if (name) {
    statsMap.delete(name);
  } else {
    statsMap.clear();
  }
}

// ── Provider Health ──────────────────────────────────────────────────────────

/**
 * Get health summary for a provider based on failure rate.
 * @param name Provider name.
 * @param failureThreshold Failure rate (0–1) above which status is "degraded". Default: 0.5.
 */
export function getProviderHealth(
  name: string,
  failureThreshold = 0.5,
): ProviderHealthSummary | undefined {
  const stats = statsMap.get(name);
  if (!stats) return undefined;

  if (stats.invocations === 0) {
    return { name, health: "unknown", failureRate: 0, stats };
  }

  const failureRate = stats.failures / stats.invocations;
  const health: ProviderHealth =
    failureRate >= failureThreshold ? "degraded" : "healthy";
  return { name, health, failureRate, stats };
}

/** Get health summaries for all registered providers. */
export function getAllProviderHealth(
  failureThreshold = 0.5,
): ProviderHealthSummary[] {
  return [...providers.keys()].map((name) => {
    return (
      getProviderHealth(name, failureThreshold) ?? {
        name,
        health: "unknown" as ProviderHealth,
        failureRate: 0,
        stats: getOrCreateStats(name),
      }
    );
  });
}
