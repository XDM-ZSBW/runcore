/**
 * Onboarding Flow — the main orchestrator.
 *
 * Under 5 minutes, zero forms. Conversational state machine that walks
 * a new human through: greeting → safe word → calibration → bootstrap → nerve link.
 *
 * Portable: identity pairing and nerve spawning are injectable interfaces.
 */

import { createLogger } from "../utils/logger.js";
import { CalibrationRunner } from "../calibration/runner.js";
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
} from "./safe-word.js";
import { bootstrapAgent, type IdentityPairer } from "./bootstrap.js";
import { offerNerveLink, type NerveLinkManager } from "./nerve-link.js";
import { extractName as extractNameFromModule, validateName } from "./name-extraction.js";

const log = createLogger("onboarding:flow");

// ── Sub-phase tracking for multi-step phases ───────────────────────────────

type SafeWordStep = "ask" | "confirm";
type RecoveryStep = "ask_question" | "ask_answer" | "confirm_answer";

// ── Agent messages ─────────────────────────────────────────────────────────

const GREETING = `Hey — I'm your agent. I don't have a name yet; you'll give me one later if you want. Right now I just need to learn a few things about you so I can start working.\n\nWhat should I call you?`;

const SAFE_WORD_ASK = (name: string) =>
  `Nice to meet you, ${name}. Next I need a safe word — a phrase only you know. This is how you'll prove it's you on any device. No passwords, no accounts, just this word.\n\nPick something memorable. What's your safe word?`;

const SAFE_WORD_CONFIRM = "Say it one more time to confirm.";

const SAFE_WORD_MISMATCH = "Those didn't match. Let's try again — what's your safe word?";

const RECOVERY_ASK_QUESTION = "One more security step. Pick a recovery question — something only you'd know the answer to. If you ever forget your safe word, this is how you'll get back in.\n\nWhat's your question? (Or say \"skip\" to set this up later.)";

const RECOVERY_ASK_ANSWER = (question: string) =>
  `Got it: "${question}"\n\nWhat's the answer?`;

const RECOVERY_CONFIRM_ANSWER = "Say the answer one more time to confirm.";

const RECOVERY_MISMATCH = "Those didn't match. What's your answer?";

const RECOVERY_SET = "Locked. If you forget your safe word, that question will get you back in.\n\n";

const RECOVERY_SKIPPED = "No problem — you can set one up later.\n\n";

const CALIBRATION_INTRO = "Now I need to learn how you like to work. I'll ask a few quick questions — just answer naturally.\n\n";

const NERVE_LINK_OFFER = "Your brain is live on this device. Want to connect another device right now? I'll generate a link you can open on your phone, tablet, or watch. Just say yes or skip.";

const COMPLETE_MESSAGE = (name: string) =>
  `You're set, ${name}. Your brain is live, your safe word is locked, and I know how you like to work. Three dots — sense, work, joy — are running. I'll start quiet and ramp up as I learn.\n\nSay anything when you're ready.`;

// ── Flow class ─────────────────────────────────────────────────────────────

export class OnboardingFlow {
  private state: OnboardingState;
  private listeners: OnboardingListener[] = [];
  private calibrationRunner: CalibrationRunner;
  private nerveLinkManager: NerveLinkManager | null;
  private identityPairer: IdentityPairer | undefined;

  /** Sub-phase state for multi-step phases */
  private safeWordStep: SafeWordStep = "ask";
  private pendingSafeWord: string | null = null;

  /** Recovery question sub-flow state */
  private recoveryStep: RecoveryStep = "ask_question";
  private pendingRecoveryQuestion: string | null = null;
  private pendingRecoveryAnswer: string | null = null;

  /** Conversation log */
  private messages: OnboardingMessage[] = [];

  /** Pairing code from server startup (needed for identity creation) */
  private pairingCode: string | null;

  constructor(options: {
    pairingCode?: string;
    calibrationRunner?: CalibrationRunner;
    nerveLinkManager?: NerveLinkManager | null;
    identityPairer?: IdentityPairer;
  } = {}) {
    this.state = createInitialState();
    this.pairingCode = options.pairingCode ?? null;
    this.calibrationRunner = options.calibrationRunner ?? new CalibrationRunner();
    this.nerveLinkManager = options.nerveLinkManager ?? null;
    this.identityPairer = options.identityPairer;
  }

  // ── Event system ──────────────────────────────────────────────────────

  onEvent(listener: OnboardingListener): void {
    this.listeners.push(listener);
  }

  private emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Message tracking ──────────────────────────────────────────────────

  private agentMessage(content: string): string {
    this.messages.push({
      role: "agent",
      content,
      phase: this.state.phase,
      ts: new Date().toISOString(),
    });
    return content;
  }

  private recordHuman(content: string): void {
    this.messages.push({
      role: "human",
      content,
      phase: this.state.phase,
      ts: new Date().toISOString(),
    });
  }

  // ── Phase transitions ─────────────────────────────────────────────────

  private advanceTo(phase: OnboardingPhase): void {
    this.state.phase = phase;
    this.emit({ type: "phase_entered", phase });
    log.info("Phase entered", { phase });
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Start the onboarding flow. Returns the first agent message (greeting).
   */
  start(): string {
    this.advanceTo("greeting");
    return this.agentMessage(GREETING);
  }

  /**
   * Process a human response. Returns the agent's reply.
   * Drives the state machine forward through phases.
   */
  async respond(input: string): Promise<string> {
    const trimmed = input.trim();
    this.recordHuman(trimmed);

    switch (this.state.phase) {
      case "greeting":
        return this.handleGreeting(trimmed);
      case "safe_word":
        return this.handleSafeWord(trimmed);
      case "recovery_question":
        return this.handleRecoveryQuestion(trimmed);
      case "calibration":
        return this.handleCalibration(trimmed);
      case "nerve_link":
        return this.handleNerveLink(trimmed);
      case "complete":
        return this.agentMessage("Onboarding is already complete.");
      default:
        return this.agentMessage("Something went wrong. Let's start over.");
    }
  }

  // ── Phase handlers ────────────────────────────────────────────────────

  private handleGreeting(input: string): string {
    if (!input) {
      return this.agentMessage("I didn't catch that. What's your name?");
    }

    const name = extractName(input);
    this.state.name = name;
    this.emit({ type: "name_captured", name });

    this.advanceTo("safe_word");
    this.safeWordStep = "ask";
    return this.agentMessage(SAFE_WORD_ASK(name));
  }

  private handleSafeWord(input: string): string {
    if (this.safeWordStep === "ask") {
      const validation = validateSafeWord(input);
      if (!validation.valid) {
        return this.agentMessage(validation.reason!);
      }

      this.pendingSafeWord = input;
      this.safeWordStep = "confirm";
      return this.agentMessage(SAFE_WORD_CONFIRM);
    }

    // Confirm step
    if (!this.pendingSafeWord || !safeWordsMatch(this.pendingSafeWord, input)) {
      this.pendingSafeWord = null;
      this.safeWordStep = "ask";
      return this.agentMessage(SAFE_WORD_MISMATCH);
    }

    // Safe word confirmed
    const strength = assessStrength(this.pendingSafeWord);
    this.state.safeWordConfirmed = true;
    this.emit({ type: "safe_word_created" });

    const msg = strengthMessage(strength);

    this.advanceTo("recovery_question");
    this.recoveryStep = "ask_question";
    return this.agentMessage(msg + "\n\n" + RECOVERY_ASK_QUESTION);
  }

  private handleRecoveryQuestion(input: string): string {
    const lower = input.toLowerCase();

    if (lower === "skip" || lower === "skip it" || lower === "later") {
      this.emit({ type: "recovery_question_skipped" });
      this.advanceTo("calibration");
      return this.startCalibration(RECOVERY_SKIPPED);
    }

    switch (this.recoveryStep) {
      case "ask_question": {
        if (!input || input.length < 3) {
          return this.agentMessage("That's too short for a question. Try something like \"What was my first pet's name?\"");
        }
        this.pendingRecoveryQuestion = input;
        this.recoveryStep = "ask_answer";
        return this.agentMessage(RECOVERY_ASK_ANSWER(input));
      }

      case "ask_answer": {
        if (!input || input.length < 1) {
          return this.agentMessage("I need an answer to lock in. What's the answer to your question?");
        }
        this.pendingRecoveryAnswer = input;
        this.recoveryStep = "confirm_answer";
        return this.agentMessage(RECOVERY_CONFIRM_ANSWER);
      }

      case "confirm_answer": {
        if (!this.pendingRecoveryAnswer || input.trim().toLowerCase() !== this.pendingRecoveryAnswer.trim().toLowerCase()) {
          this.pendingRecoveryAnswer = null;
          this.recoveryStep = "ask_answer";
          return this.agentMessage(RECOVERY_MISMATCH);
        }

        this.state.recoveryQuestionSet = true;
        this.emit({ type: "recovery_question_set" });

        this.advanceTo("calibration");
        return this.startCalibration(RECOVERY_SET);
      }

      default:
        return this.agentMessage("Something went wrong. Let's move on.");
    }
  }

  private startCalibration(prefix: string): string {
    this.emit({ type: "calibration_started" });
    return this.agentMessage(prefix + "\n\n" + CALIBRATION_INTRO + "Let me know when you're ready and I'll start the questions.");
  }

  private async handleCalibration(input: string): Promise<string> {
    if (!this.calibrationRunner.isActive()) {
      const firstQuestion = await this.calibrationRunner.start("onboarding");
      if (!firstQuestion) {
        return this.finishCalibrationAndBootstrap();
      }
      const progress = this.calibrationRunner.progress()!;
      return this.agentMessage(`(${progress.current + 1}/${progress.total}) ${firstQuestion.prompt}`);
    }

    const result = await this.calibrationRunner.respond(input);

    if (result.completed) {
      this.state.calibrated = true;
      this.emit({ type: "calibration_completed" });
      const confirmMsg = result.confirmation ? result.confirmation + "\n\n" : "";
      return this.finishCalibrationAndBootstrap(confirmMsg);
    }

    if (result.next) {
      const progress = this.calibrationRunner.progress()!;
      const confirmPrefix = result.confirmation ? result.confirmation + "\n\n" : "";
      return this.agentMessage(`${confirmPrefix}(${progress.current + 1}/${progress.total}) ${result.next.prompt}`);
    }

    return this.agentMessage("I didn't quite get that. Could you try again?");
  }

  private async finishCalibrationAndBootstrap(prefix?: string): Promise<string> {
    this.advanceTo("bootstrap");

    const bootstrapResult = await bootstrapAgent({
      name: this.state.name!,
      safeWord: this.pendingSafeWord!,
      pairingCode: this.pairingCode,
      recoveryQuestion: this.pendingRecoveryQuestion,
      recoveryAnswer: this.pendingRecoveryAnswer,
      identityPairer: this.identityPairer,
    });

    this.state.bootstrapped = true;
    this.emit({ type: "bootstrap_completed", result: bootstrapResult });

    this.advanceTo("nerve_link");
    this.state.nerveLinkOffered = true;

    const bootstrapMsg = (prefix ?? "") + NERVE_LINK_OFFER;
    return this.agentMessage(bootstrapMsg);
  }

  private async handleNerveLink(input: string): Promise<string> {
    const lower = input.toLowerCase();

    if (lower.includes("skip") || lower.includes("no") || lower.includes("later") || lower.includes("nah")) {
      this.emit({ type: "nerve_link_skipped" });
      return this.completeOnboarding();
    }

    if (lower.includes("yes") || lower.includes("yeah") || lower.includes("sure") || lower.includes("ok")) {
      if (!this.nerveLinkManager) {
        this.emit({ type: "nerve_link_skipped" });
        return this.completeOnboarding();
      }

      const offer = offerNerveLink(this.nerveLinkManager);
      this.emit({ type: "nerve_link_offered", offer });

      const minutes = Math.round((offer.expiresAt - Date.now()) / 60_000);
      return this.agentMessage(
        `Open this link on your other device:\n\n${offer.url}\n\nIt's good for ${minutes} minutes. Enter your safe word when prompted. Say "done" when you've connected, or "skip" to move on.`
      );
    }

    if (lower.includes("done") || lower.includes("connected")) {
      this.state.nerveLinkCompleted = true;
      this.emit({ type: "nerve_link_completed", nerveId: "pending-verification" });
      return this.completeOnboarding();
    }

    return this.agentMessage("Just say yes to connect another device, or skip to finish up.");
  }

  private completeOnboarding(): string {
    this.advanceTo("complete");
    this.state.completedAt = new Date().toISOString();

    const durationMs = Date.now() - new Date(this.state.startedAt).getTime();
    this.emit({ type: "onboarding_completed", durationMs });

    log.info("Onboarding complete", {
      name: this.state.name,
      durationMs,
      nerveLinkCompleted: this.state.nerveLinkCompleted,
    });

    return this.agentMessage(COMPLETE_MESSAGE(this.state.name!));
  }

  // ── State queries ─────────────────────────────────────────────────────

  getState(): OnboardingState { return { ...this.state }; }
  getMessages(): OnboardingMessage[] { return [...this.messages]; }
  isComplete(): boolean { return this.state.phase === "complete"; }
  currentPhase(): OnboardingPhase { return this.state.phase; }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractName(input: string): string {
  const result = extractNameFromModule(input);
  return result.name ?? input.trim();
}
