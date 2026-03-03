/**
 * Threshold-based alerting system for Core health monitoring.
 *
 * Evaluates health check results against configured thresholds, manages
 * alert lifecycle (firing → acknowledged → resolved), dispatches
 * notifications, and maintains alert history.
 *
 * Integrates with HealthChecker via its public API — no modifications
 * to the core checker are needed.
 */

import type { HealthChecker } from "./checker.js";
import type {
  Alert,
  AlertConfig,
  AlertSeverity,
  AlertState,
  AlertSummary,
  AlertThreshold,
  ChannelPreference,
  MetricExtractor,
} from "./alert-types.js";
import type { NotificationDispatcher } from "../notifications/channel.js";
import { creditsExtractor } from "./checks/openrouter.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("health.alerting");

// ─── Default configuration ─────────────────────────────────────────────────

const DEFAULT_EVALUATION_INTERVAL_MS = 30_000;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 300_000; // 5 minutes

// ─── Built-in metric extractors ─────────────────────────────────────────────

/** Parse metrics from the built-in memory check detail string. */
function memoryExtractor(detail: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  const heapMatch = detail.match(/heap\s+(\d+)MB/i);
  const rssMatch = detail.match(/rss\s+(\d+)MB/i);
  if (heapMatch) metrics["heap"] = parseInt(heapMatch[1], 10);
  if (rssMatch) metrics["rss"] = parseInt(rssMatch[1], 10);
  return metrics;
}

/** Parse metrics from the event loop check detail string. */
function eventLoopExtractor(detail: string): Record<string, number> {
  const match = detail.match(/drift\s+(\d+)ms/i);
  return match ? { drift: parseInt(match[1], 10) } : {};
}

/** Parse utilization percentage from agent capacity check. */
function utilizationExtractor(detail: string): Record<string, number> {
  const match = detail.match(/(\d+)%/);
  return match ? { utilization: parseInt(match[1], 10) } : {};
}

/** Parse failure count from sync check. */
function failureCountExtractor(detail: string): Record<string, number> {
  const match = detail.match(/failures:\s*(\d+)/i);
  return match ? { failures: parseInt(match[1], 10) } : {};
}

/** Parse CPU percentage from cpu check. */
function cpuExtractor(detail: string): Record<string, number> {
  const match = detail.match(/cpu\s+(\d+)%/i);
  return match ? { usage: parseInt(match[1], 10) } : {};
}

/** Parse disk usage percentage and free MB from disk usage check. */
function diskUsageExtractor(detail: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  const usedMatch = detail.match(/disk\s+(\d+)%/i);
  const freeMatch = detail.match(/(\d+)MB\s+free/i);
  if (usedMatch) metrics["used"] = parseInt(usedMatch[1], 10);
  if (freeMatch) metrics["freeMB"] = parseInt(freeMatch[1], 10);
  return metrics;
}

/** Built-in extractors for known check types. */
const BUILT_IN_EXTRACTORS: Record<string, MetricExtractor> = {
  memory: memoryExtractor,
  event_loop: eventLoopExtractor,
  agent_capacity: utilizationExtractor,
  sync: failureCountExtractor,
  cpu: cpuExtractor,
  disk_usage: diskUsageExtractor,
  openrouter_credits: creditsExtractor,
};

// ─── AlertManager ───────────────────────────────────────────────────────────

export class AlertManager {
  private checker: HealthChecker;
  private dispatcher: NotificationDispatcher | null;
  private config: Required<AlertConfig>;

  private extractors = new Map<string, MetricExtractor>();
  private activeAlerts = new Map<string, Alert>();
  private history: Alert[] = [];
  private breachCounts = new Map<string, number>();
  private lastNotified = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEvaluation: string | null = null;
  private idCounter = 0;

  constructor(
    checker: HealthChecker,
    config: AlertConfig,
    dispatcher?: NotificationDispatcher,
  ) {
    this.checker = checker;
    this.dispatcher = dispatcher ?? null;

    this.config = {
      enabled: config.enabled,
      evaluationIntervalMs:
        config.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS,
      maxHistorySize: config.maxHistorySize ?? DEFAULT_MAX_HISTORY,
      notificationCooldownMs:
        config.notificationCooldownMs ?? DEFAULT_NOTIFICATION_COOLDOWN_MS,
      thresholds: config.thresholds,
      notifications: config.notifications,
    };

    // Register built-in extractors for known check names
    for (const [name, extractor] of Object.entries(BUILT_IN_EXTRACTORS)) {
      this.extractors.set(name, extractor);
    }
  }

  // ─── Metric extractors ─────────────────────────────────────────────────

  /** Register a custom metric extractor for a check name. */
  registerExtractor(checkName: string, extractor: MetricExtractor): void {
    this.extractors.set(checkName, extractor);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the alerting evaluation loop. */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    log.info("alerting evaluation loop started", { intervalMs: this.config.evaluationIntervalMs });
    this.timer = setInterval(
      () => this.evaluate(),
      this.config.evaluationIntervalMs,
    );
  }

  /** Stop the alerting evaluation loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("alerting evaluation loop stopped");
    }
  }

  /** Run a single evaluation cycle. Returns IDs of newly fired or resolved alerts. */
  async evaluate(): Promise<{ fired: string[]; resolved: string[] }> {
    const fired: string[] = [];
    const resolved: string[] = [];

    let healthResult;
    try {
      healthResult = await this.checker.check();
    } catch (err) {
      log.error("alert evaluation failed — health check threw", { error: String(err) });
      return { fired, resolved };
    }

    this.lastEvaluation = new Date().toISOString();

    // Track which thresholds are still breaching
    const activeThresholdIds = new Set<string>();

    for (const threshold of this.config.thresholds) {
      const thresholdId = `${threshold.checkName}:${threshold.metric}`;
      const checkResult = healthResult.checks[threshold.checkName];

      if (!checkResult?.detail) {
        // Check not found or no detail — clear breach count
        this.breachCounts.set(thresholdId, 0);
        continue;
      }

      // Extract metric value
      const extractor = this.extractors.get(threshold.checkName);
      if (!extractor) continue;

      const metrics = extractor(checkResult.detail);
      const value = metrics[threshold.metric];
      if (value === undefined) continue;

      // Determine severity
      let severity: AlertSeverity | null = null;
      let breachedThreshold = 0;

      if (value >= threshold.criticalThreshold) {
        severity = "critical";
        breachedThreshold = threshold.criticalThreshold;
      } else if (value >= threshold.warningThreshold) {
        severity = "warning";
        breachedThreshold = threshold.warningThreshold;
      }

      if (severity) {
        const requiredBreaches = threshold.consecutiveBreaches ?? 1;
        const count = (this.breachCounts.get(thresholdId) ?? 0) + 1;
        this.breachCounts.set(thresholdId, count);

        if (count >= requiredBreaches) {
          activeThresholdIds.add(thresholdId);

          const existing = this.activeAlerts.get(thresholdId);
          if (existing) {
            // Update severity if it escalated
            if (
              severity === "critical" &&
              existing.severity === "warning"
            ) {
              existing.severity = "critical";
              existing.value = value;
              existing.threshold = breachedThreshold;
              existing.message = this.formatMessage(
                threshold,
                severity,
                value,
                breachedThreshold,
              );
              this.notifyIfAllowed(existing);
            }
          } else {
            // New alert
            const alert = this.createAlert(
              thresholdId,
              threshold,
              severity,
              value,
              breachedThreshold,
            );
            this.activeAlerts.set(thresholdId, alert);
            fired.push(alert.id);
            log.info("alert fired", {
              alertId: alert.id,
              thresholdId,
              severity,
              metric: threshold.metric,
              value,
              threshold: breachedThreshold,
            });
            this.notifyIfAllowed(alert);
          }
        }
      } else {
        // Value is below thresholds — clear breach count
        this.breachCounts.set(thresholdId, 0);
      }
    }

    // Resolve alerts whose thresholds are no longer breaching
    for (const [thresholdId, alert] of this.activeAlerts) {
      if (!activeThresholdIds.has(thresholdId) && alert.state !== "resolved") {
        alert.state = "resolved";
        alert.resolvedAt = new Date().toISOString();
        resolved.push(alert.id);
        log.info("alert resolved", { alertId: alert.id, thresholdId, checkName: alert.checkName });
        this.addToHistory(alert);
        this.activeAlerts.delete(thresholdId);
        this.lastNotified.delete(thresholdId);
        this.notifyResolved(alert);
      }
    }

    return { fired, resolved };
  }

  // ─── Alert acknowledgment ──────────────────────────────────────────────

  /** Acknowledge an active alert. Returns true if the alert was found and acknowledged. */
  acknowledge(alertId: string, by?: string): boolean {
    for (const alert of this.activeAlerts.values()) {
      if (alert.id === alertId && alert.state === "firing") {
        alert.state = "acknowledged";
        alert.acknowledgedAt = new Date().toISOString();
        alert.acknowledgedBy = by;
        log.info("alert acknowledged", { alertId, by });
        return true;
      }
    }
    return false;
  }

  /** Manually resolve an active alert. */
  resolve(alertId: string): boolean {
    for (const [thresholdId, alert] of this.activeAlerts) {
      if (alert.id === alertId) {
        alert.state = "resolved";
        alert.resolvedAt = new Date().toISOString();
        this.addToHistory(alert);
        this.activeAlerts.delete(thresholdId);
        this.lastNotified.delete(thresholdId);
        return true;
      }
    }
    return false;
  }

  // ─── Query ──────────────────────────────────────────────────────────────

  /** Get all active alerts (firing + acknowledged). */
  getActive(): Alert[] {
    return [...this.activeAlerts.values()];
  }

  /** Get alert history (resolved alerts, most recent first). */
  getHistory(): Alert[] {
    return [...this.history];
  }

  /** Get a single alert by ID (active or historical). */
  getAlert(id: string): Alert | undefined {
    for (const alert of this.activeAlerts.values()) {
      if (alert.id === id) return alert;
    }
    return this.history.find((a) => a.id === id);
  }

  /** Get dashboard summary. */
  getSummary(): AlertSummary {
    const firing: Alert[] = [];
    const acknowledged: Alert[] = [];
    const bySeverity: Record<AlertSeverity, number> = {
      warning: 0,
      critical: 0,
    };

    for (const alert of this.activeAlerts.values()) {
      bySeverity[alert.severity]++;
      if (alert.state === "firing") firing.push(alert);
      else if (alert.state === "acknowledged") acknowledged.push(alert);
    }

    return {
      activeCount: this.activeAlerts.size,
      bySeverity,
      firing,
      acknowledged,
      recentlyResolved: this.history.slice(0, 10),
      lastEvaluation: this.lastEvaluation,
    };
  }

  /** Get the current configuration (read-only snapshot). */
  getConfig(): Readonly<AlertConfig> {
    return { ...this.config };
  }

  // ─── Configuration updates ──────────────────────────────────────────────

  /** Update thresholds at runtime. */
  updateThresholds(thresholds: AlertThreshold[]): void {
    this.config.thresholds = thresholds;
  }

  /** Update notification preferences at runtime. */
  updateNotifications(notifications: ChannelPreference[]): void {
    this.config.notifications = notifications;
  }

  /** Enable or disable the alerting system. */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (!enabled) this.stop();
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private createAlert(
    thresholdId: string,
    threshold: AlertThreshold,
    severity: AlertSeverity,
    value: number,
    breachedThreshold: number,
  ): Alert {
    return {
      id: `alert_${Date.now()}_${++this.idCounter}`,
      thresholdId,
      checkName: threshold.checkName,
      metric: threshold.metric,
      severity,
      state: "firing",
      value,
      threshold: breachedThreshold,
      message: this.formatMessage(threshold, severity, value, breachedThreshold),
      firedAt: new Date().toISOString(),
    };
  }

  private formatMessage(
    threshold: AlertThreshold,
    severity: AlertSeverity,
    value: number,
    breachedThreshold: number,
  ): string {
    const label = threshold.label ?? `${threshold.checkName}/${threshold.metric}`;
    return `${label} is ${value} (${severity} threshold: ${breachedThreshold})`;
  }

  private addToHistory(alert: Alert): void {
    this.history.unshift({ ...alert });
    if (this.history.length > this.config.maxHistorySize) {
      this.history.length = this.config.maxHistorySize;
    }
  }

  private notifyIfAllowed(alert: Alert): void {
    if (!this.dispatcher) return;

    const thresholdId = alert.thresholdId;
    const lastTime = this.lastNotified.get(thresholdId) ?? 0;
    const now = Date.now();

    if (now - lastTime < this.config.notificationCooldownMs) return;

    this.lastNotified.set(thresholdId, now);
    this.dispatchToChannels(alert);
  }

  private notifyResolved(alert: Alert): void {
    if (!this.dispatcher) return;
    this.dispatchToChannels(alert);
  }

  private dispatchToChannels(alert: Alert): void {
    if (!this.dispatcher) return;

    for (const pref of this.config.notifications) {
      // Check severity filter
      if (!this.meetsMinSeverity(alert.severity, pref.minSeverity)) continue;
      // Check name filter
      if (
        pref.checkFilter &&
        pref.checkFilter.length > 0 &&
        !pref.checkFilter.includes(alert.checkName)
      ) {
        continue;
      }
      // Fire and forget
      log.debug("dispatching alert to channel", { alertId: alert.id, channel: pref.channel, state: alert.state });
      this.dispatcher.sendTo(pref.channel, alert);
    }
  }

  private meetsMinSeverity(
    actual: AlertSeverity,
    minimum: AlertSeverity,
  ): boolean {
    const levels: Record<AlertSeverity, number> = {
      warning: 0,
      critical: 1,
    };
    return levels[actual] >= levels[minimum];
  }
}
