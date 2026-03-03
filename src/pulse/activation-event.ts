/**
 * Unified ActivationEvent Primitive — DASH-102.
 *
 * Centralised entry point for all activation events (voltage pulses and CDT
 * triggers). Decouples CDT sources from PressureIntegrator by providing:
 *
 *   emitCdt()      — CDT sources call this directly (no PressureIntegrator needed)
 *   emitVoltage()  — PressureIntegrator calls this when a pulse fires
 *   onActivation() — subscribe to activation events in real-time
 *
 * The voltage system registers itself via bridgeVoltageSystem() at startup.
 * When a CDT event is emitted, the primitive automatically contributes voltage
 * through the registered bridge — CDT sources don't need to know about voltage.
 */

import { createLogger } from "../utils/logger.js";
import { recordActivation, isCdtRefractory, getCdtVoltageContribution } from "./activation-log.js";
import type {
  ActivationEvent,
  VoltageActivation,
  CdtActivation,
  ActivationListener,
  EmitCdtOptions,
  EmitVoltageOptions,
} from "./types.js";

const log = createLogger("activation-event");

// ─── Voltage bridge ─────────────────────────────────────────────────────────

/** Callback that adds mV to the pressure system and checks for pulse. */
type VoltageContributor = (amount: number) => void;

/** Callback that reads current voltage for snapshot purposes. */
type VoltageReader = () => number;

let voltageContributor: VoltageContributor | null = null;
let voltageReader: VoltageReader | null = null;

/**
 * Register the voltage system so CDT events can contribute tension.
 * Called once by PressureIntegrator during initialisation.
 */
export function bridgeVoltageSystem(opts: {
  contribute: VoltageContributor;
  readVoltage: VoltageReader;
}): void {
  voltageContributor = opts.contribute;
  voltageReader = opts.readVoltage;
  log.info("Voltage bridge registered");
}

/**
 * Unregister the voltage bridge (called on PressureIntegrator shutdown).
 */
export function unbridgeVoltageSystem(): void {
  voltageContributor = null;
  voltageReader = null;
}

// ─── Subscriber pattern ─────────────────────────────────────────────────────

const listeners: ActivationListener[] = [];

/**
 * Subscribe to all activation events (voltage and CDT) in real-time.
 * Returns an unsubscribe function.
 */
export function onActivation(listener: ActivationListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notifyListeners(event: ActivationEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`Activation listener error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Factory helpers ────────────────────────────────────────────────────────

/** Create a VoltageActivation event object. */
export function createVoltageEvent(opts: EmitVoltageOptions): VoltageActivation {
  return {
    type: "voltage",
    triggerId: opts.triggerId,
    anchor: opts.anchor,
    voltageAtTrigger: opts.voltageAtTrigger,
    timestamp: new Date().toISOString(),
  };
}

/** Create a CdtActivation event object. */
export function createCdtEvent(opts: EmitCdtOptions & { voltageAtTrigger?: number }): CdtActivation {
  return {
    type: "cdt",
    triggerId: opts.triggerId,
    sourceKey: opts.sourceKey,
    anchor: opts.anchor,
    voltageAtTrigger: opts.voltageAtTrigger,
    loopsInvolved: opts.loopsInvolved,
    voltageContribution: opts.voltageContribution ?? getCdtVoltageContribution(),
    timestamp: new Date().toISOString(),
  };
}

// ─── Emission API ───────────────────────────────────────────────────────────

/**
 * Emit a CDT activation event.
 *
 * Handles the full pipeline:
 * 1. CDT refractory check (per-source 5 min window)
 * 2. Voltage snapshot
 * 3. Event creation and persistence
 * 4. Voltage contribution (via bridge)
 * 5. Subscriber notification
 *
 * @returns true if emitted, false if suppressed by refractory
 */
export function emitCdt(opts: EmitCdtOptions): boolean {
  // Refractory gate
  if (isCdtRefractory(opts.sourceKey)) {
    log.debug(`CDT suppressed (refractory): ${opts.sourceKey}`);
    return false;
  }

  // Snapshot current voltage if bridge is available
  const currentVoltage = voltageReader?.() ?? undefined;

  const event = createCdtEvent({
    ...opts,
    voltageAtTrigger: currentVoltage != null
      ? Math.round(currentVoltage * 10) / 10
      : undefined,
  });

  // Persist + refractory bookkeeping
  recordActivation(event, opts.sourceKey).catch(() => {});

  // Contribute voltage to the pressure system
  const contribution = event.voltageContribution ?? 0;
  if (contribution > 0 && voltageContributor) {
    voltageContributor(contribution);
    log.debug(
      `CDT +${contribution}mV (${opts.sourceKey}): emitted trigger=${opts.triggerId}`,
    );
  }

  // Notify subscribers
  notifyListeners(event);

  return true;
}

/**
 * Emit a voltage activation event (pulse fired).
 *
 * Called by PressureIntegrator when a pulse fires. Records the event,
 * notifies subscribers.
 *
 * @returns true (voltage events are never suppressed)
 */
export function emitVoltage(opts: EmitVoltageOptions): boolean {
  const event = createVoltageEvent(opts);

  // Persist
  recordActivation(event).catch(() => {});

  // Notify subscribers
  notifyListeners(event);

  return true;
}
