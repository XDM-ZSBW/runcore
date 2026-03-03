/**
 * Prometheus metrics integration.
 * Registers standard Core metrics and provides a collection function
 * that updates gauges from process stats before exposition.
 *
 * Usage in server.ts:
 *   import { initPrometheus, collectPrometheus, prometheusRegistry } from "./metrics/prometheus.js";
 *   initPrometheus();
 *   app.get("/metrics", (c) => {
 *     const body = collectPrometheus();
 *     return c.text(body, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
 *   });
 */

import { MetricRegistry } from "./registry.js";
import { Counter, Gauge, Histogram } from "./instruments.js";

// ─── Global registry and instruments ─────────────────────────────────────────

export const prometheusRegistry = new MetricRegistry();

// Counters
export const agentSpawnsTotal = prometheusRegistry.registerCounter({
  name: "agent_spawns_total",
  help: "Total number of agent spawns",
});

export const agentExecutionsTotal = prometheusRegistry.registerCounter({
  name: "agent_executions_total",
  help: "Total number of agent executions",
  labelNames: ["status"],
});

export const apiCallsTotal = prometheusRegistry.registerCounter({
  name: "api_calls_total",
  help: "Total number of API calls",
  labelNames: ["method", "path", "status"],
});

// DASH-43: HTTP request metrics for API performance monitoring
export const httpRequestsTotal = prometheusRegistry.registerCounter({
  name: "http_requests_total",
  help: "Total HTTP requests by endpoint, method, and status",
  labelNames: ["endpoint", "method", "status"],
});

export const httpRequestDurationSeconds = prometheusRegistry.registerHistogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["endpoint", "method"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const concurrentRequests = prometheusRegistry.registerGauge({
  name: "concurrent_requests",
  help: "Number of HTTP requests currently in flight",
});

export const errorsTotal = prometheusRegistry.registerCounter({
  name: "errors_total",
  help: "Total number of errors",
  labelNames: ["source"],
});

// Histograms
export const agentExecutionDuration = prometheusRegistry.registerHistogram({
  name: "agent_execution_duration_seconds",
  help: "Duration of agent executions in seconds",
  labelNames: ["status"],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600],
});

export const apiCallDuration = prometheusRegistry.registerHistogram({
  name: "api_call_duration_seconds",
  help: "Duration of API calls in seconds",
  labelNames: ["method", "path"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Gauges
export const memoryUsageBytes = prometheusRegistry.registerGauge({
  name: "memory_usage_bytes",
  help: "Process memory usage in bytes",
  labelNames: ["type"],
});

export const agentExecutionsInFlight = prometheusRegistry.registerGauge({
  name: "agent_executions_in_flight",
  help: "Number of agent executions currently in progress",
});

export const agentSuccessRate = prometheusRegistry.registerGauge({
  name: "agent_success_rate",
  help: "Agent execution success rate (0-1)",
});

export const agentMemoryUsageBytes = prometheusRegistry.registerGauge({
  name: "agent_memory_usage_bytes",
  help: "Process memory usage during agent execution in bytes",
});

export const uptimeSeconds = prometheusRegistry.registerGauge({
  name: "process_uptime_seconds",
  help: "Process uptime in seconds",
});

export const cpuUsagePercent = prometheusRegistry.registerGauge({
  name: "cpu_usage_percent",
  help: "CPU usage percentage",
});

export const eventLoopDriftSeconds = prometheusRegistry.registerGauge({
  name: "event_loop_drift_seconds",
  help: "Event loop drift in seconds",
});

export const diskUsageBytes = prometheusRegistry.registerGauge({
  name: "disk_usage_bytes",
  help: "Total size of the brain/ directory in bytes",
});

// ─── Collection ──────────────────────────────────────────────────────────────

/**
 * Collect all Prometheus metrics, updating process gauges first.
 * Returns Prometheus text exposition format.
 */
export function collectPrometheus(): string {
  // Update process gauges before collection
  const mem = process.memoryUsage();
  memoryUsageBytes.set({ type: "heap_used" }, mem.heapUsed);
  memoryUsageBytes.set({ type: "heap_total" }, mem.heapTotal);
  memoryUsageBytes.set({ type: "rss" }, mem.rss);
  memoryUsageBytes.set({ type: "external" }, mem.external);

  uptimeSeconds.set(undefined, process.uptime());

  return prometheusRegistry.collect();
}
