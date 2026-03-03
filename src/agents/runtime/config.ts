/**
 * Agent Runtime Environment — Configuration.
 *
 * Loads defaults, merges env var overrides, produces a frozen RuntimeConfig.
 * Environment variables use the CORE_RUNTIME_ prefix (DASH_RUNTIME_ also supported).
 */

import { join } from "node:path";
import { resolveEnv } from "../../instance.js";
import type { RuntimeConfig, AgentInstanceConfig, ResourceAllocation } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: RuntimeConfig = {
  maxConcurrentAgents: 5,
  defaultTimeoutMs: 10 * 60 * 1000,     // 10 minutes
  defaultMaxRetries: 2,
  defaultBackoffMs: 2_000,
  defaultBackoffMultiplier: 2,
  defaultMaxBackoffMs: 30_000,
  maxTotalMemoryMB: 2048,               // 2 GB aggregate cap
  defaultMemoryLimitMB: 512,
  defaultCpuWeight: 50,
  monitorIntervalMs: 10_000,            // 10 seconds
  persistDir: join(process.cwd(), "brain", "agents", "runtime"),
};

// ---------------------------------------------------------------------------
// Env var resolver
// ---------------------------------------------------------------------------

function envInt(suffix: string): number | undefined {
  const v = resolveEnv(suffix);
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envStr(suffix: string): string | undefined {
  return resolveEnv(suffix) || undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build RuntimeConfig from defaults + env var overrides. */
export function loadRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const config: RuntimeConfig = {
    maxConcurrentAgents:
      overrides?.maxConcurrentAgents ??
      envInt("RUNTIME_MAX_AGENTS") ??
      DEFAULTS.maxConcurrentAgents,

    defaultTimeoutMs:
      overrides?.defaultTimeoutMs ??
      envInt("RUNTIME_TIMEOUT_MS") ??
      DEFAULTS.defaultTimeoutMs,

    defaultMaxRetries:
      overrides?.defaultMaxRetries ??
      envInt("RUNTIME_MAX_RETRIES") ??
      DEFAULTS.defaultMaxRetries,

    defaultBackoffMs:
      overrides?.defaultBackoffMs ??
      envInt("RUNTIME_BACKOFF_MS") ??
      DEFAULTS.defaultBackoffMs,

    defaultBackoffMultiplier:
      overrides?.defaultBackoffMultiplier ??
      envInt("RUNTIME_BACKOFF_MULT") ??
      DEFAULTS.defaultBackoffMultiplier,

    defaultMaxBackoffMs:
      overrides?.defaultMaxBackoffMs ??
      envInt("RUNTIME_MAX_BACKOFF_MS") ??
      DEFAULTS.defaultMaxBackoffMs,

    maxTotalMemoryMB:
      overrides?.maxTotalMemoryMB ??
      envInt("RUNTIME_MAX_MEMORY_MB") ??
      DEFAULTS.maxTotalMemoryMB,

    defaultMemoryLimitMB:
      overrides?.defaultMemoryLimitMB ??
      envInt("RUNTIME_DEFAULT_MEM_MB") ??
      DEFAULTS.defaultMemoryLimitMB,

    defaultCpuWeight:
      overrides?.defaultCpuWeight ??
      envInt("RUNTIME_DEFAULT_CPU") ??
      DEFAULTS.defaultCpuWeight,

    monitorIntervalMs:
      overrides?.monitorIntervalMs ??
      envInt("RUNTIME_MONITOR_MS") ??
      DEFAULTS.monitorIntervalMs,

    persistDir:
      overrides?.persistDir ??
      envStr("RUNTIME_PERSIST_DIR") ??
      DEFAULTS.persistDir,
  };

  return Object.freeze(config) as RuntimeConfig;
}

/** Build per-instance config by merging runtime defaults with request overrides. */
export function resolveInstanceConfig(
  runtimeConfig: RuntimeConfig,
  overrides?: Partial<AgentInstanceConfig>,
): AgentInstanceConfig {
  return {
    timeoutMs: overrides?.timeoutMs ?? runtimeConfig.defaultTimeoutMs,
    maxRetries: overrides?.maxRetries ?? runtimeConfig.defaultMaxRetries,
    backoffMs: overrides?.backoffMs ?? runtimeConfig.defaultBackoffMs,
    backoffMultiplier: overrides?.backoffMultiplier ?? runtimeConfig.defaultBackoffMultiplier,
    maxBackoffMs: overrides?.maxBackoffMs ?? runtimeConfig.defaultMaxBackoffMs,
    env: overrides?.env ?? {},
    isolation: overrides?.isolation ?? "shared",
    priority: overrides?.priority ?? 50,
  };
}

/** Build resource allocation from runtime defaults with request overrides. */
export function resolveResources(
  runtimeConfig: RuntimeConfig,
  overrides?: Partial<ResourceAllocation>,
): ResourceAllocation {
  return {
    memoryLimitMB: overrides?.memoryLimitMB ?? runtimeConfig.defaultMemoryLimitMB,
    cpuWeight: overrides?.cpuWeight ?? runtimeConfig.defaultCpuWeight,
  };
}
