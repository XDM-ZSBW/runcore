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
} from "./types.js";

export { POSTURE_SURFACE, POSTURE_LEVEL } from "./types.js";
