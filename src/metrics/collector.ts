/**
 * Metrics collector — background collection of system, HTTP, agent, and error metrics.
 * Follows queue/timer.ts pattern: module-level state, idempotent start/stop, dynamic intervals.
 */

import type { MetricPoint } from "./types.js";
import { MetricsStore } from "./store.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { collectFirewallMetrics } from "./firewall-metrics.js";
import { collectSystemMetrics, initCpuBaseline } from "./system.js";
import { runAggregation } from "./aggregator.js";

const log = createLogger("metrics");
import {
  agentSpawnsTotal,
  agentExecutionsTotal,
  agentExecutionDuration,
  agentExecutionsInFlight,
  agentSuccessRate,
  agentMemoryUsageBytes,
  errorsTotal,
  eventLoopDriftSeconds,
  concurrentRequests,
} from "./prometheus.js";

const DEFAULT_COLLECT_INTERVAL_MS = 30_000; // 30 seconds
const ROTATION_CHECK_CYCLES = 60;           // check rotation every ~30 min at 30s interval
const AGGREGATION_CHECK_CYCLES = 120;       // aggregate every ~60 min at 30s interval

// ─── Module-level state ──────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let store: MetricsStore | null = null;
let metricsDir: string | null = null;
let collectCycles = 0;

// ─── In-memory counters (written to store on each collect cycle) ─────────────

/** HTTP request tracking — populated by middleware via recordHttp(). */
const httpLatencies: number[] = [];
const httpStatusCounts = new Map<number, number>();
let httpTotal = 0;
let httpErrors = 0;
let httpConcurrent = 0;
let httpConcurrentMax = 0;

/** Per-endpoint request counts — populated by middleware via recordHttp(). */
const httpEndpointCounts = new Map<string, number>();

/** Agent lifecycle tracking — populated via recordAgentSpawn/Completion(). */
let agentSpawnCount = 0;
let agentCompleteCount = 0;
let agentFailCount = 0;
const agentDurations: number[] = [];

/** Cumulative agent success/total for computing success rate gauge. */
let cumulativeAgentSuccesses = 0;
let cumulativeAgentTotal = 0;

/** Error tracking — populated via recordError(). */
let errorCount = 0;
const errorsBySource = new Map<string, number>();

// ─── Collection ──────────────────────────────────────────────────────────────

/** Collect all metrics and write to store. */
async function collect(): Promise<void> {
  if (!store) return;

  const now = new Date().toISOString();
  const points: MetricPoint[] = [];

  // System: memory, CPU, and disk (brain/ directory size)
  points.push(...await collectSystemMetrics(now));

  // System: Event loop drift
  const driftStart = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const drift = performance.now() - driftStart;
  const driftRounded = Math.round(drift * 100) / 100;
  points.push({
    timestamp: now,
    name: "system.event_loop.drift",
    value: driftRounded,
    unit: "ms",
  });
  eventLoopDriftSeconds.set(undefined, driftRounded / 1000);

  // Snapshot accumulators (sync) so new data arriving during the async
  // write goes into fresh accumulators, not into the void.
  const hadHttp = httpLatencies.length > 0;
  const hadAgent = agentSpawnCount > 0 || agentCompleteCount > 0 || agentFailCount > 0;
  const hadErrors = errorCount > 0;

  // HTTP: snapshot and drain
  const httpSnap = hadHttp ? httpLatencies.splice(0) : [];
  const httpStatusSnap = hadHttp ? new Map(httpStatusCounts) : null;
  const httpEndpointSnap = hadHttp ? new Map(httpEndpointCounts) : null;
  const httpTotalSnap = httpTotal;
  const httpErrorsSnap = httpErrors;
  const httpConcurrentSnap = httpConcurrent;
  const httpConcurrentMaxSnap = httpConcurrentMax;
  if (hadHttp) { httpStatusCounts.clear(); httpEndpointCounts.clear(); httpTotal = 0; httpErrors = 0; httpConcurrentMax = httpConcurrent; }

  // Agent: snapshot and drain
  const agentSpawnSnap = agentSpawnCount;
  const agentCompleteSnap = agentCompleteCount;
  const agentFailSnap = agentFailCount;
  const agentDurSnap = hadAgent ? agentDurations.splice(0) : [];
  if (hadAgent) { agentSpawnCount = 0; agentCompleteCount = 0; agentFailCount = 0; }

  // Error: snapshot and drain
  const errorCountSnap = errorCount;
  const errorsBySourceSnap = hadErrors ? new Map(errorsBySource) : null;
  if (hadErrors) { errorCount = 0; errorsBySource.clear(); }

  // Build points from snapshots
  if (hadHttp) {
    const sorted = [...httpSnap].sort((a, b) => a - b);
    const sum = sorted.reduce((a, v) => a + v, 0);
    points.push(
      { timestamp: now, name: "http.request.count", value: httpTotalSnap, unit: "count" },
      { timestamp: now, name: "http.request.error_count", value: httpErrorsSnap, unit: "count" },
      { timestamp: now, name: "http.request.latency.avg", value: Math.round(sum / sorted.length), unit: "ms" },
      { timestamp: now, name: "http.request.latency.p50", value: percentile(sorted, 50), unit: "ms" },
      { timestamp: now, name: "http.request.latency.p95", value: percentile(sorted, 95), unit: "ms" },
      { timestamp: now, name: "http.request.latency.p99", value: percentile(sorted, 99), unit: "ms" },
      { timestamp: now, name: "http.request.latency.max", value: sorted[sorted.length - 1], unit: "ms" },
    );
    for (const [code, count] of httpStatusSnap!) {
      points.push({
        timestamp: now,
        name: "http.request.status",
        value: count,
        unit: "count",
        tags: { status: String(code) },
      });
    }
    // Per-endpoint request counts
    for (const [key, count] of httpEndpointSnap!) {
      const [method, ...rest] = key.split(" ");
      const endpoint = rest.join(" ");
      points.push({
        timestamp: now,
        name: "http.request.by_endpoint",
        value: count,
        unit: "count",
        tags: { method, endpoint },
      });
    }
  }

  // Concurrent requests gauge (always emitted — useful even when no new requests arrived)
  points.push({
    timestamp: now,
    name: "http.concurrent_requests",
    value: httpConcurrentSnap,
    unit: "count",
  });
  if (hadHttp) {
    points.push({
      timestamp: now,
      name: "http.concurrent_requests.max",
      value: httpConcurrentMaxSnap,
      unit: "count",
    });
  }

  if (hadAgent) {
    points.push(
      { timestamp: now, name: "agent.spawn.count", value: agentSpawnSnap, unit: "count" },
      { timestamp: now, name: "agent.complete.count", value: agentCompleteSnap, unit: "count" },
      { timestamp: now, name: "agent.fail.count", value: agentFailSnap, unit: "count" },
    );
    if (agentDurSnap.length > 0) {
      const sorted = [...agentDurSnap].sort((a, b) => a - b);
      const sum = sorted.reduce((a, v) => a + v, 0);
      points.push(
        { timestamp: now, name: "agent.duration.avg", value: Math.round(sum / sorted.length), unit: "ms" },
        { timestamp: now, name: "agent.duration.p95", value: percentile(sorted, 95), unit: "ms" },
        { timestamp: now, name: "agent.duration.max", value: sorted[sorted.length - 1], unit: "ms" },
      );
    }
  }

  // Agent execution tracking gauges (always emitted when data exists)
  if (cumulativeAgentTotal > 0) {
    points.push({
      timestamp: now,
      name: "agent.success_rate",
      value: Math.round((cumulativeAgentSuccesses / cumulativeAgentTotal) * 10000) / 10000,
      unit: "ratio",
    });
  }
  points.push({
    timestamp: now,
    name: "agent.memory_usage",
    value: process.memoryUsage().heapUsed,
    unit: "bytes",
  });

  if (hadErrors) {
    points.push({
      timestamp: now,
      name: "error.total",
      value: errorCountSnap,
      unit: "count",
    });
    for (const [source, count] of errorsBySourceSnap!) {
      points.push({
        timestamp: now,
        name: "error.by_source",
        value: count,
        unit: "count",
        tags: { source },
      });
    }
  }

  // Firewall metrics: drain accumulators
  points.push(...collectFirewallMetrics());

  // Write all points in a single batch
  try {
    await store.recordBatch(points);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to write: ${msg}`);
    // Restore snapshots so data is retried on next cycle
    if (hadHttp) {
      httpLatencies.push(...httpSnap);
      for (const [code, count] of httpStatusSnap!) {
        httpStatusCounts.set(code, (httpStatusCounts.get(code) ?? 0) + count);
      }
      for (const [key, count] of httpEndpointSnap!) {
        httpEndpointCounts.set(key, (httpEndpointCounts.get(key) ?? 0) + count);
      }
      httpTotal += httpTotalSnap;
      httpErrors += httpErrorsSnap;
    }
    if (hadAgent) {
      agentSpawnCount += agentSpawnSnap;
      agentCompleteCount += agentCompleteSnap;
      agentFailCount += agentFailSnap;
      agentDurations.push(...agentDurSnap);
    }
    if (hadErrors) {
      errorCount += errorCountSnap;
      for (const [source, count] of errorsBySourceSnap!) {
        errorsBySource.set(source, (errorsBySource.get(source) ?? 0) + count);
      }
    }
  }

  // Periodic rotation check
  collectCycles++;
  if (collectCycles % ROTATION_CHECK_CYCLES === 0 && store.shouldRotate()) {
    try {
      const { before, after } = await store.rotate();
      if (before !== after) {
        logActivity({
          source: "system",
          summary: `Metrics rotated: ${before} → ${after} points`,
        });
      }
    } catch {
      // Rotation failure is non-critical
    }
  }

  // Periodic aggregation (non-blocking — fire and forget)
  if (collectCycles % AGGREGATION_CHECK_CYCLES === 0 && metricsDir) {
    runAggregation(store, metricsDir).catch((err) => {
      log.error(`Aggregation error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// ─── Public recording API (called by middleware/hooks) ────────────────────────

/** Record an HTTP request's latency and status. Called by the metrics middleware. */
export function recordHttp(durationMs: number, statusCode: number, method?: string, endpoint?: string): void {
  httpLatencies.push(durationMs);
  httpTotal++;
  if (statusCode >= 400) httpErrors++;
  httpStatusCounts.set(statusCode, (httpStatusCounts.get(statusCode) ?? 0) + 1);

  // Track per-endpoint counts for JSONL output
  if (method && endpoint) {
    const key = `${method} ${endpoint}`;
    httpEndpointCounts.set(key, (httpEndpointCounts.get(key) ?? 0) + 1);
  }
}

/** Adjust concurrent request count. Called by the metrics middleware. */
export function recordConcurrentRequests(delta: number): void {
  httpConcurrent += delta;
  if (httpConcurrent > httpConcurrentMax) {
    httpConcurrentMax = httpConcurrent;
  }
}

/** Record an agent spawn event. */
export function recordAgentSpawn(): void {
  agentSpawnCount++;
  agentSpawnsTotal.inc();
  agentExecutionsInFlight.inc();
  agentMemoryUsageBytes.set(undefined, process.memoryUsage().heapUsed);
}

/** Record an agent completion. durationMs is startedAt→finishedAt. */
export function recordAgentCompletion(durationMs: number, success: boolean): void {
  const status = success ? "success" : "failure";
  if (success) {
    agentCompleteCount++;
    cumulativeAgentSuccesses++;
  } else {
    agentFailCount++;
  }
  cumulativeAgentTotal++;
  agentDurations.push(durationMs);

  // Prometheus instruments
  agentExecutionsTotal.inc({ status });
  agentExecutionDuration.observe({ status }, durationMs / 1000);
  agentExecutionsInFlight.dec();
  agentSuccessRate.set(
    undefined,
    cumulativeAgentTotal > 0 ? cumulativeAgentSuccesses / cumulativeAgentTotal : 0,
  );
  agentMemoryUsageBytes.set(undefined, process.memoryUsage().heapUsed);
}

/** Record an error by source category. */
export function recordError(source: string): void {
  errorCount++;
  errorsBySource.set(source, (errorsBySource.get(source) ?? 0) + 1);

  // Prometheus instrument
  errorsTotal.inc({ source });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Start the background metrics collector. Idempotent.
 * Collects system, HTTP, agent, and error metrics at a fixed interval.
 * @param brainDir - Path to the brain directory, used for aggregation output.
 */
export function startCollector(
  metricsStore: MetricsStore,
  intervalMs?: number,
  brainDir?: string,
): void {
  if (timer) return;

  store = metricsStore;
  metricsDir = brainDir ? `${brainDir}/metrics` : null;
  const interval = intervalMs ?? DEFAULT_COLLECT_INTERVAL_MS;

  // Initialize CPU baseline for delta calculations
  initCpuBaseline();
  collectCycles = 0;

  timer = setInterval(() => {
    collect().catch((err) => {
      log.error(`Collection error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, interval);

  // Fire once immediately
  collect().catch(() => {});

  // Run initial aggregation for any missed windows (non-blocking)
  if (metricsDir) {
    runAggregation(store, metricsDir).catch(() => {});
  }

  log.info(`Metrics collector: every ${Math.round(interval / 1000)}s`);
}

/** Stop the metrics collector. */
export function stopCollector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  store = null;
  metricsDir = null;
}

/** Check if the collector is running. */
export function isCollectorRunning(): boolean {
  return timer !== null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}
