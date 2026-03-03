/**
 * Distributed tracing module — public API.
 *
 * Re-exports everything needed to initialize, instrument, and query traces.
 */

// OTel initialization
export { initTracing, shutdownTracing, getTracer } from "./init.js";
export type { TracingConfig } from "./init.js";

// Correlation IDs
export {
  generateCorrelationId,
  withCorrelation,
  getCorrelationId,
  getCorrelationContext,
  CORRELATION_HEADER,
} from "./correlation.js";
export type { CorrelationContext } from "./correlation.js";

// Instrumentation helpers
export {
  withSpan,
  withSpanSync,
  traceAgentSpawn,
  traceAgentExecution,
  traceApiCall,
  traceFileOp,
  traceHttpRequest,
} from "./instrument.js";

// Hono middleware
export { tracingMiddleware } from "./middleware.js";

// OTel ↔ Core Tracer bridge
export { attachOTelToBus } from "./bridge.js";

// Existing custom tracer (for /api/traces endpoints)
export { Tracer, generateTraceId, generateSpanId } from "./tracer.js";
export type { Span, SpanEvent, Trace, TraceDetail } from "./tracer.js";
