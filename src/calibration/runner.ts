/**
 * Calibration Runner — orchestrates calibration cycles.
 *
 * Manages the state machine for onboarding and recalibration conversations.
 * Tracks trigger conditions for automatic recalibration.
 * Produces CalibrationResult on completion.
 *
 * Portable: joy history is injectable via JoyHistoryProvider interface
 * instead of importing a specific joy/store module.
 */

import { createLogger } from "../utils/logger.js";
import type {
  CalibrationState,
  CalibrationSource,
  CalibrationThresholds,
  CalibrationDimension,
  CalibrationQuestion,
  RecalibrationTriggerConfig,
} from "./types.js";
import { DEFAULT_TRIGGER_CONFIG } from "./types.js";
import {
  ONBOARDING_QUESTIONS,
  JOY_BASELINE_QUESTION,
  interpretResponse,
  buildConfirmation,
  deriveThresholds,
  applySeedBaseline,
  getQuestionsForDimensions,
  mergeWithDefaults,
} from "./conversation.js";
import {
  saveCalibration,
  buildCalibrationResult,
  getCurrentCalibration,
  saveTriggerCounters,
  loadTriggerCounters,
} from "./store.js";

const log = createLogger("calibration:runner");

// ── Joy history provider (injectable) ────────────────────────────────────────

/** Joy signal entry — matches what joy stores typically produce. */
export interface JoyEntry {
  signal: number;
}

/**
 * Interface for providing joy signal history.
 * Inject an implementation that reads from your joy store.
 * Default: returns empty array (no joy history available).
 */
export interface JoyHistoryProvider {
  getJoyHistory(limit: number): Promise<JoyEntry[]>;
}

const NULL_JOY_PROVIDER: JoyHistoryProvider = {
  async getJoyHistory() { return []; },
};

// ── Joy baseline learning ────────────────────────────────────────────────────

/** Minimum joy signals needed before deriving a baseline. */
const JOY_BASELINE_MIN_SIGNALS = 20;

/**
 * Compute joy baseline (median) from signal history.
 * Returns null if fewer than JOY_BASELINE_MIN_SIGNALS exist.
 */
async function computeJoyBaseline(provider: JoyHistoryProvider): Promise<number | null> {
  const entries = await provider.getJoyHistory(200);
  if (entries.length < JOY_BASELINE_MIN_SIGNALS) return null;

  const sorted = entries.map(e => e.signal).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return Math.round(median * 100) / 100;
}

// ── Recalibration counters ───────────────────────────────────────────────────

let interactionsSinceCalibration = 0;
let tickCyclesSinceCalibration = 0;

// ── Listener ─────────────────────────────────────────────────────────────────

export type CalibrationListener = (event: CalibrationEvent) => void;

export type CalibrationEvent =
  | { type: "started"; source: CalibrationSource }
  | { type: "question"; question: CalibrationQuestion; index: number; total: number }
  | { type: "interpreted"; dimension: CalibrationDimension; value: string; confirmation: string }
  | { type: "unrecognized"; dimension: CalibrationDimension; question: CalibrationQuestion }
  | { type: "completed"; version: number }
  | { type: "trigger_check"; triggered: boolean; reason?: string };

// ── Runner ───────────────────────────────────────────────────────────────────

export class CalibrationRunner {
  private state: CalibrationState | null = null;
  private questions: CalibrationQuestion[] = [];
  private listeners: CalibrationListener[] = [];
  private triggerConfig: RecalibrationTriggerConfig;
  private joyProvider: JoyHistoryProvider;
  /** Tracks the self-reported seed baseline from onboarding. */
  private joyBaselineSeed: string | null = null;

  constructor(options: {
    triggerConfig?: Partial<RecalibrationTriggerConfig>;
    joyProvider?: JoyHistoryProvider;
  } = {}) {
    this.triggerConfig = { ...DEFAULT_TRIGGER_CONFIG, ...options.triggerConfig };
    this.joyProvider = options.joyProvider ?? NULL_JOY_PROVIDER;
  }

  /**
   * Restore trigger counters from disk (call at startup after store init).
   */
  async restoreCounters(): Promise<void> {
    const saved = await loadTriggerCounters();
    if (saved) {
      interactionsSinceCalibration = saved.interactions;
      tickCyclesSinceCalibration = saved.tickCycles;
      log.info("Trigger counters restored", { interactions: saved.interactions, tickCycles: saved.tickCycles });
    }
  }

  /** Register a callback for calibration events. */
  onEvent(listener: CalibrationListener): void {
    this.listeners.push(listener);
  }

  private emit(event: CalibrationEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start a calibration cycle.
   * For onboarding, uses the full question set.
   * For recalibration, can scope to specific dimensions.
   * Appends a joy baseline seed question during onboarding if no baseline exists yet.
   */
  async start(
    source: CalibrationSource,
    dimensions?: CalibrationDimension[],
  ): Promise<CalibrationQuestion | null> {
    this.questions = dimensions
      ? getQuestionsForDimensions(dimensions)
      : [...ONBOARDING_QUESTIONS];

    // During onboarding, append joy baseline question if not enough signal history
    this.joyBaselineSeed = null;
    if (source === "onboarding" && !dimensions) {
      const entries = await this.joyProvider.getJoyHistory(20);
      if (entries.length < 20) {
        this.questions.push(JOY_BASELINE_QUESTION);
      }
    }

    if (this.questions.length === 0) {
      log.warn("No questions for calibration", { source, dimensions });
      return null;
    }

    this.state = {
      phase: "in_progress",
      currentQuestionIndex: 0,
      source,
      answers: {},
      startedAt: new Date().toISOString(),
    };

    this.emit({ type: "started", source });

    const first = this.questions[0];
    this.emit({ type: "question", question: first, index: 0, total: this.questions.length });
    return first;
  }

  /**
   * Process a user response for the current question.
   * Returns the next question, or null if calibration is complete.
   */
  async respond(response: string): Promise<{
    next: CalibrationQuestion | null;
    confirmation: string | null;
    completed: boolean;
  }> {
    if (!this.state || this.state.phase !== "in_progress") {
      return { next: null, confirmation: null, completed: false };
    }

    const question = this.questions[this.state.currentQuestionIndex];
    const match = interpretResponse(question, response);

    if (!match) {
      this.emit({ type: "unrecognized", dimension: question.dimension, question });
      return {
        next: question, // re-ask the same question
        confirmation: null,
        completed: false,
      };
    }

    // Capture joy baseline seed if this is the baseline question
    if (question === JOY_BASELINE_QUESTION) {
      this.joyBaselineSeed = match.value;
    }

    // Record the answer (skip recording baseline question — it shares joy_frequency dimension)
    if (question !== JOY_BASELINE_QUESTION) {
      (this.state.answers as Record<string, string>)[question.dimension] = match.value;
    }
    const confirmation = buildConfirmation(question, match.label);

    this.emit({
      type: "interpreted",
      dimension: question.dimension,
      value: match.value,
      confirmation,
    });

    // Advance to next question
    this.state.currentQuestionIndex++;

    if (this.state.currentQuestionIndex >= this.questions.length) {
      // Calibration complete
      await this.complete();
      return { next: null, confirmation, completed: true };
    }

    const next = this.questions[this.state.currentQuestionIndex];
    this.emit({
      type: "question",
      question: next,
      index: this.state.currentQuestionIndex,
      total: this.questions.length,
    });

    return { next, confirmation, completed: false };
  }

  /**
   * Finalize the calibration: merge answers, derive thresholds, save.
   */
  private async complete(): Promise<void> {
    if (!this.state) return;

    const thresholds = mergeWithDefaults(this.state.answers);
    const derived = deriveThresholds(thresholds);

    // Learn joy baseline from signal history if enough data exists
    const baseline = await computeJoyBaseline(this.joyProvider);
    if (baseline !== null) {
      derived.joy_baseline = baseline;
      log.info("Joy baseline learned from signal history", { baseline });
    } else if (this.joyBaselineSeed !== null) {
      // Fall back to self-reported seed from onboarding conversation
      applySeedBaseline(derived, this.joyBaselineSeed);
      log.info("Joy baseline seeded from onboarding", { seed: this.joyBaselineSeed });
    }

    const result = await buildCalibrationResult(thresholds, derived, this.state.source);

    await saveCalibration(result);

    this.state.phase = "complete";
    interactionsSinceCalibration = 0;
    tickCyclesSinceCalibration = 0;
    this.persistCounters();

    this.emit({ type: "completed", version: result.version });
    log.info("Calibration complete", { version: result.version, source: this.state.source });
  }

  /**
   * Cancel an in-progress calibration.
   */
  cancel(): void {
    if (this.state?.phase === "in_progress") {
      log.info("Calibration cancelled");
      this.state = null;
      this.questions = [];
    }
  }

  // ── State queries ──────────────────────────────────────────────────────

  /** Whether a calibration is currently in progress. */
  isActive(): boolean {
    return this.state?.phase === "in_progress";
  }

  /** Get the current calibration state (for persistence/resume). */
  getState(): CalibrationState | null {
    return this.state ? { ...this.state } : null;
  }

  /** Get current question index and total count. */
  progress(): { current: number; total: number } | null {
    if (!this.state || this.state.phase !== "in_progress") return null;
    return {
      current: this.state.currentQuestionIndex,
      total: this.questions.length,
    };
  }

  // ── Recalibration triggers ─────────────────────────────────────────────

  /** Record an interaction for trigger tracking. */
  recordInteraction(): void {
    interactionsSinceCalibration++;
    // Persist every 10 interactions to avoid excessive I/O
    if (interactionsSinceCalibration % 10 === 0) {
      this.persistCounters();
    }
  }

  /** Record a tick cycle for trigger tracking. */
  recordTickCycle(): void {
    tickCyclesSinceCalibration++;
    // Persist every 10 tick cycles
    if (tickCyclesSinceCalibration % 10 === 0) {
      this.persistCounters();
    }
  }

  /** Save current counter values to disk. */
  private persistCounters(): void {
    saveTriggerCounters({
      interactions: interactionsSinceCalibration,
      tickCycles: tickCyclesSinceCalibration,
      savedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  /**
   * Check if a recalibration should be triggered.
   * Returns the reason if triggered, null otherwise.
   */
  async checkTrigger(joyAverage?: number): Promise<string | null> {
    // Don't trigger during active calibration
    if (this.isActive()) return null;

    // Check interaction count
    if (interactionsSinceCalibration >= this.triggerConfig.interactionCount) {
      const reason = `${interactionsSinceCalibration} interactions since last calibration`;
      this.emit({ type: "trigger_check", triggered: true, reason });
      return reason;
    }

    // Check tick cycle count
    if (tickCyclesSinceCalibration >= this.triggerConfig.tickCycleCount) {
      const reason = `${tickCyclesSinceCalibration} tick cycles since last calibration`;
      this.emit({ type: "trigger_check", triggered: true, reason });
      return reason;
    }

    // Check joy baseline shift
    if (joyAverage !== undefined) {
      const current = await getCurrentCalibration();
      if (current?.derived.joy_baseline !== null && current?.derived.joy_baseline !== undefined) {
        const shift = Math.abs(joyAverage - current.derived.joy_baseline);
        if (shift >= this.triggerConfig.joyShiftThreshold) {
          const reason = `joy baseline shifted by ${shift.toFixed(2)}`;
          this.emit({ type: "trigger_check", triggered: true, reason });
          return reason;
        }
      }
    }

    this.emit({ type: "trigger_check", triggered: false });
    return null;
  }

  /**
   * Update the joy baseline from accumulated signal history.
   * Call periodically (e.g., every tick cycle) so the baseline
   * learns even between calibration cycles.
   */
  async updateJoyBaseline(): Promise<number | null> {
    const baseline = await computeJoyBaseline(this.joyProvider);
    if (baseline === null) return null;

    const current = await getCurrentCalibration();
    if (!current) return null;

    // Only save if baseline actually changed
    if (current.derived.joy_baseline === baseline) return baseline;

    current.derived.joy_baseline = baseline;
    await saveCalibration(current);
    log.info("Joy baseline updated", { baseline, version: current.version });
    return baseline;
  }

  /** Reset trigger counters (e.g. after manual recalibration). */
  resetTriggers(): void {
    interactionsSinceCalibration = 0;
    tickCyclesSinceCalibration = 0;
    this.persistCounters();
  }

  /** Get current trigger counter values. */
  getTriggerCounters(): { interactions: number; tickCycles: number } {
    return {
      interactions: interactionsSinceCalibration,
      tickCycles: tickCyclesSinceCalibration,
    };
  }
}
