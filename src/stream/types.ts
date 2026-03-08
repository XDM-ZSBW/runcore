/**
 * Stream type definitions — the live agent activity stream.
 *
 * Eight action types map the brain's work to a visible feed.
 * Shape controls let the human tune what they see without
 * stopping what the brain does.
 */

export type StreamActionType =
  | "sense"
  | "work"
  | "memory"
  | "decision"
  | "tunnel"
  | "nerve"
  | "state"
  | "error";

export interface StreamAction {
  id: string;
  timestamp: string;
  agentId: string;
  type: StreamActionType;
  summary: string;
  detail?: Record<string, unknown>;
  twistable?: boolean;
  traceId?: string;
}

/** Mixing board controls — shape what the human sees. */
export interface ShapeState {
  /** Which agent(s) to prioritize (empty = all). */
  focus: string[];
  /** Detail depth: 0 = headlines only, 100 = full trace. */
  depth: number;
  /** Autonomy level: 0 = ask everything, 100 = full auto. */
  autonomy: number;
  /** Noise filter: 0 = show everything, 100 = critical only. */
  noise: number;
}

export const DEFAULT_SHAPE: ShapeState = {
  focus: [],
  depth: 50,
  autonomy: 50,
  noise: 30,
};

/** Breakpoint — standing order to auto-pause when matched. */
export interface Breakpoint {
  id: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
}

/** Nudge colors — agent judgment on action importance. */
export type NudgeColor =
  | "green"    // smooth
  | "blue"     // informational
  | "yellow"   // worth noting
  | "orange"   // needs attention
  | "red"      // problem
  | "purple"   // creative/unexpected
  | "sparkle"  // delightful
  | "silent";  // suppress from UI

export interface NudgedAction extends StreamAction {
  nudge: NudgeColor;
}

/** Control commands from client to server. */
export type ControlCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "shape"; state: Partial<ShapeState> }
  | { type: "breakpoint:add"; rule: string }
  | { type: "breakpoint:remove"; id: string }
  | { type: "breakpoint:toggle"; id: string }
  | { type: "twist"; actionId: string; modification: Record<string, unknown> };

/** SSE events from server to client. */
export type StreamEvent =
  | { event: "action"; data: StreamAction }
  | { event: "state"; data: { paused: boolean; shape: ShapeState } }
  | { event: "breakpoints"; data: Breakpoint[] }
  | { event: "paused"; data: { actionId: string; rule: string } }
  | { event: "resumed"; data: Record<string, never> }
  | { event: "heartbeat"; data: { ts: string } };

/** Stream filter for multi-agent sessions. */
export interface StreamFilter {
  agents: string[];
  types: StreamActionType[];
  minSeverity: NudgeColor | null;
}

export const DEFAULT_FILTER: StreamFilter = {
  agents: [],
  types: [],
  minSeverity: null,
};
