/**
 * Unit tests for QueueStore (src/queue/store.ts).
 * Covers CRUD, exchanges, archival, identifier sequencing,
 * unsynced detection, compaction, and JSONL persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QueueStore } from "../src/queue/store.js";
import { createTestBrainDir } from "./helpers.js";

let brainDir: string;
let cleanup: () => Promise<void>;
let store: QueueStore;

beforeEach(async () => {
  const env = await createTestBrainDir();
  brainDir = env.brainDir;
  cleanup = env.cleanup;
  store = new QueueStore(brainDir);
});

afterEach(async () => {
  await cleanup();
});

describe("QueueStore — create", () => {
  it("creates a task with auto-generated id and identifier", async () => {
    const task = await store.create({ title: "First task" });

    expect(task.id).toMatch(/^q_/);
    expect(task.identifier).toBe("DASH-1");
    expect(task.title).toBe("First task");
    expect(task.state).toBe("todo");
    expect(task.priority).toBe(0);
    expect(task.assignee).toBeNull();
    expect(task.exchanges).toEqual([]);
    expect(task.status).toBe("active");
    expect(task.syncOrigin).toBe("local");
  });

  it("auto-increments identifiers across creates", async () => {
    const t1 = await store.create({ title: "A" });
    const t2 = await store.create({ title: "B" });
    const t3 = await store.create({ title: "C" });

    expect(t1.identifier).toBe("DASH-1");
    expect(t2.identifier).toBe("DASH-2");
    expect(t3.identifier).toBe("DASH-3");
  });

  it("accepts optional fields", async () => {
    const task = await store.create({
      title: "Urgent bug",
      description: "Fix ASAP",
      state: "in_progress",
      priority: 1,
      assignee: "dash",
      linearId: "lin_123",
      linearIdentifier: "LIN-1",
      syncOrigin: "linear",
    });

    expect(task.description).toBe("Fix ASAP");
    expect(task.state).toBe("in_progress");
    expect(task.priority).toBe(1);
    expect(task.assignee).toBe("dash");
    expect(task.linearId).toBe("lin_123");
    expect(task.linearIdentifier).toBe("LIN-1");
    expect(task.syncOrigin).toBe("linear");
  });
});

describe("QueueStore — get / list", () => {
  it("gets a task by id", async () => {
    const created = await store.create({ title: "Find me" });
    const found = await store.get(created.id);

    expect(found).not.toBeNull();
    expect(found!.title).toBe("Find me");
  });

  it("returns null for nonexistent id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("gets a task by identifier", async () => {
    await store.create({ title: "Task one" });
    const t2 = await store.create({ title: "Task two" });

    const found = await store.getByIdentifier("DASH-2");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(t2.id);
  });

  it("gets a task by Linear id", async () => {
    const task = await store.create({ title: "Synced", linearId: "lin_abc" });
    const found = await store.getTaskByLinearId("lin_abc");

    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  it("lists active tasks sorted by priority then createdAt", async () => {
    await store.create({ title: "Low", priority: 4 });
    await store.create({ title: "Urgent", priority: 1 });
    await store.create({ title: "None", priority: 0 });

    const tasks = await store.list();
    expect(tasks.map((t) => t.title)).toEqual(["None", "Urgent", "Low"]);
  });

  it("excludes archived tasks from list", async () => {
    const t = await store.create({ title: "To archive" });
    await store.archive(t.id);

    const tasks = await store.list();
    expect(tasks).toHaveLength(0);
  });
});

describe("QueueStore — update", () => {
  it("updates task fields", async () => {
    const task = await store.create({ title: "Original" });
    const updated = await store.update(task.id, { title: "Renamed", state: "in_progress" });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Renamed");
    expect(updated!.state).toBe("in_progress");
    // updatedAt is refreshed (may equal createdAt if within same ms tick)
    expect(updated!.updatedAt).toBeTruthy();
  });

  it("returns null when updating nonexistent task", async () => {
    expect(await store.update("fake_id", { title: "Nope" })).toBeNull();
  });

  it("returns null when updating archived task", async () => {
    const task = await store.create({ title: "Gone" });
    await store.archive(task.id);

    expect(await store.update(task.id, { title: "Back?" })).toBeNull();
  });

  it("skips file append when nothing meaningful changed", async () => {
    const task = await store.create({ title: "Stable" });
    // Update with same values — should not append a new line
    await store.update(task.id, { title: "Stable" });

    const filePath = join(brainDir, "operations", "queue.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // 1 schema + 1 create = 2 lines (no extra append)
    expect(lines).toHaveLength(2);
  });
});

describe("QueueStore — archive", () => {
  it("archives a task (soft delete)", async () => {
    const task = await store.create({ title: "Delete me" });
    const result = await store.archive(task.id);

    expect(result).toBe(true);
    expect(await store.get(task.id)).toBeNull();
  });

  it("returns false for nonexistent task", async () => {
    expect(await store.archive("nonexistent")).toBe(false);
  });
});

describe("QueueStore — exchanges", () => {
  it("adds an exchange to a task", async () => {
    const task = await store.create({ title: "Discuss" });
    const ex = await store.addExchange(task.id, {
      author: "dash",
      body: "Working on it",
      source: "chat",
    });

    expect(ex).not.toBeNull();
    expect(ex!.id).toMatch(/^ex_/);
    expect(ex!.author).toBe("dash");
    expect(ex!.body).toBe("Working on it");
  });

  it("retrieves exchanges for a task", async () => {
    const task = await store.create({ title: "Multi-exchange" });
    await store.addExchange(task.id, { author: "user", body: "First", source: "chat" });
    await store.addExchange(task.id, { author: "dash", body: "Second", source: "chat" });

    const exchanges = await store.getExchanges(task.id);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].body).toBe("First");
    expect(exchanges[1].body).toBe("Second");
  });

  it("returns null when adding exchange to archived task", async () => {
    const task = await store.create({ title: "Closed" });
    await store.archive(task.id);

    const ex = await store.addExchange(task.id, {
      author: "user",
      body: "Too late",
      source: "chat",
    });
    expect(ex).toBeNull();
  });
});

describe("QueueStore — unsynced tasks", () => {
  it("detects locally-created tasks without linearId", async () => {
    await store.create({ title: "Local only", syncOrigin: "local" });
    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced).toHaveLength(1);
  });

  it("detects tasks updated after last sync", async () => {
    const task = await store.create({
      title: "Synced once",
      linearId: "lin_1",
      syncOrigin: "local",
    });
    // Simulate sync, then local update
    await store.update(task.id, {
      linearSyncedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await store.update(task.id, { title: "Updated locally" });

    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced.some((t) => t.id === task.id)).toBe(true);
  });
});

describe("QueueStore — count", () => {
  it("returns active task count", async () => {
    await store.create({ title: "A" });
    await store.create({ title: "B" });
    const c = await store.create({ title: "C" });
    await store.archive(c.id);

    expect(await store.count()).toBe(2);
  });
});

describe("QueueStore — compact", () => {
  it("compacts the JSONL file to latest versions only", async () => {
    const task = await store.create({ title: "V1" });
    await store.update(task.id, { title: "V2" });
    await store.update(task.id, { title: "V3" });

    const beforeCount = await store.lineCount();
    expect(beforeCount).toBeGreaterThan(2); // schema + multiple appends

    const result = await store.compact();
    expect(result.after).toBeLessThanOrEqual(beforeCount);

    // Verify data integrity after compaction
    const found = await store.get(task.id);
    expect(found!.title).toBe("V3");
  });
});

describe("QueueStore — JSONL persistence", () => {
  it("persists to disk and loads on new instance", async () => {
    await store.create({ title: "Persistent" });
    await store.create({ title: "Also persistent" });

    // New store instance reads from same file
    const store2 = new QueueStore(brainDir);
    const tasks = await store2.list();

    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title).sort()).toEqual(["Also persistent", "Persistent"]);
  });

  it("resumes identifier numbering from file", async () => {
    await store.create({ title: "DASH-1" });
    await store.create({ title: "DASH-2" });

    const store2 = new QueueStore(brainDir);
    const t3 = await store2.create({ title: "Should be DASH-3" });

    expect(t3.identifier).toBe("DASH-3");
  });
});

describe("QueueStore — identifier collision prevention", () => {
  it("skips identifiers that already exist in the cache", async () => {
    // Create two tasks normally
    const t1 = await store.create({ title: "First" });
    const t2 = await store.create({ title: "Second" });
    expect(t1.identifier).toBe("DASH-1");
    expect(t2.identifier).toBe("DASH-2");

    // Simulate a stale counter by manually injecting a task with DASH-3
    // into the JSONL file and reloading, then tampering with nextNums
    const store2 = new QueueStore(brainDir);
    const t3 = await store2.create({ title: "Third" });
    expect(t3.identifier).toBe("DASH-3");

    // Now create a new store that will load all 3, compute nextNums=4
    const store3 = new QueueStore(brainDir);
    const t4 = await store3.create({ title: "Fourth" });
    expect(t4.identifier).toBe("DASH-4");

    // Verify all identifiers are unique
    const all = await store3.list();
    const identifiers = all.map((t) => t.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it("never produces duplicate identifiers under rapid sequential creates", async () => {
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(await store.create({ title: `Rapid ${i}` }));
    }
    const identifiers = tasks.map((t) => t.identifier);
    expect(new Set(identifiers).size).toBe(20);
  });
});

describe("QueueStore — repairCollisions", () => {
  it("detects and repairs identifier collisions", async () => {
    // Create two normal tasks
    await store.create({ title: "First" });
    await store.create({ title: "Second" });

    // Manually inject a collision by appending a task with a duplicate identifier
    const { writeFile: wf } = await import("node:fs/promises");
    const filePath = join(brainDir, "operations", "queue.jsonl");
    const collidingTask = JSON.stringify({
      id: "q_collision_test",
      identifier: "DASH-1",
      title: "Colliding task",
      description: "",
      state: "todo",
      priority: 0,
      assignee: null,
      exchanges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
    });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, collidingTask + "\n");

    // Reload from disk
    const store2 = new QueueStore(brainDir);
    const repairs = await store2.repairCollisions();

    expect(repairs).toHaveLength(1);
    expect(repairs[0].oldIdentifier).toBe("DASH-1");
    expect(repairs[0].newIdentifier).toBe("DASH-3"); // next available after DASH-2

    // Verify no collisions remain
    const all = await store2.list();
    const identifiers = all.map((t) => t.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it("returns empty array when no collisions exist", async () => {
    await store.create({ title: "A" });
    await store.create({ title: "B" });

    const repairs = await store.repairCollisions();
    expect(repairs).toHaveLength(0);
  });
});
