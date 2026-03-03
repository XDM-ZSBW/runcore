/**
 * Agent Runtime Environment — Error types and codes.
 */

/** Runtime-specific error with structured code and recoverability flag. */
export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean = false,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** All known error codes. */
export const ErrorCodes = {
  // Resource limits
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  MAX_AGENTS_REACHED: "MAX_AGENTS_REACHED",
  MEMORY_LIMIT_EXCEEDED: "MEMORY_LIMIT_EXCEEDED",

  // Lifecycle
  INVALID_TRANSITION: "INVALID_TRANSITION",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  ALREADY_TERMINATED: "ALREADY_TERMINATED",

  // Spawning
  SPAWN_FAILED: "SPAWN_FAILED",
  RESUME_FAILED: "RESUME_FAILED",
  PAUSE_NOT_SUPPORTED: "PAUSE_NOT_SUPPORTED",

  // Execution
  TIMEOUT: "TIMEOUT",
  DRIVER_ERROR: "DRIVER_ERROR",
  MAX_RETRIES_EXCEEDED: "MAX_RETRIES_EXCEEDED",

  // System
  SHUTDOWN_IN_PROGRESS: "SHUTDOWN_IN_PROGRESS",
  REGISTRY_CORRUPT: "REGISTRY_CORRUPT",
  BUS_DELIVERY_FAILED: "BUS_DELIVERY_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
