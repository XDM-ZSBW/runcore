/**
 * Metrics module — public API.
 * Follows src/health/index.ts pattern: re-export types + implementations.
 */

// Store
export { MetricsStore } from "./store.js";

// Collector
export {
  startCollector,
  stopCollector,
  isCollectorRunning,
  recordHttp,
  recordConcurrentRequests,
  recordAgentSpawn,
  recordAgentCompletion,
  recordError,
} from "./collector.js";

// Reporter
export {
  registerDefaultThresholds,
  registerThreshold,
  clearThresholds,
  getThresholds,
  evaluateAlerts,
  getRecentAlerts,
  buildDashboard,
} from "./reporter.js";

// Firewall metrics
export {
  FIREWALL_METRICS,
  recordAutonomousAction,
  recordDedupBlock,
  recordRoutineFiltered,
  recordResolvedFiltered,
  recordCooldownActivation,
  recordCooldownSkip,
  recordBridgeReport,
  recordSpawnRateBlock,
  recordAnalysisThroughput,
  collectFirewallMetrics,
  generatePeriodStats,
  generateComparisonReport,
} from "./firewall-metrics.js";
export type { FirewallPeriodStats } from "./firewall-metrics.js";

// Middleware
export { metricsMiddleware } from "./middleware.js";

// Prometheus-style instruments and registry
export { Counter, Gauge, Histogram, DEFAULT_BUCKETS } from "./instruments.js";
export type { Labels, Sample, BucketSample, HistogramSamples } from "./instruments.js";
export { MetricRegistry } from "./registry.js";
export type { MetricStoreBackend, MetricType } from "./registry.js";
export {
  prometheusRegistry,
  collectPrometheus,
  agentSpawnsTotal,
  agentExecutionsTotal,
  agentExecutionDuration,
  agentSuccessRate,
  agentMemoryUsageBytes,
  apiCallsTotal,
  apiCallDuration,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  concurrentRequests,
  memoryUsageBytes,
  agentExecutionsInFlight,
  uptimeSeconds,
  cpuUsagePercent,
  eventLoopDriftSeconds,
  errorsTotal,
  diskUsageBytes,
} from "./prometheus.js";

// System metrics
export {
  initCpuBaseline,
  collectMemoryMetrics,
  collectCpuMetrics,
  collectDiskMetrics,
  collectSystemMetrics,
} from "./system.js";

// Aggregator
export {
  aggregateHourly,
  aggregateDaily,
  runAggregation,
  isAggregating,
} from "./aggregator.js";
export type {
  AggregateWindow,
  AggregateEntry,
  AggregateFile,
} from "./aggregator.js";

// Types
export type {
  MetricPoint,
  MetricCategory,
  MetricSummary,
  HistogramBucket,
  AlertThreshold,
  Alert,
  AlertSeverity,
  DashboardSnapshot,
  RotationConfig,
} from "./types.js";
