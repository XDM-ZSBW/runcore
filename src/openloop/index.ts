/**
 * Open Loop Protocol — barrel re-exports.
 */

export type {
  OpenLoopState,
  OpenLoopPacket,
  Triad,
  ResonanceMatch,
  ScanRunSummary,
  ResolutionMatch,
  ResolutionScanSummary,
  LoopImpactAction,
  LifecycleAction,
  LifecycleConfig,
  LifecycleRunSummary,
} from "./types.js";

export {
  createLoop,
  loadLoops,
  loadLoopsByState,
  transitionLoop,
  createTriad,
  loadTriads,
} from "./store.js";

export {
  startOpenLoopScanner,
  stopOpenLoopScanner,
  getResonances,
  getLastScanRun,
  triggerOpenLoopScan,
} from "./scanner.js";

export {
  triggerResolutionScan,
  getResolutions,
  getLastResolutionScanRun,
} from "./resolution-scanner.js";

export { foldBack } from "./foldback.js";
export type { FoldBackInput, FoldBackResult } from "./foldback.js";

export { runLoopLifecycle, triggerLoopLifecycle } from "./lifecycle.js";
