/**
 * Health check type definitions.
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** Result from a single health check. */
export interface CheckResult {
  status: HealthStatus;
  /** Human-readable detail (e.g. "heap 120MB / 512MB"). */
  detail?: string;
  /** How long the check took (ms). */
  durationMs?: number;
  /** When this check last ran. */
  lastChecked?: string;
}

/** Aggregate result from running all (or one) health checks. */
export interface HealthCheckResult {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  checks: Record<string, CheckResult>;
}

/** A function that performs a single health check. */
export type HealthCheckFn = () => CheckResult | Promise<CheckResult>;

/** Configuration for a registered health check. */
export interface CheckRegistration {
  fn: HealthCheckFn;
  /** Critical checks cause unhealthy → 503 on liveness. Non-critical only affect readiness. */
  critical: boolean;
  /** Timeout for this check (ms). Default: 5000. */
  timeoutMs: number;
  /** Last cached result for history tracking. */
  lastResult?: CheckResult;
}

/** Options when registering a check. */
export interface RegisterOptions {
  /** If true, failures make the whole system unhealthy. Default: true. */
  critical?: boolean;
  /** Check timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

/** Component dependency descriptor for validation. */
export interface DependencyDescriptor {
  name: string;
  check: HealthCheckFn;
  /** Is this dependency required for the system to function? */
  required: boolean;
}

/** Recovery action that can be triggered automatically. */
export interface RecoveryAction {
  name: string;
  /** Which check triggers this recovery. */
  checkName: string;
  /** How many consecutive failures before triggering. */
  threshold: number;
  /** Minimum time between recovery attempts (ms). */
  cooldownMs: number;
  /** The recovery function. Returns true if recovery succeeded. */
  execute: () => Promise<boolean>;
}

/** Tracks recovery state for a single action. */
export interface RecoveryState {
  consecutiveFailures: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  totalAttempts: number;
  totalSuccesses: number;
}
