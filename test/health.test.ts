/**
 * Tests for the health check system (src/health.ts).
 *
 * Tests the HealthChecker class, built-in checks, and route-level behavior
 * using a minimal Hono app (no full server startup required).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  HealthChecker,
  memoryCheck,
  eventLoopCheck,
  availabilityCheck,
  type HealthStatus,
} from "../src/health/index.js";

describe("HealthChecker", () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker();
  });

  it("returns healthy with no checks registered", async () => {
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(Object.keys(result.checks)).toHaveLength(0);
  });

  it("registers and runs a healthy check", async () => {
    checker.register("test", () => ({ status: "healthy", detail: "ok" }));
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.checks.test.status).toBe("healthy");
    expect(result.checks.test.detail).toBe("ok");
  });

  it("registers and runs an async check", async () => {
    checker.register("async", async () => ({ status: "healthy" }));
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.checks.async.status).toBe("healthy");
  });

  it("aggregates to degraded when any check is degraded", async () => {
    checker.register("good", () => ({ status: "healthy" }));
    checker.register("warn", () => ({ status: "degraded", detail: "slow" }));
    const result = await checker.check();
    expect(result.status).toBe("degraded");
  });

  it("aggregates to unhealthy when any check is unhealthy", async () => {
    checker.register("good", () => ({ status: "healthy" }));
    checker.register("warn", () => ({ status: "degraded" }));
    checker.register("bad", () => ({ status: "unhealthy", detail: "down" }));
    const result = await checker.check();
    expect(result.status).toBe("unhealthy");
  });

  it("catches thrown errors and marks as unhealthy", async () => {
    checker.register("boom", () => {
      throw new Error("kaboom");
    });
    const result = await checker.check();
    expect(result.status).toBe("unhealthy");
    expect(result.checks.boom.detail).toBe("kaboom");
  });

  it("catches rejected promises and marks as unhealthy", async () => {
    checker.register("reject", async () => {
      throw new Error("async fail");
    });
    const result = await checker.check();
    expect(result.status).toBe("unhealthy");
    expect(result.checks.reject.detail).toBe("async fail");
  });

  it("runs a single named check", async () => {
    checker.register("a", () => ({ status: "healthy" }));
    checker.register("b", () => ({ status: "unhealthy" }));
    const result = await checker.check("a");
    expect(result.status).toBe("healthy");
    expect(Object.keys(result.checks)).toEqual(["a"]);
  });

  it("returns unhealthy for unknown check name", async () => {
    const result = await checker.check("nonexistent");
    expect(result.status).toBe("unhealthy");
    expect(result.checks.nonexistent.detail).toBe("check not found");
  });

  it("unregisters a check", async () => {
    checker.register("temp", () => ({ status: "healthy" }));
    expect(checker.list()).toContain("temp");
    checker.unregister("temp");
    expect(checker.list()).not.toContain("temp");
  });

  it("overwrites a check with the same name", async () => {
    checker.register("x", () => ({ status: "healthy", detail: "v1" }));
    checker.register("x", () => ({ status: "degraded", detail: "v2" }));
    const result = await checker.check("x");
    expect(result.checks.x.detail).toBe("v2");
  });

  it("lists registered check names", () => {
    checker.register("alpha", () => ({ status: "healthy" }));
    checker.register("beta", () => ({ status: "healthy" }));
    expect(checker.list()).toEqual(["alpha", "beta"]);
  });
});

describe("Built-in checks", () => {
  it("memoryCheck returns healthy for normal usage", async () => {
    const fn = memoryCheck(4096, 8192); // generous limits
    const result = await fn();
    expect(result.status).toBe("healthy");
    expect(result.detail).toMatch(/heap \d+MB, rss \d+MB/);
  });

  it("memoryCheck returns unhealthy when hard limit is very low", async () => {
    const fn = memoryCheck(1, 1); // 1MB — guaranteed to exceed
    const result = await fn();
    expect(result.status).toBe("unhealthy");
  });

  it("eventLoopCheck returns healthy under normal conditions", async () => {
    const fn = eventLoopCheck(5000); // generous 5s limit
    const result = await fn();
    expect(result.status).toBe("healthy");
    expect(result.detail).toMatch(/drift \d+ms/);
  });

  it("availabilityCheck returns healthy when available", () => {
    const fn = availabilityCheck(() => true, "test-service");
    const result = fn();
    expect(result.status).toBe("healthy");
    expect(result.detail).toBe("test-service available");
  });

  it("availabilityCheck returns degraded when unavailable", () => {
    const fn = availabilityCheck(() => false, "test-service");
    const result = fn();
    expect(result.status).toBe("degraded");
    expect(result.detail).toBe("test-service unavailable");
  });
});

describe("Health probe routes", () => {
  function createHealthApp(overallStatus: HealthStatus = "healthy") {
    const app = new Hono();
    const checker = new HealthChecker();

    if (overallStatus === "healthy") {
      checker.register("test", () => ({ status: "healthy" }));
    } else if (overallStatus === "degraded") {
      checker.register("ok", () => ({ status: "healthy" }));
      checker.register("warn", () => ({ status: "degraded", detail: "slow" }));
    } else {
      checker.register("bad", () => ({ status: "unhealthy", detail: "down" }));
    }

    app.get("/healthz", async (c) => {
      const result = await checker.check();
      return c.json(result, result.status === "unhealthy" ? 503 : 200);
    });

    app.get("/readyz", async (c) => {
      const result = await checker.check();
      const httpStatus = result.status === "healthy" ? 200 : 503;
      return c.json(result, httpStatus);
    });

    return app;
  }

  it("GET /healthz returns 200 when healthy", async () => {
    const app = createHealthApp("healthy");
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("healthy");
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /healthz returns 200 when degraded (still alive)", async () => {
    const app = createHealthApp("degraded");
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("degraded");
  });

  it("GET /healthz returns 503 when unhealthy", async () => {
    const app = createHealthApp("unhealthy");
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe("unhealthy");
  });

  it("GET /readyz returns 200 only when fully healthy", async () => {
    const app = createHealthApp("healthy");
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
  });

  it("GET /readyz returns 503 when degraded", async () => {
    const app = createHealthApp("degraded");
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
  });

  it("GET /readyz returns 503 when unhealthy", async () => {
    const app = createHealthApp("unhealthy");
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
  });

  it("response body includes checks detail", async () => {
    const app = createHealthApp("degraded");
    const res = await app.request("/healthz");
    const data = await res.json();
    expect(data.checks.warn.status).toBe("degraded");
    expect(data.checks.warn.detail).toBe("slow");
    expect(data.checks.ok.status).toBe("healthy");
  });
});
