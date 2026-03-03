/**
 * Integration tests: Queue store + Board provider.
 *
 * Validates task lifecycle, CRUD operations, exchanges (comments),
 * identifier generation, archival, and the BoardProvider interface.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { QueueStore } from "../src/queue/store.js";
import { QueueBoardProvider } from "../src/queue/provider.js";
import { QUEUE_STATES, stateDisplayName, type QueueTaskState } from "../src/queue/types.js";
import { setBoardProvider, getBoardProvider, isBoardAvailable } from "../src/board/provider.js";
import { createTempDir, writeJsonlFile } from "./helpers.js";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// QueueStore CRUD
// ---------------------------------------------------------------------------

describe("QueueStore CRUD operations", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;
  let store: QueueStore;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-queue-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
    store = new QueueStore(brainDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should create a task with auto-incremented identifier", async () => {
    const task = await store.create({ title: "First task" });
    expect(task.id).toBeTruthy();
    expect(task.identifier).toBe("DASH-1");
    expect(task.title).toBe("First task");
    expect(task.state).toBe("todo");
    expect(task.priority).toBe(0);
    expect(task.status).toBe("active");
    expect(task.exchanges).toEqual([]);

    const task2 = await store.create({ title: "Second task" });
    expect(task2.identifier).toBe("DASH-2");
  });

  it("should list active tasks sorted by priority then date", async () => {
    await store.create({ title: "Low priority", priority: 4 });
    await store.create({ title: "High priority", priority: 1 });
    await store.create({ title: "Medium priority", priority: 3 });

    const tasks = await store.list();
    expect(tasks.length).toBe(3);
    expect(tasks[0].title).toBe("High priority");
    expect(tasks[1].title).toBe("Medium priority");
    expect(tasks[2].title).toBe("Low priority");
  });

  it("should get task by id", async () => {
    const created = await store.create({ title: "Findable" });
    const found = await store.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Findable");
  });

  it("should get task by human-readable identifier", async () => {
    await store.create({ title: "Task A" });
    await store.create({ title: "Task B" });

    const found = await store.getByIdentifier("DASH-2");
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Task B");
  });

  it("should return null for nonexistent task", async () => {
    const found = await store.get("nonexistent");
    expect(found).toBeNull();
  });

  it("should update a task", async () => {
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
    expect(updated!.updatedAt).not.toBe(task.updatedAt);
  });

  it("should archive a task (soft delete)", async () => {
    const task = await store.create({ title: "To archive" });
    const result = await store.archive(task.id);
    expect(result).toBe(true);

    // Should not appear in list
    const tasks = await store.list();
    expect(tasks.length).toBe(0);

    // Should not be retrievable by id
    const found = await store.get(task.id);
    expect(found).toBeNull();
  });

  it("should return false when archiving nonexistent task", async () => {
    const result = await store.archive("nonexistent");
    expect(result).toBe(false);
  });

  it("should not update archived tasks", async () => {
    const task = await store.create({ title: "Archived" });
    await store.archive(task.id);
    const updated = await store.update(task.id, { title: "Changed" });
    expect(updated).toBeNull();
  });

  it("should count active tasks", async () => {
    await store.create({ title: "One" });
    await store.create({ title: "Two" });
    const threeTask = await store.create({ title: "Three" });
    await store.archive(threeTask.id);

    const count = await store.count();
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Queue exchanges (comments/interactions)
// ---------------------------------------------------------------------------

describe("QueueStore exchanges", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;
  let store: QueueStore;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-exchange-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
    store = new QueueStore(brainDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should add an exchange to a task", async () => {
    const task = await store.create({ title: "Exchangeable" });
    const exchange = await store.addExchange(task.id, {
      author: "Dash",
      body: "Working on this now",
      source: "chat",
    });

    expect(exchange).not.toBeNull();
    expect(exchange!.id).toBeTruthy();
    expect(exchange!.author).toBe("Dash");
    expect(exchange!.source).toBe("chat");
    expect(exchange!.timestamp).toBeTruthy();
  });

  it("should accumulate multiple exchanges", async () => {
    const task = await store.create({ title: "Discussion" });

    await store.addExchange(task.id, { author: "User", body: "Can you do this?", source: "chat" });
    await store.addExchange(task.id, { author: "Dash", body: "On it!", source: "chat" });
    await store.addExchange(task.id, { author: "Sarah", body: "Looks good", source: "external" });

    const exchanges = await store.getExchanges(task.id);
    expect(exchanges.length).toBe(3);
    expect(exchanges[0].author).toBe("User");
    expect(exchanges[2].source).toBe("external");
  });

  it("should not add exchange to archived task", async () => {
    const task = await store.create({ title: "Archived" });
    await store.archive(task.id);

    const exchange = await store.addExchange(task.id, {
      author: "Test",
      body: "Should fail",
      source: "manual",
    });

    expect(exchange).toBeNull();
  });

  it("should track exchange sources correctly", async () => {
    const task = await store.create({ title: "Multi-source" });

    await store.addExchange(task.id, { author: "Dash", body: "From chat", source: "chat" });
    await store.addExchange(task.id, { author: "LinearBot", body: "Synced", source: "linear" });
    await store.addExchange(task.id, { author: "Admin", body: "Manual note", source: "manual" });
    await store.addExchange(task.id, { author: "Client", body: "External", source: "external" });

    const exchanges = await store.getExchanges(task.id);
    const sources = exchanges.map((e) => e.source);
    expect(sources).toEqual(["chat", "linear", "manual", "external"]);
  });
});

// ---------------------------------------------------------------------------
// Queue task state lifecycle
// ---------------------------------------------------------------------------

describe("Queue task state lifecycle", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;
  let store: QueueStore;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-lifecycle-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
    store = new QueueStore(brainDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should transition through full workflow lifecycle", async () => {
    const task = await store.create({ title: "Full lifecycle", state: "icebox" });
    expect(task.state).toBe("icebox");

    // Icebox → Triage → Backlog → Todo → In Progress → Done
    const states: QueueTaskState[] = ["triage", "backlog", "todo", "in_progress", "done"];
    let current = task;

    for (const nextState of states) {
      const updated = await store.update(current.id, { state: nextState });
      expect(updated!.state).toBe(nextState);
      current = updated!;
    }

    expect(current.state).toBe("done");
  });

  it("should allow cancellation from any state", async () => {
    const task = await store.create({ title: "Cancel me", state: "in_progress" });
    const cancelled = await store.update(task.id, { state: "cancelled" });
    expect(cancelled!.state).toBe("cancelled");
  });

  it("should track updatedAt on each state change", async () => {
    const task = await store.create({ title: "Timestamped" });
    const firstUpdatedAt = task.updatedAt;

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const updated = await store.update(task.id, { state: "in_progress" });
    expect(updated!.updatedAt).not.toBe(firstUpdatedAt);
  });
});

// ---------------------------------------------------------------------------
// Linear sync metadata
// ---------------------------------------------------------------------------

describe("Queue Linear sync metadata", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;
  let store: QueueStore;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-sync-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
    store = new QueueStore(brainDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should track unsynced local tasks", async () => {
    await store.create({ title: "Local only" });
    await store.create({
      title: "Already synced",
      linearId: "lin_123",
      linearIdentifier: "PROJ-1",
    });

    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced.length).toBeGreaterThanOrEqual(1);
    expect(unsynced.some((t) => t.title === "Local only")).toBe(true);
  });

  it("should find task by Linear ID", async () => {
    await store.create({
      title: "Synced task",
      linearId: "lin_abc",
      linearIdentifier: "PROJ-5",
    });

    const found = await store.getTaskByLinearId("lin_abc");
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Synced task");
  });

  it("should create task with Linear origin metadata", async () => {
    const task = await store.create({
      title: "From Linear",
      linearId: "lin_xyz",
      linearIdentifier: "PROJ-10",
      syncOrigin: "linear",
    });

    expect(task.syncOrigin).toBe("linear");
    expect(task.linearId).toBe("lin_xyz");
    expect(task.linearIdentifier).toBe("PROJ-10");
  });

  it("should detect tasks modified after last sync", async () => {
    const task = await store.create({
      title: "Outdated sync",
      linearId: "lin_old",
    });

    // Update the task (updatedAt changes, no linearSyncedAt)
    await store.update(task.id, { title: "Modified" });

    const unsynced = await store.getUnsyncedTasks();
    expect(unsynced.some((t) => t.id === task.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

describe("Queue JSONL persistence", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-jsonl-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should persist and reload tasks across store instances", async () => {
    // Write with first instance
    const store1 = new QueueStore(brainDir);
    await store1.create({ title: "Persistent task" });
    await store1.create({ title: "Another task" });

    // Read with second instance
    const store2 = new QueueStore(brainDir);
    const tasks = await store2.list();
    expect(tasks.length).toBe(2);
    expect(tasks.some((t) => t.title === "Persistent task")).toBe(true);
  });

  it("should handle append-only updates (last occurrence wins)", async () => {
    const store1 = new QueueStore(brainDir);
    const task = await store1.create({ title: "Original" });
    await store1.update(task.id, { title: "Revised" });

    // The file should have both entries, but reload picks the last
    const store2 = new QueueStore(brainDir);
    const loaded = await store2.get(task.id);
    expect(loaded!.title).toBe("Revised");
  });

  it("should continue identifier numbering after reload", async () => {
    const store1 = new QueueStore(brainDir);
    await store1.create({ title: "Task 1" }); // DASH-1
    await store1.create({ title: "Task 2" }); // DASH-2

    const store2 = new QueueStore(brainDir);
    const task3 = await store2.create({ title: "Task 3" });
    expect(task3.identifier).toBe("DASH-3");
  });

  it("should load pre-existing JSONL data", async () => {
    const opsDir = join(brainDir, "operations");
    await writeJsonlFile(join(opsDir, "queue.jsonl"), "queue", [
      {
        id: "pre_1",
        identifier: "DASH-5",
        title: "Pre-existing",
        description: "",
        state: "todo",
        priority: 0,
        assignee: null,
        exchanges: [],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        status: "active",
        syncOrigin: "local",
      },
    ]);

    const store = new QueueStore(brainDir);
    const tasks = await store.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Pre-existing");

    // Should continue from DASH-6
    const next = await store.create({ title: "Next" });
    expect(next.identifier).toBe("DASH-6");
  });
});

// ---------------------------------------------------------------------------
// QueueBoardProvider (BoardProvider interface)
// ---------------------------------------------------------------------------

describe("QueueBoardProvider", () => {
  let brainDir: string;
  let cleanup: () => Promise<void>;
  let provider: QueueBoardProvider;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-board-");
    brainDir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(brainDir, "operations"), { recursive: true });
    provider = new QueueBoardProvider(brainDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should always be available", () => {
    expect(provider.isAvailable()).toBe(true);
    expect(provider.name).toBe("Dash Queue");
  });

  it("should return Dash as the team", async () => {
    const teams = await provider.getTeams();
    expect(teams).not.toBeNull();
    expect(teams!.length).toBe(1);
    expect(teams![0].key).toBe("DASH");
  });

  it("should return queue workflow states", async () => {
    const states = await provider.getTeamStates("DASH");
    expect(states).not.toBeNull();
    expect(states!.length).toBe(QUEUE_STATES.length);
    expect(states!.map((s) => s.type)).toContain("completed");
  });

  it("should create and list issues via board interface", async () => {
    const issue = await provider.createIssue("Board task", {
      description: "Test description",
      priority: 2,
    });

    expect(issue).not.toBeNull();
    expect(issue!.identifier).toBe("DASH-1");
    expect(issue!.title).toBe("Board task");
    expect(issue!.priority).toBe(2);

    const issues = await provider.listIssues();
    expect(issues).not.toBeNull();
    expect(issues!.length).toBe(1);
  });

  it("should find issue by identifier", async () => {
    await provider.createIssue("Find me");
    const found = await provider.findByIdentifier("DASH-1");
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Find me");
  });

  it("should update issue via board interface", async () => {
    const issue = await provider.createIssue("Updatable");
    const updated = await provider.updateIssue(issue!.id, {
      title: "Updated via board",
      stateId: "done",
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated via board");
    expect(updated!.state).toBe("Done");
  });

  it("should add comment via board interface", async () => {
    const issue = await provider.createIssue("Commentable");
    const result = await provider.addComment(issue!.id, "Test comment");
    expect(result).toBe(true);
  });

  it("should get done state ID", async () => {
    const doneId = await provider.getDoneStateId("DASH");
    expect(doneId).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Board provider registry
// ---------------------------------------------------------------------------

describe("Board provider registry", () => {
  it("should register and retrieve provider", async () => {
    const tmp = await createTempDir("dash-registry-");
    await mkdir(join(tmp.dir, "operations"), { recursive: true });

    const provider = new QueueBoardProvider(tmp.dir);
    setBoardProvider(provider);

    expect(getBoardProvider()).toBe(provider);
    expect(isBoardAvailable()).toBe(true);

    await tmp.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Queue state display names
// ---------------------------------------------------------------------------

describe("Queue state utilities", () => {
  it("should return display names for all states", () => {
    expect(stateDisplayName("icebox")).toBe("Icebox");
    expect(stateDisplayName("triage")).toBe("Triage");
    expect(stateDisplayName("backlog")).toBe("Backlog");
    expect(stateDisplayName("todo")).toBe("Todo");
    expect(stateDisplayName("in_progress")).toBe("In Progress");
    expect(stateDisplayName("done")).toBe("Done");
    expect(stateDisplayName("cancelled")).toBe("Cancelled");
  });

  it("should return raw state for unknown states", () => {
    expect(stateDisplayName("unknown" as QueueTaskState)).toBe("unknown");
  });
});
