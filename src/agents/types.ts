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
  /** Read-only mode — agent can investigate and report, but not edit files. */
  readOnly?: boolean;
  reflection?: {
    movedGoalForward: boolean;
    hitGuardrail: boolean;
    adjustment?: string;
    summary: string;
  };
}

/** Structured issue report from a read-only autonomous agent. */
export interface SelfReportedIssue {
  /** Unique issue ID */
  id: string;
  /** Short title */
  title: string;
  /** What was detected */
  description: string;
  /** Severity: low, medium, high */
  severity: "low" | "medium" | "high";
  /** Category: crash, error, performance, design, missing-feature */
  category: "crash" | "error" | "performance" | "design" | "missing-feature";
  /** Files involved (relative paths only — no absolute paths) */
  files: string[];
  /** Suggested fix direction (not the fix itself) */
  suggestion?: string;
  /** Agent task ID that produced this report */
  agentTaskId: string;
  /** Timestamp */
  reportedAt: string;
  /** Core version */
  coreVersion: string;
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
  /** Read-only mode — agent can investigate and report, but not edit files. */
  readOnly?: boolean;
}
