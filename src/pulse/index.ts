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
