/**
 * Shared Activation Event Log — DASH-92.
 *
 * Records all activation events (voltage pulses and CDT triggers) into a
 * unified log. Provides CDT-specific refractory window enforcement to
 * prevent semantic cascade amplification.
 *
 * Both PressureIntegrator (voltage) and CDT sources (OLP resonance,
 * trace insights, goal loop) write here so that:
 * 1. All activations are retrospectively explainable
 * 2. CDT events optionally contribute voltage tension
 * 3. CDT cascades are damped by per-source refractory windows
 */

import { join } from "node:path";
import { appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import { createLogger } from "../utils/logger.js";
import type { ActivationEvent } from "./types.js";
import { resolveEnv } from "../instance.js";

const log = createLogger("activation-log");

// ─── Constants ──────────────────────────────────────────────────────────────

/** CDT refractory window per source — prevents the same CDT source from
 *  firing repeatedly within this window. */
const CDT_REFRACTORY_MS = 5 * 60 * 1000; // 5 minutes

/** Max in-memory events (ring buffer). */
const MAX_EVENTS = 200;

/** Default voltage contribution from a CDT event. */
const CDT_VOLTAGE_CONTRIBUTION = 15; // mV

// ─── Persistence ─────────────────────────────────────────────────────────────

const BRAIN_DIR = join(resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"));
const ACTIVATION_FILE = join(BRAIN_DIR, "ops", "activations.jsonl");
const ACTIVATION_SCHEMA = JSON.stringify({ _schema: "activations", _version: "1.0" });

let fileEnsured = false;

async function ensureFile(): Promise<void> {
  if (fileEnsured) return;
  await ensureBrainJsonl(ACTIVATION_FILE, ACTIVATION_SCHEMA);
  fileEnsured = true;
}

// ─── State ──────────────────────────────────────────────────────────────────

/** Ring buffer of recent activation events. */
const events: ActivationEvent[] = [];

/** CDT refractory tracker: source key → last fire timestamp. */
const cdtRefractoryMap = new Map<string, number>();

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Check whether a CDT source is in its refractory window.
 * Returns true if the source should be suppressed (still in refractory).
 */
export function isCdtRefractory(sourceKey: string): boolean {
  const lastFire = cdtRefractoryMap.get(sourceKey);
  if (lastFire == null) return false;
  return Date.now() - lastFire < CDT_REFRACTORY_MS;
}

/**
 * Record an activation event to the shared log.
 * For CDT events, enforces refractory window. Returns false if suppressed.
 *
 * @param event    The activation event to record
 * @param sourceKey  CDT source key for refractory tracking (e.g. "olp:ol_abc123")
 * @returns true if recorded, false if suppressed by refractory
 */
export async function recordActivation(
  event: ActivationEvent,
  sourceKey?: string,
): Promise<boolean> {
  // CDT refractory check
  if (event.type === "cdt" && sourceKey) {
    if (isCdtRefractory(sourceKey)) {
      log.debug(`CDT refractory: suppressed ${sourceKey} (window: ${CDT_REFRACTORY_MS}ms)`);
      return false;
    }
    cdtRefractoryMap.set(sourceKey, Date.now());
  }

  // Ring buffer
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }

  // Persist
  try {
    await ensureFile();
    await appendBrainLine(ACTIVATION_FILE, JSON.stringify(event));
  } catch (err) {
    log.warn(`Failed to persist activation event: ${err instanceof Error ? err.message : String(err)}`);
  }

  log.debug(
    `Recorded ${event.type} activation: trigger=${event.triggerId}` +
    (event.anchor ? ` anchor="${event.anchor}"` : "") +
    (event.voltageAtTrigger != null ? ` voltage=${event.voltageAtTrigger}mV` : ""),
  );

  return true;
}

/**
 * Get all recent activation events (newest last).
 */
export function getActivationEvents(): readonly ActivationEvent[] {
  return events;
}

/**
 * Get the default voltage contribution for CDT events.
 */
export function getCdtVoltageContribution(): number {
  return CDT_VOLTAGE_CONTRIBUTION;
}
