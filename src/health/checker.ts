/**
 * Core HealthChecker — runs registered checks with timeouts and history tracking.
 *
 * Backward-compatible with the original src/health.ts API while adding:
 * - Per-check timeouts (prevents a slow check from blocking probes)
 * - Critical vs non-critical classification
 * - Cached last-result for dashboard access without re-running
 * - Timestamp on aggregate results
 */

import type {
  HealthStatus,
  CheckResult,
  HealthCheckResult,
  HealthCheckFn,
  CheckRegistration,
  RegisterOptions,
} from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("health.checker");

const DEFAULT_TIMEOUT_MS = 5_000;

export class HealthChecker {
  private checks = new Map<string, CheckRegistration>();

  /** Register a named health check. Overwrites if name already exists. */
  register(name: string, fn: HealthCheckFn, opts?: RegisterOptions): void {
    log.debug("registering health check", { name, critical: opts?.critical ?? true, timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.checks.set(name, {
      fn,
      critical: opts?.critical ?? true,
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  /** Unregister a check by name. */
  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Run all checks (or a single named check) and aggregate results. */
  async check(name?: string): Promise<HealthCheckResult> {
    const checks: Record<string, CheckResult> = {};

    if (name) {
      const reg = this.checks.get(name);
      if (!reg) {
        return {
          status: "unhealthy",
          uptime: Math.round(process.uptime()),
          timestamp: new Date().toISOString(),
          checks: { [name]: { status: "unhealthy", detail: "check not found" } },
        };
      }
      checks[name] = await this.runCheck(reg);
    } else {
      const entries = [...this.checks.entries()];
      const results = await Promise.allSettled(
        entries.map(([, reg]) => this.runCheck(reg)),
      );
      for (let i = 0; i < entries.length; i++) {
        const [checkName] = entries[i];
        const result = results[i];
        checks[checkName] =
          result.status === "fulfilled"
            ? result.value
            : { status: "unhealthy", detail: String((result as PromiseRejectedResult).reason) };
      }
    }

    // Aggregate: unhealthy if any unhealthy, degraded if any degraded
    let overall: HealthStatus = "healthy";
    for (const c of Object.values(checks)) {
      if (c.status === "unhealthy") {
        overall = "unhealthy";
        break;
      }
      if (c.status === "degraded") overall = "degraded";
    }

    log.debug("health check completed", { status: overall, checksRun: Object.keys(checks).length });
    if (overall !== "healthy") {
      log.warn("health check result is not healthy", {
        status: overall,
        unhealthyChecks: Object.entries(checks)
          .filter(([, c]) => c.status !== "healthy")
          .map(([n, c]) => ({ name: n, status: c.status, detail: c.detail })),
      });
    }

    return {
      status: overall,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  /**
   * Liveness check — only critical checks can make this fail.
   * Non-critical degraded/unhealthy checks are reported but don't affect the status.
   */
  async liveness(): Promise<HealthCheckResult> {
    const full = await this.check();
    let status: HealthStatus = "healthy";

    for (const [name, result] of Object.entries(full.checks)) {
      const reg = this.checks.get(name);
      if (!reg?.critical) continue;
      if (result.status === "unhealthy") {
        status = "unhealthy";
        break;
      }
      if (result.status === "degraded") status = "degraded";
    }

    return { ...full, status };
  }

  /** List registered check names. */
  list(): string[] {
    return [...this.checks.keys()];
  }

  /** Get the last cached result for a check (without re-running). */
  getLastResult(name: string): CheckResult | undefined {
    return this.checks.get(name)?.lastResult;
  }

  /** Get registration info for a check. */
  getRegistration(name: string): CheckRegistration | undefined {
    return this.checks.get(name);
  }

  private async runCheck(reg: CheckRegistration): Promise<CheckResult> {
    const start = performance.now();
    try {
      const result = await Promise.race([
        Promise.resolve(reg.fn()),
        new Promise<CheckResult>((_, reject) =>
          setTimeout(() => reject(new Error(`check timed out after ${reg.timeoutMs}ms`)), reg.timeoutMs),
        ),
      ]);
      result.durationMs = Math.round(performance.now() - start);
      result.lastChecked = new Date().toISOString();
      reg.lastResult = result;
      return result;
    } catch (err) {
      const result: CheckResult = {
        status: "unhealthy",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - start),
        lastChecked: new Date().toISOString(),
      };
      log.error("health check failed", { detail: result.detail, durationMs: result.durationMs });
      reg.lastResult = result;
      return result;
    }
  }
}
