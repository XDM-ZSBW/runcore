/**
 * Governed Agent Spawn — CORE-9
 *
 * High-level entry point for spawning Claude Code agents with full
 * governance controls. Composes:
 *
 * 1. Governance gate (voucher + locked paths + principles)
 * 2. Agent spawning (via existing pool or direct spawn)
 * 3. Heartbeat monitoring (silence + drift detection)
 * 4. Lifecycle management (cleanup on completion/termination)
 *
 * This replaces raw `--dangerously-skip-permissions` with a governed
 * equivalent where vouchers, locked paths, and principles replace the
 * interactive permission prompt.
 */

import type { LongTermMemoryStore } from "../memory/long-term.js";
import type { AgentPool } from "./runtime.js";
import type { SpawnRequest, AgentInstance } from "./runtime/types.js";
import {
  governanceGate,
  revokeGovernanceVoucher,
  narrowScopeCeiling,
  type GovernanceOptions,
  type GovernanceDecision,
  type GovernanceAuditEntry,
} from "./governance.js";
import {
  createHeartbeatTracker,
  removeHeartbeatTracker,
  extractTaskKeywords,
  type HeartbeatConfig,
  type HeartbeatTracker,
} from "./heartbeat.js";
import { logActivity, generateTraceId } from "../activity/log.js";
import { resolveTaskRouteAsync } from "../settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("governed-spawn");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for a governed agent spawn. */
export interface GovernedSpawnRequest {
  /** Task identifier (should be unique). */
  taskId: string;
  /** Human-readable label. */
  label: string;
  /** The actual task prompt. */
  prompt: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Who initiated the spawn. */
  origin: "user" | "ai" | "system";
  /** Tags for grouping/filtering. */
  tags?: string[];
  /** Parent agent ID (for sub-agent spawns). */
  parentId?: string;
  /** Override heartbeat config. */
  heartbeat?: Partial<HeartbeatConfig>;
  /** Override voucher TTL (minutes). */
  voucherTtlMinutes?: number;
  /** Skip voucher for system-level tasks. */
  skipVoucher?: boolean;
  /** Agent type for spawn policy checks (e.g. "administration", "brand"). */
  agentType?: string;
  /** Current total running agent count (for spawn policy max check). */
  currentAgentCount?: number;
  /** Current running count of this specific agent type. */
  currentTypeCount?: number;
  /**
   * Scope ceiling — the outermost directory this agent (and its children)
   * may operate in. Inherited from parent, can only narrow downward.
   * If omitted on a root spawn, defaults to cwd (or process.cwd()).
   */
  scopeCeiling?: string;
}

/** Result of a governed spawn — includes governance metadata. */
export interface GovernedSpawnResult {
  /** Whether the spawn was allowed and succeeded. */
  success: boolean;
  /** The spawned agent instance (if successful). */
  instance?: AgentInstance;
  /** Governance decision details. */
  governance: GovernanceDecision;
  /** Heartbeat tracker (if spawn succeeded). */
  heartbeat?: HeartbeatTracker;
  /** Trace ID linking all activity for this spawn. */
  traceId: string;
  /** Denial reason (if not allowed). */
  deniedReason?: string;
  /**
   * Effective scope ceiling for this agent. Pass this as
   * `scopeCeiling` when spawning child agents to enforce
   * the narrowing constraint.
   */
  scopeCeiling?: string;
}

/** Dependencies injected into the governed spawn system. */
export interface GovernedSpawnDeps {
  /** Long-term memory store for voucher operations. */
  ltm: LongTermMemoryStore;
  /** Agent pool for spawning (preferred). */
  pool?: AgentPool;
}

// ---------------------------------------------------------------------------
// Governed spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code agent with full governance controls.
 *
 * Flow:
 * 1. Run governance gate (voucher + locked paths + principles)
 * 2. If denied → return failure with reason
 * 3. Spawn agent via pool with governed prompt
 * 4. Attach heartbeat tracker
 * 5. Wire lifecycle cleanup (voucher revocation on exit)
 */
export async function governedSpawn(
  request: GovernedSpawnRequest,
  deps: GovernedSpawnDeps,
): Promise<GovernedSpawnResult> {
  const traceId = generateTraceId();
  const { ltm, pool } = deps;

  log.info("Governed spawn requested", {
    taskId: request.taskId,
    label: request.label,
    origin: request.origin,
    traceId,
  });

  // 1. Run governance gate (scope ceiling validated here)
  const govOpts: GovernanceOptions = {
    taskId: request.taskId,
    label: request.label,
    prompt: request.prompt,
    origin: request.origin,
    ltm,
    voucherTtlMinutes: request.voucherTtlMinutes,
    skipVoucher: request.skipVoucher,
    agentType: request.agentType,
    currentAgentCount: request.currentAgentCount,
    currentTypeCount: request.currentTypeCount,
    cwd: request.cwd,
    scopeCeiling: request.scopeCeiling,
  };

  const governance = await governanceGate(govOpts);

  // 2. Check governance decision
  if (!governance.allowed) {
    log.warn("Governed spawn denied", {
      taskId: request.taskId,
      reason: governance.deniedReason,
      traceId,
    });

    return {
      success: false,
      governance,
      traceId,
      deniedReason: governance.deniedReason,
    };
  }

  // 3. Spawn agent via pool
  if (!pool) {
    const reason = "No agent pool available — cannot spawn governed agent";
    log.error(reason, { taskId: request.taskId });

    // Revoke the voucher since we can't use it
    if (governance.voucherToken) {
      await revokeGovernanceVoucher(ltm, governance.voucherToken);
    }

    return {
      success: false,
      governance,
      traceId,
      deniedReason: reason,
    };
  }

  // Compute effective scope ceiling for this agent and its children
  const effectiveCeiling = narrowScopeCeiling(request.scopeCeiling, request.cwd);

  // Resolve model routing for this task type
  const route = await resolveTaskRouteAsync(request.agentType);
  log.info("Task route resolved", {
    taskId: request.taskId,
    agentType: request.agentType,
    provider: route.provider,
    model: route.model ?? "auto",
  });

  let instance: AgentInstance;
  try {

    const spawnRequest: SpawnRequest = {
      taskId: request.taskId,
      label: request.label,
      prompt: governance.governedPrompt,
      cwd: request.cwd,
      origin: request.origin,
      tags: [
        ...(request.tags ?? []),
        "governed",
        governance.voucherToken ? `voucher:${governance.voucherToken}` : "voucher:none",
        `scope-ceiling:${effectiveCeiling}`,
        `route:${route.provider}/${route.model ?? "auto"}`,
      ],
      parentId: request.parentId,
      config: {
        env: {
          // Inject routed provider/model into child agent's environment
          ...(route.provider ? { CORE_TASK_PROVIDER: route.provider } : {}),
          ...(route.model ? { CORE_TASK_MODEL: route.model } : {}),
        },
      },
    };

    instance = await pool.spawn(spawnRequest);

    logActivity({
      source: "agent",
      summary: `Governed agent spawned: ${request.label}`,
      detail: `Instance: ${instance.id}, PID: ${instance.pid}, voucher: ${governance.voucherToken ?? "none"}`,
      traceId,
      actionLabel: request.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "governed-spawn",
    });
  } catch (err) {
    const reason = `Spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    log.error(reason, { taskId: request.taskId, traceId });

    // Revoke voucher on spawn failure
    if (governance.voucherToken) {
      await revokeGovernanceVoucher(ltm, governance.voucherToken);
    }

    return {
      success: false,
      governance,
      traceId,
      deniedReason: reason,
    };
  }

  // 4. Attach heartbeat tracker
  const taskKeywords = extractTaskKeywords(request.prompt);
  const heartbeat = createHeartbeatTracker(
    request.taskId,
    instance.id,
    {
      taskDescription: request.prompt,
      taskKeywords,
      ...request.heartbeat,
    },
    async (instanceId, reason) => {
      // Termination callback from heartbeat
      log.warn("Heartbeat triggered termination", { instanceId, reason, traceId });
      try {
        await pool.terminate(instanceId, reason);
      } catch (err) {
        log.error("Failed to terminate via heartbeat", {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
  heartbeat.start();

  // 5. Wire lifecycle cleanup via bus events
  const cleanupHandler = async (event: { agentId: string; newState: string }) => {
    if (event.agentId !== instance.id) return;

    const terminalStates = new Set(["completed", "failed", "terminated"]);
    if (!terminalStates.has(event.newState)) return;

    // Remove handler
    pool.runtimeManager.bus.off("agent:lifecycle", cleanupHandler);

    // Stop heartbeat
    removeHeartbeatTracker(instance.id);

    // Revoke voucher
    if (governance.voucherToken) {
      await revokeGovernanceVoucher(ltm, governance.voucherToken);
    }

    logActivity({
      source: "agent",
      summary: `Governed agent ${event.newState}: ${request.label}`,
      detail: `Instance: ${instance.id}, voucher revoked: ${governance.voucherToken ?? "none"}`,
      traceId,
      actionLabel: request.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "governed-lifecycle",
    });
  };

  pool.runtimeManager.bus.on("agent:lifecycle", cleanupHandler);

  log.info("Governed spawn complete", {
    taskId: request.taskId,
    instanceId: instance.id,
    pid: instance.pid,
    voucherToken: governance.voucherToken,
    heartbeatKeywords: taskKeywords.slice(0, 5),
    traceId,
  });

  return {
    success: true,
    instance,
    governance,
    heartbeat,
    traceId,
    scopeCeiling: effectiveCeiling,
  };
}
