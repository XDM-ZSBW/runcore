/**
 * Tick Cycle — Type definitions.
 *
 * The tick is the fundamental rhythm: Sense → Work → Joy.
 * Strict order. Event-driven. No timers.
 */

export type TickPhase = "sense" | "work" | "joy";

export type TickState = "idle" | "sense" | "work" | "joy";

export interface TickEvent {
  type: TickEventType;
  ts: string;
  detail?: string;
}

export type TickEventType =
  | "human_message"
  | "spec_change"
  | "notification"
  | "agent_complete"
  | "nerve_connect"
  | "tunnel_envelope"
  | "joy_signal"
  | "system";

/** Dot color state for pulse integration. */
export type DotColor = "blue" | "green" | "amber";

export interface SenseSnapshot {
  ts: string;
  events: TickEvent[];
  activeAgents: number;
  failedAgents: number;
  recentActivityCount: number;
  latestJoy: number | null;
  joyTrend: "rising" | "falling" | "stable" | "unknown";
}

export interface WorkOutput {
  ts: string;
  actionsTaken: number;
  errors: string[];
  noop: boolean;
  summary: string;
}

export interface JoyMeasurement {
  ts: string;
  delta: number;
  friction: number;
  creation: boolean;
  quiet: boolean;
}

export interface TickRecord {
  id: number;
  startedAt: string;
  completedAt: string;
  events: TickEvent[];
  sense: SenseSnapshot;
  work: WorkOutput;
  joy: JoyMeasurement;
  durationMs: number;
}

export interface TickStatus {
  state: TickState;
  tickCount: number;
  lastTick: TickRecord | null;
  queueDepth: number;
  phaseDots: {
    sense: DotColor;
    work: DotColor;
    joy: DotColor;
  };
}

/**
 * Sense provider — injected to read the world.
 * Instances supply their own (agents, activities, joy signals).
 * Default: returns empty/idle snapshot.
 */
export interface SenseProvider {
  getActiveAgents(): Promise<number>;
  getFailedAgents(): Promise<number>;
  getRecentActivityCount(): Promise<number>;
  getLatestJoy(): Promise<number | null>;
  getJoyTrend(): Promise<SenseSnapshot["joyTrend"]>;
}
