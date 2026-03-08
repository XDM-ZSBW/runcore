/**
 * Tick Cycle — the brain's heartbeat.
 *
 * Sense → Work → Joy. Strict order. Event-driven.
 * No event = no tick. The brain rests.
 */

export { getTickRunner, tickEvent } from "./runner.js";
export type { TickLifecycleEvent, TickLifecycleEventType, TickLifecycleHandler } from "./runner.js";

export type {
  TickPhase,
  TickState,
  TickEvent,
  TickEventType,
  SenseSnapshot,
  WorkOutput,
  JoyMeasurement,
  TickRecord,
  TickStatus,
  DotColor,
  SenseProvider,
} from "./types.js";
