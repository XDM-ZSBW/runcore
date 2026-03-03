/**
 * Auto-recovery system — self-healing mechanisms for common failure modes.
 *
 * Watches health check results and triggers recovery actions when checks
 * fail beyond a configurable threshold. Includes cooldowns to prevent
 * recovery storms.
 *
 * Recovery actions are registered alongside health checks and execute
 * automatically when conditions are met.
 */

import type { HealthCheckResult, RecoveryAction, RecoveryState } from "./types.js";
import type { HealthChecker } from "./checker.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("health.recovery");

export class RecoveryManager {
  private actions: RecoveryAction[] = [];
  private state = new Map<string, RecoveryState>();
  private checker: HealthChecker;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;

  constructor(checker: HealthChecker, intervalMs = 30_000) {
    this.checker = checker;
    this.intervalMs = intervalMs;
  }

  /** Register a recovery action for a specific health check. */
  register(action: RecoveryAction): void {
    log.debug("registering recovery action", { name: action.name, checkName: action.checkName, threshold: action.threshold, cooldownMs: action.cooldownMs });
    this.actions.push(action);
    this.state.set(action.name, {
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      totalAttempts: 0,
      totalSuccesses: 0,
    });
  }

  /** Start the background recovery loop. */
  start(): void {
    if (this.timer) return;
    log.info("recovery loop started", { intervalMs: this.intervalMs });
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
  }

  /** Stop the background recovery loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("recovery loop stopped");
    }
  }

  /** Run one evaluation cycle: check health, trigger recoveries if needed. */
  async evaluate(): Promise<string[]> {
    const triggered: string[] = [];
    let result: HealthCheckResult;

    try {
      result = await this.checker.check();
    } catch (err) {
      log.error("recovery evaluation failed — health check threw", { error: String(err) });
      return triggered;
    }

    for (const action of this.actions) {
      const checkResult = result.checks[action.checkName];
      const st = this.state.get(action.name)!;

      if (!checkResult || checkResult.status === "healthy") {
        // Reset failure counter on healthy
        st.consecutiveFailures = 0;
        continue;
      }

      st.consecutiveFailures++;

      if (st.consecutiveFailures < action.threshold) continue;

      // Check cooldown
      if (st.lastAttempt) {
        const elapsed = Date.now() - new Date(st.lastAttempt).getTime();
        if (elapsed < action.cooldownMs) continue;
      }

      // Trigger recovery
      log.info("triggering recovery action", {
        action: action.name,
        checkName: action.checkName,
        consecutiveFailures: st.consecutiveFailures,
        totalAttempts: st.totalAttempts,
      });
      st.lastAttempt = new Date().toISOString();
      st.totalAttempts++;

      try {
        const success = await action.execute();
        if (success) {
          st.consecutiveFailures = 0;
          st.lastSuccess = new Date().toISOString();
          st.totalSuccesses++;
          log.info("recovery action succeeded", { action: action.name, checkName: action.checkName });
        } else {
          log.warn("recovery action returned false", { action: action.name, checkName: action.checkName });
        }
        triggered.push(action.name);
      } catch (err) {
        // Recovery itself failed — will retry on next cycle after cooldown
        log.error("recovery action threw an error", { action: action.name, checkName: action.checkName, error: String(err) });
      }
    }

    return triggered;
  }

  /** Get diagnostic state for all recovery actions. */
  getState(): Record<string, RecoveryState & { actionName: string; checkName: string }> {
    const out: Record<string, RecoveryState & { actionName: string; checkName: string }> = {};
    for (const action of this.actions) {
      const st = this.state.get(action.name);
      if (st) {
        out[action.name] = { ...st, actionName: action.name, checkName: action.checkName };
      }
    }
    return out;
  }
}

// ─── Pre-built recovery actions ──────────────────────────────────────────────

/**
 * Create a sidecar restart recovery action.
 * Stops then starts the sidecar process when its health check fails.
 */
export function sidecarRecovery(
  name: string,
  checkName: string,
  stop: () => void,
  start: () => Promise<boolean>,
  opts?: { threshold?: number; cooldownMs?: number },
): RecoveryAction {
  return {
    name: `recover_${name}`,
    checkName,
    threshold: opts?.threshold ?? 3,
    cooldownMs: opts?.cooldownMs ?? 60_000,
    execute: async () => {
      stop();
      // Brief pause before restarting
      await new Promise((r) => setTimeout(r, 1000));
      return start();
    },
  };
}

