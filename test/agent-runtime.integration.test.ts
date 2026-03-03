/**
 * Integration tests: Agent runtime — lifecycle state machine, resource pool,
 * event bus, registry, and error handling.
 *
 * Tests the agent management subsystem without spawning real processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isValidTransition,
  assertTransition,
  transition,
  isTerminal,
  isActive,
  shouldRetry,
  prepareRetry,
  reachableStates,
} from "../src/agents/runtime/lifecycle.js";
import { ResourcePool } from "../src/agents/runtime/resources.js";
import { RuntimeBus } from "../src/agents/runtime/bus.js";
import { RuntimeError, ErrorCodes } from "../src/agents/runtime/errors.js";
import { VALID_TRANSITIONS, TERMINAL_STATES } from "../src/agents/runtime/types.js";
import type {
  AgentInstance,
  AgentState,
  AgentError,
  RuntimeConfig,
  LifecycleEvent,
  AgentMessage,
} from "../src/agents/runtime/types.js";
import { createTempDir, sleep } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers: create test agent instances
// ---------------------------------------------------------------------------

function createTestInstance(overrides?: Partial<AgentInstance>): AgentInstance {
  return {
    id: `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    taskId: "task_test",
    state: "initializing",
    config: {
      timeoutMs: 60_000,
      maxRetries: 3,
      backoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30_000,
      env: {},
      isolation: "shared",
      priority: 50,
    },
    resources: { memoryLimitMB: 512, cpuWeight: 50 },
    metadata: { label: "Test Agent", origin: "user", tags: [] },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    maxConcurrentAgents: 3,
    defaultTimeoutMs: 60_000,
    defaultMaxRetries: 3,
    defaultBackoffMs: 1000,
    defaultBackoffMultiplier: 2,
    defaultMaxBackoffMs: 30_000,
    maxTotalMemoryMB: 2048,
    defaultMemoryLimitMB: 512,
    defaultCpuWeight: 50,
    persistDir: "",
    monitorIntervalMs: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

describe("Agent lifecycle state machine", () => {
  it("should validate all legal transitions", () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        expect(isValidTransition(from as AgentState, to)).toBe(true);
      }
    }
  });

  it("should reject invalid transitions", () => {
    expect(isValidTransition("completed", "running")).toBe(false);
    expect(isValidTransition("terminated", "running")).toBe(false);
    expect(isValidTransition("failed", "paused")).toBe(false);
    expect(isValidTransition("initializing", "paused")).toBe(false);
  });

  it("should throw on invalid transition via assertTransition", () => {
    expect(() => assertTransition("completed", "running")).toThrow(RuntimeError);
    expect(() => assertTransition("completed", "running")).toThrow(/Invalid state transition/);
  });

  it("should correctly identify terminal states", () => {
    expect(isTerminal("terminated")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("initializing")).toBe(false);
    expect(isTerminal("paused")).toBe(false);
  });

  it("should identify active (non-terminal) states", () => {
    expect(isActive("running")).toBe(true);
    expect(isActive("initializing")).toBe(true);
    expect(isActive("paused")).toBe(true);
    expect(isActive("resuming")).toBe(true);
    expect(isActive("completed")).toBe(false);
  });

  it("should list reachable states from any state", () => {
    expect(reachableStates("running")).toContain("paused");
    expect(reachableStates("running")).toContain("completed");
    expect(reachableStates("terminated")).toEqual([]);
    expect(reachableStates("completed")).toEqual([]);
  });

  it("should apply transition and update timestamps", () => {
    const instance = createTestInstance({ state: "initializing" });
    const event = transition(instance, "running");

    expect(instance.state).toBe("running");
    expect(event.previousState).toBe("initializing");
    expect(event.newState).toBe("running");
    expect(event.timestamp).toBeTruthy();
    expect(instance.updatedAt).toBe(event.timestamp);
  });

  it("should set pausedAt when transitioning to paused", () => {
    const instance = createTestInstance({ state: "running" });
    transition(instance, "paused");

    expect(instance.state).toBe("paused");
    expect(instance.pausedAt).toBeTruthy();
  });

  it("should set terminatedAt for terminal transitions", () => {
    const instance = createTestInstance({ state: "running" });
    transition(instance, "completed");

    expect(instance.terminatedAt).toBeTruthy();
  });

  it("should attach error on transition to failed", () => {
    const instance = createTestInstance({ state: "running" });
    const error: AgentError = {
      code: "SPAWN_FAILED",
      message: "Process exited unexpectedly",
      timestamp: new Date().toISOString(),
      recoverable: true,
    };

    transition(instance, "failed", "unexpected exit", error);

    expect(instance.state).toBe("failed");
    expect(instance.error).toBe(error);
  });

  it("should walk full lifecycle: initializing → running → paused → resuming → running → completed", () => {
    const instance = createTestInstance({ state: "initializing" });

    transition(instance, "running");
    expect(instance.state).toBe("running");

    transition(instance, "paused");
    expect(instance.state).toBe("paused");

    transition(instance, "resuming");
    expect(instance.state).toBe("resuming");

    transition(instance, "running");
    expect(instance.state).toBe("running");

    transition(instance, "completed");
    expect(instance.state).toBe("completed");
    expect(isTerminal(instance.state)).toBe(true);
  });

  it("should walk failure path: initializing → running → failed", () => {
    const instance = createTestInstance({ state: "initializing" });
    transition(instance, "running");
    transition(instance, "failed", "crash", {
      code: "TIMEOUT",
      message: "Timed out",
      timestamp: new Date().toISOString(),
      recoverable: true,
    });

    expect(instance.state).toBe("failed");
    expect(instance.error!.code).toBe("TIMEOUT");
  });

  it("should walk termination path: running → terminating → terminated", () => {
    const instance = createTestInstance({ state: "running" });
    transition(instance, "terminating");
    transition(instance, "terminated");
    expect(instance.terminatedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe("Agent retry logic", () => {
  it("should allow retry when under max retries and error is recoverable", () => {
    const instance = createTestInstance({
      state: "failed",
      retryCount: 0,
      error: { code: "SPAWN_FAILED", message: "err", timestamp: "", recoverable: true },
    });

    const delay = shouldRetry(instance);
    expect(delay).not.toBeNull();
    expect(delay).toBe(1000); // backoffMs * 2^0
  });

  it("should calculate exponential backoff", () => {
    const instance = createTestInstance({ state: "failed", retryCount: 2 });
    instance.error = { code: "TIMEOUT", message: "", timestamp: "", recoverable: true };

    const delay = shouldRetry(instance);
    // 1000 * 2^2 = 4000
    expect(delay).toBe(4000);
  });

  it("should cap backoff at maxBackoffMs", () => {
    const instance = createTestInstance({
      state: "failed",
      retryCount: 2,
      config: {
        timeoutMs: 60_000,
        maxRetries: 100,
        backoffMs: 10_000,
        backoffMultiplier: 10,
        maxBackoffMs: 30_000,
        env: {},
        isolation: "shared",
        priority: 50,
      },
    });
    instance.error = { code: "TIMEOUT", message: "", timestamp: "", recoverable: true };

    const delay = shouldRetry(instance);
    expect(delay).not.toBeNull();
    expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("should not retry when max retries exceeded", () => {
    const instance = createTestInstance({
      state: "failed",
      retryCount: 3, // equals maxRetries
    });
    instance.error = { code: "TIMEOUT", message: "", timestamp: "", recoverable: true };

    expect(shouldRetry(instance)).toBeNull();
  });

  it("should not retry non-recoverable errors", () => {
    const instance = createTestInstance({
      state: "failed",
      retryCount: 0,
      error: { code: "INVALID_TRANSITION", message: "", timestamp: "", recoverable: false },
    });

    expect(shouldRetry(instance)).toBeNull();
  });

  it("should prepare instance for retry", () => {
    const instance = createTestInstance({
      state: "failed",
      retryCount: 1,
      error: { code: "TIMEOUT", message: "timeout", timestamp: "", recoverable: true },
    });

    const event = prepareRetry(instance);

    expect(instance.state).toBe("initializing");
    expect(instance.retryCount).toBe(2);
    expect(instance.error).toBeUndefined();
    expect(instance.pid).toBeUndefined();
    expect(event.previousState).toBe("failed");
    expect(event.newState).toBe("initializing");
  });
});

// ---------------------------------------------------------------------------
// Resource pool
// ---------------------------------------------------------------------------

describe("ResourcePool", () => {
  let pool: ResourcePool;

  beforeEach(() => {
    pool = new ResourcePool(createTestConfig());
  });

  it("should start empty", () => {
    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
    expect(pool.totalMemoryMB).toBe(0);
  });

  it("should track allocations", () => {
    pool.allocate("agent_1", { memoryLimitMB: 512, cpuWeight: 50 });
    expect(pool.activeCount).toBe(1);
    expect(pool.totalMemoryMB).toBe(512);
  });

  it("should check if allocation is possible", () => {
    expect(pool.canAllocate({ memoryLimitMB: 512, cpuWeight: 50 })).toBe(true);

    // Fill up to max concurrent (3)
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a2", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a3", { memoryLimitMB: 512, cpuWeight: 50 });

    expect(pool.canAllocate({ memoryLimitMB: 512, cpuWeight: 50 })).toBe(false);
  });

  it("should enforce max concurrent agents", () => {
    pool.allocate("a1", { memoryLimitMB: 100, cpuWeight: 10 });
    pool.allocate("a2", { memoryLimitMB: 100, cpuWeight: 10 });
    pool.allocate("a3", { memoryLimitMB: 100, cpuWeight: 10 });

    expect(() =>
      pool.allocate("a4", { memoryLimitMB: 100, cpuWeight: 10 }),
    ).toThrow(RuntimeError);

    expect(() =>
      pool.allocate("a4", { memoryLimitMB: 100, cpuWeight: 10 }),
    ).toThrow(/agents active/);
  });

  it("should enforce total memory limit", () => {
    const bigPool = new ResourcePool(createTestConfig({ maxTotalMemoryMB: 1024 }));
    bigPool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });

    expect(() =>
      bigPool.allocate("a2", { memoryLimitMB: 600, cpuWeight: 50 }),
    ).toThrow(/Cannot allocate/);
  });

  it("should release resources", () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    expect(pool.activeCount).toBe(1);

    pool.release("a1");
    expect(pool.activeCount).toBe(0);
    expect(pool.totalMemoryMB).toBe(0);
  });

  it("should not allocate to the same agent twice", () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    expect(() =>
      pool.allocate("a1", { memoryLimitMB: 256, cpuWeight: 25 }),
    ).toThrow(/already has resources/);
  });

  it("should provide a resource snapshot", () => {
    pool.allocate("a1", { memoryLimitMB: 256, cpuWeight: 30 });
    pool.allocate("a2", { memoryLimitMB: 512, cpuWeight: 50 });

    const snap = pool.snapshot();
    expect(snap.activeAgents).toBe(2);
    expect(snap.maxAgents).toBe(3);
    expect(snap.totalMemoryMB).toBe(768);
    expect(snap.maxMemoryMB).toBe(2048);
    expect(snap.queuedRequests).toBe(0);
  });

  it("should update allocations in place", () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.updateAllocation("a1", { memoryLimitMB: 256 });

    const alloc = pool.getAllocation("a1");
    expect(alloc!.memoryLimitMB).toBe(256);
    expect(alloc!.cpuWeight).toBe(50); // unchanged
  });

  it("should queue spawn requests when resources exhausted", async () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a2", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a3", { memoryLimitMB: 512, cpuWeight: 50 });

    const request = {
      taskId: "task_queued",
      label: "Queued",
      prompt: "test",
      origin: "user" as const,
    };

    // Start queuing (will resolve when resources free up)
    const queuePromise = pool.enqueue(request, 50);
    expect(pool.queueLength).toBe(1);

    // Release one agent → should drain queue
    pool.release("a1");

    await queuePromise;
    expect(pool.queueLength).toBe(0);
  });

  it("should reject queued requests on shutdown", async () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a2", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a3", { memoryLimitMB: 512, cpuWeight: 50 });

    const request = {
      taskId: "task_rejected",
      label: "Rejected",
      prompt: "test",
      origin: "user" as const,
    };

    const promise = pool.enqueue(request);

    pool.rejectAll("Shutting down");

    await expect(promise).rejects.toThrow(/Shutting down/);
    expect(pool.queueLength).toBe(0);
  });

  it("should prioritize queued requests", async () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a2", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.allocate("a3", { memoryLimitMB: 512, cpuWeight: 50 });

    const order: string[] = [];

    // Queue two with different priorities
    const p1 = pool.enqueue(
      { taskId: "low", label: "Low", prompt: "test", origin: "user" },
      80,
    ).then(() => order.push("low"));

    const p2 = pool.enqueue(
      { taskId: "high", label: "High", prompt: "test", origin: "user" },
      10,
    ).then(() => order.push("high"));

    // Release two agents
    pool.release("a1");
    pool.release("a2");

    await Promise.all([p1, p2]);
    expect(order[0]).toBe("high"); // Higher priority dequeued first
  });

  it("should clear all resources and queued requests", () => {
    pool.allocate("a1", { memoryLimitMB: 512, cpuWeight: 50 });
    pool.clear();

    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RuntimeBus (event bus + inter-agent messaging)
// ---------------------------------------------------------------------------

describe("RuntimeBus", () => {
  let bus: RuntimeBus;

  beforeEach(() => {
    bus = new RuntimeBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  it("should emit and receive lifecycle events", async () => {
    const events: LifecycleEvent[] = [];
    bus.on("agent:lifecycle", (event) => events.push(event));

    bus.emitLifecycle({
      agentId: "agent_1",
      previousState: "initializing",
      newState: "running",
      timestamp: new Date().toISOString(),
    });

    expect(events.length).toBe(1);
    expect(events[0].newState).toBe("running");
  });

  it("should emit spawned, completed, and failed events", () => {
    const spawned: Array<{ agentId: string; pid?: number }> = [];
    const completed: Array<{ agentId: string; exitCode?: number }> = [];
    const failed: Array<{ agentId: string; error: AgentError }> = [];

    bus.on("agent:spawned", (e) => spawned.push(e));
    bus.on("agent:completed", (e) => completed.push(e));
    bus.on("agent:failed", (e) => failed.push(e));

    bus.emitSpawned("a1", 12345);
    bus.emitCompleted("a2", 0);
    bus.emitFailed("a3", {
      code: "TIMEOUT",
      message: "Timed out",
      timestamp: new Date().toISOString(),
      recoverable: true,
    });

    expect(spawned).toEqual([{ agentId: "a1", pid: 12345 }]);
    expect(completed).toEqual([{ agentId: "a2", exitCode: 0 }]);
    expect(failed.length).toBe(1);
    expect(failed[0].error.code).toBe("TIMEOUT");
  });

  it("should send and receive inter-agent messages", () => {
    const received: AgentMessage[] = [];
    bus.subscribe("agent_A", (msg) => received.push(msg));

    bus.send({
      from: "agent_B",
      to: "agent_A",
      type: "data",
      payload: { key: "value" },
    });

    // Messages are routed through the agent:message topic
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].payload).toEqual({ key: "value" });
  });

  it("should handle request/response with correlation", async () => {
    // Set up a responder
    bus.on("agent:message", (msg) => {
      if (msg.to === "responder" && msg.correlationId) {
        // Respond after a small delay
        setTimeout(() => {
          bus.send({
            from: "responder",
            to: msg.from,
            type: "response",
            payload: { answer: 42 },
            correlationId: msg.correlationId,
          });
        }, 10);
      }
    });

    const response = await bus.request(
      {
        from: "requester",
        to: "responder",
        type: "query",
        payload: { question: "meaning of life" },
      },
      5000,
    );

    expect(response.payload).toEqual({ answer: 42 });
  });

  it("should timeout pending requests", async () => {
    await expect(
      bus.request(
        { from: "a", to: "nobody", type: "query", payload: {} },
        100, // short timeout
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("should emit resource warning", () => {
    const warnings: any[] = [];
    bus.on("runtime:resource-warning", (e) => warnings.push(e));

    bus.emitResourceWarning({
      activeAgents: 3,
      maxAgents: 3,
      totalMemoryMB: 1500,
      maxMemoryMB: 2048,
      queuedRequests: 5,
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0].usage.activeAgents).toBe(3);
  });

  it("should emit shutdown event", () => {
    const reasons: string[] = [];
    bus.on("runtime:shutdown", (e) => reasons.push(e.reason));

    bus.emitShutdown("Test shutdown");
    expect(reasons).toEqual(["Test shutdown"]);
  });

  it("should unsubscribe agent from messages", () => {
    const received: AgentMessage[] = [];
    bus.subscribe("agent_X", (msg) => received.push(msg));

    bus.send({ from: "other", to: "agent_X", type: "ping", payload: {} });
    const beforeUnsub = received.length;

    bus.unsubscribe("agent_X");
    bus.send({ from: "other", to: "agent_X", type: "ping", payload: {} });

    // Should not receive more messages after unsubscribe
    // (the exact count depends on implementation — just verify no extra)
    expect(received.length).toBe(beforeUnsub);
  });

  it("should clean up on destroy", () => {
    const received: any[] = [];
    bus.on("agent:lifecycle", (e) => received.push(e));

    bus.destroy();

    bus.emitLifecycle({
      agentId: "test",
      previousState: "running",
      newState: "completed",
      timestamp: new Date().toISOString(),
    });

    expect(received.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RuntimeError
// ---------------------------------------------------------------------------

describe("RuntimeError", () => {
  it("should carry error code and recoverability", () => {
    const err = new RuntimeError(
      ErrorCodes.RESOURCE_EXHAUSTED,
      "No resources available",
      true,
      { requested: 512, available: 0 },
    );

    expect(err.code).toBe("RESOURCE_EXHAUSTED");
    expect(err.message).toBe("No resources available");
    expect(err.recoverable).toBe(true);
    expect(err.context?.requested).toBe(512);
    expect(err.name).toBe("RuntimeError");
    expect(err).toBeInstanceOf(Error);
  });

  it("should have all expected error codes", () => {
    const expectedCodes = [
      "RESOURCE_EXHAUSTED",
      "MAX_AGENTS_REACHED",
      "MEMORY_LIMIT_EXCEEDED",
      "INVALID_TRANSITION",
      "AGENT_NOT_FOUND",
      "ALREADY_TERMINATED",
      "SPAWN_FAILED",
      "RESUME_FAILED",
      "PAUSE_NOT_SUPPORTED",
      "TIMEOUT",
      "DRIVER_ERROR",
      "MAX_RETRIES_EXCEEDED",
      "SHUTDOWN_IN_PROGRESS",
      "REGISTRY_CORRUPT",
      "BUS_DELIVERY_FAILED",
    ];

    for (const code of expectedCodes) {
      expect(code in ErrorCodes).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-agent resource contention
// ---------------------------------------------------------------------------

describe("Multi-agent resource contention", () => {
  it("should handle rapid allocate/release cycles", () => {
    const pool = new ResourcePool(createTestConfig({ maxConcurrentAgents: 2 }));

    for (let i = 0; i < 100; i++) {
      pool.allocate(`a${i}`, { memoryLimitMB: 100, cpuWeight: 10 });
      pool.release(`a${i}`);
    }

    expect(pool.activeCount).toBe(0);
  });

  it("should correctly track resources across many agents", () => {
    const pool = new ResourcePool(createTestConfig({
      maxConcurrentAgents: 10,
      maxTotalMemoryMB: 5000,
    }));

    // Allocate 5 agents
    for (let i = 0; i < 5; i++) {
      pool.allocate(`a${i}`, { memoryLimitMB: 256, cpuWeight: 20 });
    }

    expect(pool.activeCount).toBe(5);
    expect(pool.totalMemoryMB).toBe(1280);

    // Release 3
    pool.release("a0");
    pool.release("a2");
    pool.release("a4");

    expect(pool.activeCount).toBe(2);
    expect(pool.totalMemoryMB).toBe(512);
  });
});
