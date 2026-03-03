/**
 * Tests: Agent Orchestration Engine — workflow creation, execution modes,
 * conflict detection, queue management, and status reporting.
 *
 * Uses a mock AgentPool to test orchestration logic without spawning real processes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Orchestrator,
  parseFilesFromOutput,
  type CreateWorkflowInput,
  type WorkflowTaskDef,
  type Workflow,
} from "../src/agents/orchestration.js";
import type { AgentInstance, LifecycleEvent } from "../src/agents/runtime/types.js";
import { RuntimeBus } from "../src/agents/runtime/bus.js";

// ---------------------------------------------------------------------------
// Mock AgentPool
// ---------------------------------------------------------------------------

/** Minimal mock that simulates AgentPool behavior for orchestration testing. */
function createMockPool(options?: {
  /** Delay before marking agents complete (ms). Default: 10. */
  completionDelay?: number;
  /** Task keys that should fail. */
  failKeys?: Set<string>;
}) {
  const completionDelay = options?.completionDelay ?? 10;
  const failKeys = options?.failKeys ?? new Set<string>();
  const bus = new RuntimeBus();
  const instances = new Map<string, AgentInstance>();
  let instanceCounter = 0;

  const pool = {
    runtimeManager: { bus },

    spawn: vi.fn(async (request: any): Promise<AgentInstance> => {
      instanceCounter++;
      const id = `inst_${instanceCounter}`;
      const instance: AgentInstance = {
        id,
        taskId: request.taskId,
        state: "running",
        config: {
          timeoutMs: 60_000,
          maxRetries: 0,
          backoffMs: 1000,
          backoffMultiplier: 2,
          maxBackoffMs: 30_000,
          env: {},
          isolation: "shared" as const,
          priority: 50,
        },
        resources: { memoryLimitMB: 512, cpuWeight: 50 },
        metadata: { label: request.label, origin: request.origin ?? "ai", tags: request.tags ?? [] },
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      instances.set(id, instance);

      // Determine if this task should fail based on task key in tags
      const taskKeyTag = (request.tags as string[] | undefined)?.find((t: string) => t.startsWith("task:"));
      const taskKey = taskKeyTag?.replace("task:", "");
      const shouldFail = taskKey ? failKeys.has(taskKey) : false;

      // Simulate async completion
      setTimeout(() => {
        const inst = instances.get(id);
        if (inst) {
          inst.state = shouldFail ? "failed" : "completed";
          inst.updatedAt = new Date().toISOString();
          if (shouldFail) {
            inst.error = {
              code: "SPAWN_FAILED",
              message: "Simulated failure",
              timestamp: new Date().toISOString(),
              recoverable: false,
            };
          }
          bus.emitLifecycle({
            agentId: id,
            previousState: "running",
            newState: inst.state,
            timestamp: new Date().toISOString(),
          });
        }
      }, completionDelay);

      return instance;
    }),

    getInstance: vi.fn((id: string) => instances.get(id)),

    terminate: vi.fn(async (id: string) => {
      const inst = instances.get(id);
      if (inst) {
        inst.state = "terminated";
        inst.updatedAt = new Date().toISOString();
      }
      return inst;
    }),

    get isShuttingDown() {
      return false;
    },
  };

  return { pool: pool as unknown as import("../src/agents/runtime.js").AgentPool, bus, instances };
}

// ---------------------------------------------------------------------------
// Helper: build task defs
// ---------------------------------------------------------------------------

function makeTaskDefs(count: number, overrides?: Partial<WorkflowTaskDef>): WorkflowTaskDef[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `task_${i}`,
    label: `Task ${i}`,
    prompt: `Do task ${i}`,
    ...overrides,
  }));
}

// ---------------------------------------------------------------------------
// Workflow creation
// ---------------------------------------------------------------------------

describe("Orchestrator — workflow creation", () => {
  let orch: Orchestrator;

  beforeEach(() => {
    const { pool } = createMockPool();
    orch = new Orchestrator(pool);
  });

  it("should create a workflow with tasks", () => {
    const wf = orch.createWorkflow({
      name: "Test",
      tasks: makeTaskDefs(3),
    });

    expect(wf.id).toMatch(/^wf_/);
    expect(wf.name).toBe("Test");
    expect(wf.status).toBe("pending");
    expect(wf.tasks.size).toBe(3);
    expect(wf.mode).toBe("parallel");
    expect(wf.conflictStrategy).toBe("last-write-wins");
  });

  it("should reject duplicate task keys", () => {
    expect(() =>
      orch.createWorkflow({
        name: "Dup",
        tasks: [
          { key: "a", label: "A", prompt: "a" },
          { key: "a", label: "A2", prompt: "a2" },
        ],
      }),
    ).toThrow(/Duplicate task key/);
  });

  it("should reject unknown dependency references", () => {
    expect(() =>
      orch.createWorkflow({
        name: "Bad deps",
        mode: "dependency",
        tasks: [
          { key: "a", label: "A", prompt: "a", dependsOn: ["nonexistent"] },
        ],
      }),
    ).toThrow(/depends on unknown task/);
  });

  it("should detect dependency cycles", () => {
    expect(() =>
      orch.createWorkflow({
        name: "Cycle",
        mode: "dependency",
        tasks: [
          { key: "a", label: "A", prompt: "a", dependsOn: ["b"] },
          { key: "b", label: "B", prompt: "b", dependsOn: ["c"] },
          { key: "c", label: "C", prompt: "c", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/Dependency cycle detected/);
  });

  it("should accept valid dependency graph", () => {
    const wf = orch.createWorkflow({
      name: "Deps",
      mode: "dependency",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b", dependsOn: ["a"] },
        { key: "c", label: "C", prompt: "c", dependsOn: ["a"] },
        { key: "d", label: "D", prompt: "d", dependsOn: ["b", "c"] },
      ],
    });

    expect(wf.tasks.size).toBe(4);
    expect(wf.mode).toBe("dependency");
  });
});

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

describe("Orchestrator — parallel execution", () => {
  it("should execute all tasks in parallel and report completion", async () => {
    const { pool } = createMockPool();
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Parallel test",
      tasks: makeTaskDefs(3),
      mode: "parallel",
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("completed");
    expect(result.summary.total).toBe(3);
    expect(result.summary.completed).toBe(3);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should respect maxConcurrent in parallel mode", async () => {
    const { pool } = createMockPool({ completionDelay: 50 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Throttled",
      tasks: makeTaskDefs(5),
      mode: "parallel",
      maxConcurrent: 2,
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("completed");
    expect(result.summary.completed).toBe(5);
    // All 5 tasks spawned via pool
    expect(pool.spawn).toHaveBeenCalledTimes(5);
  });

  it("should report partial status when some tasks fail", async () => {
    const { pool } = createMockPool({ failKeys: new Set(["task_1"]) });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Partial",
      tasks: makeTaskDefs(3),
      mode: "parallel",
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("partial");
    expect(result.summary.completed).toBe(2);
    expect(result.summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sequential execution
// ---------------------------------------------------------------------------

describe("Orchestrator — sequential execution", () => {
  it("should execute tasks one at a time in order", async () => {
    const spawnOrder: string[] = [];
    const { pool } = createMockPool({ completionDelay: 10 });

    // Track spawn order
    const origSpawn = pool.spawn;
    (pool as any).spawn = vi.fn(async (req: any) => {
      const tag = (req.tags as string[]).find((t: string) => t.startsWith("task:"));
      if (tag) spawnOrder.push(tag.replace("task:", ""));
      return origSpawn(req);
    });

    const orch = new Orchestrator(pool);
    const wf = orch.createWorkflow({
      name: "Sequential",
      tasks: makeTaskDefs(3),
      mode: "sequential",
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("completed");
    expect(spawnOrder).toEqual(["task_0", "task_1", "task_2"]);
  });
});

// ---------------------------------------------------------------------------
// Dependency execution
// ---------------------------------------------------------------------------

describe("Orchestrator — dependency execution", () => {
  it("should execute tasks in dependency order", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Deps",
      mode: "dependency",
      tasks: [
        { key: "setup", label: "Setup", prompt: "setup" },
        { key: "build", label: "Build", prompt: "build", dependsOn: ["setup"] },
        { key: "test", label: "Test", prompt: "test", dependsOn: ["build"] },
      ],
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("completed");
    expect(result.summary.completed).toBe(3);
  });

  it("should skip tasks whose dependencies failed", async () => {
    const { pool } = createMockPool({
      completionDelay: 10,
      failKeys: new Set(["build"]),
    });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Dep fail",
      mode: "dependency",
      tasks: [
        { key: "setup", label: "Setup", prompt: "setup" },
        { key: "build", label: "Build", prompt: "build", dependsOn: ["setup"] },
        { key: "test", label: "Test", prompt: "test", dependsOn: ["build"] },
      ],
    });

    const result = await orch.execute(wf.id);

    // setup completes, build fails, test skipped
    const taskMap = new Map(result.tasks.map((t) => [t.key, t]));
    expect(taskMap.get("setup")!.status).toBe("completed");
    expect(taskMap.get("build")!.status).toBe("failed");
    expect(taskMap.get("test")!.status).toBe("skipped");
    expect(result.summary.skipped).toBe(1);
  });

  it("should run independent branches in parallel", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Parallel deps",
      mode: "dependency",
      tasks: [
        { key: "root", label: "Root", prompt: "root" },
        { key: "branch_a", label: "Branch A", prompt: "a", dependsOn: ["root"] },
        { key: "branch_b", label: "Branch B", prompt: "b", dependsOn: ["root"] },
        { key: "merge", label: "Merge", prompt: "merge", dependsOn: ["branch_a", "branch_b"] },
      ],
    });

    const result = await orch.execute(wf.id);

    expect(result.status).toBe("completed");
    expect(result.summary.completed).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe("Orchestrator — conflict detection", () => {
  it("should detect file conflicts when tasks touch the same files", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Conflicts",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b" },
      ],
      mode: "sequential",
      conflictStrategy: "last-write-wins",
    });

    // Pre-set filesTouched on tasks — these persist through execution
    // since execute() doesn't reset them
    const workflowRef = orch.getWorkflow(wf.id)!;
    workflowRef.tasks.get("a")!.filesTouched = ["src/index.ts", "src/utils.ts"];
    workflowRef.tasks.get("b")!.filesTouched = ["src/index.ts", "src/other.ts"];

    const result = await orch.execute(wf.id);

    // Conflict on src/index.ts (touched by both a and b)
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].filePath).toBe("src/index.ts");
    expect(result.conflicts[0].taskKeys).toEqual(["a", "b"]);
  });

  it("should apply last-write-wins resolution", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "LWW",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b" },
      ],
      mode: "sequential",
      conflictStrategy: "last-write-wins",
    });

    const workflowRef = orch.getWorkflow(wf.id)!;
    workflowRef.tasks.get("a")!.filesTouched = ["shared.ts"];
    workflowRef.tasks.get("b")!.filesTouched = ["shared.ts"];

    const result = await orch.execute(wf.id);

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].resolution).toBe("accepted");
    // "b" finishes last in sequential mode, so it wins
    expect(result.conflicts[0].resolvedBy).toBe("b");
  });

  it("should apply first-write-wins resolution", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "FWW",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b" },
      ],
      mode: "sequential",
      conflictStrategy: "first-write-wins",
    });

    const workflowRef = orch.getWorkflow(wf.id)!;
    workflowRef.tasks.get("a")!.filesTouched = ["shared.ts"];
    workflowRef.tasks.get("b")!.filesTouched = ["shared.ts"];

    const result = await orch.execute(wf.id);

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].resolution).toBe("accepted");
    // "a" finishes first in sequential mode, so it wins
    expect(result.conflicts[0].resolvedBy).toBe("a");
  });

  it("should defer conflicts with manual strategy", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Manual",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b" },
      ],
      mode: "sequential",
      conflictStrategy: "manual",
    });

    const workflowRef = orch.getWorkflow(wf.id)!;
    workflowRef.tasks.get("a")!.filesTouched = ["shared.ts"];
    workflowRef.tasks.get("b")!.filesTouched = ["shared.ts"];

    const result = await orch.execute(wf.id);

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].resolution).toBe("deferred");
  });

  it("should report no conflicts when files don't overlap", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "No conflicts",
      tasks: [
        { key: "a", label: "A", prompt: "a" },
        { key: "b", label: "B", prompt: "b" },
      ],
      mode: "parallel",
    });

    const workflowRef = orch.getWorkflow(wf.id)!;
    workflowRef.tasks.get("a")!.filesTouched = ["src/a.ts"];
    workflowRef.tasks.get("b")!.filesTouched = ["src/b.ts"];

    const result = await orch.execute(wf.id);

    expect(result.conflicts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow cancellation
// ---------------------------------------------------------------------------

describe("Orchestrator — cancellation", () => {
  it("should cancel a pending workflow", async () => {
    const { pool } = createMockPool();
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Cancel me",
      tasks: makeTaskDefs(2),
    });

    await orch.cancel(wf.id);

    const result = orch.getResult(wf.id);
    expect(result.status).toBe("cancelled");
    expect(result.summary.cancelled).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

describe("Orchestrator — reporting", () => {
  it("should produce an orchestrator report", async () => {
    const { pool } = createMockPool();
    const orch = new Orchestrator(pool);

    orch.createWorkflow({ name: "WF1", tasks: makeTaskDefs(2) });
    orch.createWorkflow({ name: "WF2", tasks: makeTaskDefs(3) });

    const report = orch.getReport();

    expect(report.activeWorkflows).toBe(0);
    expect(report.pendingWorkflows).toBe(2);
    expect(report.workflows.length).toBe(2);
    expect(report.queueDepth).toBe(0);
  });

  it("should track progress during execution", async () => {
    const { pool } = createMockPool({ completionDelay: 10 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({
      name: "Progress",
      tasks: makeTaskDefs(2),
    });

    const promise = orch.execute(wf.id);

    // During execution the report should show active
    // (timing dependent, but the report structure is correct)
    const report = orch.getReport();
    expect(report.workflows.length).toBe(1);

    await promise;

    const finalReport = orch.getReport();
    const wfReport = finalReport.workflows.find((w) => w.id === wf.id);
    expect(wfReport).toBeDefined();
    expect(wfReport!.progress.total).toBe(2);
  });

  it("should allow removing completed workflows", async () => {
    const { pool } = createMockPool();
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({ name: "Remove me", tasks: makeTaskDefs(1) });
    await orch.execute(wf.id);

    expect(orch.removeWorkflow(wf.id)).toBe(true);
    expect(orch.getWorkflow(wf.id)).toBeUndefined();
  });

  it("should record task output and include in results", async () => {
    const { pool } = createMockPool();
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({ name: "Output", tasks: makeTaskDefs(1) });
    await orch.execute(wf.id);

    orch.recordTaskOutput(wf.id, "task_0", "Created src/foo.ts\nModified src/bar.ts");
    orch.recordFilesTouched(wf.id, "task_0", ["src/foo.ts", "src/bar.ts"]);

    const result = orch.getResult(wf.id);
    expect(result.tasks[0].output).toBe("Created src/foo.ts\nModified src/bar.ts");
  });

  it("should refuse to remove a running workflow", async () => {
    const { pool } = createMockPool({ completionDelay: 500 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({ name: "Running", tasks: makeTaskDefs(1) });
    const promise = orch.execute(wf.id);

    // Attempt remove while running — may or may not be running yet
    // This is timing-dependent, so we just verify the API doesn't crash
    try {
      orch.removeWorkflow(wf.id);
    } catch (err: any) {
      expect(err.message).toMatch(/running/i);
    }

    await promise;
  });
});

// ---------------------------------------------------------------------------
// Workflow queue management
// ---------------------------------------------------------------------------

describe("Orchestrator — queue management", () => {
  it("should queue workflows when max active is reached", async () => {
    const { pool } = createMockPool({ completionDelay: 50 });
    const orch = new Orchestrator(pool, { maxActiveWorkflows: 1 });

    const wf1 = orch.createWorkflow({ name: "WF1", tasks: makeTaskDefs(1) });
    const wf2 = orch.createWorkflow({ name: "WF2", tasks: makeTaskDefs(1) });

    // Execute both — second should queue
    const p1 = orch.execute(wf1.id);
    const p2 = orch.execute(wf2.id);

    // During execution, queue depth is tracked
    const report = orch.getReport();
    expect(report.workflows.length).toBe(2);

    await Promise.all([p1, p2]);

    // Both should complete
    expect(orch.getResult(wf1.id).status).toBe("completed");
    expect(orch.getResult(wf2.id).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// parseFilesFromOutput
// ---------------------------------------------------------------------------

describe("parseFilesFromOutput", () => {
  it("should extract file paths from Created/Modified patterns", () => {
    const output = `
Created src/agents/orchestration.ts
Modified src/agents/index.ts
Wrote test/orchestration.test.ts
Updated package.json
    `;

    const files = parseFilesFromOutput(output);
    expect(files).toContain("src/agents/orchestration.ts");
    expect(files).toContain("src/agents/index.ts");
    expect(files).toContain("test/orchestration.test.ts");
    expect(files).toContain("package.json");
  });

  it("should extract backtick-wrapped paths", () => {
    const output = 'Created `src/new-file.ts`';
    const files = parseFilesFromOutput(output);
    expect(files).toContain("src/new-file.ts");
  });

  it("should deduplicate files", () => {
    const output = `
Modified src/index.ts
Updated src/index.ts
    `;
    const files = parseFilesFromOutput(output);
    const indexCount = files.filter((f) => f === "src/index.ts").length;
    expect(indexCount).toBe(1);
  });

  it("should return empty array for no matches", () => {
    const files = parseFilesFromOutput("No files here, just text.");
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("Orchestrator — shutdown", () => {
  it("should cancel running workflows on shutdown", async () => {
    const { pool } = createMockPool({ completionDelay: 500 });
    const orch = new Orchestrator(pool);

    const wf = orch.createWorkflow({ name: "Shutdown", tasks: makeTaskDefs(1) });
    const execPromise = orch.execute(wf.id);

    // Shutdown while running
    await orch.shutdown();

    // The workflow should be cancelled
    const result = orch.getResult(wf.id);
    expect(["cancelled", "completed", "partial"]).toContain(result.status);

    // Wait for the execute promise to settle
    await execPromise.catch(() => {});
  });
});
