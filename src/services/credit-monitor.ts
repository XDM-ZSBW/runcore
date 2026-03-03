/**
 * OpenRouter credit monitoring timer service.
 *
 * Periodically checks credit usage via the openrouterCreditsCheck health
 * check, registers it with the AlertManager pipeline for threshold-based
 * alerting, and exposes status + manual trigger for the API.
 *
 * Follows the module-level timer pattern (goals/timer.ts, backlogReview.ts).
 */

import type { HealthChecker } from "../health/checker.js";
import type { AlertManager } from "../health/alerting.js";
import { openrouterCreditsCheck } from "../health/checks/openrouter.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnv } from "../instance.js";

const log = createLogger("credit-monitor");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface CreditStatus {
  limit: number | null;
  remaining: number | null;
  usage: number;
  usageDaily: number;
  percentUsed: number | null;
  isFreeTier: boolean;
  checkedAt: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus: CreditStatus | null = null;
let healthRef: HealthChecker | null = null;

/**
 * Start the credit monitoring timer. Idempotent.
 *
 * 1. Registers `openrouterCreditsCheck` with HealthChecker as non-critical.
 * 2. Starts an interval timer that runs the check and caches CreditStatus.
 * 3. Fires an immediate first check (credits can be urgent).
 */
export function startCreditMonitor(
  health: HealthChecker,
  alertManager: AlertManager,
  intervalMs?: number,
): void {
  if (timer) return;

  healthRef = health;

  // Register the health check (non-critical — instance can still work with cached context)
  health.register("openrouter_credits", openrouterCreditsCheck(), { critical: false });

  const interval = intervalMs
    ?? (parseInt(resolveEnv("CREDIT_CHECK_INTERVAL_MS") ?? "", 10) || DEFAULT_INTERVAL_MS);

  const runCheck = async () => {
    try {
      const result = await health.check("openrouter_credits");
      const checkResult = result.checks["openrouter_credits"];
      if (checkResult?.detail) {
        lastStatus = parseDetailToStatus(checkResult.detail);
      }
    } catch (err) {
      log.error("credit check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Fire immediately, then on interval
  runCheck();
  timer = setInterval(runCheck, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Credit monitor: every ${mins} min`);
}

/** Stop the credit monitoring timer. */
export function stopCreditMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  healthRef = null;
  log.info("Credit monitor stopped");
}

/** Check if the credit monitor is running. */
export function isCreditMonitorRunning(): boolean {
  return timer !== null;
}

/** Get the last cached credit status (null if never checked). */
export function getCreditStatus(): CreditStatus | null {
  return lastStatus;
}

/**
 * Trigger an immediate credit check. Returns the fresh status.
 * Works even if the timer isn't running (uses the registered health check).
 */
export async function triggerCreditCheck(): Promise<CreditStatus | null> {
  if (!healthRef) return lastStatus;

  try {
    const result = await healthRef.check("openrouter_credits");
    const checkResult = result.checks["openrouter_credits"];
    if (checkResult?.detail) {
      lastStatus = parseDetailToStatus(checkResult.detail);
    }
    return lastStatus;
  } catch (err) {
    log.error("manual credit check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return lastStatus;
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Parse the health check detail string into a structured CreditStatus.
 *
 * Formats handled:
 *   "credits 85% used, $2.30 remaining of $15.00 limit"
 *   "credits unlimited (no limit set), $4.20 used"
 *   "credits unknown — OPENROUTER_API_KEY not set"
 *   "cannot verify credits — ..."
 */
function parseDetailToStatus(detail: string): CreditStatus {
  const now = new Date().toISOString();

  // Unlimited case
  if (detail.includes("unlimited")) {
    const usageMatch = detail.match(/\$(\d+\.?\d*)\s+used/);
    return {
      limit: null,
      remaining: null,
      usage: usageMatch ? parseFloat(usageMatch[1]) : 0,
      usageDaily: 0,
      percentUsed: null,
      isFreeTier: false,
      checkedAt: now,
    };
  }

  // Normal case with percentage
  const pctMatch = detail.match(/credits\s+(\d+)%\s+used/);
  const remainingMatch = detail.match(/\$(\d+\.?\d*)\s+remaining/);
  const limitMatch = detail.match(/of\s+\$(\d+\.?\d*)\s+limit/);

  if (pctMatch) {
    const limit = limitMatch ? parseFloat(limitMatch[1]) : null;
    const remaining = remainingMatch ? parseFloat(remainingMatch[1]) : null;
    const percentUsed = parseInt(pctMatch[1], 10);
    const usage = limit !== null && remaining !== null ? limit - remaining : 0;

    return {
      limit,
      remaining,
      usage,
      usageDaily: 0,
      percentUsed,
      isFreeTier: false,
      checkedAt: now,
    };
  }

  // Error/unknown case
  return {
    limit: null,
    remaining: null,
    usage: 0,
    usageDaily: 0,
    percentUsed: null,
    isFreeTier: false,
    checkedAt: now,
  };
}
