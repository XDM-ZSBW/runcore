export type AgentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  id: string;
  label: string;
  prompt: string;
  cwd: string;
  status: AgentTaskStatus;
  pid?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  origin: "user" | "ai";
  sessionId?: string;
  timeoutMs?: number;
  resultSummary?: string;
  /** Board task ID — used to move the board item through states on completion. */
  boardTaskId?: string;
  reflection?: {
    movedGoalForward: boolean;
    hitGuardrail: boolean;
    adjustment?: string;
    summary: string;
  };
}

export interface CreateTaskInput {
  label: string;
  prompt: string;
  cwd?: string;
  origin: "user" | "ai";
  sessionId?: string;
  timeoutMs?: number;
  /** Board task ID — passed through to AgentTask for lifecycle tracking. */
  boardTaskId?: string;
}
