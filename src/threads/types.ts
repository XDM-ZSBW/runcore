/**
 * Chat thread types.
 * A thread groups related messages into a single conversation topic.
 */

export interface ChatThread {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  status: "active" | "archived";
  linkedBoardId?: string;
  origin?: "user" | "auto";
}
