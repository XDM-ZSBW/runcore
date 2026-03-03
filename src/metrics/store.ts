/**
 * Time-series metrics store with JSONL persistence and rotation.
 * Follows queue/store.ts pattern: append-only JSONL, lazy load + cache, periodic compaction.
 * All metrics encrypted at rest via brain-io.
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readBrainLines, appendBrainLine, writeBrainLines } from "../lib/brain-io.js";
import type { MetricPoint, MetricSummary, RotationConfig } from "./types.js";

const SCHEMA_HEADER = JSON.stringify({ _schema: "metrics", _version: "1.0" });
const DEFAULT_MAX_POINTS = 10_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class MetricsStore {
  private readonly filePath: string;
  private cache: MetricPoint[] | null = null;
  private readonly maxPoints: number;
  private readonly maxAgeMs: number;
  private appendsSinceLoad = 0;
  private rotating = false;
  private rotationBuffer: MetricPoint[] = [];

  constructor(brainDir: string, config?: RotationConfig) {
    this.filePath = join(brainDir, "metrics", "metrics.jsonl");
    this.maxPoints = config?.maxPoints ?? DEFAULT_MAX_POINTS;
    this.maxAgeMs = config?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** Append a metric data point. Writes to disk immediately. */
  async record(point: MetricPoint): Promise<void> {
    if (this.rotating) {
      this.rotationBuffer.push(point);
      return;
    }
    await this.ensureFile();
    await appendBrainLine(this.filePath, JSON.stringify(point));

    if (this.cache) {
      this.cache.push(point);
    }
    this.appendsSinceLoad++;
  }

  /** Append multiple points in a single write. */
  async recordBatch(points: MetricPoint[]): Promise<void> {
    if (points.length === 0) return;

    // Buffer writes during rotation to prevent race condition:
    // rotate() reads snapshot → writeBrainLines overwrites file →
    // any appends between those two steps would be lost.
    if (this.rotating) {
      this.rotationBuffer.push(...points);
      return;
    }

    await this.ensureFile();
    for (const p of points) {
      await appendBrainLine(this.filePath, JSON.stringify(p));
    }

    if (this.cache) {
      this.cache.push(...points);
    }
    this.appendsSinceLoad += points.length;
  }

  /** Query points by name and/or time range. */
  async query(opts?: {
    name?: string;
    tags?: Record<string, string>;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<MetricPoint[]> {
    const all = await this.load();
    let filtered = all;

    if (opts?.name) {
      filtered = filtered.filter((p) => p.name === opts.name);
    }
    if (opts?.tags) {
      const tagEntries = Object.entries(opts.tags);
      filtered = filtered.filter((p) =>
        p.tags != null && tagEntries.every(([k, v]) => p.tags![k] === v),
      );
    }
    if (opts?.since) {
      filtered = filtered.filter((p) => p.timestamp >= opts.since!);
    }
    if (opts?.until) {
      filtered = filtered.filter((p) => p.timestamp <= opts.until!);
    }
    if (opts?.limit && opts.limit > 0) {
      filtered = filtered.slice(-opts.limit);
    }

    return filtered;
  }

  /** Compute an aggregate summary for a named metric within a window. */
  async summarize(name: string, opts?: {
    tags?: Record<string, string>;
    windowMs?: number;
  }): Promise<MetricSummary | null> {
    const windowMs = opts?.windowMs ?? 60_000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const points = await this.query({
      name,
      tags: opts?.tags,
      since: cutoff,
    });

    if (points.length === 0) return null;

    const values = points.map((p) => p.value).sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);

    return {
      name,
      count: values.length,
      sum,
      min: values[0],
      max: values[values.length - 1],
      avg: sum / values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
      unit: points[0].unit,
      tags: opts?.tags,
      windowStart: cutoff,
      windowEnd: new Date().toISOString(),
    };
  }

  /** Rotate: drop old/excess points, rewrite file. Returns points removed. */
  async rotate(): Promise<{ before: number; after: number }> {
    this.rotating = true;
    try {
      const all = await this.load();
      const before = all.length;

      const cutoff = new Date(Date.now() - this.maxAgeMs).toISOString();
      let kept = all.filter((p) => p.timestamp >= cutoff);

      if (kept.length > this.maxPoints) {
        kept = kept.slice(kept.length - this.maxPoints);
      }

      const lines = [SCHEMA_HEADER, ...kept.map((p) => JSON.stringify(p))];
      await writeBrainLines(this.filePath, lines);
      this.cache = kept;
      this.appendsSinceLoad = 0;

      // Flush buffer WHILE STILL HOLDING the rotation flag —
      // prevents concurrent recordBatch() calls from racing with the flush.
      if (this.rotationBuffer.length > 0) {
        const buffered = this.rotationBuffer.splice(0);
        try {
          for (const p of buffered) {
            await appendBrainLine(this.filePath, JSON.stringify(p));
          }
          if (this.cache) {
            this.cache.push(...buffered);
          }
          this.appendsSinceLoad += buffered.length;
        } catch {
          // Restore unwritten points to buffer for retry on next cycle
          this.rotationBuffer.unshift(...buffered);
        }
      }

      return { before, after: kept.length };
    } finally {
      // Flag reset is the LAST thing that happens
      this.rotating = false;
    }
  }

  /** Check if rotation is needed (heuristic: >50% over max or old appends). */
  shouldRotate(): boolean {
    if (!this.cache) return this.appendsSinceLoad > this.maxPoints;
    return this.cache.length > this.maxPoints * 1.5 || this.appendsSinceLoad > this.maxPoints;
  }

  /** Get approximate number of data points. */
  async pointCount(): Promise<number> {
    const all = await this.load();
    return all.length;
  }

  /** Return distinct metric names in the store. */
  async metricNames(): Promise<string[]> {
    const all = await this.load();
    return [...new Set(all.map((p) => p.name))];
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async load(): Promise<MetricPoint[]> {
    if (this.cache) return this.cache;

    const lines = await readBrainLines(this.filePath);
    const points: MetricPoint[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        points.push(obj as MetricPoint);
      } catch {
        // skip malformed lines
      }
    }

    this.cache = points;
    return points;
  }

  private async ensureFile(): Promise<void> {
    try {
      await stat(this.filePath);
    } catch {
      const dir = join(this.filePath, "..");
      await mkdir(dir, { recursive: true });
      await appendBrainLine(this.filePath, SCHEMA_HEADER);
    }
  }
}

/** Calculate percentile from a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}
