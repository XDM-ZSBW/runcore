/**
 * Tick Runner — the heartbeat state machine.
 *
 * Enforces: Sense → Work → Joy. Strict order. No skipping.
 * Event-driven: events queue, next tick drains the queue.
 * No concurrent ticks. If a tick is running, events wait.
 *
 * Portable: no Dash-specific imports. Sense data comes from
 * an injectable SenseProvider. Default provider returns idle state.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import type {
  TickEvent,
  TickEventType,
  TickPhase,
  TickState,
  TickStatus,
  TickRecord,
  SenseSnapshot,
  WorkOutput,
  JoyMeasurement,
  DotColor,
  SenseProvider,
} from "./types.js";

// ── Lifecycle events (for runtime integration) ─────────────────────────────

export type TickLifecycleEventType =
  | "tick:phase-start"
  | "tick:phase-end"
  | "tick:complete"
  | "tick:error";

export interface TickLifecycleEvent {
  type: TickLifecycleEventType;
  tickId: number;
  phase?: TickPhase;
  state: TickState;
  timestamp: string;
  detail?: string;
}

export type TickLifecycleHandler = (event: TickLifecycleEvent) => void;

const log = createLogger("tick");

// ── Default sense provider (idle) ───────────────────────────────────────────

const idleSenseProvider: SenseProvider = {
  getActiveAgents: async () => 0,
  getFailedAgents: async () => 0,
  getRecentActivityCount: async () => 0,
  getLatestJoy: async () => null,
  getJoyTrend: async () => "unknown",
};

// ── Phase dot state ─────────────────────────────────────────────────────────

interface PhaseDots {
  sense: DotColor;
  work: DotColor;
  joy: DotColor;
}

// ── Tick Runner ─────────────────────────────────────────────────────────────

class TickRunner {
  private state: TickState = "idle";
  private queue: TickEvent[] = [];
  private tickCount = 0;
  private lastTick: TickRecord | null = null;
  private phaseDots: PhaseDots = { sense: "blue", work: "blue", joy: "blue" };
  private draining = false;
  private readonly lifecycleEmitter = new EventEmitter();
  private senseProvider: SenseProvider = idleSenseProvider;

  /** Inject a custom sense provider (instances supply their own). */
  setSenseProvider(provider: SenseProvider): void {
    this.senseProvider = provider;
  }

  // ── Lifecycle subscriptions ───────────────────────────────────────────

  onLifecycle(handler: TickLifecycleHandler): () => void {
    this.lifecycleEmitter.on("tick", handler);
    return () => this.lifecycleEmitter.off("tick", handler);
  }

  private emitLifecycle(event: TickLifecycleEvent): void {
    this.lifecycleEmitter.emit("tick", event);
  }

  // ── Event queue ─────────────────────────────────────────────────────────

  push(type: TickEventType, detail?: string): void {
    const event: TickEvent = {
      type,
      ts: new Date().toISOString(),
      detail,
    };
    this.queue.push(event);
    log.info(`Event queued: ${type}${detail ? " — " + detail : ""} (queue: ${this.queue.length})`);

    if (!this.draining) {
      this.draining = true;
      setImmediate(() => this.drain());
    }
  }

  // ── Drain loop ──────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    while (this.state === "idle" && this.queue.length > 0) {
      const events = this.queue.splice(0);
      try {
        await this.runTick(events);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Tick failed: ${msg}`);
        this.emitLifecycle({
          type: "tick:error",
          tickId: this.tickCount,
          state: this.state,
          timestamp: new Date().toISOString(),
          detail: msg,
        });
        this.phaseDots.joy = "amber";
        this.state = "idle";
      }
    }
    this.draining = false;
  }

  // ── The tick ────────────────────────────────────────────────────────────

  private async runTick(events: TickEvent[]): Promise<void> {
    const tickId = ++this.tickCount;
    const startedAt = new Date().toISOString();

    this.emitLifecycle({ type: "tick:phase-start", tickId, phase: "sense", state: "sense", timestamp: startedAt });
    const snapshot = await this.sense(events);
    this.emitLifecycle({ type: "tick:phase-end", tickId, phase: "sense", state: "sense", timestamp: new Date().toISOString() });

    this.emitLifecycle({ type: "tick:phase-start", tickId, phase: "work", state: "work", timestamp: new Date().toISOString() });
    const output = await this.work(snapshot);
    this.emitLifecycle({ type: "tick:phase-end", tickId, phase: "work", state: "work", timestamp: new Date().toISOString() });

    this.emitLifecycle({ type: "tick:phase-start", tickId, phase: "joy", state: "joy", timestamp: new Date().toISOString() });
    const measurement = await this.joy(snapshot, output);
    this.emitLifecycle({ type: "tick:phase-end", tickId, phase: "joy", state: "joy", timestamp: new Date().toISOString() });

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    this.lastTick = {
      id: tickId,
      startedAt,
      completedAt,
      events,
      sense: snapshot,
      work: output,
      joy: measurement,
      durationMs,
    };

    this.state = "idle";

    this.emitLifecycle({ type: "tick:complete", tickId, state: "idle", timestamp: completedAt, detail: `${durationMs}ms` });

    logActivity({
      source: "system",
      summary: `Tick ${tickId} complete (${durationMs}ms, delta=${measurement.delta})`,
    });

    log.info(`Tick ${tickId} complete (${durationMs}ms, delta=${measurement.delta})`);
  }

  // ── Phase 1: Sense ────────────────────────────────────────────────────

  private async sense(events: TickEvent[]): Promise<SenseSnapshot> {
    this.state = "sense";

    const [activeAgents, failedAgents, recentActivityCount, latestJoy, joyTrend] =
      await Promise.all([
        this.senseProvider.getActiveAgents(),
        this.senseProvider.getFailedAgents(),
        this.senseProvider.getRecentActivityCount(),
        this.senseProvider.getLatestJoy(),
        this.senseProvider.getJoyTrend(),
      ]);

    const snapshot: SenseSnapshot = {
      ts: new Date().toISOString(),
      events,
      activeAgents,
      failedAgents,
      recentActivityCount,
      latestJoy,
      joyTrend,
    };

    if (failedAgents > 0) {
      this.phaseDots.sense = "amber";
    } else if (events.some((e) => e.type === "human_message") || recentActivityCount > 0 || events.length > 0) {
      this.phaseDots.sense = "green";
    } else {
      this.phaseDots.sense = "blue";
    }

    log.info(`Sense: ${events.length} events, ${activeAgents} active, ${failedAgents} failed`);
    return snapshot;
  }

  // ── Phase 2: Work ─────────────────────────────────────────────────────

  private async work(snapshot: SenseSnapshot): Promise<WorkOutput> {
    this.state = "work";

    const hasWork = snapshot.activeAgents > 0 || snapshot.events.length > 0;
    const noop = snapshot.events.length === 0 && snapshot.activeAgents === 0;

    if (snapshot.activeAgents >= 1) {
      this.phaseDots.work = "green";
    } else if (snapshot.failedAgents >= 1) {
      this.phaseDots.work = "amber";
    } else {
      this.phaseDots.work = "blue";
    }

    const summary = noop
      ? "Quiet tick — nothing to do"
      : `${snapshot.activeAgents} agents active, ${snapshot.events.length} events processed`;

    return {
      ts: new Date().toISOString(),
      actionsTaken: hasWork ? 1 : 0,
      errors: [],
      noop,
      summary,
    };
  }

  // ── Phase 3: Joy ──────────────────────────────────────────────────────

  private async joy(snapshot: SenseSnapshot, output: WorkOutput): Promise<JoyMeasurement> {
    this.state = "joy";

    const friction = output.errors.length + snapshot.failedAgents;
    const creation = !output.noop;
    const quiet = output.noop && snapshot.events.length === 0;

    let delta = 0;
    if (creation) delta += 0.3;
    if (friction > 0) delta -= 0.2 * friction;
    if (snapshot.latestJoy !== null && snapshot.latestJoy >= 3) delta += 0.1;
    if (snapshot.joyTrend === "rising") delta += 0.1;
    if (snapshot.joyTrend === "falling") delta -= 0.1;

    if (delta > 0) {
      this.phaseDots.joy = "green";
    } else if (delta < 0 || friction > 0) {
      this.phaseDots.joy = "amber";
    } else {
      this.phaseDots.joy = "blue";
    }

    const measurement: JoyMeasurement = {
      ts: new Date().toISOString(),
      delta: Math.round(delta * 100) / 100,
      friction,
      creation,
      quiet,
    };

    log.info(`Joy: delta=${measurement.delta}, friction=${friction}`);
    return measurement;
  }

  // ── Status ────────────────────────────────────────────────────────────

  getStatus(): TickStatus {
    return {
      state: this.state,
      tickCount: this.tickCount,
      lastTick: this.lastTick,
      queueDepth: this.queue.length,
      phaseDots: { ...this.phaseDots },
    };
  }

  getState(): TickState { return this.state; }
  getPhaseDots(): PhaseDots { return { ...this.phaseDots }; }
  getTickCount(): number { return this.tickCount; }
  getLastTick(): TickRecord | null { return this.lastTick; }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let instance: TickRunner | null = null;

export function getTickRunner(): TickRunner {
  if (!instance) {
    instance = new TickRunner();
    log.info("Tick runner initialized");
  }
  return instance;
}

/** Push an event to the tick runner (convenience wrapper). */
export function tickEvent(type: TickEventType, detail?: string): void {
  getTickRunner().push(type, detail);
}
