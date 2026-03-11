/**
 * Whiteboard types — shared collaboration surface between human and agent.
 *
 * WhiteboardNode is the core data type. Nodes form a tree (parentId).
 * Questions are first-class: they carry attention weight and block
 * downstream work until answered.
 */

// ── Node Types ───────────────────────────────────────────────────────────────

export type NodeType = "goal" | "task" | "question" | "decision" | "note";
export type NodeStatus = "open" | "done" | "archived";
export type NodePlanter = "agent" | "human";

export interface WhiteboardNode {
  id: string;                    // "wb_<timestamp>_<8hex>"
  parentId: string | null;       // null = root node
  title: string;                 // Short label
  body?: string;                 // Markdown detail
  type: NodeType;
  status: NodeStatus;
  tags: string[];                // ["engineering", "p1"]
  plantedBy: NodePlanter;        // Who created it

  // Question-specific
  question?: string;             // The actual question text
  answer?: string;               // Human's response
  answeredAt?: string;           // ISO timestamp when answered

  // Links
  boardTaskId?: string;          // Optional link to QueueTask

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

// ── Weighted Node (computed on read) ─────────────────────────────────────────

export interface WeightedNode extends WhiteboardNode {
  weight: number;                // 0-1, higher = more attention needed
  openDescendants: number;       // Count of open children (recursive)
}

// ── Tree Node (for nested API response) ──────────────────────────────────────

export interface TreeNode extends WeightedNode {
  children: TreeNode[];
  path: string[];               // Ancestor IDs from root to this node
}

// ── Filter ───────────────────────────────────────────────────────────────────

export interface WhiteboardFilter {
  type?: NodeType;
  status?: NodeStatus;
  tags?: string[];
  plantedBy?: NodePlanter;
  parentId?: string;             // Direct children only
  search?: string;               // Title + body + question + answer
  answeredSince?: string;        // ISO timestamp — recently answered questions
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface WhiteboardSummary {
  total: number;
  open: number;
  done: number;
  openQuestions: number;
  topWeighted: WeightedNode[];   // Top 5 by weight
  byTag: Record<string, number>;
}

// ── Create Input ─────────────────────────────────────────────────────────────

export type CreateNodeInput = Omit<WhiteboardNode, "id" | "createdAt" | "updatedAt" | "status"> & {
  status?: NodeStatus;           // Defaults to "open"
};
