/**
 * Agent Runtime Environment — Public API.
 *
 * Re-exports the core runtime components and provides a convenience
 * factory for creating a fully configured RuntimeManager.
 */

// Types
export type {
  AgentState,
  AgentInstance,
  AgentInstanceConfig,
  ResourceAllocation,
  AgentMetadata,
  AgentError,
  AgentMessage,
  LifecycleEvent,
  RuntimeEvents,
  ResourceSnapshot,
  AgentDriver,
  RuntimeConfig,
  SpawnRequest,
} from "./types.js";

export { VALID_TRANSITIONS, TERMINAL_STATES } from "./types.js";

// Errors
export { RuntimeError, ErrorCodes } from "./errors.js";
export type { ErrorCode } from "./errors.js";

// Configuration
export { loadRuntimeConfig, resolveInstanceConfig, resolveResources } from "./config.js";

// Lifecycle state machine
export {
  isValidTransition,
  assertTransition,
  isTerminal,
  transition,
  shouldRetry,
  prepareRetry,
  reachableStates,
  isActive,
} from "./lifecycle.js";

// Resources
export { ResourcePool } from "./resources.js";

// Event bus
export { RuntimeBus } from "./bus.js";

// Registry
export { AgentRegistry } from "./registry.js";

// Driver
export { ClaudeCliDriver } from "./driver.js";

// Manager
export { RuntimeManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { RuntimeManager } from "./manager.js";
import { ClaudeCliDriver } from "./driver.js";
import type { RuntimeConfig } from "./types.js";

/** Module-level singleton. */
let _manager: RuntimeManager | null = null;

/**
 * Create and initialize a RuntimeManager with the default Claude CLI driver.
 * Returns the same instance on subsequent calls (singleton).
 */
export async function createRuntime(
  configOverrides?: Partial<RuntimeConfig>,
): Promise<RuntimeManager> {
  if (_manager) return _manager;

  const driver = new ClaudeCliDriver();
  _manager = new RuntimeManager(driver, configOverrides);
  await _manager.init();

  return _manager;
}

/** Get the current runtime manager (or null if not initialized). */
export function getRuntime(): RuntimeManager | null {
  return _manager;
}

/** Shut down and clear the singleton runtime. */
export async function shutdownRuntime(reason?: string): Promise<void> {
  if (_manager) {
    await _manager.shutdown(reason);
    _manager = null;
  }
}
