/**
 * Metabolic Pulse — type definitions.
 * Tension-based heartbeat that replaces the fixed-interval autonomous timer.
 */

export interface PulseConfig {
  threshold: number;              // Θ — default 60
  refractoryMs: number;           // absolute refractory — default 60_000
  relativeRefractoryMs: number;   // doubled-threshold window — default 300_000
  decayLambda: number;            // λ for exponential decay — default 0.001
  basalLeakMv: number;            // mV added per hour idle — default 10
  basalLeakIntervalMs: number;    // leak check interval — default 3_600_000
}

export interface PulseStatus {
  voltage: number;
  threshold: number;
  effectiveThreshold: number;     // Θ or 2Θ during relative refractory
  refractoryRemaining: number;    // ms until ready, 0 if ready
  lastPulseAge: number;           // ms since last pulse
  pulseCount: number;
  decayRate: number;              // current mV/hour decay
  state: "ready" | "refractory" | "relative-refractory";
}

export interface VoltageWeight {
  source: string;
  baseWeight: number;
  keywords?: string[];            // summary keywords that boost weight
}

/**
 * VoltageSnapshot — a point-in-time record of voltage state.
 * Stored in a ring buffer for debugging pulse behavior and
 * retrospective voltage attribution (Gap 8.1).
 */
export interface VoltageSnapshot {
  timestamp: string;
  voltage: number;           // voltage after this event
  source: string;            // what caused this snapshot (e.g. "board", "user-chat", "pulse-fired")
  delta: number;             // mV change from this event
  fired: boolean;            // did this event trigger a pulse?
  refractory: boolean;       // was the system in refractory when this was recorded?
}

/**
 * Unified ActivationEvent — bridges voltage and CDT activation mechanisms.
 * Discriminated union: type-specific fields enable precise handling while
 * sharing a common base for the unified activation log.
 *
 * DASH-92: deepest architectural seam — semantic CDT actions must be
 * visible to the voltage layer for refractory enforcement and retrospective analysis.
 *
 * DASH-102: promoted to a first-class primitive with factory functions,
 * centralized emission, and subscriber pattern. CDT sources emit directly
 * without coupling to PressureIntegrator.
 */

/** Shared fields for all activation events. */
export interface ActivationEventBase {
  triggerId: string;              // unique ID for this trigger (traceId, insightId, etc.)
  anchor?: string;                // human-readable context (loop anchor, insight title, etc.)
  voltageAtTrigger?: number;      // voltage reading when event was recorded
  timestamp: string;
}

/** A voltage pulse fired by PressureIntegrator when Θ is crossed. */
export interface VoltageActivation extends ActivationEventBase {
  type: "voltage";
}

/** A semantic CDT event from OLP resonance, trace insights, goal loop, etc. */
export interface CdtActivation extends ActivationEventBase {
  type: "cdt";
  sourceKey?: string;             // refractory key (e.g. "olp:ol_abc", "insight:anomaly")
  loopsInvolved?: string[];       // open loop IDs involved in CDT activation
  voltageContribution?: number;   // mV contributed to pressure system
}

/** Discriminated union — the unified ActivationEvent primitive. */
export type ActivationEvent = VoltageActivation | CdtActivation;

/** Options for emitting a CDT activation event. */
export interface EmitCdtOptions {
  triggerId: string;
  sourceKey: string;
  anchor?: string;
  loopsInvolved?: string[];
  voltageContribution?: number;
}

/** Options for emitting a voltage activation event. */
export interface EmitVoltageOptions {
  triggerId: string;
  anchor?: string;
  voltageAtTrigger?: number;
}

/** Callback signature for activation event subscribers. */
export type ActivationListener = (event: ActivationEvent) => void;
