/**
 * Onboarding Conversation — core conversational state machine.
 *
 * Manages the lower-level conversation mechanics:
 * - Message logging (agent + human with timestamps)
 * - Name extraction from free-text input
 * - Safe word creation sub-flow (validate → confirm → strength feedback)
 * - Strict forward-only phase transitions
 * - Event emission for phase transitions and milestones
 * - State query methods
 *
 * This is the composable engine that OnboardingFlow orchestrates.
 */

import {
  type OnboardingState,
  type OnboardingPhase,
  type OnboardingMessage,
  type OnboardingEvent,
  type OnboardingListener,
  PHASE_ORDER,
  createInitialState,
} from "./types.js";
import {
  validateSafeWord,
  safeWordsMatch,
  assessStrength,
  strengthMessage,
  type SafeWordStrength,
} from "./safe-word.js";
import {
  extractName as extractNameFull,
  type NameExtractionResult,
} from "./name-extraction.js";

// ── Name extraction (delegates to name-extraction module) ────────────────────

/**
 * Extract a name from free-text input.
 * Thin wrapper for backward compatibility — returns just the string.
 */
export function extractName(input: string): string {
  const result = extractNameFull(input);
  return result.name ?? input.trim();
}

// ── Safe word sub-flow state ────────────────────────────────────────────────

export type SafeWordStep = "ask" | "confirm";
export type RecoveryQuestionStep = "ask_question" | "ask_answer" | "confirm_answer";

export interface SafeWordResult {
  confirmed: boolean;
  strength?: SafeWordStrength;
  strengthMsg?: string;
}

// ── Conversation engine ─────────────────────────────────────────────────────

export class OnboardingConversation {
  private state: OnboardingState;
  private messages: OnboardingMessage[] = [];
  private listeners: OnboardingListener[] = [];

  /** Safe word sub-flow tracking */
  private safeWordStep: SafeWordStep = "ask";
  private pendingSafeWord: string | null = null;

  /** Recovery question sub-flow tracking */
  private recoveryStep: RecoveryQuestionStep = "ask_question";
  private pendingRecoveryQuestion: string | null = null;
  private pendingRecoveryAnswer: string | null = null;

  constructor(initialState?: OnboardingState) {
    this.state = initialState ?? createInitialState();
  }

  // ── Event system ────────────────────────────────────────────────────────

  /** Register a listener for onboarding events. */
  onEvent(listener: OnboardingListener): void {
    this.listeners.push(listener);
  }

  /** Remove a listener. */
  offEvent(listener: OnboardingListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  private emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Message logging ─────────────────────────────────────────────────────

  /** Log an agent message and return the content (for chaining). */
  logAgent(content: string): string {
    this.messages.push({
      role: "agent",
      content,
      phase: this.state.phase,
      ts: new Date().toISOString(),
    });
    return content;
  }

  /** Log a human message. */
  logHuman(content: string): void {
    this.messages.push({
      role: "human",
      content,
      phase: this.state.phase,
      ts: new Date().toISOString(),
    });
  }

  // ── Phase transitions (strict forward-only) ────────────────────────────

  /**
   * Advance to a target phase. Throws if the target is not strictly
   * ahead of the current phase in PHASE_ORDER.
   */
  advanceTo(target: OnboardingPhase): void {
    const currentIdx = PHASE_ORDER.indexOf(this.state.phase);
    const targetIdx = PHASE_ORDER.indexOf(target);

    if (targetIdx < 0) {
      throw new Error(`Unknown phase: ${target}`);
    }
    if (targetIdx <= currentIdx) {
      throw new Error(
        `Cannot move from "${this.state.phase}" to "${target}" — phases only advance forward.`
      );
    }

    this.state.phase = target;
    this.emit({ type: "phase_entered", phase: target });
  }

  // ── Greeting phase ─────────────────────────────────────────────────────

  /**
   * Handle a greeting response. Extracts the name and emits name_captured.
   * Returns the extracted name, or null if input was empty.
   */
  handleGreeting(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const name = extractName(trimmed);
    this.state.name = name;
    this.emit({ type: "name_captured", name });
    return name;
  }

  // ── Safe word phase ────────────────────────────────────────────────────

  /**
   * Process a safe word input. Manages the ask → confirm sub-flow.
   */
  handleSafeWord(input: string): SafeWordResponse {
    if (this.safeWordStep === "ask") {
      const validation = validateSafeWord(input);
      if (!validation.valid) {
        return { type: "invalid", reason: validation.reason! };
      }

      this.pendingSafeWord = input;
      this.safeWordStep = "confirm";
      return { type: "needs_confirm" };
    }

    // Confirm step
    if (!this.pendingSafeWord || !safeWordsMatch(this.pendingSafeWord, input)) {
      this.pendingSafeWord = null;
      this.safeWordStep = "ask";
      return { type: "mismatch" };
    }

    // Confirmed
    const strength = assessStrength(this.pendingSafeWord);
    this.state.safeWordConfirmed = true;
    this.emit({ type: "safe_word_created" });

    const result: SafeWordResponse = {
      type: "confirmed",
      strength,
      strengthMsg: strengthMessage(strength),
    };

    // Reset sub-flow state
    this.pendingSafeWord = null;
    this.safeWordStep = "ask";

    return result;
  }

  /** Get the pending (unconfirmed) safe word, if in confirm step. */
  getPendingSafeWord(): string | null {
    return this.pendingSafeWord;
  }

  /** Get the current safe word sub-step. */
  getSafeWordStep(): SafeWordStep {
    return this.safeWordStep;
  }

  // ── Recovery question phase ─────────────────────────────────────────────

  /**
   * Process a recovery question input. Manages the ask_question → ask_answer → confirm_answer sub-flow.
   */
  handleRecoveryQuestion(input: string): RecoveryQuestionResponse {
    const lower = input.toLowerCase();

    if (lower === "skip" || lower === "skip it" || lower === "later") {
      this.emit({ type: "recovery_question_skipped" });
      return { type: "skipped" };
    }

    switch (this.recoveryStep) {
      case "ask_question": {
        if (!input || input.length < 3) {
          return { type: "too_short" };
        }
        this.pendingRecoveryQuestion = input;
        this.recoveryStep = "ask_answer";
        return { type: "needs_answer", question: input };
      }

      case "ask_answer": {
        if (!input || input.length < 1) {
          return { type: "empty_answer" };
        }
        this.pendingRecoveryAnswer = input;
        this.recoveryStep = "confirm_answer";
        return { type: "needs_confirm" };
      }

      case "confirm_answer": {
        if (!this.pendingRecoveryAnswer || input.trim().toLowerCase() !== this.pendingRecoveryAnswer.trim().toLowerCase()) {
          this.pendingRecoveryAnswer = null;
          this.recoveryStep = "ask_answer";
          return { type: "mismatch" };
        }

        // Confirmed
        this.state.recoveryQuestionSet = true;
        this.emit({ type: "recovery_question_set" });

        const question = this.pendingRecoveryQuestion!;

        // Reset sub-flow state
        this.recoveryStep = "ask_question";

        return { type: "confirmed", question };
      }

      default:
        return { type: "skipped" };
    }
  }

  /** Get the pending recovery question. */
  getPendingRecoveryQuestion(): string | null {
    return this.pendingRecoveryQuestion;
  }

  /** Get the pending recovery answer. */
  getPendingRecoveryAnswer(): string | null {
    return this.pendingRecoveryAnswer;
  }

  /** Get the current recovery question sub-step. */
  getRecoveryStep(): RecoveryQuestionStep {
    return this.recoveryStep;
  }

  // ── State mutation helpers ──────────────────────────────────────────────

  /** Mark calibration as complete on the state. */
  markCalibrated(): void {
    this.state.calibrated = true;
    this.emit({ type: "calibration_completed" });
  }

  /** Mark bootstrap as complete on the state. */
  markBootstrapped(): void {
    this.state.bootstrapped = true;
  }

  /** Mark nerve link as offered. */
  markNerveLinkOffered(): void {
    this.state.nerveLinkOffered = true;
  }

  /** Mark nerve link as completed. */
  markNerveLinkCompleted(): void {
    this.state.nerveLinkCompleted = true;
  }

  /** Mark onboarding as complete. Sets completedAt and emits event. */
  markComplete(): void {
    this.state.completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(this.state.startedAt).getTime();
    this.emit({ type: "onboarding_completed", durationMs });
  }

  /** Set the human's name directly (e.g., if corrected later). */
  setName(name: string): void {
    this.state.name = name;
  }

  // ── State queries ───────────────────────────────────────────────────────

  /** Get a snapshot of the current onboarding state. */
  getState(): OnboardingState {
    return { ...this.state };
  }

  /** Get all conversation messages (agent + human). */
  getMessages(): OnboardingMessage[] {
    return [...this.messages];
  }

  /** Whether onboarding has reached the complete phase. */
  isComplete(): boolean {
    return this.state.phase === "complete";
  }

  /** The current phase. */
  currentPhase(): OnboardingPhase {
    return this.state.phase;
  }

  /** The human's name, if captured. */
  getName(): string | null {
    return this.state.name;
  }

  /** Total number of messages in the conversation. */
  messageCount(): number {
    return this.messages.length;
  }
}

// ── Safe word response types ────────────────────────────────────────────────

export type SafeWordResponse =
  | { type: "invalid"; reason: string }
  | { type: "needs_confirm" }
  | { type: "mismatch" }
  | { type: "confirmed"; strength: SafeWordStrength; strengthMsg: string };

export type RecoveryQuestionResponse =
  | { type: "skipped" }
  | { type: "too_short" }
  | { type: "needs_answer"; question: string }
  | { type: "empty_answer" }
  | { type: "needs_confirm" }
  | { type: "mismatch" }
  | { type: "confirmed"; question: string };
