/**
 * Tiered metrics aggregation — hourly and daily rollups.
 * Reads raw MetricPoints from the store, buckets by time window,
 * and writes aggregate JSON files to brain/metrics/hourly/ and brain/metrics/daily/.
 *
 * Metric types are inferred from name/unit:
 * - Counters (unit "count"): summed
 * - Gauges (unit "%", "bytes", "ms", "ratio"): averaged with min/max
 * - All metrics get count, sum, min, max, avg, p50, p95, p99
 *
 * Aggregation is designed to run in the background without blocking collection.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { MetricsStore } from "./store.js";
import type { MetricPoint } from "./types.js";

const log = createLogger("metrics.aggregator");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AggregateWindow {
  start: string;
  end: string;
  type: "hourly" | "daily";
}

export interface AggregateEntry {
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
}

export interface AggregateFile {
  window: AggregateWindow;
  metrics: AggregateEntry[];
  pointsProcessed: number;
  generatedAt: string;
}

// ─── Module state ────────────────────────────────────────────────────────────

let running = false;

// ─── Core aggregation ────────────────────────────────────────────────────────

/**
 * Group metric points into time buckets.
 * Returns a map of bucket key → points in that bucket.
 */
function bucketPoints(
  points: MetricPoint[],
  type: "hourly" | "daily",
): Map<string, MetricPoint[]> {
  const buckets = new Map<string, MetricPoint[]>();

  for (const point of points) {
    const dt = new Date(point.timestamp);
    // Key format: YYYY-MM-DD-HH for hourly, YYYY-MM-DD for daily
    const key =
      type === "hourly"
        ? `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}-${pad(dt.getUTCHours())}`
        : `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(point);
  }

  return buckets;
}

/**
 * Compute a unique grouping key for a metric point (name + sorted tags).
 */
function metricKey(point: MetricPoint): string {
  if (!point.tags || Object.keys(point.tags).length === 0) {
    return point.name;
  }
  const tagStr = Object.entries(point.tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${point.name}{${tagStr}}`;
}

/**
 * Aggregate a set of points sharing the same name+tags into a summary entry.
 */
function aggregateGroup(points: MetricPoint[]): AggregateEntry {
  const values = points.map((p) => p.value).sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);

  return {
    name: points[0].name,
    count: values.length,
    sum,
    min: values[0],
    max: values[values.length - 1],
    avg: Math.round((sum / values.length) * 1000) / 1000,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    unit: points[0].unit,
    ...(points[0].tags && Object.keys(points[0].tags).length > 0
      ? { tags: points[0].tags }
      : {}),
  };
}

/**
 * Build an aggregate file from a bucket of raw points.
 */
function buildAggregate(
  bucketKey: string,
  points: MetricPoint[],
  type: "hourly" | "daily",
): AggregateFile {
  // Determine window boundaries from bucket key
  const { start, end } = windowFromKey(bucketKey, type);

  // Group by metric name + tags
  const groups = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const key = metricKey(point);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(point);
  }

  // Aggregate each group
  const metrics: AggregateEntry[] = [];
  for (const group of groups.values()) {
    metrics.push(aggregateGroup(group));
  }

  // Sort by name for stable output
  metrics.sort((a, b) => a.name.localeCompare(b.name));

  return {
    window: { start, end, type },
    metrics,
    pointsProcessed: points.length,
    generatedAt: new Date().toISOString(),
  };
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Check if an aggregate file already exists.
 */
async function aggregateExists(dir: string, filename: string): Promise<boolean> {
  try {
    await readFile(join(dir, filename), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Write an aggregate file to disk.
 */
async function writeAggregate(
  dir: string,
  filename: string,
  aggregate: AggregateFile,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, filename),
    JSON.stringify(aggregate, null, 2) + "\n",
    "utf-8",
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run hourly aggregation for all complete hours in the store.
 * Skips hours that already have an aggregate file.
 * Returns the number of new aggregate files written.
 */
export async function aggregateHourly(store: MetricsStore, metricsDir: string): Promise<number> {
  const hourlyDir = join(metricsDir, "hourly");
  const points = await store.query();
  if (points.length === 0) return 0;

  const buckets = bucketPoints(points, "hourly");
  const currentHourKey = getCurrentBucketKey("hourly");
  let written = 0;

  for (const [key, bucketPoints] of buckets) {
    // Skip the current (incomplete) hour
    if (key === currentHourKey) continue;

    const filename = `${key}.json`;
    if (await aggregateExists(hourlyDir, filename)) continue;

    const aggregate = buildAggregate(key, bucketPoints, "hourly");
    await writeAggregate(hourlyDir, filename, aggregate);
    written++;
    log.debug(`Wrote hourly aggregate: ${filename} (${bucketPoints.length} points)`);
  }

  return written;
}

/**
 * Run daily aggregation for all complete days in the store.
 * Skips days that already have an aggregate file.
 * Returns the number of new aggregate files written.
 */
export async function aggregateDaily(store: MetricsStore, metricsDir: string): Promise<number> {
  const dailyDir = join(metricsDir, "daily");
  const points = await store.query();
  if (points.length === 0) return 0;

  const buckets = bucketPoints(points, "daily");
  const currentDayKey = getCurrentBucketKey("daily");
  let written = 0;

  for (const [key, bucketPoints] of buckets) {
    // Skip the current (incomplete) day
    if (key === currentDayKey) continue;

    const filename = `${key}.json`;
    if (await aggregateExists(dailyDir, filename)) continue;

    const aggregate = buildAggregate(key, bucketPoints, "daily");
    await writeAggregate(dailyDir, filename, aggregate);
    written++;
    log.debug(`Wrote daily aggregate: ${filename} (${bucketPoints.length} points)`);
  }

  return written;
}

/**
 * Run both hourly and daily aggregation. Safe to call frequently —
 * already-aggregated windows are skipped.
 * Returns total new files written.
 */
export async function runAggregation(store: MetricsStore, metricsDir: string): Promise<number> {
  if (running) {
    log.debug("Aggregation already in progress, skipping");
    return 0;
  }

  running = true;
  try {
    const hourly = await aggregateHourly(store, metricsDir);
    const daily = await aggregateDaily(store, metricsDir);
    const total = hourly + daily;
    if (total > 0) {
      log.info(`Aggregation complete: ${hourly} hourly + ${daily} daily files`);
    }
    return total;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Aggregation failed: ${msg}`);
    return 0;
  } finally {
    running = false;
  }
}

/** Check if aggregation is currently running. */
export function isAggregating(): boolean {
  return running;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function getCurrentBucketKey(type: "hourly" | "daily"): string {
  const now = new Date();
  if (type === "hourly") {
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}`;
  }
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

function windowFromKey(
  key: string,
  type: "hourly" | "daily",
): { start: string; end: string } {
  if (type === "hourly") {
    // key format: YYYY-MM-DD-HH
    const [year, month, day, hour] = key.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
    const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // key format: YYYY-MM-DD
  const [year, month, day] = key.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // +1 day
  return { start: start.toISOString(), end: end.toISOString() };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const result = sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  return Math.round(result * 1000) / 1000;
}
