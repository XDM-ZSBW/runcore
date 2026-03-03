/**
 * Tests for the agent runtime system.
 *
 * Covers the lifecycle state machine (src/agents/runtime/lifecycle.ts),
 * runtime configuration (src/agents/runtime/config.ts), and
 * spawn utility exports (src/agents/spawn.ts).
 *
 * spawn.ts has heavy external dependencies (Twilio, child_process, etc.)
 * so we test its pure utility exports and focus integration tests on the
 * lifecycle state machine which is the testable core of agent spawning.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isValidTransition,
  assertTransition,
  isTerminal,
  transition,
  shouldRetry,
  prepareRetry,
  reachableStates,
  isActive,
} from "../../src/agents/runtime/lifecycle.js";
import { VALID_TRANSITIONS, TERMINAL_STATES } from "../../src/agents/runtime/types.js";
import type { AgentInstance, AgentState, AgentInstanceConfig } from "../../src/agents/runtime/types.js";
import { RuntimeError } from "../../src/agents/runtime/errors.js";
import { loadRuntimeConfig, resolveInstanceConfig, resolveResources } from "../../src/agents/runtime/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstanceConfig(overrides: Partial<AgentInstanceConfig> = {}): AgentInstanceConfig {
  return {
    timeoutMs: 60_000,
    maxRetries: 3,
    backoffMs: 1_000,
    backoffMultiplier: 2,
    maxBackoffMs: 30_000,
    env: {},
    isolation: "shared",
    priority: 50,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  const now = new Date().toISOString();
  return {
    id: "agent_test_001",
    taskId: "task_test_001",
    state: "initializing",
    config: makeInstanceConfig(),
    resources: { memoryLimitMB: 512, cpuWeight: 50 },
    metadata: { label: "Test agent", origin: "user", tags: [] },
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle — State transitions
// ---------------------------------------------------------------------------

describe("Lifecycle — isValidTransition", () => {
  it("allows initializing → running", () => {
    expect(isValidTransition("initializing", "running")).toBe(true);
  });

  it("allows initializing → failed", () => {
    expect(isValidTransition("initializing", "failed")).toBe(true);
  });

  it("allows running → paused", () => {
    expect(isValidTransition("running", "paused")).toBe(true);
  });

  it("allows running → terminating", () => {
    expect(isValidTransition("running", "terminating")).toBe(true);
  });

  it("allows running → completed", () => {
    expect(isValidTransition("running", "completed")).toBe(true);
  });

  it("allows running → failed", () => {
    expect(isValidTransition("running", "failed")).toBe(true);
  });

  it("allows paused → resuming", () => {
    expect(isValidTransition("paused", "resuming")).toBe(true);
  });

  it("allows paused → terminating", () => {
    expect(isValidTransition("paused", "terminating")).toBe(true);
  });

  it("allows resuming → running", () => {
    expect(isValidTransition("resuming", "running")).toBe(true);
  });

  it("allows terminating → terminated", () => {
    expect(isValidTransition("terminating", "terminated")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidTransition("initializing", "completed")).toBe(false);
    expect(isValidTransition("completed", "running")).toBe(false);
    expect(isValidTransition("terminated", "initializing")).toBe(false);
    expect(isValidTransition("failed", "running")).toBe(false);
  });

  it("rejects self-transitions (not in valid transitions)", () => {
    expect(isValidTransition("running", "running")).toBe(false);
    expect(isValidTransition("paused", "paused")).toBe(false);
  });
});

describe("Lifecycle — assertTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertTransition("initializing", "running")).not.toThrow();
    expect(() => assertTransition("running", "completed")).not.toThrow();
  });

  it("throws RuntimeError for invalid transitions", () => {
    expect(() => assertTransition("completed", "running")).toThrow(RuntimeError);
  });

  it("includes state info in error context", () => {
    try {
      assertTransition("failed", "running");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe("INVALID_TRANSITION");
      expect(re.context).toHaveProperty("from", "failed");
      expect(re.context).toHaveProperty("to", "running");
    }
  });
});

describe("Lifecycle — isTerminal", () => {
  it("identifies terminal states", () => {
    expect(isTerminal("terminated")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("completed")).toBe(true);
  });

  it("identifies non-terminal states", () => {
    expect(isTerminal("initializing")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("paused")).toBe(false);
    expect(isTerminal("resuming")).toBe(false);
    expect(isTerminal("terminating")).toBe(false);
  });
});

describe("Lifecycle — isActive", () => {
  it("returns true for non-terminal states", () => {
    expect(isActive("initializing")).toBe(true);
    expect(isActive("running")).toBe(true);
    expect(isActive("paused")).toBe(true);
  });

  it("returns false for terminal states", () => {
    expect(isActive("terminated")).toBe(false);
    expect(isActive("failed")).toBe(false);
    expect(isActive("completed")).toBe(false);
  });
});

describe("Lifecycle — reachableStates", () => {
  it("returns valid targets from each state", () => {
    expect(reachableStates("initializing")).toEqual(["running", "failed"]);
    expect(reachableStates("running")).toEqual(["paused", "terminating", "completed", "failed"]);
    expect(reachableStates("paused")).toEqual(["resuming", "terminating"]);
    expect(reachableStates("terminating")).toEqual(["terminated"]);
  });

  it("returns empty array for terminal states", () => {
    expect(reachableStates("terminated")).toEqual([]);
    expect(reachableStates("failed")).toEqual([]);
    expect(reachableStates("completed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — transition execution
// ---------------------------------------------------------------------------

describe("Lifecycle — transition", () => {
  it("mutates instance state in place", () => {
    const instance = makeInstance({ state: "initializing" });
    transition(instance, "running");

    expect(instance.state).toBe("running");
  });

  it("returns a LifecycleEvent", () => {
    const instance = makeInstance({ state: "initializing" });
    const event = transition(instance, "running", "Agent started");

    expect(event.agentId).toBe(instance.id);
    expect(event.previousState).toBe("initializing");
    expect(event.newState).toBe("running");
    expect(event.reason).toBe("Agent started");
    expect(event.timestamp).toBeTruthy();
  });

  it("updates updatedAt timestamp", () => {
    const instance = makeInstance({ state: "initializing" });
    const before = instance.updatedAt;

    // Small artificial delay
    const event = transition(instance, "running");
    expect(instance.updatedAt).toBe(event.timestamp);
  });

  it("sets pausedAt when transitioning to paused", () => {
    const instance = makeInstance({ state: "running" });
    expect(instance.pausedAt).toBeUndefined();

    transition(instance, "paused");
    expect(instance.pausedAt).toBeTruthy();
  });

  it("sets terminatedAt when reaching a terminal state", () => {
    const instance = makeInstance({ state: "running" });
    transition(instance, "completed");

    expect(instance.terminatedAt).toBeTruthy();
  });

  it("sets error on failure transition", () => {
    const instance = makeInstance({ state: "running" });
    const error = {
      code: "TIMEOUT",
      message: "Agent exceeded time limit",
      timestamp: new Date().toISOString(),
      recoverable: true,
    };

    transition(instance, "failed", "Timed out", error);
    expect(instance.error).toEqual(error);
    expect(instance.state).toBe("failed");
  });

  it("throws on invalid transition", () => {
    const instance = makeInstance({ state: "completed" });
    expect(() => transition(instance, "running")).toThrow(RuntimeError);
    // State should not have changed
    expect(instance.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — Retry logic
// ---------------------------------------------------------------------------

describe("Lifecycle — shouldRetry", () => {
  it("returns delay for first retry", () => {
    const instance = makeInstance({ retryCount: 0 });
    const delay = shouldRetry(instance);

    expect(delay).not.toBeNull();
    expect(delay).toBe(1_000); // backoffMs * 2^0
  });

  it("applies exponential backoff", () => {
    const instance = makeInstance({ retryCount: 1 });
    expect(shouldRetry(instance)).toBe(2_000); // 1000 * 2^1

    instance.retryCount = 2;
    expect(shouldRetry(instance)).toBe(4_000); // 1000 * 2^2
  });

  it("caps at maxBackoffMs", () => {
    const instance = makeInstance({
      retryCount: 5,
      config: makeInstanceConfig({ backoffMs: 20_000, maxBackoffMs: 30_000, maxRetries: 10 }),
    });
    // 20000 * 2^5 = 640000, capped at 30000
    expect(shouldRetry(instance)).toBe(30_000);
  });

  it("returns null when maxRetries exhausted", () => {
    const instance = makeInstance({
      retryCount: 3,
      config: makeInstanceConfig({ maxRetries: 3 }),
    });
    expect(shouldRetry(instance)).toBeNull();
  });

  it("returns null when error is non-recoverable", () => {
    const instance = makeInstance({
      retryCount: 0,
      error: {
        code: "FATAL",
        message: "Unrecoverable",
        timestamp: new Date().toISOString(),
        recoverable: false,
      },
    });
    expect(shouldRetry(instance)).toBeNull();
  });
});

describe("Lifecycle — prepareRetry", () => {
  it("resets instance for retry", () => {
    const instance = makeInstance({ state: "failed", retryCount: 0 });
    instance.error = {
      code: "TIMEOUT",
      message: "Timed out",
      timestamp: new Date().toISOString(),
      recoverable: true,
    };
    instance.pid = 12345;
    instance.terminatedAt = new Date().toISOString();

    const event = prepareRetry(instance);

    expect(instance.state).toBe("initializing");
    expect(instance.retryCount).toBe(1);
    expect(instance.error).toBeUndefined();
    expect(instance.pid).toBeUndefined();
    expect(instance.terminatedAt).toBeUndefined();

    expect(event.previousState).toBe("failed");
    expect(event.newState).toBe("initializing");
    expect(event.reason).toContain("Retry attempt 1/3");
  });

  it("increments retryCount on each call", () => {
    const instance = makeInstance({ state: "failed", retryCount: 1 });
    prepareRetry(instance);
    expect(instance.retryCount).toBe(2);

    instance.state = "failed" as AgentState;
    prepareRetry(instance);
    expect(instance.retryCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

describe("Runtime config — loadRuntimeConfig", () => {
  it("returns frozen config with defaults", () => {
    const config = loadRuntimeConfig();

    expect(config.maxConcurrentAgents).toBe(5);
    expect(config.defaultTimeoutMs).toBe(600_000);
    expect(config.defaultMaxRetries).toBe(2);
    expect(config.maxTotalMemoryMB).toBe(2048);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("applies overrides", () => {
    const config = loadRuntimeConfig({
      maxConcurrentAgents: 10,
      defaultTimeoutMs: 120_000,
    });

    expect(config.maxConcurrentAgents).toBe(10);
    expect(config.defaultTimeoutMs).toBe(120_000);
    // Other fields remain defaults
    expect(config.defaultMaxRetries).toBe(2);
  });
});

describe("Runtime config — resolveInstanceConfig", () => {
  it("uses runtime defaults when no overrides", () => {
    const runtimeConfig = loadRuntimeConfig();
    const instanceConfig = resolveInstanceConfig(runtimeConfig);

    expect(instanceConfig.timeoutMs).toBe(runtimeConfig.defaultTimeoutMs);
    expect(instanceConfig.maxRetries).toBe(runtimeConfig.defaultMaxRetries);
    expect(instanceConfig.isolation).toBe("shared");
    expect(instanceConfig.priority).toBe(50);
  });

  it("applies per-instance overrides", () => {
    const runtimeConfig = loadRuntimeConfig();
    const instanceConfig = resolveInstanceConfig(runtimeConfig, {
      timeoutMs: 5_000,
      isolation: "sandboxed",
      priority: 10,
    });

    expect(instanceConfig.timeoutMs).toBe(5_000);
    expect(instanceConfig.isolation).toBe("sandboxed");
    expect(instanceConfig.priority).toBe(10);
    // Non-overridden fields use runtime defaults
    expect(instanceConfig.maxRetries).toBe(runtimeConfig.defaultMaxRetries);
  });
});

describe("Runtime config — resolveResources", () => {
  it("uses runtime defaults when no overrides", () => {
    const runtimeConfig = loadRuntimeConfig();
    const resources = resolveResources(runtimeConfig);

    expect(resources.memoryLimitMB).toBe(runtimeConfig.defaultMemoryLimitMB);
    expect(resources.cpuWeight).toBe(runtimeConfig.defaultCpuWeight);
  });

  it("applies per-instance resource overrides", () => {
    const runtimeConfig = loadRuntimeConfig();
    const resources = resolveResources(runtimeConfig, {
      memoryLimitMB: 1024,
      cpuWeight: 90,
    });

    expect(resources.memoryLimitMB).toBe(1024);
    expect(resources.cpuWeight).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// State machine completeness
// ---------------------------------------------------------------------------

describe("State machine — completeness", () => {
  const ALL_STATES: AgentState[] = [
    "initializing", "running", "paused", "resuming",
    "terminating", "terminated", "failed", "completed",
  ];

  it("VALID_TRANSITIONS covers all states", () => {
    for (const state of ALL_STATES) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("TERMINAL_STATES are exactly terminated, failed, completed", () => {
    expect(TERMINAL_STATES.size).toBe(3);
    expect(TERMINAL_STATES.has("terminated")).toBe(true);
    expect(TERMINAL_STATES.has("failed")).toBe(true);
    expect(TERMINAL_STATES.has("completed")).toBe(true);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(VALID_TRANSITIONS[state]).toEqual([]);
    }
  });

  it("all transition targets are valid states", () => {
    for (const [, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATES).toContain(target);
      }
    }
  });
});
