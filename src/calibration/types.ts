/**
 * Calibration Cycle — Type definitions.
 *
 * Calibration is how the brain learns what "right" means for you.
 * Same process for onboarding and recurring performance review.
 * Produces thresholds that drive pulse dots, agent behavior, and posture timing.
 */

// ── Threshold levels ─────────────────────────────────────────────────────────

export type AutonomyLevel = "low" | "medium" | "high";
export type VisibilityLevel = "low" | "medium" | "high";
export type EscalationSpeed = "slow" | "normal" | "fast";
export type VerbosityLevel = "concise" | "balanced" | "detailed";
export type ProactivityLevel = "low" | "medium" | "high";
export type PacePreference = "sequential" | "parallel";

/** Joy prompt frequency as max prompts per active day. */
export type JoyFrequency = `${number}/day`;

// ── Calibration thresholds ───────────────────────────────────────────────────

export interface CalibrationThresholds {
  autonomy: AutonomyLevel;
  work_visibility: VisibilityLevel;
  escalation_speed: EscalationSpeed;
  joy_frequency: JoyFrequency;
  verbosity: VerbosityLevel;
  proactivity: ProactivityLevel;
  pace: PacePreference;
}

export const DEFAULT_THRESHOLDS: CalibrationThresholds = {
  autonomy: "medium",
  work_visibility: "medium",
  escalation_speed: "normal",
  joy_frequency: "2/day",
  verbosity: "concise",
  proactivity: "medium",
  pace: "sequential",
};

// ── Derived dot thresholds ───────────────────────────────────────────────────

export interface DotThresholds {
  sense_calm: number;
  sense_active: number;
  sense_attention: number;
  work_calm: number;
  work_active: number;
  work_attention: number;
  joy_baseline: number | null;
}

export const DEFAULT_DOT_THRESHOLDS: DotThresholds = {
  sense_calm: 5,
  sense_active: 15,
  sense_attention: 15,
  work_calm: 0,
  work_active: 3,
  work_attention: 3,
  joy_baseline: null,
};

// ── Calibration result ───────────────────────────────────────────────────────

export type CalibrationSource = "onboarding" | "recalibration" | "manual";

export interface CalibrationResult {
  version: number;
  date: string;
  thresholds: CalibrationThresholds;
  derived: DotThresholds;
  source: CalibrationSource;
  delta?: CalibrationDelta;
}

export interface CalibrationDelta {
  [key: string]: { from: unknown; to: unknown };
}

// ── Recalibration triggers ───────────────────────────────────────────────────

export interface RecalibrationTriggerConfig {
  /** Interactions since last calibration before auto-trigger. */
  interactionCount: number;
  /** Tick cycles since last calibration before auto-trigger. */
  tickCycleCount: number;
  /** Joy baseline shift threshold (absolute change in average). */
  joyShiftThreshold: number;
}

export const DEFAULT_TRIGGER_CONFIG: RecalibrationTriggerConfig = {
  interactionCount: 200,
  tickCycleCount: 500,
  joyShiftThreshold: 0.8,
};

// ── Calibration state ────────────────────────────────────────────────────────

export type CalibrationPhase =
  | "not_started"
  | "in_progress"
  | "complete";

export interface CalibrationState {
  phase: CalibrationPhase;
  currentQuestionIndex: number;
  source: CalibrationSource;
  /** Partial thresholds accumulated from answered questions. */
  answers: Partial<CalibrationThresholds>;
  startedAt: string;
}

// ── Conversation types ───────────────────────────────────────────────────────

export type CalibrationDimension = keyof CalibrationThresholds;

export interface CalibrationQuestion {
  dimension: CalibrationDimension;
  /** The natural-language question the agent asks. */
  prompt: string;
  /** Map of recognized response patterns to threshold values. */
  interpretations: CalibrationInterpretation[];
  /** Confirmation message template. Use {{value}} for the interpreted value. */
  confirmation: string;
}

export interface CalibrationInterpretation {
  /** Keywords or phrases that map to this value. */
  patterns: string[];
  value: string;
  /** Human-readable label for confirmation. */
  label: string;
}

// ── Archetype calibration profiles ───────────────────────────────────────────

export type ArchetypeCalibrationStyle =
  | "full"           // Founder: all dimensions
  | "domain"         // Template: domain-specific subset
  | "data_driven"    // Operator: show metrics, confirm
  | "threshold_review" // Observer: review what was flagged
  | "self"           // Creator: self-calibrating

export interface ArchetypeCalibrationProfile {
  style: ArchetypeCalibrationStyle;
  /** Which dimensions this archetype calibrates. */
  dimensions: CalibrationDimension[];
}

export const ARCHETYPE_PROFILES: Record<string, ArchetypeCalibrationProfile> = {
  founder: {
    style: "full",
    dimensions: ["autonomy", "work_visibility", "escalation_speed", "joy_frequency", "verbosity", "proactivity", "pace"],
  },
  template: {
    style: "domain",
    dimensions: ["autonomy", "escalation_speed", "verbosity"],
  },
  operator: {
    style: "data_driven",
    dimensions: ["work_visibility", "escalation_speed", "pace"],
  },
  observer: {
    style: "threshold_review",
    dimensions: ["work_visibility", "escalation_speed"],
  },
  creator: {
    style: "self",
    dimensions: [],
  },
};
