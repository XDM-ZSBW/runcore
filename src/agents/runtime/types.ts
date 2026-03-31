/**
 * Agent Runtime Environment — Type definitions.
 *
 * Defines the core abstractions for agent lifecycle management,
 * resource allocation, inter-agent messaging, and driver interface.
 */

// ---------------------------------------------------------------------------
// Agent state machine
// ---------------------------------------------------------------------------

/** Finite states an agent instance can occupy. */
export type AgentState =
  | "initializing"
  | "running"
  | "paused"
  | "resuming"
  | "terminating"
  | "terminated"
  | "failed"
  | "completed";

/** All valid state transitions. */
export const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  initializing: ["running", "failed"],
  running: ["paused", "terminating", "completed", "failed"],
  paused: ["resuming", "terminating"],
  resuming: ["running", "failed"],
  terminating: ["terminated"],
  terminated: [],
  failed: [],
  completed: [],
};

/** Terminal states — no further transitions possible. */
export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set([
  "terminated",
  "failed",
  "completed",
]);

// ---------------------------------------------------------------------------
// Agent instance
// ---------------------------------------------------------------------------

/** A runtime-managed agent instance. Links to an AgentTask by taskId. */
export interface AgentInstance {
  id: string;
  taskId: string;
  state: AgentState;
  pid?: number;
  /** Working directory for the agent process. Defaults to process.cwd(). */
  cwd?: string;
  config: AgentInstanceConfig;
  resources: ResourceAllocation;
  metadata: AgentMetadata;
  /** Saved context for pause → resume cycles. */
  checkpointData?: string;
  /** Last runtime error (if state is "failed"). */
  error?: AgentError;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  terminatedAt?: string;
}

/** Per-instance configuration (merged from defaults + request overrides). */
export interface AgentInstanceConfig {
  /** Absolute maximum wall-clock time (ms). Safety net. */
  timeoutMs: number;
  /** Kill the agent if no stdout/stderr output for this many ms. 0 = disabled. */
  staleAfterMs: number;
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  env: Record<string, string>;
  isolation: "shared" | "sandboxed";
  priority: number; // 0 = highest
}

/** Resource limits assigned to a single agent. */
export interface ResourceAllocation {
  memoryLimitMB: number;
  cpuWeight: number; // 1–100 relative weight
}

/** Descriptive metadata attached to an agent instance. */
export interface AgentMetadata {
  label: string;
  origin: "user" | "ai" | "system";
  parentId?: string;
  tags: string[];
}

/** Structured error stored on failed agents. */
export interface AgentError {
  code: string;
  message: string;
  timestamp: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Inter-agent messaging
// ---------------------------------------------------------------------------

/** A message routed between agents via the event bus. */
export interface AgentMessage {
  id: string;
  from: string;       // sender agent ID
  to: string;         // receiver agent ID, or "*" for broadcast
  type: string;       // application-defined message type
  payload: unknown;
  timestamp: string;
  /** For request/response patterns — correlate reply to original. */
  correlationId?: string;
  /** TTL in ms — message expires after this duration. */
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/** Emitted on every state transition. */
export interface LifecycleEvent {
  agentId: string;
  previousState: AgentState;
  newState: AgentState;
  timestamp: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Runtime events (bus topics)
// ---------------------------------------------------------------------------

/** All event types the runtime bus emits. */
export interface RuntimeEvents {
  "agent:lifecycle": LifecycleEvent;
  "agent:message": AgentMessage;
  "agent:error": { agentId: string; error: AgentError };
  "agent:spawned": { agentId: string; pid?: number };
  "agent:completed": { agentId: string; exitCode?: number };
  "agent:failed": { agentId: string; error: AgentError };
  "runtime:resource-warning": { usage: ResourceSnapshot };
  "runtime:shutdown": { reason: string };
}

/** Point-in-time snapshot of resource usage. */
export interface ResourceSnapshot {
  activeAgents: number;
  maxAgents: number;
  totalMemoryMB: number;
  maxMemoryMB: number;
  queuedRequests: number;
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

/**
 * Strategy for how to run an agent process.
 * Implementations handle the platform-specific spawning, pausing, resuming,
 * and terminating. The runtime delegates to the driver for all process ops.
 */
export interface AgentDriver {
  readonly name: string;

  /** Spawn the agent. Returns PID if applicable. */
  spawn(instance: AgentInstance): Promise<number | undefined>;

  /**
   * Pause a running agent. Returns a checkpoint string that can
   * be passed to resume(). Not all drivers support pause — return
   * undefined if unsupported.
   */
  pause(instance: AgentInstance): Promise<string | undefined>;

  /** Resume a paused agent using checkpoint data. Returns new PID. */
  resume(instance: AgentInstance, checkpoint?: string): Promise<number | undefined>;

  /** Terminate the agent. Should be idempotent. */
  terminate(instance: AgentInstance): Promise<void>;

  /** Check if the agent's process is still alive. */
  isAlive(instance: AgentInstance): boolean;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Top-level runtime configuration. */
export interface RuntimeConfig {
  maxConcurrentAgents: number;
  defaultTimeoutMs: number;
  defaultStaleAfterMs: number;
  defaultMaxRetries: number;
  defaultBackoffMs: number;
  defaultBackoffMultiplier: number;
  defaultMaxBackoffMs: number;
  maxTotalMemoryMB: number;
  defaultMemoryLimitMB: number;
  defaultCpuWeight: number;
  monitorIntervalMs: number;
  /** Directory for runtime persistence files. */
  persistDir: string;
}

// ---------------------------------------------------------------------------
// Spawn request — input to RuntimeManager.spawn()
// ---------------------------------------------------------------------------

/** Request to spawn a new agent via the runtime. */
export interface SpawnRequest {
  taskId: string;
  label: string;
  prompt: string;
  cwd?: string;
  origin: "user" | "ai" | "system";
  parentId?: string;
  tags?: string[];
  config?: Partial<AgentInstanceConfig>;
  resources?: Partial<ResourceAllocation>;
}
