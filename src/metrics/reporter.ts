/**
 * Metrics reporter — dashboard snapshots and alert evaluation.
 * Follows health/checker.ts pattern: configurable thresholds, aggregated output.
 */

import type {
  AlertThreshold,
  Alert,
  AlertSeverity,
  DashboardSnapshot,
  MetricSummary,
} from "./types.js";
import { MetricsStore } from "./store.js";
import { logActivity } from "../activity/log.js";

const startTime = Date.now();

// ─── Alert state ─────────────────────────────────────────────────────────────

const thresholds: AlertThreshold[] = [];
const recentAlerts: Alert[] = [];
const MAX_RECENT_ALERTS = 50;

/** Cooldown: don't fire the same alert more than once per window. */
const alertCooldowns = new Map<string, number>();

// ─── Default thresholds ──────────────────────────────────────────────────────

/** Register built-in alert thresholds for common system metrics. */
export function registerDefaultThresholds(): void {
  registerThreshold({
    metric: "system.cpu.percent",
    warnAbove: 80,
    critAbove: 95,
    minSamples: 3,
    windowMs: 120_000,
  });
  registerThreshold({
    metric: "system.memory.rss",
    warnAbove: 512 * 1024 * 1024,  // 512 MB
    critAbove: 1024 * 1024 * 1024, // 1 GB
    minSamples: 2,
    windowMs: 60_000,
  });
  registerThreshold({
    metric: "system.event_loop.drift",
    warnAbove: 100,
    critAbove: 500,
    minSamples: 3,
    windowMs: 120_000,
  });
  registerThreshold({
    metric: "http.request.latency.p95",
    warnAbove: 2000,
    critAbove: 5000,
    minSamples: 5,
    windowMs: 120_000,
  });
  registerThreshold({
    metric: "error.total",
    warnAbove: 10,
    critAbove: 50,
    minSamples: 1,
    windowMs: 300_000,
  });
}

// ─── Threshold management ────────────────────────────────────────────────────

/** Register an alert threshold. */
export function registerThreshold(t: AlertThreshold): void {
  thresholds.push(t);
}

/** Clear all thresholds. */
export function clearThresholds(): void {
  thresholds.length = 0;
}

/** Get all registered thresholds. */
export function getThresholds(): readonly AlertThreshold[] {
  return thresholds;
}

// ─── Alert evaluation ────────────────────────────────────────────────────────

/** Evaluate all thresholds against current data. Returns newly fired alerts. */
export async function evaluateAlerts(store: MetricsStore): Promise<Alert[]> {
  const fired: Alert[] = [];
  const now = Date.now();

  for (const t of thresholds) {
    const windowMs = t.windowMs ?? 60_000;
    const since = new Date(now - windowMs).toISOString();
    const points = await store.query({ name: t.metric, tags: t.tags, since });

    if (points.length < (t.minSamples ?? 1)) continue;

    // Use the average value over the window for evaluation
    const avg = points.reduce((s, p) => s + p.value, 0) / points.length;
    const cooldownKey = `${t.metric}:${JSON.stringify(t.tags ?? {})}`;

    // Check critical first, then warn
    const checks: Array<{ severity: AlertSeverity; value: number; threshold: number; direction: string }> = [];

    if (t.critAbove != null && avg > t.critAbove) {
      checks.push({ severity: "crit", value: avg, threshold: t.critAbove, direction: "above" });
    } else if (t.warnAbove != null && avg > t.warnAbove) {
      checks.push({ severity: "warn", value: avg, threshold: t.warnAbove, direction: "above" });
    }

    if (t.critBelow != null && avg < t.critBelow) {
      checks.push({ severity: "crit", value: avg, threshold: t.critBelow, direction: "below" });
    } else if (t.warnBelow != null && avg < t.warnBelow) {
      checks.push({ severity: "warn", value: avg, threshold: t.warnBelow, direction: "below" });
    }

    for (const check of checks) {
      // Cooldown: skip if recently fired
      const lastFired = alertCooldowns.get(`${cooldownKey}:${check.severity}`);
      if (lastFired && now - lastFired < windowMs) continue;

      const alert: Alert = {
        timestamp: new Date().toISOString(),
        severity: check.severity,
        metric: t.metric,
        value: Math.round(check.value * 100) / 100,
        threshold: check.threshold,
        message: `${t.metric} is ${check.direction} ${check.severity} threshold: ${formatValue(check.value, points[0]?.unit)} > ${formatValue(check.threshold, points[0]?.unit)}`,
        tags: t.tags,
      };

      fired.push(alert);
      recentAlerts.push(alert);
      alertCooldowns.set(`${cooldownKey}:${check.severity}`, now);

      // Trim recent alerts
      while (recentAlerts.length > MAX_RECENT_ALERTS) {
        recentAlerts.shift();
      }

      // Log to activity
      logActivity({
        source: "system",
        summary: `Alert [${check.severity}]: ${alert.message}`,
      });
    }
  }

  return fired;
}

/** Get recent alerts. */
export function getRecentAlerts(limit?: number): Alert[] {
  const n = limit ?? MAX_RECENT_ALERTS;
  return recentAlerts.slice(-n);
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** Build a dashboard snapshot from the metrics store. */
export async function buildDashboard(store: MetricsStore): Promise<DashboardSnapshot> {
  const now = new Date().toISOString();
  const windowMs = 300_000; // 5-minute window for dashboard

  // System metrics: most recent values
  const cpuPoints = await store.query({ name: "system.cpu.percent", limit: 1 });
  const heapUsedPoints = await store.query({ name: "system.memory.heap_used", limit: 1 });
  const heapTotalPoints = await store.query({ name: "system.memory.heap_total", limit: 1 });
  const rssPoints = await store.query({ name: "system.memory.rss", limit: 1 });
  const driftPoints = await store.query({ name: "system.event_loop.drift", limit: 1 });

  // HTTP: aggregate over window
  const httpLatency = await store.summarize("http.request.latency.avg", { windowMs });
  const httpCountPoints = await store.query({
    name: "http.request.count",
    since: new Date(Date.now() - windowMs).toISOString(),
  });
  const httpErrorPoints = await store.query({
    name: "http.request.error_count",
    since: new Date(Date.now() - windowMs).toISOString(),
  });

  const totalRequests = httpCountPoints.reduce((s, p) => s + p.value, 0);
  const totalErrors = httpErrorPoints.reduce((s, p) => s + p.value, 0);

  // Agent: aggregate over window
  const agentSpawnPoints = await store.query({
    name: "agent.spawn.count",
    since: new Date(Date.now() - windowMs).toISOString(),
  });
  const agentCompletePoints = await store.query({
    name: "agent.complete.count",
    since: new Date(Date.now() - windowMs).toISOString(),
  });
  const agentFailPoints = await store.query({
    name: "agent.fail.count",
    since: new Date(Date.now() - windowMs).toISOString(),
  });
  const agentDurationSummary = await store.summarize("agent.duration.avg", { windowMs });

  return {
    timestamp: now,
    uptime: Date.now() - startTime,
    system: {
      cpuPercent: last(cpuPoints)?.value ?? 0,
      heapUsedMB: Math.round((last(heapUsedPoints)?.value ?? 0) / 1024 / 1024),
      heapTotalMB: Math.round((last(heapTotalPoints)?.value ?? 0) / 1024 / 1024),
      rssMB: Math.round((last(rssPoints)?.value ?? 0) / 1024 / 1024),
      eventLoopDriftMs: last(driftPoints)?.value ?? 0,
    },
    http: {
      totalRequests,
      errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
      latency: httpLatency,
    },
    agents: {
      totalSpawned: agentSpawnPoints.reduce((s, p) => s + p.value, 0),
      totalCompleted: agentCompletePoints.reduce((s, p) => s + p.value, 0),
      totalFailed: agentFailPoints.reduce((s, p) => s + p.value, 0),
      avgDurationMs: agentDurationSummary?.avg ?? 0,
    },
    recentAlerts: getRecentAlerts(10),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

function formatValue(value: number, unit?: string): string {
  if (unit === "bytes") {
    if (value > 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    return `${(value / 1024).toFixed(1)}KB`;
  }
  if (unit === "ms") return `${Math.round(value)}ms`;
  if (unit === "%") return `${value.toFixed(1)}%`;
  return String(Math.round(value * 100) / 100);
}
