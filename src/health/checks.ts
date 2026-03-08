/**
 * Built-in health checks — process-level diagnostics.
 *
 * These are the foundational checks that every Core instance registers.
 * Moved from the original src/health.ts with identical signatures.
 */

import type { HealthCheckFn, CheckResult } from "./types.js";

/** Process memory check. Unhealthy above hardMax, degraded above softMax. */
export function memoryCheck(softMaxMB = 512, hardMaxMB = 1024): HealthCheckFn {
  return () => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const detail = `heap ${heapMB}MB, rss ${rssMB}MB`;
    if (rssMB > hardMaxMB) return { status: "unhealthy", detail };
    if (rssMB > softMaxMB) return { status: "degraded", detail };
    return { status: "healthy", detail };
  };
}

/** Event loop responsiveness check. Measures setTimeout drift. */
export function eventLoopCheck(maxDriftMs = 500): HealthCheckFn {
  return () => {
    return new Promise<CheckResult>((resolve) => {
      const start = performance.now();
      setTimeout(() => {
        const drift = performance.now() - start;
        const detail = `drift ${Math.round(drift)}ms`;
        if (drift > maxDriftMs) resolve({ status: "unhealthy", detail });
        else if (drift > maxDriftMs / 2) resolve({ status: "degraded", detail });
        else resolve({ status: "healthy", detail });
      }, 0);
    });
  };
}

/**
 * Wrap an availability function (like isSidecarAvailable) into a health check.
 * Returns degraded (not unhealthy) because sidecars are optional.
 */
export function availabilityCheck(
  isAvailable: () => boolean,
  label: string,
): HealthCheckFn {
  return () => ({
    status: isAvailable() ? "healthy" : "degraded",
    detail: isAvailable() ? `${label} available` : `${label} unavailable`,
  });
}

/** CPU usage check. Reports user + system CPU time as a percentage over a sample window. Normalized by core count. */
export function cpuCheck(warnPct = 80, criticalPct = 95, sampleMs = 1000): HealthCheckFn {
  const cpuCount = (() => { try { return require("node:os").cpus().length || 1; } catch { return 1; } })();
  return () =>
    new Promise<CheckResult>((resolve) => {
      const start = process.cpuUsage();
      const startTime = performance.now();
      setTimeout(() => {
        const elapsed = (performance.now() - startTime) * 1000; // microseconds
        const usage = process.cpuUsage(start);
        const totalCpu = usage.user + usage.system;
        const pct = Math.round((totalCpu / elapsed / cpuCount) * 100);
        const detail = `cpu ${pct}% of ${cpuCount} cores, user ${Math.round(usage.user / 1000)}ms, system ${Math.round(usage.system / 1000)}ms`;
        if (pct >= criticalPct) resolve({ status: "unhealthy", detail });
        else if (pct >= warnPct) resolve({ status: "degraded", detail });
        else resolve({ status: "healthy", detail });
      }, sampleMs);
    });
}

/** Disk usage check. Reports free space in the brain directory's volume. */
export function diskUsageCheck(brainDir: string, warnPct = 85, criticalPct = 95): HealthCheckFn {
  return async () => {
    try {
      const { statfs } = await import("node:fs/promises");
      const stats = await statfs(brainDir);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
      const freeMB = Math.round(freeBytes / 1024 / 1024);
      const detail = `disk ${usedPct}% used, ${freeMB}MB free`;
      if (usedPct >= criticalPct) return { status: "unhealthy", detail };
      if (usedPct >= warnPct) return { status: "degraded", detail };
      return { status: "healthy", detail };
    } catch (err) {
      return {
        status: "degraded",
        detail: `disk usage unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/**
 * Disk I/O check — verifies the brain directory is readable and writable.
 * Uses a temp file write+read+delete cycle.
 */
export function diskCheck(brainDir: string): HealthCheckFn {
  return async () => {
    const { writeFile, readFile, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const probe = join(brainDir, `.health-probe-${token}`);
    try {
      await writeFile(probe, token, "utf-8");
      const read = await readFile(probe, "utf-8");
      await unlink(probe).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
      if (read !== token) {
        return { status: "unhealthy", detail: "disk read-back mismatch" };
      }
      return { status: "healthy", detail: `brain dir writable` };
    } catch (err) {
      return {
        status: "unhealthy",
        detail: `disk I/O failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
