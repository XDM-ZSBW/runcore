/**
 * Background goal-check timer lifecycle.
 * Follows sidecar.ts pattern: module-level state, idempotent start/stop.
 */

import type { Brain } from "../brain.js";
import { runGoalCheck } from "./loop.js";
import { logActivity } from "../activity/log.js";
import { resolveProvider, resolveUtilityModel } from "../settings.js";
import { resolveEnv } from "../instance.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("goals");

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface TimerConfig {
  brain: Brain;
  humanName: string;
  intervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let config: TimerConfig | null = null;

/**
 * Start the background goal timer. Idempotent — calling twice is a no-op.
 * First check fires after one full interval (not immediately).
 */
export function startGoalTimer(opts: TimerConfig): void {
  if (timer) return; // Already running

  config = opts;
  const interval = opts.intervalMs ?? (parseInt(resolveEnv("GOAL_INTERVAL_MS") ?? "", 10) || DEFAULT_INTERVAL_MS);

  timer = setInterval(async () => {
    if (!config) return;
    try {
      const result = await runGoalCheck({
        brain: config.brain,
        provider: resolveProvider(),
        model: resolveUtilityModel(),
        humanName: config.humanName,
      });
      if (result.action !== "nothing") {
        logActivity({ source: "goal-loop", summary: `${result.action}: ${result.reasoning ?? ""}`, actionLabel: "AUTONOMOUS", reason: "goal-loop timer tick" });
      }
      if (result.error) {
        logActivity({ source: "goal-loop", summary: `Error: ${result.error}`, actionLabel: "AUTONOMOUS", reason: "goal-loop timer tick" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "goal-loop", summary: `Unhandled error: ${msg}`, actionLabel: "AUTONOMOUS", reason: "goal-loop timer tick" });
    }
  }, interval);

  const mins = Math.round(interval / 60_000);
  log.info(`Goal loop: every ${mins} min`);
}

/** Stop the background goal timer. */
export function stopGoalTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  config = null;
}

/** Check if the goal timer is currently running. */
export function isGoalTimerRunning(): boolean {
  return timer !== null;
}
