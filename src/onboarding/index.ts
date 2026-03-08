/**
 * Onboarding module — under 5 minutes, zero forms.
 *
 * Conversational flow: greeting → safe word → calibration → bootstrap → nerve link.
 * Produces a paired human identity, calibrated thresholds, Founder archetype,
 * initialized pulse dots, and optional cross-device nerve link.
 */

// ── Flow orchestrator ──────────────────────────────────────────────────────
export { OnboardingFlow } from "./flow.js";

// ── Conversation engine ──────────────────────────────────────────────────
export {
  OnboardingConversation,
  extractName,
  type SafeWordStep,
  type SafeWordResult,
  type SafeWordResponse,
} from "./conversation.js";

// ── Name extraction ──────────────────────────────────────────────────────
export {
  extractName as extractNameFull,
  validateName,
  type NameExtractionResult,
  type NameValidationResult,
} from "./name-extraction.js";

// ── Safe word ──────────────────────────────────────────────────────────────
export {
  validateSafeWord,
  safeWordsMatch,
  hashSafeWord,
  generateSalt,
  assessStrength,
  strengthMessage,
  type SafeWordStrength,
} from "./safe-word.js";

// ── Bootstrap ──────────────────────────────────────────────────────────────
export { bootstrapAgent, type BootstrapInput, type IdentityPairer, type PairResult } from "./bootstrap.js";

// ── Nerve link ─────────────────────────────────────────────────────────────
export {
  offerNerveLink,
  type NerveLinkManager,
} from "./nerve-link.js";

// ── Phases ──────────────────────────────────────────────────────────────────
export {
  PhaseManager,
  PHASE_SEQUENCE,
  PHASE_DEFINITIONS,
  phaseIndex,
  isValidPhase,
  isValidTransition,
  nextPhase,
  isFirstPhase,
  isFinalPhase,
  phasesBefore,
  phasesAfter,
  type PhaseDefinition,
  type PhaseEvent,
  type PhaseEventListener,
} from "./phases.js";

// ── Types ──────────────────────────────────────────────────────────────────
export type {
  OnboardingPhase,
  OnboardingState,
  OnboardingMessage,
  MessageRole,
  SafeWordRules,
  SafeWordValidation,
  BootstrapResult,
  PulseDotInit,
  NerveLinkOffer,
  OnboardingEvent,
  OnboardingListener,
  Archetype,
  NerveProfile,
} from "./types.js";

export {
  PHASE_ORDER,
  SAFE_WORD_RULES,
  INITIAL_PULSE_DOTS,
  createInitialState,
} from "./types.js";
