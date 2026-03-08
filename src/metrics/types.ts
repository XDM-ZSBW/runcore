/**
 * Metrics type definitions.
 * Follows health/types.ts pattern: interfaces + literal union types.
 */

/** Metric data point — a single time-series measurement. */
export interface MetricPoint {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Metric name (e.g. "http.request.duration", "system.cpu.percent"). */
  name: string;
  /** Numeric value. */
  value: number;
  /** Unit label (e.g. "ms", "bytes", "%", "count"). */
  unit?: string;
  /** Dimensional tags for filtering/grouping. */
  tags?: Record<string, string>;
}

/** Pre-defined metric categories for collection. */
export type MetricCategory = "system" | "http" | "agent" | "error" | "llm" | "sidecar" | "context";

/** Histogram bucket for latency distributions. */
export interface HistogramBucket {
  le: number;   // upper bound (less-than-or-equal)
  count: number;
}

/** Aggregated metric summary over a time window. */
export interface MetricSummary {
  name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  unit?: string;
  tags?: Record<string, string>;
  windowStart: string;
  windowEnd: string;
}

/** Alert threshold configuration. */
export interface AlertThreshold {
  metric: string;
  /** Tag filter — alert only fires for points matching these tags. */
  tags?: Record<string, string>;
  /** Alert when value exceeds this. */
  warnAbove?: number;
  /** Alert when value exceeds this. */
  critAbove?: number;
  /** Alert when value drops below this. */
  warnBelow?: number;
  /** Alert when value drops below this. */
  critBelow?: number;
  /** Minimum points in window before evaluating. */
  minSamples?: number;
  /** Evaluation window in ms. Default: 60_000 (1 min). */
  windowMs?: number;
}

export type AlertSeverity = "warn" | "crit";

/** A fired alert. */
export interface Alert {
  timestamp: string;
  severity: AlertSeverity;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  tags?: Record<string, string>;
}

/** Dashboard snapshot — aggregated view of all tracked metrics. */
export interface DashboardSnapshot {
  timestamp: string;
  uptime: number;
  system: {
    cpuPercent: number;
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    eventLoopDriftMs: number;
  };
  http: {
    totalRequests: number;
    errorRate: number;
    latency: MetricSummary | null;
  };
  agents: {
    totalSpawned: number;
    totalCompleted: number;
    totalFailed: number;
    avgDurationMs: number;
  };
  recentAlerts: Alert[];
}

/** Store rotation config. */
export interface RotationConfig {
  /** Max points before rotation. Default: 10_000. */
  maxPoints?: number;
  /** Max age in ms before points are dropped. Default: 24 hours. */
  maxAgeMs?: number;
}
