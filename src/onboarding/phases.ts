/**
 * Onboarding Phase System — strict forward-only phase management.
 *
 * Phase order: greeting → safe_word → recovery_question → calibration → bootstrap → nerve_link → complete
 */

import { type OnboardingPhase, PHASE_ORDER } from "./types.js";

// Re-export for convenience
export type { OnboardingPhase } from "./types.js";

/**
 * Ordered list of phases — re-export of PHASE_ORDER for backward compat.
 */
export const PHASE_SEQUENCE: readonly OnboardingPhase[] = PHASE_ORDER;

// ── Phase metadata ──────────────────────────────────────────────────────────

export interface PhaseDefinition {
  phase: OnboardingPhase;
  label: string;
  requiresInput: boolean;
  /** What this phase produces when completed. */
  produces: string;
}

export const PHASE_DEFINITIONS: Record<OnboardingPhase, PhaseDefinition> = {
  greeting: {
    phase: "greeting",
    label: "Greeting",
    requiresInput: true,
    produces: "state.name",
  },
  safe_word: {
    phase: "safe_word",
    label: "Safe Word",
    requiresInput: true,
    produces: "human.json hash",
  },
  recovery_question: {
    phase: "recovery_question",
    label: "Recovery Question",
    requiresInput: true,
    produces: "recovery question + answer hash",
  },
  calibration: {
    phase: "calibration",
    label: "Calibration",
    requiresInput: true,
    produces: "calibration/current.json",
  },
  bootstrap: {
    phase: "bootstrap",
    label: "Agent Bootstrap",
    requiresInput: false,
    produces: "brain dirs, identity, archetype, pulse dots",
  },
  nerve_link: {
    phase: "nerve_link",
    label: "Nerve Link",
    requiresInput: true,
    produces: "spawn URL for second device",
  },
  complete: {
    phase: "complete",
    label: "Complete",
    requiresInput: false,
    produces: "fully initialized brain",
  },
};

// ── Phase validation ────────────────────────────────────────────────────────

export function phaseIndex(phase: OnboardingPhase): number {
  return PHASE_SEQUENCE.indexOf(phase);
}

export function isValidPhase(value: string): value is OnboardingPhase {
  return PHASE_SEQUENCE.includes(value as OnboardingPhase);
}

export function isValidTransition(
  current: OnboardingPhase,
  target: OnboardingPhase,
): boolean {
  const currentIdx = phaseIndex(current);
  const targetIdx = phaseIndex(target);
  return currentIdx >= 0 && targetIdx > currentIdx;
}

export function nextPhase(current: OnboardingPhase): OnboardingPhase | null {
  const idx = phaseIndex(current);
  if (idx < 0 || idx >= PHASE_SEQUENCE.length - 1) return null;
  return PHASE_SEQUENCE[idx + 1];
}

export function isFirstPhase(phase: OnboardingPhase): boolean {
  return phase === PHASE_SEQUENCE[0];
}

export function isFinalPhase(phase: OnboardingPhase): boolean {
  return phase === PHASE_SEQUENCE[PHASE_SEQUENCE.length - 1];
}

export function phasesBefore(phase: OnboardingPhase): OnboardingPhase[] {
  const idx = phaseIndex(phase);
  if (idx <= 0) return [];
  return [...PHASE_SEQUENCE.slice(0, idx)];
}

export function phasesAfter(phase: OnboardingPhase): OnboardingPhase[] {
  const idx = phaseIndex(phase);
  if (idx < 0 || idx >= PHASE_SEQUENCE.length - 1) return [];
  return [...PHASE_SEQUENCE.slice(idx + 1)];
}

// ── Phase transition events ─────────────────────────────────────────────────

export type PhaseEvent =
  | { type: "phase_entered"; phase: OnboardingPhase; from: OnboardingPhase | null }
  | { type: "phase_completed"; phase: OnboardingPhase }
  | { type: "transition_rejected"; from: OnboardingPhase; to: OnboardingPhase; reason: string }
  | { type: "onboarding_started" }
  | { type: "onboarding_finished"; durationMs: number };

export type PhaseEventListener = (event: PhaseEvent) => void;

// ── Phase manager ───────────────────────────────────────────────────────────

export class PhaseManager {
  private current: OnboardingPhase;
  private listeners: PhaseEventListener[] = [];
  private startedAt: number;
  private completedPhases: Set<OnboardingPhase> = new Set();

  constructor(startPhase: OnboardingPhase = "greeting") {
    this.current = startPhase;
    this.startedAt = Date.now();
  }

  on(listener: PhaseEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: PhaseEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  start(): void {
    this.startedAt = Date.now();
    this.emit({ type: "onboarding_started" });
    this.emit({ type: "phase_entered", phase: this.current, from: null });
  }

  advance(): OnboardingPhase {
    const next = nextPhase(this.current);
    if (!next) {
      throw new Error(`Cannot advance past final phase "${this.current}".`);
    }
    return this.transitionTo(next);
  }

  transitionTo(target: OnboardingPhase): OnboardingPhase {
    if (!isValidTransition(this.current, target)) {
      const reason = `Cannot transition from "${this.current}" to "${target}" — phases only advance forward.`;
      this.emit({
        type: "transition_rejected",
        from: this.current,
        to: target,
        reason,
      });
      throw new Error(reason);
    }

    const from = this.current;
    this.completedPhases.add(from);
    this.emit({ type: "phase_completed", phase: from });

    this.current = target;
    this.emit({ type: "phase_entered", phase: target, from });

    if (isFinalPhase(target) && !PHASE_DEFINITIONS[target].requiresInput) {
      this.completedPhases.add(target);
      this.emit({ type: "phase_completed", phase: target });
      this.emit({
        type: "onboarding_finished",
        durationMs: Date.now() - this.startedAt,
      });
    }

    return target;
  }

  completeCurrentPhase(): void {
    this.completedPhases.add(this.current);
    this.emit({ type: "phase_completed", phase: this.current });

    if (isFinalPhase(this.current)) {
      this.emit({
        type: "onboarding_finished",
        durationMs: Date.now() - this.startedAt,
      });
    }
  }

  getCurrentPhase(): OnboardingPhase { return this.current; }
  getCurrentDefinition(): PhaseDefinition { return PHASE_DEFINITIONS[this.current]; }
  isPhaseCompleted(phase: OnboardingPhase): boolean { return this.completedPhases.has(phase); }
  getCompletedPhases(): OnboardingPhase[] { return PHASE_SEQUENCE.filter(p => this.completedPhases.has(p)) as OnboardingPhase[]; }
  getElapsedMs(): number { return Date.now() - this.startedAt; }
  isFinished(): boolean { return isFinalPhase(this.current) && this.completedPhases.has(this.current); }
}
