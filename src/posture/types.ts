/**
 * Posture — how much UI surface assembles around the user.
 *
 * Three modes:
 * - silent:  No UI. Core works in background. Reaches out via chat/SMS/email.
 * - pulse:   Three dots only. Tap for drill-down. Zero-to-one interaction.
 * - board:   Full visibility. Threads, agents, memory, operations.
 *
 * Posture is orthogonal to tier (capabilities) and bonding (trust).
 * A BYOK user might be silent. A Spawn user might only want pulse.
 * UI is a symptom of unresolved autonomy — buttons exist because
 * Core couldn't handle it alone yet.
 *
 * Posture is observed, not configured. Intent accumulation drives transitions.
 * The system records interaction patterns and adapts surface area.
 */

export type PostureName = "silent" | "pulse" | "board";

export const POSTURE_LEVEL: Record<PostureName, number> = {
  silent: 0,
  pulse: 1,
  board: 2,
};

/** What UI surfaces are available at each posture. */
export interface PostureSurface {
  /** Chat channel (always available — the minimum) */
  chat: boolean;
  /** Three-dot pulse strip */
  pulse: boolean;
  /** Drill-down panels when tapping dots */
  drilldown: boolean;
  /** Full page views: observatory, ops, board, library, etc. */
  pages: boolean;
  /** Agent task management UI */
  agents: boolean;
  /** Settings/configuration UI */
  settings: boolean;
}

export const POSTURE_SURFACE: Record<PostureName, PostureSurface> = {
  silent: {
    chat: true,
    pulse: false,
    drilldown: false,
    pages: false,
    agents: false,
    settings: false,
  },
  pulse: {
    chat: true,
    pulse: true,
    drilldown: true,
    pages: false,
    agents: false,
    settings: false,
  },
  board: {
    chat: true,
    pulse: true,
    drilldown: true,
    pages: true,
    agents: true,
    settings: true,
  },
};

/**
 * An interaction signal — recorded every time the user does something.
 * Intent accumulation uses these to decide posture transitions.
 */
export interface InteractionSignal {
  timestamp: string;
  /** What surface the user touched */
  surface: keyof PostureSurface | "page-view";
  /** Specific detail — page name, dot tapped, etc. */
  detail?: string;
}

/**
 * Posture state — persisted in brain/settings.json alongside other settings.
 */
export interface PostureState {
  /** Current posture */
  current: PostureName;
  /** When the posture last changed */
  changedAt: string;
  /** Whether the user explicitly set this (locks auto-transition) */
  pinned: boolean;
  /** Interaction count per surface in the current window */
  interactions: Record<string, number>;
  /** When the interaction window started */
  windowStart: string;
}

// ── Intent signals (from Dash posture spec) ─────────────────────────────────

/** The seven canonical intent signal kinds. */
export type IntentSignalKind =
  | "open_app"
  | "tap_dot"
  | "tap_nudge"
  | "start_typing"
  | "voice_activation"
  | "multiple_tap"
  | "joy_signal";

/** Weight table from the spec. */
export const INTENT_WEIGHTS: Record<IntentSignalKind, number> = {
  open_app: 2,
  tap_dot: 1,
  tap_nudge: 1,
  start_typing: 3,
  voice_activation: 3,
  multiple_tap: 1,
  joy_signal: 1,
};

/** Signals that cause instant escalation to board. */
export const INSTANT_BOARD_SIGNALS: readonly IntentSignalKind[] = [
  "start_typing",
  "voice_activation",
] as const;

export interface IntentSignal {
  kind: IntentSignalKind;
  ts: string;
}

// ── Nerve profiles ──────────────────────────────────────────────────────────

export type NerveProfile = "glance" | "phone" | "tablet" | "desktop";

/** Maximum posture reachable by each nerve profile. */
export const POSTURE_CEILING: Record<NerveProfile, PostureName> = {
  glance: "pulse",
  phone: "board",
  tablet: "board",
  desktop: "board",
};

// ── Decay pause conditions ──────────────────────────────────────────────────

export interface DecayPauseConditions {
  activeAgentWork: boolean;
  pendingHumanDecision: boolean;
  crisisMode: boolean;
}

// ── Escalation config ───────────────────────────────────────────────────────

export interface PostureConfig {
  silentToPulseThreshold: number;
  pulseToBoardThreshold: number;
  boardDecayMs: number;
  pulseDecayMs: number;
}

export const DEFAULT_POSTURE_CONFIG: PostureConfig = {
  silentToPulseThreshold: 1,
  pulseToBoardThreshold: 5,
  boardDecayMs: 5 * 60 * 1000,
  pulseDecayMs: 30 * 60 * 1000,
};

// ── Posture transition event ────────────────────────────────────────────────

export type TransitionDirection = "escalate" | "decay";

export interface PostureTransition {
  from: PostureName;
  to: PostureName;
  direction: TransitionDirection;
  reason: string;
  ts: string;
  sessionId: string;
}
