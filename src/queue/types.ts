/**
 * Internal task queue types.
 * QueueTask is the local source of truth — fully self-contained.
 */

import type { BoardState } from "../board/types.js";

export type QueueTaskState = "icebox" | "triage" | "backlog" | "todo" | "in_progress" | "done" | "cancelled";

export interface QueueProject {
  id: string;           // "core-dev", "triage"
  name: string;         // "Core Dev", "Triage"
  prefix: string;       // "CORE", "TRI" — uppercase, used in identifiers
  description?: string;
}

export const DEFAULT_PROJECT_ID = "triage";

export interface QueueExchange {
  id: string;
  author: string;
  body: string;
  source: "chat" | "external" | "whatsapp" | "manual";
  timestamp: string;
}

export interface QueueTask {
  id: string;
  identifier: string;           // "DASH-1", "DASH-2", ...
  title: string;
  description: string;
  state: QueueTaskState;
  priority: number;             // 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
  assignee: string | null;
  project?: string;             // project id — undefined = urgent escalation
  exchanges: QueueExchange[];
  createdAt: string;
  updatedAt: string;
  // Append-only archival
  status?: "active" | "archived";
  // ── Causal backrefs ────────────────────────────────────────────────────
  /** How this task was created. */
  origin?: "chat" | "agent" | "autonomous" | "external";
  /** Session ID of the chat/agent that created this task. */
  originSessionId?: string;
  /** Agent task ID when an agent is assigned to work on this board item. */
  agentTaskId?: string;
}

/** Fixed workflow states — maps QueueTaskState to BoardState. */
export const QUEUE_STATES: (BoardState & { queueState: QueueTaskState })[] = [
  { id: "icebox",      name: "Icebox",      type: "icebox",    position: 0, queueState: "icebox" },
  { id: "triage",      name: "Triage",      type: "triage",    position: 1, queueState: "triage" },
  { id: "backlog",     name: "Backlog",     type: "backlog",   position: 2, queueState: "backlog" },
  { id: "todo",        name: "Todo",        type: "unstarted", position: 3, queueState: "todo" },
  { id: "in_progress", name: "In Progress", type: "started",   position: 4, queueState: "in_progress" },
  { id: "done",        name: "Done",        type: "completed", position: 5, queueState: "done" },
  { id: "cancelled",   name: "Cancelled",   type: "cancelled", position: 6, queueState: "cancelled" },
];

/** Map a QueueTaskState to its display name. */
export function stateDisplayName(state: QueueTaskState): string {
  if (!state) return "Unknown";
  return QUEUE_STATES.find((s) => s.queueState === state)?.name ?? state;
}
