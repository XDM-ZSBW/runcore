/**
 * Unit tests for QueueStore (src/queue/store.ts).
 *
 * Covers CRUD operations, JSONL persistence, identifier sequencing,
 * exchanges, archival, sync detection, and compaction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QueueStore } from "../../src/queue/store.js";
import { createTestBrainDir } from "../../test/helpers.js";

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

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("QueueStore — create", () => {
  it("creates a task with defaults", async () => {
    const task = await store.create({ title: "Test task" });

    expect(task.id).toMatch(/^q_/);
    expect(task.identifier).toBe("DASH-1");
    expect(task.title).toBe("Test task");
    expect(task.description).toBe("");
    expect(task.state).toBe("todo");
    expect(task.priority).toBe(0);
    expect(task.assignee).toBeNull();
    expect(task.exchanges).toEqual([]);
    expect(task.status).toBe("active");
    expect(task.syncOrigin).toBe("local");
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBe(task.createdAt);
  });

  it("auto-increments DASH-N identifiers", async () => {
    const t1 = await store.create({ title: "A" });
    const t2 = await store.create({ title: "B" });
    const t3 = await store.create({ title: "C" });

    expect(t1.identifier).toBe("DASH-1");
    expect(t2.identifier).toBe("DASH-2");
    expect(t3.identifier).toBe("DASH-3");
  });

  it("passes through Linear sync metadata", async () => {
    const task = await store.create({
      title: "From Linear",
      linearId: "lin_issue_abc",
      linearIdentifier: "ENG-42",
      linearSyncedAt: "2025-01-01T00:00:00Z",
      syncOrigin: "linear",
    });

    expect(task.linearId).toBe("lin_issue_abc");
    expect(task.linearIdentifier).toBe("ENG-42");
    expect(task.linearSyncedAt).toBe("2025-01-01T00:00:00Z");
    expect(task.syncOrigin).toBe("linear");
  });
});

// ---------------------------------------------------------------------------
// Get / List
// ---------------------------------------------------------------------------

describe("QueueStore — get / list", () => {
  it("retrieves by internal id", async () => {
    const created = await store.create({ title: "Findable" });
    const found = await store.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Findable");
  });

  it("retrieves by human-readable identifier", async () => {
    await store.create({ title: "First" });
    const second = await store.create({ title: "Second" });

    const found = await store.getByIdentifier("DASH-2");
    expect(found!.id).toBe(second.id);
  });

  it("retrieves by Linear id", async () => {
    const task = await store.create({ title: "Synced", linearId: "lin_xyz" });
    const found = await store.getTaskByLinearId("lin_xyz");
    expect(found!.id).toBe(task.id);
  });

  it("returns null for missing ids", async () => {
    expect(await store.get("nonexistent")).toBeNull();
    expect(await store.getByIdentifier("DASH-999")).toBeNull();
    expect(await store.getTaskByLinearId("lin_missing")).toBeNull();
  });

  it("lists tasks sorted by priority then createdAt", async () => {
    await store.create({ title: "Low priority", priority: 4 });
    await store.create({ title: "High priority", priority: 1 });
    await store.create({ title: "No priority", priority: 0 });

    const tasks = await store.list();
    const titles = tasks.map((t) => t.title);
    expect(titles).toEqual(["No priority", "High priority", "Low priority"]);
  });

  it("excludes archived tasks from all lookups", async () => {
    const task = await store.create({ title: "To archive" });
    await store.archive(task.id);

    expect(await store.get(task.id)).toBeNull();
    expect(await store.getByIdentifier(task.identifier)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("QueueStore — update", () => {
  it("updates multiple fields at once", async () => {
    const task = await store.create({ title: "Original" });
    const updated = await store.update(task.id, {
      title: "Renamed",
      state: "in_progress",
      priority: 1,
      assignee: "dash",
    });

    expect(updated!.title).toBe("Renamed");
    expect(updated!.state).toBe("in_progress");
    expect(updated!.priority).toBe(1);
    expect(updated!.assignee).toBe("dash");
  });

  it("refreshes updatedAt on meaningful change", async () => {
    const task = await store.create({ title: "Original" });
    const originalUpdatedAt = task.updatedAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(task.id, { title: "Changed" });

    expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("skips file append when no meaningful fields changed", async () => {
    const task = await store.create({ title: "Stable" });
    await store.update(task.id, { title: "Stable" }); // no-op

    const filePath = join(brainDir, "operations", "queue.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // schema + create = 2 lines, no extra append
    expect(lines).toHaveLength(2);
  });

  it("returns null for nonexistent or archived tasks", async () => {
    expect(await store.update("no_id", { title: "Nope" })).toBeNull();

    const task = await store.create({ title: "Soon archived" });
    await store.archive(task.id);
    expect(await store.update(task.id, { title: "Too late" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

describe("QueueStore — archive", () => {
  it("soft-deletes a task", async () => {
    const task = await store.create({ title: "Delete me" });
    expect(await store.archive(task.id)).toBe(true);
    expect(await store.get(task.id)).toBeNull();
  });

  it("returns false for nonexistent task", async () => {
    expect(await store.archive("ghost")).toBe(false);
  });

  it("persists archival to JSONL", async () => {
    const task = await store.create({ title: "Archived" });
    await store.archive(task.id);

    const filePath = join(brainDir, "operations", "queue.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Exchanges
// ---------------------------------------------------------------------------

describe("QueueStore — exchanges", () => {
  it("adds and retrieves exchanges", async () => {
    const task = await store.create({ title: "Discussion" });

    await store.addExchange(task.id, { author: "user", body: "What's the status?", source: "chat" });
    await store.addExchange(task.id, { author: "dash", body: "Working on it.", source: "chat" });

    const exchanges = await store.getExchanges(task.id);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].id).toMatch(/^ex_/);
    expect(exchanges[0].author).toBe("user");
    expect(exchanges[1].author).toBe("dash");
    expect(exchanges[0].timestamp).toBeTruthy();
  });

  it("returns null when adding to archived task", async () => {
    const task = await store.create({ title: "Closed" });
    await store.archive(task.id);
    expect(await store.addExchange(task.id, { author: "x", body: "y", source: "chat" })).toBeNull();
  });

  it("returns empty array for task with no exchanges", async () => {
    const task = await store.create({ title: "Silent" });
    expect(await store.getExchanges(task.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unsynced detection
// ---------------------------------------------------------------------------

describe("QueueStore — unsynced tasks", () => {
  it("flags local tasks without linearId as unsynced", async () => {
    await store.create({ title: "Local only", syncOrigin: "local" });
    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced).toHaveLength(1);
  });

  it("does NOT flag linear-origin tasks without linearSyncedAt", async () => {
    await store.create({ title: "From Linear", syncOrigin: "linear" });
    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced).toHaveLength(0);
  });

  it("flags tasks updated after last sync", async () => {
    const task = await store.create({
      title: "Synced",
      linearId: "lin_1",
      syncOrigin: "local",
    });
    await store.update(task.id, {
      linearSyncedAt: new Date(Date.now() - 5000).toISOString(),
    });
    // Now update something meaningful after sync
    await store.update(task.id, { title: "Updated after sync" });

    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced.some((t) => t.id === task.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

describe("QueueStore — count", () => {
  it("counts only active tasks", async () => {
    await store.create({ title: "A" });
    await store.create({ title: "B" });
    const c = await store.create({ title: "C" });
    await store.archive(c.id);

    expect(await store.count()).toBe(2);
  });

  it("returns 0 for empty store", async () => {
    expect(await store.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe("QueueStore — compact", () => {
  it("reduces JSONL file to latest versions only", async () => {
    const task = await store.create({ title: "V1" });
    await store.update(task.id, { title: "V2" });
    await store.update(task.id, { title: "V3" });

    const beforeLines = await store.lineCount();
    expect(beforeLines).toBeGreaterThan(2);

    await store.compact();

    const afterLines = await store.lineCount();
    expect(afterLines).toBeLessThanOrEqual(beforeLines);

    // Data integrity preserved
    const found = await store.get(task.id);
    expect(found!.title).toBe("V3");
  });
});

// ---------------------------------------------------------------------------
// Persistence across instances
// ---------------------------------------------------------------------------

describe("QueueStore — persistence", () => {
  it("new instance reads existing data from disk", async () => {
    await store.create({ title: "Persisted task" });

    const store2 = new QueueStore(brainDir);
    const tasks = await store2.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Persisted task");
  });

  it("resumes identifier numbering from file", async () => {
    await store.create({ title: "One" });
    await store.create({ title: "Two" });

    const store2 = new QueueStore(brainDir);
    const t3 = await store2.create({ title: "Three" });
    expect(t3.identifier).toBe("DASH-3");
  });

  it("handles multiple updates then reload", async () => {
    const task = await store.create({ title: "Original" });
    await store.update(task.id, { title: "Updated", state: "in_progress" });
    await store.addExchange(task.id, { author: "dash", body: "On it", source: "chat" });

    const store2 = new QueueStore(brainDir);
    const loaded = await store2.get(task.id);
    expect(loaded!.title).toBe("Updated");
    expect(loaded!.state).toBe("in_progress");
    expect(loaded!.exchanges).toHaveLength(1);
  });
});
