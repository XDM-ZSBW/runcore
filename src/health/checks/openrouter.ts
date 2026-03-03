/**
 * OpenRouter credit monitoring health check.
 *
 * Polls GET https://openrouter.ai/api/v1/key to report credit usage
 * as a percentage. Maps to the "higher is worse" threshold model used
 * by AlertManager.
 */

import type { HealthCheckFn, CheckResult } from "../types.js";

interface OpenRouterKeyData {
  label?: string;
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
  usage_daily?: number;
  usage_monthly?: number;
  is_free_tier: boolean;
}

interface OpenRouterKeyResponse {
  data: OpenRouterKeyData;
}

/**
 * Returns a health check function that polls the OpenRouter key endpoint.
 *
 * Detail format:
 *   "credits 85% used, $2.30 remaining of $15.00 limit"
 *   "credits unlimited (no limit set), $4.20 used"
 *
 * Status mapping:
 *   limit === null     → healthy (unlimited)
 *   percentUsed < 80   → healthy
 *   percentUsed >= 80  → degraded
 *   percentUsed >= 95  → unhealthy
 *   API error / 401    → unhealthy
 */
export function openrouterCreditsCheck(): HealthCheckFn {
  return async (): Promise<CheckResult> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        status: "unhealthy",
        detail: "credits unknown — OPENROUTER_API_KEY not set",
      };
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return {
          status: "unhealthy",
          detail: `cannot verify credits — API returned ${res.status}`,
        };
      }

      const json = (await res.json()) as OpenRouterKeyResponse;
      const data = json.data;

      if (data.limit === null || data.limit === undefined) {
        return {
          status: "healthy",
          detail: `credits unlimited (no limit set), $${data.usage.toFixed(2)} used`,
        };
      }

      const remaining = data.limit_remaining ?? data.limit - data.usage;
      const percentUsed = Math.round((data.usage / data.limit) * 100);
      const detail = `credits ${percentUsed}% used, $${remaining.toFixed(2)} remaining of $${data.limit.toFixed(2)} limit`;

      if (percentUsed >= 95) return { status: "unhealthy", detail };
      if (percentUsed >= 80) return { status: "degraded", detail };
      return { status: "healthy", detail };
    } catch (err) {
      return {
        status: "unhealthy",
        detail: `cannot verify credits — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/**
 * Metric extractor for the credits check detail string.
 * Parses "credits 85% used, ..." → { percentUsed: 85 }
 */
export function creditsExtractor(detail: string): Record<string, number> {
  const match = detail.match(/credits\s+(\d+)%\s+used/);
  return match ? { percentUsed: parseInt(match[1], 10) } : {};
}
