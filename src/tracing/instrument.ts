/**
 * Instrumentation helpers for wrapping Core operations with OTel spans.
 *
 * Provides typed wrappers for the key operation categories:
 * - Agent execution (spawn, lifecycle)
 * - External API calls (Linear, Google, OpenRouter)
 * - File operations (ingest, read, write)
 * - HTTP request handling
 *
 * Each wrapper creates an OTel span, records relevant attributes,
 * and properly handles errors and status codes.
 */

import {
  type Span,
  SpanStatusCode,
  SpanKind,
  context,
  trace,
} from "@opentelemetry/api";
import { getTracer } from "./init.js";
import { getCorrelationId } from "./correlation.js";

// ---------------------------------------------------------------------------
// Generic span wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an async operation in an OTel span.
 * Automatically records errors and sets span status.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  opts?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  },
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    {
      kind: opts?.kind ?? SpanKind.INTERNAL,
      attributes: {
        ...opts?.attributes,
        ...(getCorrelationId()
          ? { "dash.correlation_id": getCorrelationId()! }
          : {}),
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
    },
  );
}

/**
 * Wrap a synchronous operation in an OTel span.
 */
export function withSpanSync<T>(
  name: string,
  fn: (span: Span) => T,
  opts?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  },
): T {
  const tracer = getTracer();
  const span = tracer.startSpan(name, {
    kind: opts?.kind ?? SpanKind.INTERNAL,
    attributes: {
      ...opts?.attributes,
      ...(getCorrelationId()
        ? { "dash.correlation_id": getCorrelationId()! }
        : {}),
    },
  });

  try {
    const result = fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
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
}

// ---------------------------------------------------------------------------
// Agent instrumentation
// ---------------------------------------------------------------------------

/** Wrap an agent spawn operation. */
export async function traceAgentSpawn<T>(
  taskId: string,
  label: string,
  origin: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`agent.spawn`, fn, {
    kind: SpanKind.PRODUCER,
    attributes: {
      "agent.task_id": taskId,
      "agent.label": label,
      "agent.origin": origin,
    },
  });
}

/** Wrap agent execution (the full lifecycle of a single agent run). */
export async function traceAgentExecution<T>(
  taskId: string,
  label: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`agent.execute`, fn, {
    kind: SpanKind.INTERNAL,
    attributes: {
      "agent.task_id": taskId,
      "agent.label": label,
    },
  });
}

// ---------------------------------------------------------------------------
// API call instrumentation
// ---------------------------------------------------------------------------

/** Wrap an external API call (Linear, Google, OpenRouter, etc.). */
export async function traceApiCall<T>(
  service: string,
  operation: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`${service}.${operation}`, fn, {
    kind: SpanKind.CLIENT,
    attributes: {
      "rpc.service": service,
      "rpc.method": operation,
    },
  });
}

// ---------------------------------------------------------------------------
// File operation instrumentation
// ---------------------------------------------------------------------------

/** Wrap a file operation (read, write, ingest). */
export async function traceFileOp<T>(
  operation: string,
  path: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`file.${operation}`, fn, {
    attributes: {
      "file.operation": operation,
      "file.path": path,
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP instrumentation
// ---------------------------------------------------------------------------

/** Wrap an HTTP request handler. */
export async function traceHttpRequest<T>(
  method: string,
  route: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`HTTP ${method} ${route}`, fn, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.method": method,
      "http.route": route,
    },
  });
}
