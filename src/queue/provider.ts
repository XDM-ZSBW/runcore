/**
 * QueueBoardProvider — implements BoardProvider using the local QueueStore.
 * Always available (offline-safe). Local JSONL is the sole source of truth.
 */

import type {
  BoardProvider,
  BoardIssue,
  BoardTeam,
  BoardState,
  BoardUser,
} from "../board/types.js";
import { QueueStore, ProjectStore } from "./store.js";
import { QUEUE_STATES, stateDisplayName } from "./types.js";
import type { QueueTask, QueueTaskState } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { getInstanceName } from "../instance.js";

const log = createLogger("queue.provider");

const LOCAL_TEAM: BoardTeam = { id: "local", name: getInstanceName(), key: getInstanceName().toUpperCase() };

function taskToIssue(task: QueueTask): BoardIssue {
  return {
    id: task.id ?? "unknown",
    identifier: task.identifier ?? `${getInstanceName().toUpperCase()}-?`,
    title: task.title ?? "(untitled)",
    state: stateDisplayName(task.state),
    priority: task.priority ?? 0,
    assignee: task.assignee ?? null,
    project: task.project,
    url: "",  // local tasks have no URL
  };
}

/** Map a BoardState id (from QUEUE_STATES) to a QueueTaskState. */
function stateIdToQueueState(stateId: string): QueueTaskState | null {
  const found = QUEUE_STATES.find((s) => s.id === stateId);
  return found?.queueState ?? null;
}

export class QueueBoardProvider implements BoardProvider {
  readonly name = `${getInstanceName()} Queue`;
  private readonly store: QueueStore;
  private readonly projects: ProjectStore;
  private onProjectlessTask?: (identifier: string, title: string) => void;

  constructor(brainDir: string) {
    this.projects = new ProjectStore(brainDir);
    this.store = new QueueStore(brainDir, this.projects);
  }

  /** Register a callback for when a task is created without a project (escalation). */
  setOnProjectlessTask(fn: (identifier: string, title: string) => void): void {
    this.onProjectlessTask = fn;
  }

  /** Expose the store for exchange-aware operations beyond BoardProvider. */
  getStore(): QueueStore {
    return this.store;
  }

  /** Expose the project store for project CRUD from server routes. */
  getProjectStore(): ProjectStore {
    return this.projects;
  }

  isAvailable(): boolean {
    return true; // Always available — local file
  }

  async getMe(): Promise<BoardUser | null> {
    return { id: getInstanceName().toLowerCase(), name: getInstanceName(), email: "", displayName: getInstanceName() };
  }

  async getTeams(): Promise<BoardTeam[]> {
    return [LOCAL_TEAM];
  }

  async getTeamStates(_teamId: string): Promise<BoardState[]> {
    return QUEUE_STATES.map(({ queueState: _, ...bs }) => bs);
  }

  async listIssues(opts?: {
    teamId?: string;
    stateType?: string;
    limit?: number;
    excludeAssigned?: boolean;
    project?: string;
  }): Promise<BoardIssue[]> {
    let tasks = await this.store.list();

    if (opts?.stateType) {
      const matching = QUEUE_STATES.filter((s) => s.type === opts.stateType);
      const matchingStates = new Set(matching.map((s) => s.queueState));
      tasks = tasks.filter((t) => matchingStates.has(t.state));
    }

    // Filter by project
    if (opts?.project) {
      tasks = tasks.filter((t) => t.project === opts.project);
    }

    // Filter out tasks already assigned to an agent (prevents duplicate pickup)
    if (opts?.excludeAssigned) {
      tasks = tasks.filter((t) => !t.assignee);
    }

    if (opts?.limit) {
      tasks = tasks.slice(0, opts.limit);
    }

    log.debug("listIssues", { stateType: opts?.stateType, project: opts?.project, limit: opts?.limit, excludeAssigned: opts?.excludeAssigned, resultCount: tasks.length });
    return tasks.map(taskToIssue);
  }

  async createIssue(
    title: string,
    opts?: {
      description?: string;
      teamId?: string;
      assigneeId?: string;
      priority?: number;
      labelIds?: string[];
      project?: string;
      origin?: "chat" | "agent" | "autonomous" | "external";
      originSessionId?: string;
    },
  ): Promise<BoardIssue | null> {
    const task = await this.store.create({
      title,
      description: opts?.description,
      priority: opts?.priority,
      assignee: opts?.assigneeId ?? null,
      project: opts?.project,
      origin: opts?.origin,
      originSessionId: opts?.originSessionId,
    });
    const issue = taskToIssue(task);
    // Trigger escalation for projectless tasks
    if (!task.project && this.onProjectlessTask) {
      this.onProjectlessTask(issue.identifier, issue.title);
    }
    return issue;
  }

  async updateIssue(
    id: string,
    opts: {
      title?: string;
      stateId?: string;
      assigneeId?: string;
      priority?: number;
    },
  ): Promise<BoardIssue | null> {
    const changes: Record<string, unknown> = {};
    if (opts.title) changes.title = opts.title;
    if (opts.priority !== undefined) changes.priority = opts.priority;
    if (opts.assigneeId !== undefined) changes.assignee = opts.assigneeId;
    if (opts.stateId) {
      const qs = stateIdToQueueState(opts.stateId);
      if (qs) changes.state = qs;
    }

    const updated = await this.store.update(id, changes as any);
    return updated ? taskToIssue(updated) : null;
  }

  async addComment(issueId: string, body: string): Promise<boolean> {
    const ex = await this.store.addExchange(issueId, {
      author: getInstanceName(),
      body,
      source: "chat",
    });
    return ex !== null;
  }

  async findByIdentifier(identifier: string): Promise<BoardIssue | null> {
    const task = await this.store.getByIdentifier(identifier);
    return task ? taskToIssue(task) : null;
  }

  async getDoneStateId(_teamId: string): Promise<string> {
    return "done";
  }
}
