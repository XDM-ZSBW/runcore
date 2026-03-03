/**
 * Prometheus-style metric registry.
 * Holds all registered instruments and provides collection + format output.
 *
 * Pluggable: default is in-memory (instruments hold their own state).
 * Swap the store backend to persist to a different system.
 */

import { Counter, Gauge, Histogram, type Labels, type Sample, type HistogramSamples } from "./instruments.js";

// ─── Pluggable store interface ───────────────────────────────────────────────

/** Backend store for metric values. Default: in-memory (Map inside each instrument). */
export interface MetricStoreBackend {
  /** Called when a counter is incremented. */
  counterInc(name: string, labels: Labels, value: number): void;
  /** Called when a gauge is set. */
  gaugeSet(name: string, labels: Labels, value: number): void;
  /** Called when a histogram observation is recorded. */
  histogramObserve(name: string, labels: Labels, value: number): void;
}

/** Default no-op backend — instruments manage their own in-memory state. */
class InMemoryBackend implements MetricStoreBackend {
  counterInc(): void { /* in-memory, handled by instrument */ }
  gaugeSet(): void { /* in-memory, handled by instrument */ }
  histogramObserve(): void { /* in-memory, handled by instrument */ }
}

// ─── Metric type enum ────────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

interface RegisteredMetric {
  type: MetricType;
  instrument: Counter | Gauge | Histogram;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class MetricRegistry {
  private metrics = new Map<string, RegisteredMetric>();
  private backend: MetricStoreBackend;

  constructor(backend?: MetricStoreBackend) {
    this.backend = backend ?? new InMemoryBackend();
  }

  /** Register and return a new Counter. */
  registerCounter(opts: { name: string; help: string; labelNames?: string[] }): Counter {
    if (this.metrics.has(opts.name)) {
      const existing = this.metrics.get(opts.name)!;
      if (existing.type !== "counter") throw new Error(`Metric "${opts.name}" already registered as ${existing.type}`);
      return existing.instrument as Counter;
    }
    const counter = new Counter(opts);
    this.metrics.set(opts.name, { type: "counter", instrument: counter });
    return counter;
  }

  /** Register and return a new Gauge. */
  registerGauge(opts: { name: string; help: string; labelNames?: string[] }): Gauge {
    if (this.metrics.has(opts.name)) {
      const existing = this.metrics.get(opts.name)!;
      if (existing.type !== "gauge") throw new Error(`Metric "${opts.name}" already registered as ${existing.type}`);
      return existing.instrument as Gauge;
    }
    const gauge = new Gauge(opts);
    this.metrics.set(opts.name, { type: "gauge", instrument: gauge });
    return gauge;
  }

  /** Register and return a new Histogram. */
  registerHistogram(opts: {
    name: string;
    help: string;
    labelNames?: string[];
    buckets?: number[];
  }): Histogram {
    if (this.metrics.has(opts.name)) {
      const existing = this.metrics.get(opts.name)!;
      if (existing.type !== "histogram") throw new Error(`Metric "${opts.name}" already registered as ${existing.type}`);
      return existing.instrument as Histogram;
    }
    const histogram = new Histogram(opts);
    this.metrics.set(opts.name, { type: "histogram", instrument: histogram });
    return histogram;
  }

  /** Get a registered metric by name. */
  getMetric(name: string): RegisteredMetric | undefined {
    return this.metrics.get(name);
  }

  /** List all registered metric names. */
  getMetricNames(): string[] {
    return Array.from(this.metrics.keys());
  }

  /** Swap the store backend at runtime. */
  setBackend(backend: MetricStoreBackend): void {
    this.backend = backend;
  }

  /** Collect all metrics and return Prometheus text exposition format. */
  collect(): string {
    const lines: string[] = [];

    for (const [name, { type, instrument }] of this.metrics) {
      lines.push(`# HELP ${name} ${instrument.help}`);
      lines.push(`# TYPE ${name} ${type}`);

      if (instrument instanceof Counter || instrument instanceof Gauge) {
        const samples = instrument.collect();
        if (samples.length === 0) {
          // Emit a zero-value sample for metrics with no observations
          lines.push(`${name} 0`);
        } else {
          for (const sample of samples) {
            lines.push(formatSample(name, sample.labels, sample.value));
          }
        }
      } else if (instrument instanceof Histogram) {
        const data = instrument.collect();
        if (data.counts.length === 0) {
          // No observations yet
          lines.push(`${name}_bucket{le="+Inf"} 0`);
          lines.push(`${name}_sum 0`);
          lines.push(`${name}_count 0`);
        } else {
          for (const bucket of data.buckets) {
            const leStr = bucket.le === Infinity ? "+Inf" : String(bucket.le);
            const labelStr = formatLabels({ ...bucket.labels, le: leStr });
            lines.push(`${name}_bucket${labelStr} ${bucket.count}`);
          }
          for (const s of data.sums) {
            lines.push(formatSample(`${name}_sum`, s.labels, s.value));
          }
          for (const s of data.counts) {
            lines.push(formatSample(`${name}_count`, s.labels, s.value));
          }
        }
      }

      lines.push(""); // blank line between metrics
    }

    return lines.join("\n");
  }

  /** Reset all metrics. */
  reset(): void {
    for (const { instrument } of this.metrics.values()) {
      instrument.reset();
    }
  }
}

// ─── Format helpers ──────────────────────────────────────────────────────────

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

function formatSample(name: string, labels: Labels, value: number): string {
  const labelStr = formatLabels(labels);
  return `${name}${labelStr} ${formatValue(value)}`;
}

function formatValue(v: number): string {
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  if (Number.isNaN(v)) return "NaN";
  return String(v);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
