/**
 * Agent Runtime Environment — Lifecycle state machine.
 *
 * Enforces valid state transitions with guards and hooks.
 * Every transition is validated, timestamped, and emits a LifecycleEvent.
 */

import type { AgentInstance, AgentState, AgentError, LifecycleEvent } from "./types.js";
import { VALID_TRANSITIONS, TERMINAL_STATES } from "./types.js";
import { RuntimeError, ErrorCodes } from "./errors.js";

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

/** Check if a transition from → to is valid per the state machine. */
export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Assert a transition is valid; throw RuntimeError if not. */
export function assertTransition(from: AgentState, to: AgentState): void {
  if (!isValidTransition(from, to)) {
    throw new RuntimeError(
      ErrorCodes.INVALID_TRANSITION,
      `Invalid state transition: ${from} → ${to}`,
      false,
      { from, to, validTargets: VALID_TRANSITIONS[from] },
    );
  }
}

/** Check if an agent is in a terminal state. */
export function isTerminal(state: AgentState): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Transition execution
// ---------------------------------------------------------------------------

export type LifecycleHook = (event: LifecycleEvent) => void | Promise<void>;

/**
 * Apply a state transition to an agent instance.
 *
 * - Validates the transition
 * - Updates state + timestamps
 * - Returns the LifecycleEvent for emission
 *
 * Mutates the instance in place (consistent with existing Core patterns).
 */
export function transition(
  instance: AgentInstance,
  newState: AgentState,
  reason?: string,
  error?: AgentError,
): LifecycleEvent {
  assertTransition(instance.state, newState);

  const event: LifecycleEvent = {
    agentId: instance.id,
    previousState: instance.state,
    newState,
    timestamp: new Date().toISOString(),
    reason,
  };

  instance.state = newState;
  instance.updatedAt = event.timestamp;

  // Set state-specific timestamps
  if (newState === "paused") {
    instance.pausedAt = event.timestamp;
  } else if (isTerminal(newState)) {
    instance.terminatedAt = event.timestamp;
  }

  // Attach error if transitioning to failed
  if (newState === "failed" && error) {
    instance.error = error;
  }

  return event;
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

/**
 * Determine if an agent should be retried after failure.
 * Returns the delay in ms before retry, or null if no retry should occur.
 *
 * Uses exponential backoff with jitter to prevent thundering-herd when
 * multiple agents fail simultaneously.
 */
export function shouldRetry(instance: AgentInstance): number | null {
  const { maxRetries, backoffMs, backoffMultiplier, maxBackoffMs } = instance.config;

  if (instance.retryCount >= maxRetries) return null;
  if (instance.error && !instance.error.recoverable) return null;

  const baseDelay = backoffMs * Math.pow(backoffMultiplier, instance.retryCount);
  // Add ±25% jitter to prevent synchronized retries
  const jitter = baseDelay * 0.25 * (2 * Math.random() - 1);
  const delay = Math.min(Math.max(0, baseDelay + jitter), maxBackoffMs);

  return Math.round(delay);
}

/**
 * Prepare an instance for retry: increment counter, clear error, reset to initializing.
 * Returns the LifecycleEvent for the transition back to initializing.
 *
 * The caller should transition through failed first, then call this to reset.
 * This does a direct state override since failed → initializing isn't in the
 * standard FSM — retries are a runtime-level concern.
 */
export function prepareRetry(instance: AgentInstance): LifecycleEvent {
  const event: LifecycleEvent = {
    agentId: instance.id,
    previousState: instance.state,
    newState: "initializing",
    timestamp: new Date().toISOString(),
    reason: `Retry attempt ${instance.retryCount + 1}/${instance.config.maxRetries}`,
  };

  instance.retryCount += 1;
  instance.state = "initializing";
  instance.error = undefined;
  instance.pid = undefined;
  instance.updatedAt = event.timestamp;
  instance.terminatedAt = undefined;

  return event;
}

// ---------------------------------------------------------------------------
// Convenience queries
// ---------------------------------------------------------------------------

/** Returns all states reachable from the given state. */
export function reachableStates(from: AgentState): AgentState[] {
  return VALID_TRANSITIONS[from] ?? [];
}

/** Check if an agent is currently active (not terminal). */
export function isActive(state: AgentState): boolean {
  return !isTerminal(state);
}
