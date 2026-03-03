/**
 * Default alert threshold configurations for common health checks.
 *
 * Provides ready-to-use threshold sets so callers can do:
 *   new AlertManager(checker, { ...defaultAlertConfig(), thresholds: defaultThresholds() })
 */

import type { AlertConfig, AlertThreshold } from "./alert-types.js";

/** Default thresholds for the built-in process-level checks. */
export function defaultThresholds(): AlertThreshold[] {
  return [
    {
      checkName: "memory",
      metric: "rss",
      warningThreshold: 512,
      criticalThreshold: 1024,
      consecutiveBreaches: 2,
      label: "Memory RSS",
    },
    {
      checkName: "memory",
      metric: "heap",
      warningThreshold: 400,
      criticalThreshold: 800,
      consecutiveBreaches: 2,
      label: "Heap Usage",
    },
    {
      checkName: "event_loop",
      metric: "drift",
      warningThreshold: 250,
      criticalThreshold: 500,
      consecutiveBreaches: 3,
      label: "Event Loop Drift",
    },
    {
      checkName: "agent_capacity",
      metric: "utilization",
      warningThreshold: 80,
      criticalThreshold: 95,
      consecutiveBreaches: 2,
      label: "Agent Capacity",
    },
    {
      checkName: "sync",
      metric: "failures",
      warningThreshold: 3,
      criticalThreshold: 5,
      consecutiveBreaches: 1,
      label: "Sync Failures",
    },
    {
      checkName: "cpu",
      metric: "usage",
      warningThreshold: 80,
      criticalThreshold: 95,
      consecutiveBreaches: 3,
      label: "CPU Usage",
    },
    {
      checkName: "disk_usage",
      metric: "used",
      warningThreshold: 85,
      criticalThreshold: 95,
      consecutiveBreaches: 2,
      label: "Disk Usage",
    },
    {
      checkName: "openrouter_credits",
      metric: "percentUsed",
      warningThreshold: 80,
      criticalThreshold: 95,
      consecutiveBreaches: 1,
      label: "OpenRouter Credits",
    },
  ];
}

/** Default alert configuration with sensible values. */
export function defaultAlertConfig(
  overrides?: Partial<AlertConfig>,
): AlertConfig {
  return {
    enabled: true,
    evaluationIntervalMs: 30_000,
    maxHistorySize: 100,
    notificationCooldownMs: 300_000,
    thresholds: defaultThresholds(),
    notifications: [],
    ...overrides,
  };
}
