/**
 * Work signal — derives a 0-1 Work value from inference metrics.
 *
 * The Work dot in the Sense/Work/Joy flywheel represents how much
 * productive inference activity is happening. This module reads
 * trend data and normalizes it into a [0, 1] signal suitable for
 * pulse emission and field participation.
 *
 * Factors:
 *   - Call volume (more calls = more work)
 *   - Error rate (high errors dampen work signal)
 *   - Escalation rate (escalations indicate harder work)
 *   - Token throughput (more tokens = more substance)
 *
 * Portability: InferenceMetricsProvider is injectable. The server
 * injects the concrete implementation at runtime; the module itself
 * has no direct dependency on any specific metrics backend.
 */

// ─── Injectable interface ───────────────────────────────────────────────────

/** Trend window data — a snapshot of inference metrics over a time window. */
export interface TrendWindow {
  callCount: number;
  errorRate: number;
  escalationRate: number;
  tokensByTarget: { cloud: number; local: number };
}

/** Provider for inference metrics. Injected by the server at runtime. */
export interface InferenceMetricsProvider {
  trend(windowMs: number): TrendWindow;
}

// ─── Module state ───────────────────────────────────────────────────────────

let metricsProvider: InferenceMetricsProvider | null = null;

/** Register the inference metrics provider. Called once at startup. */
export function setInferenceMetricsProvider(provider: InferenceMetricsProvider): void {
  metricsProvider = provider;
}

// ─── Tuning knobs ───────────────────────────────────────────────────────────

/** Tuning knobs for Work signal normalization. */
const WORK_PARAMS = {
  /** Calls per hour that maps to work=1.0 (saturation point). */
  callSaturation: 100,
  /** Tokens per hour that maps to full token contribution. */
  tokenSaturation: 50_000,
  /** Weight of call volume in the composite signal. */
  callWeight: 0.4,
  /** Weight of token throughput in the composite signal. */
  tokenWeight: 0.3,
  /** Weight of escalation intensity (harder work). */
  escalationWeight: 0.15,
  /** Weight of success rate (errors dampen). */
  successWeight: 0.15,
  /** Rolling window for trend calculation (ms). */
  windowMs: 60 * 60 * 1000, // 1 hour
};

// ─── Signal computation ─────────────────────────────────────────────────────

/**
 * Compute the current Work signal (0-1) from inference metrics.
 *
 * Returns 0 when no inference activity has occurred or no provider is registered.
 * Approaches 1.0 as call volume and token throughput increase,
 * modulated by error rate and escalation intensity.
 */
export function computeWorkSignal(): number {
  if (!metricsProvider) return 0;
  const trend = metricsProvider.trend(WORK_PARAMS.windowMs);
  if (trend.callCount === 0) return 0;
  return computeFromTrend(trend);
}

/**
 * Compute Work signal from a pre-fetched trend window.
 * Useful when the caller already has trend data.
 */
export function computeFromTrend(trend: TrendWindow): number {
  if (trend.callCount === 0) return 0;

  // Call volume: saturates at callSaturation calls/window
  const callSignal = Math.min(trend.callCount / WORK_PARAMS.callSaturation, 1);

  // Token throughput: total tokens in window, saturates at tokenSaturation
  const totalTokens = trend.tokensByTarget.cloud + trend.tokensByTarget.local;
  const tokenSignal = Math.min(totalTokens / WORK_PARAMS.tokenSaturation, 1);

  // Escalation intensity: escalations indicate harder, more complex work
  // Cap at 0.5 escalation rate for full signal (beyond that is pathological)
  const escalationSignal = Math.min(trend.escalationRate / 0.5, 1);

  // Success rate: errors dampen the work signal (broken work isn't real work)
  const successSignal = 1 - trend.errorRate;

  // Weighted composite
  const raw =
    callSignal * WORK_PARAMS.callWeight +
    tokenSignal * WORK_PARAMS.tokenWeight +
    escalationSignal * WORK_PARAMS.escalationWeight +
    successSignal * WORK_PARAMS.successWeight;

  // Clamp to [0, 1]
  return Math.min(Math.max(raw, 0), 1);
}

/**
 * Get a diagnostic breakdown of the Work signal components.
 * Useful for debugging and HUD display.
 */
export function getWorkSignalBreakdown(): WorkSignalBreakdown {
  if (!metricsProvider) {
    const emptyTrend: TrendWindow = { callCount: 0, errorRate: 0, escalationRate: 0, tokensByTarget: { cloud: 0, local: 0 } };
    return { work: 0, components: { calls: 0, tokens: 0, escalation: 0, success: 0 }, trend: emptyTrend };
  }

  const trend = metricsProvider.trend(WORK_PARAMS.windowMs);

  if (trend.callCount === 0) {
    return {
      work: 0,
      components: { calls: 0, tokens: 0, escalation: 0, success: 0 },
      trend,
    };
  }

  const callSignal = Math.min(trend.callCount / WORK_PARAMS.callSaturation, 1);
  const totalTokens = trend.tokensByTarget.cloud + trend.tokensByTarget.local;
  const tokenSignal = Math.min(totalTokens / WORK_PARAMS.tokenSaturation, 1);
  const escalationSignal = Math.min(trend.escalationRate / 0.5, 1);
  const successSignal = 1 - trend.errorRate;

  return {
    work: computeFromTrend(trend),
    components: {
      calls: Math.round(callSignal * 1000) / 1000,
      tokens: Math.round(tokenSignal * 1000) / 1000,
      escalation: Math.round(escalationSignal * 1000) / 1000,
      success: Math.round(successSignal * 1000) / 1000,
    },
    trend,
  };
}

export interface WorkSignalBreakdown {
  /** Composite Work signal (0-1). */
  work: number;
  /** Individual component values (0-1 each). */
  components: {
    calls: number;
    tokens: number;
    escalation: number;
    success: number;
  };
  /** The trend window used for calculation. */
  trend: TrendWindow;
}
