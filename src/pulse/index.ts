/**
 * Pulse module — metabolic nervous system.
 *
 * Exports the unified ActivationEvent primitive (DASH-102),
 * PressureIntegrator, and supporting types.
 */

// ─── Unified ActivationEvent primitive (DASH-102) ───────────────────────────
export {
  emitCdt,
  emitVoltage,
  onActivation,
  bridgeVoltageSystem,
  unbridgeVoltageSystem,
  createCdtEvent,
  createVoltageEvent,
} from "./activation-event.js";

// ─── Activation log (persistence + refractory) ─────────────────────────────
export {
  recordActivation,
  getActivationEvents,
  isCdtRefractory,
  getCdtVoltageContribution,
} from "./activation-log.js";

// ─── PressureIntegrator (voltage system) ────────────────────────────────────
export {
  PressureIntegrator,
  getPressureIntegrator,
  initPressureIntegrator,
} from "./pressure.js";

// ─── Work signal (inference metrics → pulse) ─────────────────────────────────
export {
  computeWorkSignal,
  computeFromTrend,
  getWorkSignalBreakdown,
  setInferenceMetricsProvider,
  type WorkSignalBreakdown,
  type TrendWindow,
  type InferenceMetricsProvider,
} from "./work.js";

// ─── Flywheel tier system ─────────────────────────────────────────────────────
export {
  calculateFlywheelTier,
  dotStateToTier,
  DOT_PRODUCT_MAP,
  TIER_COLORS,
} from "./tier.js";

export type {
  DotState,
  DotTier,
  DotName,
  DotStatus,
  FlywheelTier,
  FlywheelStatus,
} from "./tier.js";

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  ActivationEvent,
  ActivationEventBase,
  VoltageActivation,
  CdtActivation,
  ActivationListener,
  EmitCdtOptions,
  EmitVoltageOptions,
  PulseConfig,
  PulseStatus,
  VoltageSnapshot,
  VoltageWeight,
} from "./types.js";
