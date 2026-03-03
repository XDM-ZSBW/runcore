/**
 * Centralized configuration defaults for all Core subsystems.
 * Import from here instead of hardcoding constants across modules.
 */

// ─── Open Loop Scanner ──────────────────────────────────────────────────────

export const OLP_SCAN_INTERVAL_MS = 5 * 60 * 1000;       // 5 min
export const OLP_FIRST_RUN_DELAY_MS = 3 * 60 * 1000;     // 3 min
export const OLP_MAX_ENTRIES_PER_SCAN = 50;
export const OLP_MAX_RESONANCES = 30;
export const OLP_VECTOR_SIMILARITY_THRESHOLD = 0.55;
export const OLP_KEYWORD_HIT_THRESHOLD = 2;
export const OLP_ACTIVE_TO_DORMANT_MS = 2 * 24 * 60 * 60 * 1000;   // 2 days
export const OLP_DORMANT_TO_EXPIRED_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
export const OLP_RESONANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;       // 24h

// ─── Open Loop Lifecycle ─────────────────────────────────────────────────────

export const OLP_STALE_DAYS = 5;
export const OLP_MERGE_SIMILARITY_THRESHOLD = 0.80;
export const OLP_MIN_CONFIDENCE_FOR_ARCHIVE = 0.3;
export const OLP_MAX_MERGE_COMPARISONS = 50;

// ─── Metrics Store ───────────────────────────────────────────────────────────

export const METRICS_MAX_POINTS = 10_000;
export const METRICS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Instance Manager ────────────────────────────────────────────────────────

export const IM_GC_INTERVAL_MS = 30_000;
export const IM_GC_TTL_MS = 5 * 60_000;
export const IM_HEALTH_CHECK_INTERVAL_MS = 30_000;
export const IM_UNHEALTHY_THRESHOLD = 3;
export const IM_MAX_HISTORY_PER_INSTANCE = 50;
export const IM_MAX_AUTO_RESTARTS = 2;
export const IM_GC_BATCH_SIZE = 100;
export const IM_GC_MIN_INTERVAL_MS = 5_000;
export const IM_GC_JITTER_MS = 10_000;

// ─── Health Score Weights ────────────────────────────────────────────────────

export const HEALTH_RETRY_PENALTY = 15;
export const HEALTH_RESTART_PENALTY = 10;
export const HEALTH_FAILURE_PENALTY = 20;
export const HEALTH_STUCK_INIT_PENALTY = 25;
export const HEALTH_TIMEOUT_PENALTY = 20;
export const HEALTH_DECAY_HALF_LIFE_MS = 30 * 60 * 1000; // 30 min half-life for score decay

// ─── Activity Log ────────────────────────────────────────────────────────────

export const ACTIVITY_MAX_IN_MEMORY = 500;
export const ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Vector Index ────────────────────────────────────────────────────────────

export const VECTOR_AVAILABILITY_CACHE_MS = 30_000;      // 30s
export const VECTOR_CIRCUIT_BREAKER_FAILURES = 3;
export const VECTOR_CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

// ─── Recovery ────────────────────────────────────────────────────────────────

export const RECOVERY_MAX_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min cap

// ─── Trace Insights ──────────────────────────────────────────────────────────

export const INSIGHT_ANALYSIS_INTERVAL_MS = 10 * 60 * 1000;  // 10 min
export const INSIGHT_FIRST_RUN_DELAY_MS = 2 * 60 * 1000;     // 2 min
export const INSIGHT_MAX_INSIGHTS = 50;
export const INSIGHT_ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h per pattern
