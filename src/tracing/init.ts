/**
 * OpenTelemetry initialization for Core.
 *
 * Sets up the OTel SDK with a console exporter (default) and extensible
 * configuration for future backends (Jaeger, OTLP, etc.).
 *
 * Call `initTracing()` early in the startup sequence — before any
 * instrumented code runs — so the global tracer provider is registered.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { getInstanceNameLower } from "../instance.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TracingConfig {
  /** Service name reported in traces. Default: "${instanceName}-brain". */
  serviceName?: string;
  /** Service version. Default: reads from package.json or "0.1.0". */
  serviceVersion?: string;
  /** Additional span exporters (e.g. OTLP, Jaeger). */
  exporters?: SpanExporter[];
  /** Use BatchSpanProcessor instead of Simple (better for production). */
  batch?: boolean;
  /** Enable console exporter. Default: false (set OTEL_CONSOLE=1 to enable). */
  consoleExport?: boolean;
  /** Additional resource attributes. */
  resourceAttributes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let provider: NodeTracerProvider | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize OpenTelemetry tracing.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Returns the TracerProvider for testing or manual control.
 */
export function initTracing(config?: TracingConfig): TracerProvider {
  if (provider) return provider;

  const serviceName = config?.serviceName ?? `${getInstanceNameLower()}-brain`;
  const serviceVersion = config?.serviceVersion ?? "0.1.0";

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    ...config?.resourceAttributes,
  });

  provider = new NodeTracerProvider({ resource });

  // Console exporter (opt-in: pass consoleExport:true or set OTEL_CONSOLE=1)
  const enableConsole = config?.consoleExport ?? process.env.OTEL_CONSOLE === "1";
  if (enableConsole) {
    const consoleExporter = new ConsoleSpanExporter();
    if (config?.batch) {
      provider.addSpanProcessor(new BatchSpanProcessor(consoleExporter));
    } else {
      provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));
    }
  }

  // Additional exporters (e.g. OTLP for Jaeger/Grafana Tempo)
  if (config?.exporters) {
    for (const exporter of config.exporters) {
      if (config?.batch) {
        provider.addSpanProcessor(new BatchSpanProcessor(exporter));
      } else {
        provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      }
    }
  }

  // Register as the global tracer provider
  provider.register();

  return provider;
}

/**
 * Gracefully shut down tracing — flushes pending spans.
 * Call during server shutdown.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
  provider = null;
}

/**
 * Get the tracer instance. Always returns a valid tracer
 * (noop tracer if initTracing hasn't been called yet).
 */
export function getTracer(name?: string) {
  return trace.getTracer(name ?? `${getInstanceNameLower()}-brain`);
}
