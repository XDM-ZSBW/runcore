/**
 * Stream emitter — central event hub for the live activity stream.
 *
 * Bridges the activity log, agent runtime, and SSE clients.
 * Maintains stream state (paused, shape, breakpoints).
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type {
  StreamAction,
  StreamActionType,
  ShapeState,
  Breakpoint,
  ControlCommand,
  NudgeColor,
  NudgedAction,
} from "./types.js";
import { DEFAULT_SHAPE } from "./types.js";

const log = createLogger("stream");

type StreamListener = (action: StreamAction) => void;

/** Map activity log sources to stream action types. */
const SOURCE_TO_TYPE: Record<string, StreamActionType> = {
  system: "state",
  agent: "work",
  chat: "work",
  memory: "memory",
  "goal-loop": "sense",
  learn: "memory",
  search: "sense",
  whatsapp: "nerve",
  email: "nerve",
  slack: "nerve",
  calendar: "sense",
  tick: "sense",
};

const MAX_RECENT = 100;

class StreamEmitter {
  private listeners = new Set<StreamListener>();
  private recent: StreamAction[] = [];
  private paused = false;
  private shape: ShapeState = { ...DEFAULT_SHAPE };
  private breakpoints: Breakpoint[] = [];

  /** Emit an action to all listeners. */
  emit(action: Omit<StreamAction, "id" | "timestamp">): void {
    const full: StreamAction = {
      ...action,
      id: `sa_${Date.now()}_${randomBytes(3).toString("hex")}`,
      timestamp: new Date().toISOString(),
    };

    this.recent.push(full);
    if (this.recent.length > MAX_RECENT) {
      this.recent = this.recent.slice(-MAX_RECENT);
    }

    if (this.paused) return;

    // Noise filter — suppress low-priority actions
    if (this.shape.noise > 0 && this.shouldFilter(full)) return;

    for (const listener of this.listeners) {
      try { listener(full); } catch {}
    }

    // Check breakpoints
    const matched = this.checkBreakpoints(full);
    if (matched) {
      this.paused = true;
      log.info(`Stream paused by breakpoint: ${matched.rule}`);
    }
  }

  /** Emit from an activity log entry (source → type mapping). */
  emitFromActivity(source: string, summary: string, detail?: Record<string, unknown>): void {
    this.emit({
      agentId: source,
      type: SOURCE_TO_TYPE[source] ?? "state",
      summary,
      detail,
    });
  }

  /** Subscribe to the stream. Returns unsubscribe function. */
  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Handle a control command from the client. */
  handleCommand(cmd: ControlCommand): void {
    switch (cmd.type) {
      case "pause":
        this.paused = true;
        log.info("Stream paused by user");
        break;
      case "resume":
        this.paused = false;
        log.info("Stream resumed");
        break;
      case "shape":
        Object.assign(this.shape, cmd.state);
        log.info("Shape updated", { ...this.shape });
        break;
      case "breakpoint:add": {
        const bp: Breakpoint = {
          id: `bp_${Date.now()}_${randomBytes(3).toString("hex")}`,
          rule: cmd.rule,
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        this.breakpoints.push(bp);
        log.info(`Breakpoint added: ${bp.rule}`);
        break;
      }
      case "breakpoint:remove":
        this.breakpoints = this.breakpoints.filter((b) => b.id !== cmd.id);
        break;
      case "breakpoint:toggle": {
        const bp = this.breakpoints.find((b) => b.id === cmd.id);
        if (bp) bp.enabled = !bp.enabled;
        break;
      }
    }
  }

  /** Compute a nudge color for an action (default heuristic). */
  nudge(action: StreamAction): NudgedAction {
    let nudge: NudgeColor = "blue";
    if (action.type === "error") nudge = "red";
    else if (action.type === "decision") nudge = "yellow";
    else if (action.type === "memory") nudge = "green";
    else if (action.type === "sense") nudge = "blue";
    else if (action.type === "work") nudge = "green";
    return { ...action, nudge };
  }

  isPaused(): boolean { return this.paused; }
  getShape(): ShapeState { return { ...this.shape }; }
  getBreakpoints(): Breakpoint[] { return [...this.breakpoints]; }
  getRecentActions(limit = 50): StreamAction[] { return this.recent.slice(-limit); }
  getListenerCount(): number { return this.listeners.size; }

  private shouldFilter(action: StreamAction): boolean {
    // Focus filter
    if (this.shape.focus.length > 0 && !this.shape.focus.includes(action.agentId)) {
      return this.shape.noise > 50;
    }
    // State/sense actions are lower priority
    if (this.shape.noise > 70 && (action.type === "state" || action.type === "sense")) {
      return true;
    }
    return false;
  }

  private checkBreakpoints(action: StreamAction): Breakpoint | null {
    for (const bp of this.breakpoints) {
      if (!bp.enabled) continue;
      if (this.matchRule(bp.rule, action)) return bp;
    }
    return null;
  }

  private matchRule(rule: string, action: StreamAction): boolean {
    const parts = rule.split(/\s+/);
    for (const part of parts) {
      if (part.startsWith("type:") && action.type !== part.slice(5)) return false;
      if (part.startsWith("agent:") && action.agentId !== part.slice(6)) return false;
      if (part.startsWith("summary:") && !action.summary.includes(part.slice(8))) return false;
      if (part === "twistable" && !action.twistable) return false;
    }
    return true;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let instance: StreamEmitter | null = null;

export function getStreamEmitter(): StreamEmitter {
  if (!instance) {
    instance = new StreamEmitter();
    log.info("Stream emitter initialized");
  }
  return instance;
}
