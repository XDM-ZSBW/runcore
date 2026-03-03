/**
 * System metrics collection — memory, CPU, and disk usage.
 * Extracts system-level metric gathering into a dedicated module
 * for use by the collector and Prometheus exposition.
 */

import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { MetricPoint } from "./types.js";
import {
  memoryUsageBytes,
  cpuUsagePercent,
  diskUsageBytes,
} from "./prometheus.js";

// ─── CPU state ───────────────────────────────────────────────────────────────

let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastCpuTime = 0;

const DEFAULT_INTERVAL_MS = 30_000;

/** Initialize the CPU baseline. Call once at collector start. */
export function initCpuBaseline(): void {
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = performance.now();
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/** Collect process memory metrics (heap used, heap total, RSS, external). */
export function collectMemoryMetrics(timestamp: string): MetricPoint[] {
  const mem = process.memoryUsage();

  // Update Prometheus gauges
  memoryUsageBytes.set({ type: "heap_used" }, mem.heapUsed);
  memoryUsageBytes.set({ type: "heap_total" }, mem.heapTotal);
  memoryUsageBytes.set({ type: "rss" }, mem.rss);
  memoryUsageBytes.set({ type: "external" }, mem.external);

  return [
    { timestamp, name: "system.memory.heap_used", value: mem.heapUsed, unit: "bytes" },
    { timestamp, name: "system.memory.heap_total", value: mem.heapTotal, unit: "bytes" },
    { timestamp, name: "system.memory.rss", value: mem.rss, unit: "bytes" },
    { timestamp, name: "system.memory.external", value: mem.external, unit: "bytes" },
  ];
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

/** Collect CPU usage as a percentage since the last call. */
export function collectCpuMetrics(timestamp: string): MetricPoint[] {
  const cpuUsage = process.cpuUsage(lastCpuUsage ?? undefined);
  const elapsed = lastCpuTime ? performance.now() - lastCpuTime : DEFAULT_INTERVAL_MS;
  const cpuPercent = elapsed > 0
    ? ((cpuUsage.user + cpuUsage.system) / 1000) / elapsed * 100
    : 0;

  // Update baseline
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = performance.now();

  const rounded = Math.round(cpuPercent * 100) / 100;
  cpuUsagePercent.set(undefined, rounded);

  return [{
    timestamp,
    name: "system.cpu.percent",
    value: rounded,
    unit: "%",
  }];
}

// ─── Disk ────────────────────────────────────────────────────────────────────

/**
 * Recursively calculate the total size of a directory in bytes.
 * Skips entries that can't be stat'd (permission errors, broken symlinks).
 */
async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        total += await dirSize(fullPath);
      } else {
        total += s.size;
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return total;
}

/** Collect disk usage for the brain/ directory. */
export async function collectDiskMetrics(
  timestamp: string,
  brainDir?: string,
): Promise<MetricPoint[]> {
  const dir = brainDir ?? join(process.cwd(), "brain");
  const bytes = await dirSize(dir);

  diskUsageBytes.set(undefined, bytes);

  return [{
    timestamp,
    name: "system.disk.brain_bytes",
    value: bytes,
    unit: "bytes",
  }];
}

// ─── Combined ────────────────────────────────────────────────────────────────

/**
 * Collect all system metrics: memory, CPU, and disk.
 * Returns an array of MetricPoints ready for the store.
 */
export async function collectSystemMetrics(
  timestamp: string,
  brainDir?: string,
): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  points.push(...collectMemoryMetrics(timestamp));
  points.push(...collectCpuMetrics(timestamp));
  points.push(...await collectDiskMetrics(timestamp, brainDir));
  return points;
}
