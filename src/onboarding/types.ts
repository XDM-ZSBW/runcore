/**
 * Onboarding System — Type definitions.
 *
 * Under 5 minutes. Zero forms. Conversational flow that produces:
 * - Human identity (name + safe word)
 * - Calibration thresholds (via CalibrationRunner)
 * - Agent bootstrap (Founder archetype + pulse dots initialized)
 * - First nerve spawned (cross-device setup)
 */

import type { CalibrationThresholds, DotThresholds } from "../calibration/types.js";

// ── Agent archetype (portable — no dependency on specific agents module) ────

/** Agent archetypes used during bootstrap. */
export type Archetype =
  | "founder"
  | "template"
  | "operator"
  | "observer"
  | "creator";

// ── Nerve profile (portable — no dependency on specific nerve module) ───────

/** Nerve profile hint for device type detection. */
export type NerveProfile = "glance" | "phone" | "tablet" | "desktop";

// ── Onboarding phases ──────────────────────────────────────────────────────

/**
 * The onboarding flow moves through seven phases in order.
 * Each phase is a conversational step — no forms, no screens.
 */
export type OnboardingPhase =
  | "greeting"          // Agent introduces itself, asks for name
  | "safe_word"         // Create and confirm safe word
  | "recovery_question" // Collect recovery question + answer for safe word reset
  | "calibration"       // 7-question calibration conversation
  | "bootstrap"         // Agent init + pulse dot initialization (automatic, no user input)
  | "nerve_link"        // Optional: spawn a second nerve for cross-device
  | "complete";         // Done — brain is live

/**
 * Phase transition order. Each phase can only advance forward.
 */
export const PHASE_ORDER: readonly OnboardingPhase[] = [
  "greeting",
  "safe_word",
  "recovery_question",
  "calibration",
  "bootstrap",
  "nerve_link",
  "complete",
] as const;

// ── Onboarding state ───────────────────────────────────────────────────────

export interface OnboardingState {
  phase: OnboardingPhase;
  startedAt: string;
  /** Human's name, captured during greeting. */
  name: string | null;
  /** Whether safe word has been created and confirmed. */
  safeWordConfirmed: boolean;
  /** Whether recovery question has been set. */
  recoveryQuestionSet: boolean;
  /** Whether calibration is complete. */
  calibrated: boolean;
  /** Whether agent bootstrap is complete. */
  bootstrapped: boolean;
  /** Nerve spawn offered (user may skip). */
  nerveLinkOffered: boolean;
  /** Nerve spawn completed (if they accepted). */
  nerveLinkCompleted: boolean;
  /** ISO timestamp of completion. */
  completedAt: string | null;
}

export function createInitialState(): OnboardingState {
  return {
    phase: "greeting",
    startedAt: new Date().toISOString(),
    name: null,
    safeWordConfirmed: false,
    recoveryQuestionSet: false,
    calibrated: false,
    bootstrapped: false,
    nerveLinkOffered: false,
    nerveLinkCompleted: false,
    completedAt: null,
  };
}

// ── Conversation messages ──────────────────────────────────────────────────

/** Direction of a message in the onboarding conversation. */
export type MessageRole = "agent" | "human";

export interface OnboardingMessage {
  role: MessageRole;
  content: string;
  phase: OnboardingPhase;
  ts: string;
}

// ── Safe word validation ───────────────────────────────────────────────────

export interface SafeWordRules {
  minLength: number;
  maxLength: number;
  minWords: number;
}

export const SAFE_WORD_RULES: SafeWordRules = {
  minLength: 4,
  maxLength: 64,
  minWords: 1,
};

export interface SafeWordValidation {
  valid: boolean;
  reason?: string;
}

// ── Bootstrap result ───────────────────────────────────────────────────────

export interface BootstrapResult {
  archetype: Archetype;
  thresholds: CalibrationThresholds;
  dotThresholds: DotThresholds;
  brainDirs: string[];
  pulseDots: PulseDotInit;
}

/** Initial pulse dot state — all three dots start at zero signal. */
export interface PulseDotInit {
  sense: { level: number; label: string };
  work: { level: number; label: string };
  joy: { level: number; label: string };
}

export const INITIAL_PULSE_DOTS: PulseDotInit = {
  sense: { level: 0, label: "quiet" },
  work: { level: 0, label: "idle" },
  joy: { level: 0, label: "baseline" },
};

// ── Nerve link ─────────────────────────────────────────────────────────────

export interface NerveLinkOffer {
  url: string;
  token: string;
  expiresAt: number;
  hintProfile?: NerveProfile;
}

// ── Events ─────────────────────────────────────────────────────────────────

export type OnboardingEvent =
  | { type: "phase_entered"; phase: OnboardingPhase }
  | { type: "name_captured"; name: string }
  | { type: "safe_word_created" }
  | { type: "recovery_question_set" }
  | { type: "recovery_question_skipped" }
  | { type: "calibration_started" }
  | { type: "calibration_completed" }
  | { type: "bootstrap_completed"; result: BootstrapResult }
  | { type: "nerve_link_offered"; offer: NerveLinkOffer }
  | { type: "nerve_link_skipped" }
  | { type: "nerve_link_completed"; nerveId: string }
  | { type: "onboarding_completed"; durationMs: number };

export type OnboardingListener = (event: OnboardingEvent) => void;
