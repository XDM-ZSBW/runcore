/**
 * Component health checks — subsystem-level diagnostics.
 *
 * Each check probes a specific Core component and returns its health status.
 * These are registered at startup after their respective systems initialize.
 */

import type { HealthCheckFn } from "./types.js";
import type { HealthSummary } from "../agents/instance-manager.js";
import type { ResourceSnapshot } from "../agents/runtime/types.js";

// ─── Queue store ─────────────────────────────────────────────────────────────

/**
 * Queue store health — verifies the JSONL store is accessible and has valid state.
 * Accepts a lazy getter so it doesn't import the store directly.
 */
export function queueStoreCheck(
  getStore: () => { count: () => Promise<number> } | null,
): HealthCheckFn {
  return async () => {
    const store = getStore();
    if (!store) {
      return { status: "degraded", detail: "queue store not initialized" };
    }
    try {
      const count = await store.count();
      return { status: "healthy", detail: `${count} tasks` };
    } catch (err) {
      return {
        status: "unhealthy",
        detail: `queue read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

// ─── Agent runtime ───────────────────────────────────────────────────────────

/**
 * Agent runtime capacity — checks resource utilization against thresholds.
 * Degraded at 80% utilization, unhealthy at 95%.
 */
export function agentCapacityCheck(
  getSnapshot: () => ResourceSnapshot | null,
): HealthCheckFn {
  return () => {
    const snap = getSnapshot();
    if (!snap) return { status: "degraded", detail: "runtime not initialized" };

    const agentUtil = snap.maxAgents > 0 ? snap.activeAgents / snap.maxAgents : 0;
    const memUtil = snap.maxMemoryMB > 0 ? snap.totalMemoryMB / snap.maxMemoryMB : 0;
    const maxUtil = Math.max(agentUtil, memUtil);

    const detail = `${snap.activeAgents}/${snap.maxAgents} agents, ${snap.totalMemoryMB}/${snap.maxMemoryMB}MB, ${snap.queuedRequests} queued`;

    if (maxUtil >= 0.95) return { status: "unhealthy", detail: `at capacity — ${detail}` };
    if (maxUtil >= 0.80) return { status: "degraded", detail: `high utilization — ${detail}` };
    return { status: "healthy", detail };
  };
}

/**
 * Agent instance health — checks aggregate health scores from instance manager.
 */
export function agentHealthCheck(
  getHealthSummary: () => HealthSummary | null,
): HealthCheckFn {
  return () => {
    const summary = getHealthSummary();
    if (!summary) return { status: "degraded", detail: "instance manager not initialized" };

    const { totalInstances, activeInstances, unhealthyInstances, averageScore } = summary;
    const detail = `${activeInstances} active, ${unhealthyInstances} unhealthy, avg score ${averageScore}`;

    if (activeInstances > 0 && unhealthyInstances >= activeInstances) {
      return { status: "unhealthy", detail: `all agents unhealthy — ${detail}` };
    }
    if (unhealthyInstances > 0 || averageScore < 50) {
      return { status: "degraded", detail };
    }
    return { status: "healthy", detail };
  };
}

// ─── Board provider ──────────────────────────────────────────────────────────

/**
 * Board provider health — checks if the provider is registered and available.
 */
export function boardCheck(
  getProvider: () => { name: string; isAvailable: () => boolean } | null,
): HealthCheckFn {
  return () => {
    const provider = getProvider();
    if (!provider) return { status: "degraded", detail: "no board provider registered" };
    if (!provider.isAvailable()) {
      return { status: "degraded", detail: `${provider.name} unavailable` };
    }
    return { status: "healthy", detail: `${provider.name} available` };
  };
}

// ─── External service connectivity ───────────────────────────────────────────

/**
 * HTTP endpoint check — pings a URL and expects a 2xx response.
 * Useful for checking upstream APIs or sidecar HTTP endpoints.
 */
export function httpCheck(url: string, label: string, timeoutMs = 3000): HealthCheckFn {
  return async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return { status: "healthy", detail: `${label} reachable (${res.status})` };
      return { status: "degraded", detail: `${label} returned ${res.status}` };
    } catch (err) {
      return {
        status: "degraded",
        detail: `${label} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
