/**
 * Metabolic Firewall metrics — tracks dedup guard, routine classifier,
 * cooldown manager, autonomous action rate, and resolved pattern filter.
 *
 * Records into the existing MetricsStore as MetricPoints with "firewall.*" names.
 * Provides a report generator for before/after comparison over 2-4 weeks.
 */

import type { MetricPoint } from "./types.js";
import { MetricsStore } from "./store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("firewall-metrics");

// ─── Metric names ────────────────────────────────────────────────────────────

export const FIREWALL_METRICS = {
  /** Autonomous actions spawned in a 10-min window. */
  AUTONOMOUS_ACTIONS: "firewall.autonomous.actions",
  /** Dedup guard blocks (each block is one count). */
  DEDUP_BLOCKS: "firewall.dedup.blocks",
  /** Routine entries filtered per analysis cycle. */
  ROUTINE_FILTERED: "firewall.routine.filtered",
  /** Entries filtered by resolved pattern match per analysis cycle. */
  RESOLVED_FILTERED: "firewall.resolved.filtered",
  /** Cooldown activations (task put on cooldown). */
  COOLDOWN_ACTIVATIONS: "firewall.cooldown.activations",
  /** Cooldown skips (task skipped because on cooldown). */
  COOLDOWN_SKIPS: "firewall.cooldown.skips",
  /** Bridge reports generated (3+ failure handoffs). */
  BRIDGE_REPORTS: "firewall.bridge.reports",
  /** Spawn rate limiter blocks. */
  SPAWN_RATE_BLOCKS: "firewall.spawn_rate.blocks",
  /** Total entries entering analysis pipeline. */
  ANALYSIS_ENTRIES_RAW: "firewall.analysis.entries_raw",
  /** Entries remaining after all filters. */
  ANALYSIS_ENTRIES_KEPT: "firewall.analysis.entries_kept",
} as const;

// ─── In-memory accumulators (flushed on each collect cycle) ──────────────────

let autonomousActions = 0;
let dedupBlocks = 0;
const dedupReasons: string[] = [];
let routineFiltered = 0;
let resolvedFiltered = 0;
let cooldownActivations = 0;
let cooldownSkips = 0;
let bridgeReports = 0;
let spawnRateBlocks = 0;
let analysisEntriesRaw = 0;
let analysisEntriesKept = 0;

// ─── Recording API (called from firewall components) ─────────────────────────

/** Record an autonomous action (agent spawned by the autonomous loop). */
export function recordAutonomousAction(): void {
  autonomousActions++;
}

/** Record a dedup guard block. */
export function recordDedupBlock(reason: string): void {
  dedupBlocks++;
  dedupReasons.push(reason);
}

/** Record routine entries filtered in an analysis cycle. */
export function recordRoutineFiltered(count: number): void {
  routineFiltered += count;
}

/** Record resolved-pattern entries filtered in an analysis cycle. */
export function recordResolvedFiltered(count: number): void {
  resolvedFiltered += count;
}

/** Record a cooldown activation (task failure → cooldown). */
export function recordCooldownActivation(): void {
  cooldownActivations++;
}

/** Record a cooldown skip (task skipped because on cooldown). */
export function recordCooldownSkip(): void {
  cooldownSkips++;
}

/** Record a bridge report generation. */
export function recordBridgeReport(): void {
  bridgeReports++;
}

/** Record a spawn rate limiter block. */
export function recordSpawnRateBlock(): void {
  spawnRateBlocks++;
}

/** Record analysis pipeline throughput for one cycle. */
export function recordAnalysisThroughput(raw: number, kept: number): void {
  analysisEntriesRaw += raw;
  analysisEntriesKept += kept;
}

// ─── Collection (called by the main metrics collector) ───────────────────────

/**
 * Drain in-memory accumulators and return MetricPoints.
 * Designed to be called from the main collect() cycle in collector.ts.
 */
export function collectFirewallMetrics(): MetricPoint[] {
  const now = new Date().toISOString();
  const points: MetricPoint[] = [];

  if (autonomousActions > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.AUTONOMOUS_ACTIONS,
      value: autonomousActions,
      unit: "count",
    });
  }

  if (dedupBlocks > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.DEDUP_BLOCKS,
      value: dedupBlocks,
      unit: "count",
    });
  }

  if (routineFiltered > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.ROUTINE_FILTERED,
      value: routineFiltered,
      unit: "count",
    });
  }

  if (resolvedFiltered > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.RESOLVED_FILTERED,
      value: resolvedFiltered,
      unit: "count",
    });
  }

  if (cooldownActivations > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.COOLDOWN_ACTIVATIONS,
      value: cooldownActivations,
      unit: "count",
    });
  }

  if (cooldownSkips > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.COOLDOWN_SKIPS,
      value: cooldownSkips,
      unit: "count",
    });
  }

  if (bridgeReports > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.BRIDGE_REPORTS,
      value: bridgeReports,
      unit: "count",
    });
  }

  if (spawnRateBlocks > 0) {
    points.push({
      timestamp: now,
      name: FIREWALL_METRICS.SPAWN_RATE_BLOCKS,
      value: spawnRateBlocks,
      unit: "count",
    });
  }

  if (analysisEntriesRaw > 0) {
    points.push(
      { timestamp: now, name: FIREWALL_METRICS.ANALYSIS_ENTRIES_RAW, value: analysisEntriesRaw, unit: "count" },
      { timestamp: now, name: FIREWALL_METRICS.ANALYSIS_ENTRIES_KEPT, value: analysisEntriesKept, unit: "count" },
    );
  }

  // Reset accumulators
  autonomousActions = 0;
  dedupBlocks = 0;
  dedupReasons.length = 0;
  routineFiltered = 0;
  resolvedFiltered = 0;
  cooldownActivations = 0;
  cooldownSkips = 0;
  bridgeReports = 0;
  spawnRateBlocks = 0;
  analysisEntriesRaw = 0;
  analysisEntriesKept = 0;

  return points;
}

// ─── Report generation ───────────────────────────────────────────────────────

export interface FirewallPeriodStats {
  periodStart: string;
  periodEnd: string;
  /** Autonomous actions per 10-min window (avg). */
  autonomousActionsPer10Min: number;
  /** Total dedup guard blocks. */
  dedupBlocksTotal: number;
  /** Avg routine entries filtered per analysis cycle. */
  routineFilteredPerCycle: number;
  /** Avg resolved-pattern entries filtered per cycle. */
  resolvedFilteredPerCycle: number;
  /** Total cooldown activations. */
  cooldownActivationsTotal: number;
  /** Total cooldown skips. */
  cooldownSkipsTotal: number;
  /** Total bridge reports. */
  bridgeReportsTotal: number;
  /** Spawn rate limiter blocks. */
  spawnRateBlocksTotal: number;
  /** Filter efficiency: % of raw entries filtered before LLM. */
  filterEfficiencyPercent: number;
}

/**
 * Generate stats for a time period from the metrics store.
 * @param store MetricsStore instance
 * @param since ISO timestamp for period start
 * @param until ISO timestamp for period end (defaults to now)
 */
export async function generatePeriodStats(
  store: MetricsStore,
  since: string,
  until?: string,
): Promise<FirewallPeriodStats> {
  const periodEnd = until ?? new Date().toISOString();

  const query = (name: string) => store.query({ name, since, until: periodEnd });

  const [
    autonomousPoints,
    dedupPoints,
    routinePoints,
    resolvedPoints,
    cooldownActPoints,
    cooldownSkipPoints,
    bridgePoints,
    spawnRatePoints,
    rawEntryPoints,
    keptEntryPoints,
  ] = await Promise.all([
    query(FIREWALL_METRICS.AUTONOMOUS_ACTIONS),
    query(FIREWALL_METRICS.DEDUP_BLOCKS),
    query(FIREWALL_METRICS.ROUTINE_FILTERED),
    query(FIREWALL_METRICS.RESOLVED_FILTERED),
    query(FIREWALL_METRICS.COOLDOWN_ACTIVATIONS),
    query(FIREWALL_METRICS.COOLDOWN_SKIPS),
    query(FIREWALL_METRICS.BRIDGE_REPORTS),
    query(FIREWALL_METRICS.SPAWN_RATE_BLOCKS),
    query(FIREWALL_METRICS.ANALYSIS_ENTRIES_RAW),
    query(FIREWALL_METRICS.ANALYSIS_ENTRIES_KEPT),
  ]);

  const sum = (pts: MetricPoint[]) => pts.reduce((s, p) => s + p.value, 0);

  // Calculate autonomous actions per 10-min window
  const totalAutonomous = sum(autonomousPoints);
  const periodMs = new Date(periodEnd).getTime() - new Date(since).getTime();
  const tenMinWindows = Math.max(1, periodMs / (10 * 60 * 1000));
  const autonomousActionsPer10Min = Math.round((totalAutonomous / tenMinWindows) * 100) / 100;

  // Analysis cycle count = number of raw entry data points
  const analysisCycles = Math.max(1, rawEntryPoints.length);

  const totalRaw = sum(rawEntryPoints);
  const totalKept = sum(keptEntryPoints);
  const filterEfficiency = totalRaw > 0
    ? Math.round(((totalRaw - totalKept) / totalRaw) * 10000) / 100
    : 0;

  return {
    periodStart: since,
    periodEnd,
    autonomousActionsPer10Min,
    dedupBlocksTotal: sum(dedupPoints),
    routineFilteredPerCycle: Math.round((sum(routinePoints) / analysisCycles) * 100) / 100,
    resolvedFilteredPerCycle: Math.round((sum(resolvedPoints) / analysisCycles) * 100) / 100,
    cooldownActivationsTotal: sum(cooldownActPoints),
    cooldownSkipsTotal: sum(cooldownSkipPoints),
    bridgeReportsTotal: sum(bridgePoints),
    spawnRateBlocksTotal: sum(spawnRatePoints),
    filterEfficiencyPercent: filterEfficiency,
  };
}

/**
 * Generate a markdown comparison report between two periods.
 * Designed for the 2-4 week before/after writeup.
 */
export async function generateComparisonReport(
  store: MetricsStore,
  before: { since: string; until: string },
  after: { since: string; until: string },
): Promise<string> {
  const [beforeStats, afterStats] = await Promise.all([
    generatePeriodStats(store, before.since, before.until),
    generatePeriodStats(store, after.since, after.until),
  ]);

  const delta = (b: number, a: number): string => {
    if (b === 0 && a === 0) return "—";
    if (b === 0) return `+${a}`;
    const pct = Math.round(((a - b) / b) * 100);
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct}%`;
  };

  const lines = [
    `# Metabolic Firewall — Before/After Comparison`,
    ``,
    `| Metric | Before | After | Change |`,
    `|--------|--------|-------|--------|`,
    `| Autonomous actions / 10-min window | ${beforeStats.autonomousActionsPer10Min} | ${afterStats.autonomousActionsPer10Min} | ${delta(beforeStats.autonomousActionsPer10Min, afterStats.autonomousActionsPer10Min)} |`,
    `| Dedup guard blocks (total) | ${beforeStats.dedupBlocksTotal} | ${afterStats.dedupBlocksTotal} | ${delta(beforeStats.dedupBlocksTotal, afterStats.dedupBlocksTotal)} |`,
    `| Routine entries filtered / cycle | ${beforeStats.routineFilteredPerCycle} | ${afterStats.routineFilteredPerCycle} | ${delta(beforeStats.routineFilteredPerCycle, afterStats.routineFilteredPerCycle)} |`,
    `| Resolved-pattern filtered / cycle | ${beforeStats.resolvedFilteredPerCycle} | ${afterStats.resolvedFilteredPerCycle} | ${delta(beforeStats.resolvedFilteredPerCycle, afterStats.resolvedFilteredPerCycle)} |`,
    `| Cooldown activations (total) | ${beforeStats.cooldownActivationsTotal} | ${afterStats.cooldownActivationsTotal} | ${delta(beforeStats.cooldownActivationsTotal, afterStats.cooldownActivationsTotal)} |`,
    `| Cooldown skips (total) | ${beforeStats.cooldownSkipsTotal} | ${afterStats.cooldownSkipsTotal} | ${delta(beforeStats.cooldownSkipsTotal, afterStats.cooldownSkipsTotal)} |`,
    `| Bridge reports (total) | ${beforeStats.bridgeReportsTotal} | ${afterStats.bridgeReportsTotal} | ${delta(beforeStats.bridgeReportsTotal, afterStats.bridgeReportsTotal)} |`,
    `| Spawn rate blocks (total) | ${beforeStats.spawnRateBlocksTotal} | ${afterStats.spawnRateBlocksTotal} | ${delta(beforeStats.spawnRateBlocksTotal, afterStats.spawnRateBlocksTotal)} |`,
    `| Filter efficiency | ${beforeStats.filterEfficiencyPercent}% | ${afterStats.filterEfficiencyPercent}% | ${delta(beforeStats.filterEfficiencyPercent, afterStats.filterEfficiencyPercent)} |`,
    ``,
    `**Before period:** ${beforeStats.periodStart} → ${beforeStats.periodEnd}`,
    `**After period:** ${afterStats.periodStart} → ${afterStats.periodEnd}`,
    ``,
    `**Target:** Autonomous actions per 10-min window < 5 (baseline: 22)`,
  ];

  return lines.join("\n");
}
