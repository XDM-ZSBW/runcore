/**
 * Prometheus-style metric instruments: Counter, Gauge, Histogram.
 * Each instrument tracks values in-memory with optional label dimensions.
 */

export type Labels = Record<string, string>;

/** Serialize a label set to a stable string key for Map lookups. */
function labelsKey(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return entries.sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

/** Collected sample from an instrument. */
export interface Sample {
  labels: Labels;
  value: number;
}

/** Histogram bucket sample. */
export interface BucketSample {
  labels: Labels;
  le: number;
  count: number;
}

/** Histogram collected data. */
export interface HistogramSamples {
  buckets: BucketSample[];
  sums: Sample[];
  counts: Sample[];
}

// ─── Counter ─────────────────────────────────────────────────────────────────

/** Monotonically increasing counter. */
export class Counter {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(opts: { name: string; help: string; labelNames?: string[] }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  /** Increment the counter. Value must be >= 0. */
  inc(labels?: Labels, value = 1): void {
    if (value < 0) throw new Error("Counter can only increase");
    const key = labelsKey(labels ?? {});
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, { labels: { ...(labels ?? {}) }, value });
    }
  }

  /** Get current value for a label set. */
  get(labels?: Labels): number {
    return this.values.get(labelsKey(labels ?? {}))?.value ?? 0;
  }

  /** Reset all values. */
  reset(): void {
    this.values.clear();
  }

  /** Collect all samples for exposition. */
  collect(): Sample[] {
    return Array.from(this.values.values());
  }
}

// ─── Gauge ───────────────────────────────────────────────────────────────────

/** Value that can go up and down. */
export class Gauge {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(opts: { name: string; help: string; labelNames?: string[] }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  /** Set the gauge to an absolute value. */
  set(labels: Labels | undefined, value: number): void {
    const key = labelsKey(labels ?? {});
    const existing = this.values.get(key);
    if (existing) {
      existing.value = value;
    } else {
      this.values.set(key, { labels: { ...(labels ?? {}) }, value });
    }
  }

  /** Increment the gauge. */
  inc(labels?: Labels, value = 1): void {
    const key = labelsKey(labels ?? {});
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, { labels: { ...(labels ?? {}) }, value });
    }
  }

  /** Decrement the gauge. */
  dec(labels?: Labels, value = 1): void {
    this.inc(labels, -value);
  }

  /** Get current value for a label set. */
  get(labels?: Labels): number {
    return this.values.get(labelsKey(labels ?? {}))?.value ?? 0;
  }

  /** Reset all values. */
  reset(): void {
    this.values.clear();
  }

  /** Collect all samples for exposition. */
  collect(): Sample[] {
    return Array.from(this.values.values());
  }
}

// ─── Histogram ───────────────────────────────────────────────────────────────

/** Default Prometheus histogram buckets. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramEntry {
  labels: Labels;
  bucketCounts: number[];   // one count per bucket boundary
  sum: number;
  count: number;
}

/** Tracks value distributions with configurable bucket boundaries. */
export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[];
  private entries = new Map<string, HistogramEntry>();

  constructor(opts: {
    name: string;
    help: string;
    labelNames?: string[];
    buckets?: number[];
  }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
    this.buckets = [...(opts.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b);
  }

  /** Record an observed value. */
  observe(labels: Labels | undefined, value: number): void {
    const key = labelsKey(labels ?? {});
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        labels: { ...(labels ?? {}) },
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.entries.set(key, entry);
    }

    entry.sum += value;
    entry.count++;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i]++;
      }
    }
  }

  /** Reset all entries. */
  reset(): void {
    this.entries.clear();
  }

  /** Collect all histogram data for exposition. */
  collect(): HistogramSamples {
    const buckets: BucketSample[] = [];
    const sums: Sample[] = [];
    const counts: Sample[] = [];

    for (const entry of this.entries.values()) {
      // Cumulative bucket counts (Prometheus convention)
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.bucketCounts[i];
        buckets.push({
          labels: entry.labels,
          le: this.buckets[i],
          count: cumulative,
        });
      }
      // +Inf bucket
      buckets.push({
        labels: entry.labels,
        le: Infinity,
        count: entry.count,
      });

      sums.push({ labels: entry.labels, value: entry.sum });
      counts.push({ labels: entry.labels, value: entry.count });
    }

    return { buckets, sums, counts };
  }
}
