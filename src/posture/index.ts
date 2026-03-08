/**
 * Posture module — UI surface assembly around the user.
 *
 * Three modes: silent → pulse → board.
 * Driven by intent accumulation, not configuration.
 */

export {
  getPosture,
  getPostureState,
  getSurface,
  hasSurface,
  recordInteraction,
  pinPosture,
  unpinPosture,
  evaluateDecay,
  loadPosture,
  startDecayTimer,
  stopDecayTimer,
} from "./engine.js";

export {
  postureTracker,
  pageViewTracker,
  requireSurface,
  postureHeader,
} from "./middleware.js";

export type {
  PostureName,
  PostureState,
  PostureSurface,
  InteractionSignal,
  IntentSignalKind,
  IntentSignal,
  NerveProfile,
  DecayPauseConditions,
  PostureConfig,
  PostureTransition,
  TransitionDirection,
} from "./types.js";

export {
  POSTURE_SURFACE,
  POSTURE_LEVEL,
  INTENT_WEIGHTS,
  INSTANT_BOARD_SIGNALS,
  POSTURE_CEILING,
  DEFAULT_POSTURE_CONFIG,
} from "./types.js";
