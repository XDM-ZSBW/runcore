/**
 * Hono middleware for distributed tracing.
 *
 * Automatically creates OTel spans for HTTP requests and propagates
 * correlation IDs via the `x-correlation-id` header.
 *
 * Adds to every request:
 * - An OTel span with HTTP semantic attributes
 * - A correlation ID (from header or auto-generated)
 * - Response headers: x-correlation-id, x-trace-id
 */

import type { MiddlewareHandler } from "hono";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./init.js";
import {
  generateCorrelationId,
  withCorrelation,
  CORRELATION_HEADER,
} from "./correlation.js";

/**
 * Tracing middleware for Hono.
 * Wraps each request in an OTel span and correlation context.
 */
export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const tracer = getTracer();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    // Extract or generate correlation ID
    const incomingCorrelationId = c.req.header(CORRELATION_HEADER);
    const correlationId = incomingCorrelationId || generateCorrelationId();

    // Run the handler inside both an OTel span and correlation context
    await withCorrelation(correlationId, async () => {
      const span = tracer.startSpan(`HTTP ${method} ${path}`, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.method": method,
          "http.route": path,
          "http.url": c.req.url,
          "dash.correlation_id": correlationId,
        },
      });

      try {
        await next();

        const status = c.res.status;
        span.setAttribute("http.status_code", status);

        if (status >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${status}`,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }

      // Propagate correlation + trace IDs in response headers
      c.header(CORRELATION_HEADER, correlationId);
      c.header("x-trace-id", span.spanContext().traceId);
    });
  };
}
