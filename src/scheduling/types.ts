/**
 * Types for the scheduling module — Core's internal time allocation.
 */

export type BlockType = "focus" | "deadline" | "milestone" | "admin" | "review" | "break";

export type BlockStatus = "planned" | "active" | "completed" | "skipped" | "cancelled";

export interface SchedulingBlock {
  id: string;
  type: BlockType;
  title: string;
  /** ISO 8601 start time (for time-range blocks). */
  start?: string;
  /** ISO 8601 end time (for time-range blocks). */
  end?: string;
  /** ISO 8601 due date (for deadlines/milestones instead of start/end). */
  dueAt?: string;
  /** Optional board item link (e.g. "DASH-112"). */
  boardItemId?: string;
  status: BlockStatus;
  /** Optional note on completion. */
  outcome?: string;
  /** Optional categorization. */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DaySchedule {
  date: string;
  blocks: SchedulingBlock[];
  stats: {
    total: number;
    planned: number;
    active: number;
    completed: number;
    skipped: number;
    cancelled: number;
  };
}

export interface BlockFilter {
  date?: string;
  status?: BlockStatus;
  type?: BlockType;
}
