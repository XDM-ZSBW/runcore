/**
 * PressureIntegrator — the nervous system of Core.
 *
 * Accumulates voltage from events, decays exponentially over time,
 * and fires a pulse (checkForWork) when tension crosses the threshold.
 * Silent when idle, instantly responsive under pressure.
 *
 * Core metaphor: Action Potential.
 *   Events → voltage accumulation → Θ exceeded → pulse → refractory cooldown
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PulseConfig, PulseStatus, VoltageSnapshot } from "./types.js";
import { emitVoltage, emitCdt, bridgeVoltageSystem, unbridgeVoltageSystem } from "./activation-event.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("pulse");

// ─── Voltage weights (source → base mV) ─────────────────────────────────────

const VOLTAGE_WEIGHTS: Array<{ source: string; weight: number; keywords?: string[] }> = [
  { source: "agent",      weight: 50, keywords: ["fail", "error", "crash", "exception"] },
  { source: "system",     weight: 20, keywords: ["commit", "push", "merge"] },
  { source: "open-loop",  weight: 25 },
  { source: "board",      weight: 70, keywords: ["created", "todo"] },  // new work → cross threshold immediately
  { source: "autonomous", weight: 5 },
  { source: "scheduling", weight: 40, keywords: ["overdue", "missed", "deadline", "skipped"] },
];

const USER_CHAT_WEIGHT = 30;
const DEFAULT_WEIGHT = 5;
const VOLTAGE_HISTORY_MAX = 100;
const VOLTAGE_HISTORY_PATH = join(BRAIN_DIR, "metrics", "voltage-history.jsonl");

function resolveWeight(source: string, summary: string): number {
  // Agent failures are highest priority — but only if it actually failed
  if (source === "agent") {
    const isFail = /fail|error|crash|exception/i.test(summary);
    return isFail ? 50 : DEFAULT_WEIGHT;
  }

  for (const entry of VOLTAGE_WEIGHTS) {
    if (entry.source !== source) continue;
    if (!entry.keywords) return entry.weight;
    const hasKeyword = entry.keywords.some((kw) => summary.toLowerCase().includes(kw));
    return hasKeyword ? entry.weight : DEFAULT_WEIGHT;
  }

  return DEFAULT_WEIGHT;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PulseConfig = {
  threshold: 60,
  refractoryMs: 60_000,
  relativeRefractoryMs: 300_000,
  decayLambda: 0.000001,  // per-ms — half-life ≈ 11.5 minutes
  basalLeakMv: 10,
  basalLeakIntervalMs: 3_600_000,  // 1 hour — just a boredom drip, real triggers are event-driven
};

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: PressureIntegrator | null = null;

export function getPressureIntegrator(): PressureIntegrator | null {
  return instance;
}

export function initPressureIntegrator(
  pulseFn: () => Promise<void>,
  config?: Partial<PulseConfig>,
): PressureIntegrator {
  if (instance) {
    instance.shutdown();
  }
  instance = new PressureIntegrator(pulseFn, config);
  return instance;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class PressureIntegrator {
  private voltage = 0;
  private lastDecayAt = Date.now();
  private lastPulseAt = 0;
  private refractoryUntil = 0;
  private pulseCount = 0;
  private recentEventCount = 0;
  private recentEventWindowStart = Date.now();

  private config: PulseConfig;
  private pulseFn: () => Promise<void>;
  private basalLeakTimer: ReturnType<typeof setInterval> | null = null;

  /** Ring buffer for voltage snapshots (Gap 8.1 — voltage attribution). */
  private voltageHistory: VoltageSnapshot[] = [];
  private historyHead = 0;
  private historySize = 0;

  constructor(pulseFn: () => Promise<void>, config?: Partial<PulseConfig>) {
    this.pulseFn = pulseFn;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startBasalLeak();

    // DASH-102: Register as the voltage bridge so CDT events can contribute tension
    bridgeVoltageSystem({
      contribute: (amount: number) => {
        this.voltage += amount;
        log.debug(`Bridge +${amount}mV: voltage=${this.voltage.toFixed(1)}/${this.getEffectiveThreshold()}`);
        this.maybeFirePulse();
      },
      readVoltage: () => {
        this.applyDecay();
        return this.voltage;
      },
    });

    log.info(`Initialized: Θ=${this.config.threshold}mV, λ=${this.config.decayLambda}, refractory=${this.config.refractoryMs}ms`);
  }

  /** Feed an event into the pressure system. */
  addTension(source: string, summary: string): void {
    // Special handling: user chat messages are detected by the caller
    const weight = source === "user-chat" ? USER_CHAT_WEIGHT : resolveWeight(source, summary);

    this.applyDecay();
    this.voltage += weight;
    this.recentEventCount++;

    // Reset event window every hour
    const now = Date.now();
    if (now - this.recentEventWindowStart > 3_600_000) {
      this.recentEventCount = 1;
      this.recentEventWindowStart = now;
    }

    log.debug(`+${weight}mV (${source}): voltage=${this.voltage.toFixed(1)}/${this.getEffectiveThreshold()}`);

    // Record snapshot before checking pulse (fired flag set by firePulse snapshot)
    this.recordSnapshot(source, weight, false);

    this.maybeFirePulse();
  }

  /** Manually inject voltage (used for user chat detection from server.ts). */
  addUserChatTension(): void {
    this.addTension("user-chat", "user chat message");
  }

  /**
   * Accept a CDT (cognitive dissonance threshold) event.
   * Delegates to the unified ActivationEvent primitive (DASH-102).
   *
   * @deprecated Prefer calling `emitCdt()` from `pulse/activation-event.ts` directly.
   *   This method is kept for backward compatibility during migration.
   */
  addCdtTension(triggerId: string, sourceKey: string, opts?: {
    anchor?: string;
    loopsInvolved?: string[];
    voltageContribution?: number;
  }): void {
    emitCdt({
      triggerId,
      sourceKey,
      anchor: opts?.anchor,
      loopsInvolved: opts?.loopsInvolved,
      voltageContribution: opts?.voltageContribution,
    });
  }

  /** Get current system status for API/HUD. */
  getStatus(): PulseStatus {
    this.applyDecay();
    const now = Date.now();
    const effectiveThreshold = this.getEffectiveThreshold();

    let state: PulseStatus["state"] = "ready";
    let refractoryRemaining = 0;

    if (now < this.refractoryUntil) {
      refractoryRemaining = this.refractoryUntil - now;
      // Check if in absolute or relative refractory
      const absoluteEnd = this.lastPulseAt + this.config.refractoryMs;
      state = now < absoluteEnd ? "refractory" : "relative-refractory";
    }

    // Decay rate in mV/hour: d(voltage)/dt = -λ * voltage, so rate = λ * voltage * 3600000
    const decayRate = this.config.decayLambda * this.voltage * 3_600_000;

    return {
      voltage: Math.round(this.voltage * 10) / 10,
      threshold: this.config.threshold,
      effectiveThreshold,
      refractoryRemaining: Math.round(refractoryRemaining),
      lastPulseAge: this.lastPulseAt > 0 ? now - this.lastPulseAt : -1,
      pulseCount: this.pulseCount,
      decayRate: Math.round(decayRate * 10) / 10,
      state,
    };
  }

  /** Update threshold (e.g. from settings change). */
  setThreshold(theta: number): void {
    this.config.threshold = theta;
    log.info(`Threshold updated: Θ=${theta}mV`);
  }

  /** Return voltage history ordered oldest → newest. */
  getVoltageHistory(): VoltageSnapshot[] {
    if (this.historySize === 0) return [];
    if (this.historySize < VOLTAGE_HISTORY_MAX) {
      return this.voltageHistory.slice(0, this.historySize);
    }
    // Ring buffer wrap: [head..end, 0..head)
    return [
      ...this.voltageHistory.slice(this.historyHead),
      ...this.voltageHistory.slice(0, this.historyHead),
    ];
  }

  /** Clean up timers, unbridge voltage, and persist voltage history. */
  shutdown(): void {
    if (this.basalLeakTimer) {
      clearInterval(this.basalLeakTimer);
      this.basalLeakTimer = null;
    }
    unbridgeVoltageSystem();
    this.persistVoltageHistory();
    log.info("Shut down");
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private applyDecay(): void {
    const now = Date.now();
    const elapsed = now - this.lastDecayAt;
    if (elapsed <= 0) return;

    // Exponential decay: voltage *= e^(-λ * elapsed)
    this.voltage *= Math.exp(-this.config.decayLambda * elapsed);

    // Floor tiny values to zero
    if (this.voltage < 0.1) this.voltage = 0;

    this.lastDecayAt = now;
  }

  private getEffectiveThreshold(): number {
    const now = Date.now();
    if (now < this.refractoryUntil && now >= this.lastPulseAt + this.config.refractoryMs) {
      // Relative refractory: threshold doubles
      return this.config.threshold * 2;
    }
    return this.config.threshold;
  }

  private maybeFirePulse(): void {
    const now = Date.now();

    // Absolute refractory: cannot fire at all
    if (now < this.lastPulseAt + this.config.refractoryMs) return;

    const effectiveThreshold = this.getEffectiveThreshold();
    if (this.voltage < effectiveThreshold) return;

    this.firePulse();
  }

  private firePulse(): void {
    const now = Date.now();
    this.pulseCount++;
    this.lastPulseAt = now;
    this.refractoryUntil = now + this.config.refractoryMs + this.config.relativeRefractoryMs;

    // Snapshot voltage before drain for the activation event
    const preDrainVoltage = this.voltage;

    // Drain voltage by 50% — unaddressed tension persists
    this.voltage *= 0.5;

    log.info(`PULSE #${this.pulseCount} fired at ${this.voltage.toFixed(1)}mV (post-drain). Refractory until +${this.config.refractoryMs}ms absolute, +${this.config.relativeRefractoryMs}ms relative`);

    // Record pulse-fired snapshot (delta is the drain amount, negative)
    this.recordSnapshot("pulse-fired", -(preDrainVoltage * 0.5), true);

    // DASH-102: Emit voltage activation via unified primitive
    emitVoltage({
      triggerId: `pulse_${this.pulseCount}`,
      anchor: `Metabolic pulse #${this.pulseCount}`,
      voltageAtTrigger: Math.round(preDrainVoltage * 10) / 10,
    });

    logActivity({
      source: "system",
      summary: `Metabolic pulse #${this.pulseCount} fired — tension threshold crossed`,
      actionLabel: "AUTONOMOUS",
      reason: "pressure integrator threshold exceeded",
    });

    // Fire the pulse function asynchronously — don't block the event that triggered it
    this.pulseFn().catch((err) => {
      log.error(`Pulse function error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private recordSnapshot(source: string, delta: number, fired: boolean): void {
    const snap: VoltageSnapshot = {
      timestamp: new Date().toISOString(),
      voltage: Math.round(this.voltage * 10) / 10,
      source,
      delta: Math.round(delta * 10) / 10,
      fired,
      refractory: Date.now() < this.refractoryUntil,
    };

    if (this.historySize < VOLTAGE_HISTORY_MAX) {
      this.voltageHistory.push(snap);
      this.historySize++;
    } else {
      this.voltageHistory[this.historyHead] = snap;
      this.historyHead = (this.historyHead + 1) % VOLTAGE_HISTORY_MAX;
    }
  }

  private persistVoltageHistory(): void {
    const history = this.getVoltageHistory();
    if (history.length === 0) return;
    try {
      const lines = history.map((s) => JSON.stringify(s)).join("\n") + "\n";
      appendFileSync(VOLTAGE_HISTORY_PATH, lines, "utf-8");
      log.info(`Persisted ${history.length} voltage snapshots to ${VOLTAGE_HISTORY_PATH}`);
    } catch (err) {
      log.error(`Failed to persist voltage history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Board-aware basal leak — checks every 15min.
   *
   * Slow background drip for total silence. Only matters when zero
   * events are flowing. Real work triggers come from logActivity →
   * addTension (event-driven, not polled).
   */
  private startBasalLeak(): void {
    this.basalLeakTimer = setInterval(() => {
      if (this.recentEventCount >= 5) {
        log.debug(`Basal leak skipped: ${this.recentEventCount} events in window`);
        return;
      }

      this.applyDecay();
      this.voltage += this.config.basalLeakMv;
      log.debug(`Basal leak: +${this.config.basalLeakMv}mV → ${this.voltage.toFixed(1)}mV`);

      this.maybeFirePulse();
    }, this.config.basalLeakIntervalMs);
  }
}
