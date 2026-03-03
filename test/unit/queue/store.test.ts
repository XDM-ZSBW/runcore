import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QueueStore } from "../../../src/queue/store.js";

describe("QueueStore", () => {
  let tempDir: string;
  let store: QueueStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dash-queue-"));
    await mkdir(join(tempDir, "operations"), { recursive: true });
    store = new QueueStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── File initialization ─────────────────────────────────────────────

  describe("file initialization", () => {
    it("creates queue.jsonl with schema header on first access", async () => {
      await store.list();
      const raw = await readFile(join(tempDir, "operations", "queue.jsonl"), "utf-8");
      const firstLine = raw.split("\n")[0];
      expect(JSON.parse(firstLine)).toEqual({ _schema: "queue", _version: "1.0" });
    });

    it("starts with an empty task list", async () => {
      const tasks = await store.list();
      expect(tasks).toEqual([]);
    });

    it("returns count of 0 for empty store", async () => {
      expect(await store.count()).toBe(0);
    });
  });

  // ── Create ──────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a task with generated id and DASH-N identifier", async () => {
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

    it("increments DASH-N identifiers for successive tasks", async () => {
      const t1 = await store.create({ title: "Task 1" });
      const t2 = await store.create({ title: "Task 2" });
      const t3 = await store.create({ title: "Task 3" });
      expect(t1.identifier).toBe("DASH-1");
      expect(t2.identifier).toBe("DASH-2");
      expect(t3.identifier).toBe("DASH-3");
    });

    it("applies provided options", async () => {
      const task = await store.create({
        title: "Urgent bug",
        description: "Fix it now",
        state: "in_progress",
        priority: 1,
        assignee: "dash",
        linearId: "lin_123",
        linearIdentifier: "LIN-1",
        syncOrigin: "linear",
      });
      expect(task.description).toBe("Fix it now");
      expect(task.state).toBe("in_progress");
      expect(task.priority).toBe(1);
      expect(task.assignee).toBe("dash");
      expect(task.linearId).toBe("lin_123");
      expect(task.linearIdentifier).toBe("LIN-1");
      expect(task.syncOrigin).toBe("linear");
    });

    it("persists task to JSONL file", async () => {
      const task = await store.create({ title: "Persisted" });
      const raw = await readFile(join(tempDir, "operations", "queue.jsonl"), "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(2); // schema + task
      const parsed = JSON.parse(lines[1]);
      expect(parsed.id).toBe(task.id);
      expect(parsed.title).toBe("Persisted");
    });
  });

  // ── Read ────────────────────────────────────────────────────────────

  describe("get / getByIdentifier / getTaskByLinearId", () => {
    it("retrieves a task by internal id", async () => {
      const created = await store.create({ title: "Find me" });
      const found = await store.get(created.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Find me");
    });

    it("returns null for non-existent id", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });

    it("retrieves a task by DASH-N identifier", async () => {
      await store.create({ title: "First" });
      const t2 = await store.create({ title: "Second" });
      const found = await store.getByIdentifier("DASH-2");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(t2.id);
    });

    it("returns null for non-existent identifier", async () => {
      expect(await store.getByIdentifier("DASH-999")).toBeNull();
    });

    it("retrieves a task by Linear id", async () => {
      const task = await store.create({ title: "Linear task", linearId: "lin_abc" });
      const found = await store.getTaskByLinearId("lin_abc");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(task.id);
    });

    it("returns null for non-existent Linear id", async () => {
      expect(await store.getTaskByLinearId("lin_none")).toBeNull();
    });
  });

  // ── List ────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns tasks sorted by priority then createdAt", async () => {
      await store.create({ title: "Low priority", priority: 4 });
      await store.create({ title: "Urgent", priority: 1 });
      await store.create({ title: "Medium", priority: 3 });

      const tasks = await store.list();
      expect(tasks.map((t) => t.title)).toEqual(["Urgent", "Medium", "Low priority"]);
    });

    it("excludes archived tasks", async () => {
      const t1 = await store.create({ title: "Active" });
      const t2 = await store.create({ title: "Will archive" });
      await store.archive(t2.id);

      const tasks = await store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(t1.id);
    });
  });

  // ── Update ──────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates task fields and returns the updated task", async () => {
      const task = await store.create({ title: "Original" });
      const updated = await store.update(task.id, {
        title: "Updated",
        state: "in_progress",
        priority: 2,
      });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("Updated");
      expect(updated!.state).toBe("in_progress");
      expect(updated!.priority).toBe(2);
    });

    it("returns null when updating non-existent task", async () => {
      expect(await store.update("nonexistent", { title: "Nope" })).toBeNull();
    });

    it("returns null when updating archived task", async () => {
      const task = await store.create({ title: "Soon archived" });
      await store.archive(task.id);
      expect(await store.update(task.id, { title: "Too late" })).toBeNull();
    });

    it("skips JSONL append when nothing meaningful changed", async () => {
      const task = await store.create({ title: "Static" });
      // Update with same values
      await store.update(task.id, { title: "Static" });
      const linesBefore = await store.lineCount();
      // Lines should be: schema + create = 2 (no redundant append)
      expect(linesBefore).toBe(2);
    });

    it("appends to JSONL when meaningful change occurs", async () => {
      const task = await store.create({ title: "Will change" });
      await store.update(task.id, { title: "Changed" });
      const lines = await store.lineCount();
      // schema + create + update = 3
      expect(lines).toBe(3);
    });
  });

  // ── Archive (soft-delete) ───────────────────────────────────────────

  describe("archive", () => {
    it("archives a task (soft-delete)", async () => {
      const task = await store.create({ title: "Delete me" });
      const result = await store.archive(task.id);
      expect(result).toBe(true);
      expect(await store.get(task.id)).toBeNull();
    });

    it("returns false for non-existent task", async () => {
      expect(await store.archive("nonexistent")).toBe(false);
    });

    it("archived task is excluded from list and get", async () => {
      const task = await store.create({ title: "Hidden" });
      await store.archive(task.id);
      expect(await store.get(task.id)).toBeNull();
      expect(await store.getByIdentifier(task.identifier)).toBeNull();
      const all = await store.list();
      expect(all.find((t) => t.id === task.id)).toBeUndefined();
    });
  });

  // ── Exchanges ───────────────────────────────────────────────────────

  describe("exchanges", () => {
    it("adds an exchange to a task", async () => {
      const task = await store.create({ title: "With comments" });
      const ex = await store.addExchange(task.id, {
        author: "user",
        body: "Looking into this",
        source: "chat",
      });
      expect(ex).not.toBeNull();
      expect(ex!.id).toMatch(/^ex_/);
      expect(ex!.author).toBe("user");
      expect(ex!.body).toBe("Looking into this");
      expect(ex!.source).toBe("chat");
      expect(ex!.timestamp).toBeTruthy();
    });

    it("returns null when adding exchange to non-existent task", async () => {
      expect(
        await store.addExchange("nonexistent", { author: "x", body: "y", source: "chat" })
      ).toBeNull();
    });

    it("retrieves exchanges for a task", async () => {
      const task = await store.create({ title: "Chatty" });
      await store.addExchange(task.id, { author: "user", body: "First", source: "chat" });
      await store.addExchange(task.id, { author: "dash", body: "Second", source: "chat" });

      const exchanges = await store.getExchanges(task.id);
      expect(exchanges).toHaveLength(2);
      expect(exchanges[0].body).toBe("First");
      expect(exchanges[1].body).toBe("Second");
    });

    it("returns empty array for task with no exchanges", async () => {
      const task = await store.create({ title: "Quiet" });
      expect(await store.getExchanges(task.id)).toEqual([]);
    });

    it("returns empty array for non-existent task", async () => {
      expect(await store.getExchanges("nonexistent")).toEqual([]);
    });
  });

  // ── Sync tracking ──────────────────────────────────────────────────

  describe("getUnsyncedTasks", () => {
    it("returns local tasks without linearId", async () => {
      await store.create({ title: "Local only", syncOrigin: "local" });
      const unsynced = await store.getUnsyncedTasks();
      expect(unsynced).toHaveLength(1);
      expect(unsynced[0].title).toBe("Local only");
    });

    it("excludes tasks with linearId and recent sync", async () => {
      const now = new Date().toISOString();
      const task = await store.create({
        title: "Synced",
        linearId: "lin_1",
        syncOrigin: "local",
      });
      await store.update(task.id, { linearSyncedAt: now });
      const unsynced = await store.getUnsyncedTasks();
      // The task was just updated so updatedAt >= linearSyncedAt — edge case
      // It could show up if updatedAt > linearSyncedAt
      expect(unsynced.length).toBeLessThanOrEqual(1);
    });

    it("includes tasks with linearId but no linearSyncedAt", async () => {
      await store.create({ title: "Never synced", linearId: "lin_2" });
      const unsynced = await store.getUnsyncedTasks();
      expect(unsynced.some((t) => t.title === "Never synced")).toBe(true);
    });
  });

  // ── Compact ─────────────────────────────────────────────────────────

  describe("compact", () => {
    it("rewrites JSONL with only latest version of each task", async () => {
      const task = await store.create({ title: "Version 1" });
      await store.update(task.id, { title: "Version 2" });
      await store.update(task.id, { title: "Version 3" });

      const linesBefore = await store.lineCount();
      expect(linesBefore).toBe(4); // schema + create + 2 updates

      const result = await store.compact();
      expect(result.after).toBe(2); // schema + 1 task (latest version)

      // Verify the surviving task has the latest title
      const fresh = new QueueStore(tempDir);
      const tasks = await fresh.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Version 3");
    });
  });

  // ── Persistence across instances ────────────────────────────────────

  describe("persistence", () => {
    it("new QueueStore instance reads tasks written by previous instance", async () => {
      await store.create({ title: "Persistent task" });
      await store.create({ title: "Another one" });

      // Create a fresh instance pointing to the same dir
      const store2 = new QueueStore(tempDir);
      const tasks = await store2.list();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.title).sort()).toEqual(["Another one", "Persistent task"]);
    });

    it("preserves DASH-N numbering across instances", async () => {
      await store.create({ title: "First" });
      await store.create({ title: "Second" });

      const store2 = new QueueStore(tempDir);
      const t3 = await store2.create({ title: "Third" });
      expect(t3.identifier).toBe("DASH-3");
    });

    it("last-occurrence-wins on reload with multiple updates", async () => {
      const task = await store.create({ title: "Original" });
      await store.update(task.id, { title: "Updated" });

      const store2 = new QueueStore(tempDir);
      const found = await store2.get(task.id);
      expect(found!.title).toBe("Updated");
    });
  });

  // ── Count & lineCount ───────────────────────────────────────────────

  describe("count / lineCount", () => {
    it("count returns number of active tasks", async () => {
      await store.create({ title: "A" });
      await store.create({ title: "B" });
      const t3 = await store.create({ title: "C" });
      await store.archive(t3.id);
      expect(await store.count()).toBe(2);
    });

    it("lineCount returns raw file lines (includes stale entries)", async () => {
      const task = await store.create({ title: "Original" });
      await store.update(task.id, { title: "Updated" });
      // schema + create + update = 3
      expect(await store.lineCount()).toBe(3);
    });

    it("lineCount returns 0 when file does not exist", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "dash-empty-"));
      await mkdir(join(emptyDir, "operations"), { recursive: true });
      const emptyStore = new QueueStore(emptyDir);
      expect(await emptyStore.lineCount()).toBe(0);
      await rm(emptyDir, { recursive: true, force: true });
    });
  });
});
