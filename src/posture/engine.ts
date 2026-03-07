/**
 * Posture Engine — observes interaction patterns and adapts UI surface.
 *
 * The UI assembles itself around the user:
 * - No interaction → silent mode, Core reaches out proactively
 * - Light touches (pulse checks) → pulse mode
 * - Deep dives (pages, agent logs, settings) → board mode
 *
 * Transitions happen automatically based on intent accumulation.
 * The user can also pin a posture to lock it.
 * Posture decays toward silent over time — if you stop looking, the UI fades.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
  PostureName,
  PostureState,
  PostureSurface,
  InteractionSignal,
} from "./types.js";
import { POSTURE_SURFACE } from "./types.js";

const log = createLogger("posture");
import { BRAIN_DIR } from "../lib/paths.js";
const STATE_PATH = join(BRAIN_DIR, "settings.json");

// ── In-memory state ─────────────────────────────────────────────────────────

const DEFAULT_STATE: PostureState = {
  current: "silent",
  changedAt: new Date().toISOString(),
  pinned: false,
  interactions: {},
  windowStart: new Date().toISOString(),
};

let state: PostureState = { ...DEFAULT_STATE };

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Interactions in a 24h window to trigger escalation */
const ESCALATION_THRESHOLDS = {
  /** Any interaction at all → at least pulse */
  toPulse: 1,
  /** Deep interactions (pages, agents, settings) → board */
  toBoard: 5,
};

/** Hours of silence before decay */
const DECAY_HOURS = {
  /** Board → pulse after this many hours of no interaction */
  boardToPulse: 48,
  /** Pulse → silent after this many hours of no interaction */
  pulseToSilent: 168, // 1 week
};

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window

// ── Core API ────────────────────────────────────────────────────────────────

/** Get current posture. */
export function getPosture(): PostureName {
  return state.current;
}

/** Get current posture state (full details). */
export function getPostureState(): PostureState {
  return { ...state };
}

/** Get the surface map for the current posture. */
export function getSurface(): PostureSurface {
  return POSTURE_SURFACE[state.current];
}

/** Check if a specific surface is available. */
export function hasSurface(surface: keyof PostureSurface): boolean {
  return POSTURE_SURFACE[state.current][surface];
}

/**
 * Record an interaction signal. This is the primary input to the posture engine.
 * Called by route handlers, middleware, or UI events.
 */
export function recordInteraction(signal: InteractionSignal): void {
  // Reset window if expired
  const windowAge = Date.now() - new Date(state.windowStart).getTime();
  if (windowAge > WINDOW_MS) {
    state.interactions = {};
    state.windowStart = new Date().toISOString();
  }

  // Increment counter for this surface
  const key = signal.detail ? `${signal.surface}:${signal.detail}` : signal.surface;
  state.interactions[key] = (state.interactions[key] || 0) + 1;

  // Evaluate transition
  if (!state.pinned) {
    evaluateEscalation(signal);
  }
}

/**
 * Pin the current posture — locks auto-transitions until unpinned.
 * User explicitly chose this level. Respect it.
 */
export function pinPosture(posture: PostureName): void {
  state.current = posture;
  state.pinned = true;
  state.changedAt = new Date().toISOString();
  log.info(`Posture pinned: ${posture}`);
  saveState();
}

/** Unpin — allow auto-transitions again. */
export function unpinPosture(): void {
  state.pinned = false;
  log.info("Posture unpinned — auto-transitions enabled");
  saveState();
}

// ── Transition logic ────────────────────────────────────────────────────────

function evaluateEscalation(signal: InteractionSignal): void {
  const prev = state.current;
  const deepSurfaces = ["pages", "agents", "settings", "page-view"];
  const isDeep = deepSurfaces.includes(signal.surface);

  // Count deep interactions in current window
  const deepCount = Object.entries(state.interactions)
    .filter(([k]) => deepSurfaces.some(s => k.startsWith(s)))
    .reduce((sum, [, v]) => sum + v, 0);

  const totalCount = Object.values(state.interactions)
    .reduce((sum, v) => sum + v, 0);

  if (state.current === "silent") {
    if (totalCount >= ESCALATION_THRESHOLDS.toPulse) {
      transition("pulse");
    }
  } else if (state.current === "pulse") {
    if (isDeep && deepCount >= ESCALATION_THRESHOLDS.toBoard) {
      transition("board");
    }
  }
  // Board doesn't escalate further — it's the max

  if (state.current !== prev) {
    log.info(`Posture escalated: ${prev} → ${state.current} (${signal.surface})`);
  }
}

/** Check for decay — called on a timer or at startup. */
export function evaluateDecay(): void {
  if (state.pinned) return;

  const hoursSinceChange = (Date.now() - new Date(state.changedAt).getTime()) / (60 * 60 * 1000);
  const hoursSinceInteraction = getHoursSinceLastInteraction();
  const prev = state.current;

  if (state.current === "board" && hoursSinceInteraction >= DECAY_HOURS.boardToPulse) {
    transition("pulse");
  } else if (state.current === "pulse" && hoursSinceInteraction >= DECAY_HOURS.pulseToSilent) {
    transition("silent");
  }

  if (state.current !== prev) {
    log.info(`Posture decayed: ${prev} → ${state.current} (${hoursSinceInteraction.toFixed(0)}h silent)`);
  }
}

function getHoursSinceLastInteraction(): number {
  // Use window start + max interaction timestamp
  const windowAge = Date.now() - new Date(state.windowStart).getTime();
  if (Object.keys(state.interactions).length === 0) {
    return (Date.now() - new Date(state.changedAt).getTime()) / (60 * 60 * 1000);
  }
  // If there are interactions in the window, consider the window recent
  return windowAge / (60 * 60 * 1000);
}

function transition(to: PostureName): void {
  state.current = to;
  state.changedAt = new Date().toISOString();
  saveState();
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Load posture state from brain/settings.json. */
export async function loadPosture(): Promise<void> {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    const settings = JSON.parse(raw);
    if (settings.posture) {
      state = {
        current: settings.posture.current || "silent",
        changedAt: settings.posture.changedAt || new Date().toISOString(),
        pinned: settings.posture.pinned || false,
        interactions: settings.posture.interactions || {},
        windowStart: settings.posture.windowStart || new Date().toISOString(),
      };
      log.info(`Posture loaded: ${state.current}${state.pinned ? " (pinned)" : ""}`);
    }
  } catch {
    // No settings yet — start silent
    state = { ...DEFAULT_STATE };
  }

  // Check for decay on load
  evaluateDecay();
}

async function saveState(): Promise<void> {
  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = await readFile(STATE_PATH, "utf-8");
      settings = JSON.parse(raw);
    } catch { /* new file */ }

    settings.posture = {
      current: state.current,
      changedAt: state.changedAt,
      pinned: state.pinned,
      interactions: state.interactions,
      windowStart: state.windowStart,
    };

    await writeFile(STATE_PATH, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to save posture state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Decay timer ─────────────────────────────────────────────────────────────

let decayTimer: ReturnType<typeof setInterval> | null = null;

/** Start the decay check timer — runs hourly. */
export function startDecayTimer(): void {
  if (decayTimer) return;
  decayTimer = setInterval(() => evaluateDecay(), 60 * 60 * 1000);
  log.info("Posture decay timer started (1h interval)");
}

export function stopDecayTimer(): void {
  if (decayTimer) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
}
