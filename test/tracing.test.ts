/**
 * Tests for the Dash tracing module.
 *
 * Covers: span lifecycle, trace tree construction, bus integration,
 * parent/child agent correlation, query API, and eviction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Tracer,
  generateTraceId,
  generateSpanId,
} from "../src/tracing/tracer.js";
import { RuntimeBus } from "../src/agents/runtime/bus.js";
import type { LifecycleEvent } from "../src/agents/runtime/types.js";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe("Trace ID generation", () => {
  it("should generate 32-char hex trace IDs", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("should generate 16-char hex span IDs", () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("should produce unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Manual span API
// ---------------------------------------------------------------------------

describe("Tracer — manual span API", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer();
  });

  it("should start a span with a new trace", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
      taskId: "task_1",
      attributes: { "agent.label": "Test Agent" },
    });

    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.operationName).toBe("agent:spawn");
    expect(span.agentId).toBe("agent_1");
    expect(span.taskId).toBe("task_1");
    expect(span.status).toBe("running");
    expect(span.events).toEqual([]);
    expect(span.attributes["agent.label"]).toBe("Test Agent");
  });

  it("should end a span with duration", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    tracer.endSpan(span.spanId, "ok");

    expect(span.status).toBe("ok");
    expect(span.endTime).toBeTruthy();
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should not end an already-ended span", () => {
    const span = tracer.startSpan({
      operationName: "test",
      agentId: "a1",
    });

    tracer.endSpan(span.spanId, "ok");
    const firstEnd = span.endTime;

    tracer.endSpan(span.spanId, "error");
    expect(span.endTime).toBe(firstEnd);
    expect(span.status).toBe("ok"); // not overwritten
  });

  it("should add events to a span", () => {
    const span = tracer.startSpan({
      operationName: "test",
      agentId: "a1",
    });

    tracer.addEvent(span.spanId, "state:running", { pid: 1234 });
    tracer.addEvent(span.spanId, "state:completed");

    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("state:running");
    expect(span.events[0].attributes?.pid).toBe(1234);
    expect(span.events[1].name).toBe("state:completed");
  });

  it("should set attributes on a span", () => {
    const span = tracer.startSpan({
      operationName: "test",
      agentId: "a1",
    });

    tracer.setAttributes(span.spanId, { pid: 5678, "agent.label": "Worker" });

    expect(span.attributes.pid).toBe(5678);
    expect(span.attributes["agent.label"]).toBe("Worker");
  });

  it("should track active span per agent", () => {
    const span = tracer.startSpan({
      operationName: "test",
      agentId: "a1",
    });

    expect(tracer.getActiveSpan("a1")).toBe(span);

    tracer.endSpan(span.spanId);
    expect(tracer.getActiveSpan("a1")).toBeUndefined();
  });

  it("should look up spans by ID", () => {
    const span = tracer.startSpan({
      operationName: "test",
      agentId: "a1",
    });

    expect(tracer.getSpan(span.spanId)).toBe(span);
    expect(tracer.getSpan("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Parent/child agent traces
// ---------------------------------------------------------------------------

describe("Tracer — parent/child agent traces", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer();
  });

  it("should create child span within parent's trace", () => {
    const parentSpan = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "parent",
    });

    const childSpan = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "child",
      parentAgentId: "parent",
    });

    expect(childSpan.traceId).toBe(parentSpan.traceId);
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
  });

  it("should chain grandchild spans through the trace", () => {
    const root = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "root",
    });

    const child = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "child",
      parentAgentId: "root",
    });

    const grandchild = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "grandchild",
      parentAgentId: "child",
    });

    expect(grandchild.traceId).toBe(root.traceId);
    expect(grandchild.parentSpanId).toBe(child.spanId);
  });

  it("should create a new trace if parent has no trace", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "orphan",
      parentAgentId: "nonexistent",
    });

    // New trace since the parent isn't tracked
    expect(span.parentSpanId).toBeUndefined();
    expect(span.traceId).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// Trace queries
// ---------------------------------------------------------------------------

describe("Tracer — trace queries", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer();
  });

  it("should return a trace summary", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "a1",
      attributes: { "agent.label": "Worker" },
    });

    const trace = tracer.getTrace(span.traceId);
    expect(trace).toBeDefined();
    expect(trace!.traceId).toBe(span.traceId);
    expect(trace!.rootSpanId).toBe(span.spanId);
    expect(trace!.spanCount).toBe(1);
    expect(trace!.status).toBe("running");
    expect(trace!.label).toBe("Worker");
  });

  it("should mark trace as ok when all spans complete", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "a1",
    });

    tracer.endSpan(span.spanId, "ok");

    const trace = tracer.getTrace(span.traceId);
    expect(trace!.status).toBe("ok");
    expect(trace!.endTime).toBeTruthy();
    expect(trace!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should mark trace as error if any span has error", () => {
    const s1 = tracer.startSpan({ operationName: "a", agentId: "a1" });
    const s2 = tracer.startSpan({ operationName: "b", agentId: "a2", parentAgentId: "a1" });

    tracer.endSpan(s1.spanId, "ok");
    tracer.endSpan(s2.spanId, "error");

    const trace = tracer.getTrace(s1.traceId);
    expect(trace!.status).toBe("error");
  });

  it("should return trace detail with sorted spans", () => {
    const s1 = tracer.startSpan({ operationName: "root", agentId: "a1" });
    const s2 = tracer.startSpan({ operationName: "child", agentId: "a2", parentAgentId: "a1" });

    tracer.endSpan(s2.spanId);
    tracer.endSpan(s1.spanId);

    const detail = tracer.getTraceDetail(s1.traceId);
    expect(detail).toBeDefined();
    expect(detail!.spans).toHaveLength(2);
    // Sorted by startTime — root first
    expect(detail!.spans[0].operationName).toBe("root");
    expect(detail!.spans[1].operationName).toBe("child");
  });

  it("should list traces newest first", () => {
    const s1 = tracer.startSpan({ operationName: "first", agentId: "a1" });
    tracer.endSpan(s1.spanId);

    const s2 = tracer.startSpan({ operationName: "second", agentId: "a2" });
    tracer.endSpan(s2.spanId);

    const traces = tracer.listTraces();
    expect(traces).toHaveLength(2);
    expect(traces[0].traceId).toBe(s2.traceId);
    expect(traces[1].traceId).toBe(s1.traceId);
  });

  it("should filter traces by status", () => {
    const s1 = tracer.startSpan({ operationName: "ok-op", agentId: "a1" });
    tracer.endSpan(s1.spanId, "ok");

    const s2 = tracer.startSpan({ operationName: "err-op", agentId: "a2" });
    tracer.endSpan(s2.spanId, "error");

    expect(tracer.listTraces({ status: "ok" })).toHaveLength(1);
    expect(tracer.listTraces({ status: "error" })).toHaveLength(1);
  });

  it("should respect limit on listTraces", () => {
    for (let i = 0; i < 10; i++) {
      const s = tracer.startSpan({ operationName: `op${i}`, agentId: `a${i}` });
      tracer.endSpan(s.spanId);
    }

    const traces = tracer.listTraces({ limit: 3 });
    expect(traces).toHaveLength(3);
  });

  it("should return undefined for nonexistent trace", () => {
    expect(tracer.getTrace("nonexistent")).toBeUndefined();
    expect(tracer.getTraceDetail("nonexistent")).toBeUndefined();
  });

  it("should return agent trace ID", () => {
    const span = tracer.startSpan({ operationName: "test", agentId: "a1" });
    expect(tracer.getAgentTraceId("a1")).toBe(span.traceId);
    expect(tracer.getAgentTraceId("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bus integration
// ---------------------------------------------------------------------------

describe("Tracer — RuntimeBus integration", () => {
  let tracer: Tracer;
  let bus: RuntimeBus;

  beforeEach(() => {
    tracer = new Tracer();
    bus = new RuntimeBus();
    tracer.attachToBus(bus);
  });

  afterEach(() => {
    bus.destroy();
  });

  function emitLifecycle(event: LifecycleEvent): void {
    bus.emitLifecycle(event);
  }

  it("should record state transitions as span events", () => {
    // Manually start a span (simulates what RuntimeManager.spawn would do)
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
      taskId: "task_1",
      attributes: { "agent.label": "Worker" },
    });

    // Simulate lifecycle: initializing → running
    emitLifecycle({
      agentId: "agent_1",
      previousState: "initializing",
      newState: "running",
      timestamp: new Date().toISOString(),
      reason: "Spawned successfully",
    });

    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe("state:running");

    // running → completed
    emitLifecycle({
      agentId: "agent_1",
      previousState: "running",
      newState: "completed",
      timestamp: new Date().toISOString(),
      reason: "Exited with code 0",
    });

    expect(span.events).toHaveLength(2);
    expect(span.events[1].name).toBe("state:completed");
    expect(span.status).toBe("ok");
    expect(span.endTime).toBeTruthy();
  });

  it("should set PID attribute on agent:spawned event", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    bus.emitSpawned("agent_1", 42);

    expect(span.attributes.pid).toBe(42);
  });

  it("should record error details on agent:failed event", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    bus.emitFailed("agent_1", {
      code: "SPAWN_FAILED",
      message: "Process crashed",
      timestamp: new Date().toISOString(),
      recoverable: true,
    });

    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe("error");
    expect(span.events[0].attributes?.["error.code"]).toBe("SPAWN_FAILED");
  });

  it("should end span with error status on failed lifecycle transition", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    emitLifecycle({
      agentId: "agent_1",
      previousState: "running",
      newState: "failed",
      timestamp: new Date().toISOString(),
      reason: "Process died",
    });

    expect(span.status).toBe("error");
    expect(span.endTime).toBeTruthy();
  });

  it("should end span on terminated lifecycle transition", () => {
    const span = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    emitLifecycle({
      agentId: "agent_1",
      previousState: "running",
      newState: "terminating",
      timestamp: new Date().toISOString(),
    });

    emitLifecycle({
      agentId: "agent_1",
      previousState: "terminating",
      newState: "terminated",
      timestamp: new Date().toISOString(),
      reason: "User request",
    });

    expect(span.status).toBe("ok");
    expect(span.endTime).toBeTruthy();
  });

  it("should handle pause/resume lifecycle with separate spans", () => {
    const span1 = tracer.startSpan({
      operationName: "agent:spawn",
      agentId: "agent_1",
    });

    // Running → paused: ends the first span
    emitLifecycle({
      agentId: "agent_1",
      previousState: "running",
      newState: "paused",
      timestamp: new Date().toISOString(),
    });

    expect(span1.status).toBe("ok");
    expect(span1.endTime).toBeTruthy();

    // Paused → resuming: creates a new span
    emitLifecycle({
      agentId: "agent_1",
      previousState: "paused",
      newState: "resuming",
      timestamp: new Date().toISOString(),
    });

    const span2 = tracer.getActiveSpan("agent_1");
    expect(span2).toBeDefined();
    expect(span2!.spanId).not.toBe(span1.spanId);
    expect(span2!.traceId).toBe(span1.traceId); // same trace
    expect(span2!.operationName).toBe("agent:resume");
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("Tracer — eviction", () => {
  it("should evict oldest traces when exceeding maxTraces", () => {
    const tracer = new Tracer({ maxTraces: 5 });

    const traceIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const span = tracer.startSpan({
        operationName: `op${i}`,
        agentId: `a${i}`,
      });
      traceIds.push(span.traceId);
      tracer.endSpan(span.spanId);
    }

    // First 3 should be evicted (8 - 5 = 3)
    expect(tracer.getTrace(traceIds[0])).toBeUndefined();
    expect(tracer.getTrace(traceIds[1])).toBeUndefined();
    expect(tracer.getTrace(traceIds[2])).toBeUndefined();

    // Last 5 should remain
    expect(tracer.getTrace(traceIds[3])).toBeDefined();
    expect(tracer.getTrace(traceIds[7])).toBeDefined();

    // Evicted spans should be gone too
    expect(tracer.listTraces()).toHaveLength(5);
  });
});
