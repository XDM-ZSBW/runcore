/**
 * Lightweight tracing for Core agent runtime.
 *
 * Hooks into RuntimeBus lifecycle events to automatically create trace spans
 * for agent operations (spawn, pause, resume, terminate, complete, fail).
 * Tracks parent→child agent relationships as nested spans within a trace.
 *
 * Trace/span IDs use W3C-compatible hex format for future OTel export.
 */

import { randomBytes } from "node:crypto";
import type { RuntimeBus } from "../agents/runtime/bus.js";
import type { LifecycleEvent, AgentError } from "../agents/runtime/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  agentId: string;
  /** Linked task ID from the agent instance. */
  taskId?: string;
  startTime: string; // ISO
  endTime?: string;
  durationMs?: number;
  status: "ok" | "error" | "running";
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface Trace {
  traceId: string;
  rootSpanId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  spanCount: number;
  status: "ok" | "error" | "running";
  /** Label of the root agent (for display). */
  label?: string;
}

export interface TraceDetail {
  trace: Trace;
  spans: Span[];
}

// ---------------------------------------------------------------------------
// ID generation (W3C Trace Context compatible)
// ---------------------------------------------------------------------------

/** 16-byte (32 hex char) trace ID. */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 8-byte (16 hex char) span ID. */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export class Tracer {
  /** All spans indexed by spanId. */
  private readonly spans = new Map<string, Span>();

  /** agentId → active spanId for that agent. */
  private readonly activeSpans = new Map<string, string>();

  /** agentId → traceId (so child agents inherit the parent's trace). */
  private readonly agentTraces = new Map<string, string>();

  /** traceId → set of spanIds. */
  private readonly traceSpans = new Map<string, Set<string>>();

  /** traceId → root spanId. */
  private readonly traceRoots = new Map<string, string>();

  /** Maximum number of completed traces to retain. */
  private readonly maxTraces: number;

  /** Ordered list of traceIds for eviction. */
  private readonly traceOrder: string[] = [];

  constructor(opts?: { maxTraces?: number }) {
    this.maxTraces = opts?.maxTraces ?? 500;
  }

  // -------------------------------------------------------------------------
  // Manual span API
  // -------------------------------------------------------------------------

  /** Start a new span. If parentAgentId is provided, joins that agent's trace. */
  startSpan(opts: {
    operationName: string;
    agentId: string;
    taskId?: string;
    parentAgentId?: string;
    attributes?: Record<string, string | number | boolean>;
  }): Span {
    // Determine trace context
    let traceId: string;
    let parentSpanId: string | undefined;

    if (opts.parentAgentId && this.agentTraces.has(opts.parentAgentId)) {
      // Join parent's trace
      traceId = this.agentTraces.get(opts.parentAgentId)!;
      parentSpanId = this.activeSpans.get(opts.parentAgentId);
    } else {
      // New root trace
      traceId = generateTraceId();
    }

    const spanId = generateSpanId();
    const now = new Date().toISOString();

    const span: Span = {
      traceId,
      spanId,
      parentSpanId,
      operationName: opts.operationName,
      agentId: opts.agentId,
      taskId: opts.taskId,
      startTime: now,
      status: "running",
      attributes: opts.attributes ?? {},
      events: [],
    };

    this.spans.set(spanId, span);
    this.activeSpans.set(opts.agentId, spanId);
    this.agentTraces.set(opts.agentId, traceId);

    // Track span in trace index
    if (!this.traceSpans.has(traceId)) {
      this.traceSpans.set(traceId, new Set());
      this.traceRoots.set(traceId, spanId);
      this.traceOrder.push(traceId);
      this.evict();
    }
    this.traceSpans.get(traceId)!.add(spanId);

    return span;
  }

  /** Add an event to an active span. */
  addEvent(
    spanId: string,
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.events.push({
      name,
      timestamp: new Date().toISOString(),
      attributes,
    });
  }

  /** Set attributes on a span. */
  setAttributes(
    spanId: string,
    attributes: Record<string, string | number | boolean>,
  ): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    Object.assign(span.attributes, attributes);
  }

  /** End a span with a status. */
  endSpan(spanId: string, status: "ok" | "error" = "ok"): void {
    const span = this.spans.get(spanId);
    if (!span || span.endTime) return;

    const now = new Date().toISOString();
    span.endTime = now;
    span.durationMs = new Date(now).getTime() - new Date(span.startTime).getTime();
    span.status = status;

    // Clear active span if this is the current one for the agent
    if (this.activeSpans.get(span.agentId) === spanId) {
      this.activeSpans.delete(span.agentId);
    }
  }

  // -------------------------------------------------------------------------
  // Bus integration — auto-create spans from lifecycle events
  // -------------------------------------------------------------------------

  /**
   * Attach to a RuntimeBus to automatically create spans from lifecycle events.
   * Call this once during runtime initialization.
   */
  attachToBus(bus: RuntimeBus): void {
    bus.on("agent:lifecycle", (event: LifecycleEvent) => {
      this.handleLifecycleEvent(event);
    });

    bus.on("agent:spawned", ({ agentId, pid }) => {
      const spanId = this.activeSpans.get(agentId);
      if (spanId) {
        this.setAttributes(spanId, { pid: pid ?? 0 });
      }
    });

    bus.on("agent:failed", ({ agentId, error }) => {
      const spanId = this.activeSpans.get(agentId);
      if (spanId) {
        this.addEvent(spanId, "error", {
          "error.code": error.code,
          "error.message": error.message,
          "error.recoverable": error.recoverable,
        });
      }
    });
  }

  private handleLifecycleEvent(event: LifecycleEvent): void {
    const { agentId, previousState, newState, timestamp, reason } = event;

    // Add state transition as an event on the active span
    const activeSpanId = this.activeSpans.get(agentId);

    if (previousState === "initializing" && newState === "running") {
      // Span was already started during spawn — just add the event
      if (activeSpanId) {
        this.addEvent(activeSpanId, "state:running", {
          ...(reason ? { reason } : {}),
        });
      }
    } else if (newState === "paused") {
      if (activeSpanId) {
        this.addEvent(activeSpanId, "state:paused", {
          ...(reason ? { reason } : {}),
        });
        // End the running span, mark as ok (paused is not an error)
        this.endSpan(activeSpanId, "ok");
      }
    } else if (previousState === "paused" && newState === "resuming") {
      // Start a new span for the resumed execution
      const traceId = this.agentTraces.get(agentId);
      if (traceId) {
        const spanId = generateSpanId();
        const span: Span = {
          traceId,
          spanId,
          parentSpanId: activeSpanId, // chain from the paused span
          operationName: "agent:resume",
          agentId,
          startTime: timestamp,
          status: "running",
          attributes: {},
          events: [{ name: "state:resuming", timestamp }],
        };
        this.spans.set(spanId, span);
        this.activeSpans.set(agentId, spanId);
        this.traceSpans.get(traceId)?.add(spanId);
      }
    } else if (newState === "completed") {
      if (activeSpanId) {
        this.addEvent(activeSpanId, "state:completed", {
          ...(reason ? { reason } : {}),
        });
        this.endSpan(activeSpanId, "ok");
      }
      this.agentTraces.delete(agentId);
    } else if (newState === "failed") {
      if (activeSpanId) {
        this.addEvent(activeSpanId, "state:failed", {
          ...(reason ? { reason } : {}),
        });
        this.endSpan(activeSpanId, "error");
      }
      this.agentTraces.delete(agentId);
    } else if (newState === "terminated") {
      if (activeSpanId) {
        this.addEvent(activeSpanId, "state:terminated", {
          ...(reason ? { reason } : {}),
        });
        this.endSpan(activeSpanId, "ok");
      }
      this.agentTraces.delete(agentId);
    } else if (activeSpanId) {
      // Generic transition event
      this.addEvent(activeSpanId, `state:${newState}`, {
        previousState,
        ...(reason ? { reason } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /** Get a span by ID. */
  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  /** Get the active span for an agent. */
  getActiveSpan(agentId: string): Span | undefined {
    const spanId = this.activeSpans.get(agentId);
    return spanId ? this.spans.get(spanId) : undefined;
  }

  /** Get a trace summary by ID. */
  getTrace(traceId: string): Trace | undefined {
    const spanIds = this.traceSpans.get(traceId);
    if (!spanIds) return undefined;

    const rootSpanId = this.traceRoots.get(traceId);
    if (!rootSpanId) return undefined;

    const rootSpan = this.spans.get(rootSpanId);
    if (!rootSpan) return undefined;

    const spans = [...spanIds].map((id) => this.spans.get(id)!).filter(Boolean);
    const hasError = spans.some((s) => s.status === "error");
    const allDone = spans.every((s) => s.status !== "running");

    // Trace end time = latest span end time
    let endTime: string | undefined;
    let durationMs: number | undefined;
    if (allDone) {
      const endTimes = spans
        .map((s) => s.endTime)
        .filter((t): t is string => !!t)
        .sort();
      endTime = endTimes[endTimes.length - 1];
      if (endTime) {
        durationMs = new Date(endTime).getTime() - new Date(rootSpan.startTime).getTime();
      }
    }

    return {
      traceId,
      rootSpanId,
      startTime: rootSpan.startTime,
      endTime,
      durationMs,
      spanCount: spans.length,
      status: hasError ? "error" : allDone ? "ok" : "running",
      label: rootSpan.attributes["agent.label"] as string | undefined,
    };
  }

  /** Get full trace detail (summary + all spans). */
  getTraceDetail(traceId: string): TraceDetail | undefined {
    const trace = this.getTrace(traceId);
    if (!trace) return undefined;

    const spanIds = this.traceSpans.get(traceId)!;
    const spans = [...spanIds]
      .map((id) => this.spans.get(id)!)
      .filter(Boolean)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    return { trace, spans };
  }

  /** List recent traces, newest first. */
  listTraces(opts?: { limit?: number; status?: "ok" | "error" | "running" }): Trace[] {
    const limit = opts?.limit ?? 50;
    const traces: Trace[] = [];

    // Walk traceOrder in reverse (newest first)
    for (let i = this.traceOrder.length - 1; i >= 0 && traces.length < limit; i--) {
      const trace = this.getTrace(this.traceOrder[i]);
      if (!trace) continue;
      if (opts?.status && trace.status !== opts.status) continue;
      traces.push(trace);
    }

    return traces;
  }

  /** Get the trace ID associated with an agent. */
  getAgentTraceId(agentId: string): string | undefined {
    return this.agentTraces.get(agentId);
  }

  // -------------------------------------------------------------------------
  // Internal: eviction
  // -------------------------------------------------------------------------

  private evict(): void {
    while (this.traceOrder.length > this.maxTraces) {
      const oldTraceId = this.traceOrder.shift()!;
      const spanIds = this.traceSpans.get(oldTraceId);
      if (spanIds) {
        for (const spanId of spanIds) {
          const span = this.spans.get(spanId);
          if (span) {
            this.activeSpans.delete(span.agentId);
            this.agentTraces.delete(span.agentId);
          }
          this.spans.delete(spanId);
        }
      }
      this.traceSpans.delete(oldTraceId);
      this.traceRoots.delete(oldTraceId);
    }
  }
}
