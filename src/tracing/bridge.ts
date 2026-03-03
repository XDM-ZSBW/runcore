/**
 * Bridge between the custom Tracer and OpenTelemetry.
 *
 * Listens to RuntimeBus events and creates OTel spans alongside
 * the existing Tracer spans. This ensures both the custom trace
 * API (used by /api/traces endpoints) and OTel export work together.
 */

import { SpanKind, SpanStatusCode, type Span as OTelSpan } from "@opentelemetry/api";
import { getTracer } from "./init.js";
import type { RuntimeBus } from "../agents/runtime/bus.js";
import type { LifecycleEvent } from "../agents/runtime/types.js";
import { getInstanceNameLower } from "../instance.js";

// Track active OTel spans by agentId
const activeOTelSpans = new Map<string, OTelSpan>();

/**
 * Attach OTel span creation to the RuntimeBus.
 * Call alongside `tracer.attachToBus(bus)` during initialization.
 */
export function attachOTelToBus(bus: RuntimeBus): void {
  const otelTracer = getTracer(`${getInstanceNameLower()}-agent-runtime`);

  bus.on("agent:spawned", ({ agentId, pid }) => {
    const span = otelTracer.startSpan("agent.lifecycle", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "agent.id": agentId,
        "agent.pid": pid ?? 0,
        "agent.state": "spawned",
      },
    });
    activeOTelSpans.set(agentId, span);
  });

  bus.on("agent:lifecycle", (event: LifecycleEvent) => {
    const span = activeOTelSpans.get(event.agentId);
    if (!span) return;

    span.addEvent(`state:${event.newState}`, {
      "agent.previous_state": event.previousState,
      ...(event.reason ? { reason: event.reason } : {}),
    });

    // End span on terminal states
    if (
      event.newState === "completed" ||
      event.newState === "terminated"
    ) {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      activeOTelSpans.delete(event.agentId);
    } else if (event.newState === "failed") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: event.reason ?? "Agent failed",
      });
      span.end();
      activeOTelSpans.delete(event.agentId);
    }
  });

  bus.on("agent:failed", ({ agentId, error }) => {
    const span = activeOTelSpans.get(agentId);
    if (!span) return;

    span.recordException(new Error(error.message));
    span.setAttribute("error.code", error.code);
    span.setAttribute("error.recoverable", error.recoverable);
  });

  bus.on("agent:completed", ({ agentId, exitCode }) => {
    const span = activeOTelSpans.get(agentId);
    if (!span) return;

    span.setAttribute("agent.exit_code", exitCode ?? 0);
    // The lifecycle event handler will end the span
  });
}
