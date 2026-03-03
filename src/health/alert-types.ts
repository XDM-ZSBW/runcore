/**
 * Alert system type definitions.
 *
 * Extends the health check system with threshold-based alerting,
 * notification channels, and alert lifecycle management.
 */

import type { HealthStatus } from "./types.js";

// ─── Alert severity & state ────────────────────────────────────────────────

export type AlertSeverity = "warning" | "critical";

export type AlertState = "firing" | "acknowledged" | "resolved";

// ─── Alert threshold configuration ─────────────────────────────────────────

/** Threshold for a single metric (e.g., memory RSS, CPU, disk usage). */
export interface AlertThreshold {
  /** The health check name this threshold watches. */
  checkName: string;
  /** Metric name within the check (e.g., "rss", "heap", "utilization"). */
  metric: string;
  /** Value above which a warning fires. */
  warningThreshold: number;
  /** Value above which a critical alert fires. */
  criticalThreshold: number;
  /** How many consecutive breaches before firing. Prevents flapping. Default: 1. */
  consecutiveBreaches?: number;
  /** Human-readable label for notifications (e.g., "Memory RSS"). */
  label?: string;
}

// ─── Alert instance ────────────────────────────────────────────────────────

/** A single alert occurrence. */
export interface Alert {
  id: string;
  /** Which threshold rule produced this alert. */
  thresholdId: string;
  checkName: string;
  metric: string;
  severity: AlertSeverity;
  state: AlertState;
  /** The value that triggered the alert. */
  value: number;
  /** The threshold that was breached. */
  threshold: number;
  message: string;
  /** ISO timestamp when the alert first fired. */
  firedAt: string;
  /** ISO timestamp when acknowledged, if applicable. */
  acknowledgedAt?: string;
  /** Who/what acknowledged the alert. */
  acknowledgedBy?: string;
  /** ISO timestamp when resolved, if applicable. */
  resolvedAt?: string;
}

// ─── Notification channel ──────────────────────────────────────────────────

/** Interface for notification delivery channels. */
export interface NotificationChannel {
  /** Channel identifier (e.g., "email", "sms", "webhook"). */
  name: string;
  /** Whether this channel is currently enabled. */
  enabled: boolean;
  /** Send an alert notification. Returns true on success. */
  send(alert: Alert): Promise<boolean>;
}

// ─── Alert configuration ───────────────────────────────────────────────────

/** Per-channel notification preferences. */
export interface ChannelPreference {
  /** Channel name. */
  channel: string;
  /** Minimum severity to notify on this channel. */
  minSeverity: AlertSeverity;
  /** Only notify for specific check names. Empty = all checks. */
  checkFilter?: string[];
}

/** Full alert system configuration. */
export interface AlertConfig {
  /** Whether the alerting system is enabled. */
  enabled: boolean;
  /** How often to evaluate thresholds (ms). Default: 30_000. */
  evaluationIntervalMs?: number;
  /** How many resolved alerts to keep in history. Default: 100. */
  maxHistorySize?: number;
  /** Minimum time between repeated notifications for the same alert (ms). Default: 300_000. */
  notificationCooldownMs?: number;
  /** Threshold rules. */
  thresholds: AlertThreshold[];
  /** Notification channel preferences. */
  notifications: ChannelPreference[];
}

// ─── Dashboard integration ─────────────────────────────────────────────────

/** Summary for dashboard display. */
export interface AlertSummary {
  /** Total active (firing + acknowledged) alerts. */
  activeCount: number;
  /** Breakdown by severity. */
  bySeverity: Record<AlertSeverity, number>;
  /** Currently firing alerts. */
  firing: Alert[];
  /** Acknowledged but unresolved alerts. */
  acknowledged: Alert[];
  /** Recently resolved alerts. */
  recentlyResolved: Alert[];
  /** When the last evaluation ran. */
  lastEvaluation: string | null;
}

/** Metric value extractor — registered per check to pull numeric values. */
export type MetricExtractor = (detail: string) => Record<string, number>;
