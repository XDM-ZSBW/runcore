/**
 * Hono middleware for automatic HTTP request metrics collection.
 * Measures request duration, status codes, and concurrent requests.
 * Records to both the time-series collector and Prometheus instruments.
 */

import type { MiddlewareHandler } from "hono";
import { recordHttp, recordConcurrentRequests } from "./collector.js";
import {
  apiCallsTotal,
  apiCallDuration,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  concurrentRequests,
} from "./prometheus.js";

/**
 * Metrics middleware — records request duration, status code, and concurrent requests.
 * Attach early in the middleware chain (before routes).
 */
export function metricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Track concurrent requests
    concurrentRequests.inc();
    recordConcurrentRequests(1);

    const start = performance.now();
    try {
      await next();
    } finally {
      const durationMs = performance.now() - start;
      const status = c.res.status;
      const method = c.req.method;
      const endpoint = normalizePath(c.req.path);

      // Decrement concurrent requests
      concurrentRequests.dec();
      recordConcurrentRequests(-1);

      // Time-series store (JSONL)
      recordHttp(Math.round(durationMs), status, method, endpoint);

      // Legacy Prometheus instruments
      apiCallsTotal.inc({ method, path: endpoint, status: String(status) });
      apiCallDuration.observe({ method, path: endpoint }, durationMs / 1000);

      // DASH-43: New HTTP request instruments
      httpRequestsTotal.inc({ endpoint, method, status: String(status) });
      httpRequestDurationSeconds.observe({ endpoint, method }, durationMs / 1000);
    }
  };
}

/** Normalize path to avoid high-cardinality label values. */
function normalizePath(path: string): string {
  // Replace UUIDs and numeric IDs with placeholders
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}
