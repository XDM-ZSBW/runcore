import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTask } from "./types.js";
import { writeTask, updateTask, readTask, readTaskOutput, listTasks, LOGS_DIR } from "./store.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { rememberTaskOutcome, recordScar } from "./memory.js";
import { makeCall } from "../twilio/call.js";
import { attemptRecovery, recordRecoveryFailure } from "./recover.js";
import { TaskCooldownManager } from "./cooldown.js";
import { triageAgentOutput } from "./triage.js";
import type { AgentPool } from "./runtime.js";
import { releaseLocks } from "./locks.js";
import { recordAgentSpawn, recordAgentCompletion } from "../metrics/collector.js";
import { recordSpawnRateBlock, recordBridgeReport as recordBridgeReportMetric } from "../metrics/firewall-metrics.js";
import { traceAgentSpawn, withSpan } from "../tracing/instrument.js";
import { getCorrelationId } from "../tracing/correlation.js";
import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveUtilityModel, resolveAgentModelAsync, resolveAgentProvider } from "../settings.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnv, getInstanceName, getInstanceNameLower, getAlertEmailFrom } from "../instance.js";
import { skillRegistry as _skillRegistry } from "../skills/registry.js";
import { getBoardProvider } from "../board/provider.js";
import { BRAIN_DIR } from "../lib/paths.js";
import { processAgentIssues } from "./issues.js";

const log = createLogger("agent-spawn");

/**
 * Update a board task's state/assignee. Best-effort — failures are logged, not thrown.
 * Used to move board items through in_progress → done/todo as agents work.
 * Exported so the monitor can also update board state on recovered completions.
 */
export async function updateBoardTaskState(
  boardTaskId: string,
  changes: { state?: string; assignee?: string | null; agentTaskId?: string },
): Promise<void> {
  try {
    const bp = getBoardProvider() as any;
    const store = bp?.getStore?.();
    if (store) {
      await store.update(boardTaskId, changes);
      log.debug(`Board task ${boardTaskId} updated: ${JSON.stringify(changes)}`);
    }
  } catch (err) {
    log.warn(`Failed to update board task ${boardTaskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Track recent failures — email first, phone only as last resort. */
const recentFailures: { label: string; time: number }[] = [];
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const EMAIL_THRESHOLD = 2; // 2+ failures in window → email
const CALL_THRESHOLD = 5; // 5+ failures in window → phone (last resort)
let lastEmailTime = 0;
let lastCallTime = 0;
const EMAIL_COOLDOWN_MS = 10 * 60 * 1000; // Don't email more than once per 10 min
const CALL_COOLDOWN_MS = 30 * 60 * 1000; // Don't call more than once per 30 min

/**
 * Global spawn rate limiter — prevents burst-spawning agents.
 * Tracks timestamps of recent spawns and enforces minimum spacing.
 */
const recentSpawnTimestamps: number[] = [];
const SPAWN_RATE_WINDOW_MS = 60_000; // 1 minute window
const MAX_SPAWNS_PER_WINDOW = 10; // Max 10 spawns per minute

function isSpawnRateLimited(): boolean {
  const now = Date.now();
  // Prune old entries
  while (recentSpawnTimestamps.length > 0 && recentSpawnTimestamps[0] < now - SPAWN_RATE_WINDOW_MS) {
    recentSpawnTimestamps.shift();
  }
  return recentSpawnTimestamps.length >= MAX_SPAWNS_PER_WINDOW;
}

function recordSpawn(): void {
  recentSpawnTimestamps.push(Date.now());
}

// ─── Skill Enrichment ─────────────────────────────────────────────────────────

/**
 * Enrich a task's prompt with matched skill instructions from the SkillRegistry.
 * Transparent: if the registry isn't initialized or no skills match, returns the
 * original prompt unchanged.
 */
async function enrichPromptWithSkills(task: AgentTask): Promise<string> {
  try {
    const matched = await _skillRegistry.findByTrigger(task.label);
    if (!matched) return task.prompt;

    const content = await _skillRegistry.getContent(matched.id);
    if (!content) return task.prompt;

    const skillPrompts = [`<skill name="${matched.name}" type="${matched.type}">\n${content}\n</skill>`];
    const skillNames = [matched.name];

    log.info(`Enriching agent "${task.label}" with skill: ${skillNames.join(", ")}`, { taskId: task.id });

    return [
      task.prompt,
      "",
      "---",
      "## Relevant Skills",
      "",
      ...skillPrompts,
    ].join("\n");
  } catch (err) {
    log.warn(`Skill enrichment failed for "${task.label}", using original prompt: ${err instanceof Error ? err.message : String(err)}`, { taskId: task.id });
    return task.prompt;
  }
}

/** Map of task ID → spawned ChildProcess (only for tasks we spawned this session). */
const activeProcesses = new Map<string, ChildProcess>();

/** Tasks that fell back from pool to direct — skip recovery to prevent double-retry. */
const poolFallbackTasks = new Set<string>();

/** Track batch membership: sessionId → set of task IDs spawned together. */
const sessionBatches = new Map<string, Set<string>>();

/** Collect results from each agent as they finish (sessionId → results[]) */
const batchResults = new Map<string, Array<{ label: string; status: string }>>();

/** Callback invoked when all agents from a session batch have completed. */
let onBatchComplete: ((sessionId: string, results: Array<{ label: string; status: string }>) => void) | null = null;

/** Register a callback for when an agent batch finishes. */
export function setOnBatchComplete(cb: typeof onBatchComplete): void {
  onBatchComplete = cb;
}

/** Map of task ID → timeout timer. */
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export { activeProcesses };

/** Check if any agents are currently running (active processes or pending batches). */
export function isAgentsBusy(): boolean {
  return activeProcesses.size > 0 || sessionBatches.size > 0;
}

/** Number of currently active agent processes. */
export function activeAgentCount(): number {
  return activeProcesses.size;
}

/** Reference to the runtime pool. Set via setAgentPool() when the pool is initialized. */
let agentPool: AgentPool | null = null;

/** Wire the runtime pool into spawn.ts so spawnAgent delegates to it. */
export function setAgentPool(pool: AgentPool | null): void {
  agentPool = pool;
}

/** Check if the runtime pool is active. */
export function hasAgentPool(): boolean {
  return agentPool !== null && !agentPool.isShuttingDown;
}

/**
 * Spawn the claude CLI for a task.
 *
 * When the runtime AgentPool is available, delegates to it for lifecycle
 * management, resource tracking, circuit breakers, and isolation.
 * Falls back to direct process spawning when the pool isn't initialized.
 *
 * Mutates task in-place (status, pid, startedAt) and writes to disk.
 */
export async function spawnAgent(task: AgentTask): Promise<void> {
  return traceAgentSpawn(task.id, task.label, task.origin, async (span) => {
    const correlationId = getCorrelationId();
    if (correlationId) {
      span.setAttribute("dash.correlation_id", correlationId);
    }
    if (task.sessionId) {
      span.setAttribute("agent.session_id", task.sessionId);
    }

    log.info(`Spawning agent: ${task.label}`, { taskId: task.id, origin: task.origin, sessionId: task.sessionId });

    // Enrich prompt with matched skill instructions (transparent — no-op if registry unavailable)
    task.prompt = await enrichPromptWithSkills(task);

    // Global spawn rate limiter — prevent burst-spawning
    if (isSpawnRateLimited()) {
      log.warn(`Spawn rate-limited, skipping: ${task.label}`, { taskId: task.id });
      span.setAttribute("agent.rate_limited", true);
      recordSpawnRateBlock();
      logActivity({
        source: "agent",
        summary: `Spawn rate-limited, skipping: ${task.label}`,
        detail: `Max ${MAX_SPAWNS_PER_WINDOW} spawns per ${SPAWN_RATE_WINDOW_MS / 1000}s`,
        actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
        reason: "spawn rate limit exceeded",
      });
      return;
    }
    recordSpawn();

    // Delegate to runtime pool when available
    if (agentPool && !agentPool.isShuttingDown) {
      log.debug(`Using pool spawn for: ${task.label}`, { taskId: task.id });
      span.setAttribute("agent.spawn_mode", "pool");
      return spawnViaPool(task);
    }

    // Fallback: direct process spawning (original behavior)
    log.debug(`Using direct spawn for: ${task.label}`, { taskId: task.id });
    span.setAttribute("agent.spawn_mode", "direct");
    return spawnDirect(task);
  });
}

/**
 * Spawn through the AgentPool runtime.
 * The pool handles resource allocation, circuit breakers, isolation, and monitoring.
 */
async function spawnViaPool(task: AgentTask): Promise<void> {
  try {
    const instance = await agentPool!.spawn({
      taskId: task.id,
      label: task.label,
      prompt: task.prompt,
      cwd: task.cwd,
      origin: task.origin,
      tags: task.sessionId ? [`session:${task.sessionId}`] : [],
      config: {
        timeoutMs: task.timeoutMs ?? 600000,
        maxRetries: 2,
        backoffMs: 2000,
        backoffMultiplier: 2,
        maxBackoffMs: 30000,
        env: {},
        isolation: "shared",
        priority: 50,
      },
    });

    // Sync task state from runtime instance
    task.status = "running";
    task.pid = instance.pid;
    task.startedAt = new Date().toISOString();
    await writeTask(task);

    // Move board task to in_progress and write back the agent task ID for causal backrefs
    if (task.boardTaskId) {
      updateBoardTaskState(task.boardTaskId, { state: "in_progress", assignee: `${getInstanceNameLower()}-agent`, agentTaskId: task.id });
    }

    // Track batch membership (still needed for continuation)
    if (task.sessionId) {
      if (!sessionBatches.has(task.sessionId)) {
        sessionBatches.set(task.sessionId, new Set());
      }
      sessionBatches.get(task.sessionId)!.add(task.id);
    }

    // Listen for completion via the runtime bus
    // Use .on() with self-removal instead of .once() to avoid race conditions
    // where another agent's event consumes this listener
    const onCompleted = (data: any) => {
      if (data.agentId === instance.id) {
        agentPool?.runtimeManager.bus.off("agent:completed", onCompleted);
        agentPool?.runtimeManager.bus.off("agent:failed", onFailed);
        handlePoolCompletion(task, "completed", data.exitCode ?? 0);
      }
    };
    const onFailed = (data: any) => {
      if (data.agentId === instance.id) {
        agentPool?.runtimeManager.bus.off("agent:completed", onCompleted);
        agentPool?.runtimeManager.bus.off("agent:failed", onFailed);
        handlePoolCompletion(task, "failed", null);
      }
    };
    agentPool!.runtimeManager.bus.on("agent:completed", onCompleted);
    agentPool!.runtimeManager.bus.on("agent:failed", onFailed);

    recordAgentSpawn();
    logActivity({
      source: "agent",
      summary: `Spawned agent via pool: ${task.label}`,
      detail: `Instance ${instance.id}, PID ${instance.pid}, task ${task.id}`,
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: task.origin === "ai" ? "planner selected from backlog" : "user chat triggered agent",
    });
  } catch (err) {
    // Pool rejected the spawn (circuit breaker, resources, etc.)
    // Fall back to direct spawning, but mark task to skip recovery
    // (pool already handles retries — don't double up with recovery agents)
    poolFallbackTasks.add(task.id);
    logActivity({
      source: "agent",
      summary: `Pool spawn failed, falling back to direct (no recovery): ${task.label}`,
      detail: err instanceof Error ? err.message : String(err),
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "pool spawn failed, falling back",
    });
    return spawnDirect(task);
  }
}

/** Handle completion callbacks when spawned via pool. */
async function handlePoolCompletion(
  task: AgentTask,
  status: "completed" | "failed",
  exitCode: number | null,
): Promise<void> {
  log.info(`Agent ${status}: ${task.label}`, { taskId: task.id, exitCode, sessionId: task.sessionId });

  // Release file locks held by this agent
  releaseLocks(task.id).catch((err) => {
    log.warn(`Failed to release locks for agent ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Record agent completion metric
  if (task.startedAt) {
    const durationMs = Date.now() - new Date(task.startedAt).getTime();
    recordAgentCompletion(durationMs, status === "completed");
  }

  // DASH-143: Record cooldown IMMEDIATELY on failure — before setting
  // board task back to "todo". This closes the race window where the
  // autonomous loop re-plans the same task before batch-level cooldown fires.
  if (status === "failed" && task.boardTaskId) {
    TaskCooldownManager.getInstance().recordFailure(
      task.boardTaskId,
      task.label,
      `Pool terminal failure (exit ${exitCode})`,
    );
  }

  // Update board task state: done on success, back to todo on failure
  if (task.boardTaskId) {
    if (status === "completed") {
      await updateBoardTaskState(task.boardTaskId, { state: "done" });
      // Feed back to insight engine so it stops re-detecting this pattern
      notifyInsightResolved(task.label);
    } else {
      // Failed: move back to todo and clear assignee so it can be retried
      await updateBoardTaskState(task.boardTaskId, { state: "todo", assignee: null });
    }
  }

  const output = await readTaskOutput(task.id).catch(() => "");
  const resultSummary = output.trim().slice(0, 1000) || undefined;

  // Process issue reports from read-only autonomous agents
  if (task.readOnly && status === "completed" && output) {
    processAgentIssues(output, task.id).catch((err) => {
      log.warn(`Failed to process issues from ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Notifications
  const outputSnippet = resultSummary ? `\nOutput:\n${resultSummary}` : "";
  pushNotification({
    timestamp: new Date().toISOString(),
    source: "agent",
    message: `Agent task "${task.label}" ${status} (exit ${exitCode}).${outputSnippet}`,
  });

  // Triage: check if agent surfaced questions for the human
  const needsHuman = await triageAgentOutput(
    { ...task, status, exitCode: exitCode ?? undefined },
    output,
  ).catch(() => false);

  // On failure via pool: the RuntimeManager already handles retries at the
  // instance level (maybeRetry with exponential backoff). Don't also spawn
  // a recovery agent — that creates double-retry fan-out. Only track for
  // phone alerts and record if this was a recovery task that failed.
  if (status === "failed") {
    if (task.label.startsWith("Fix: ")) {
      recordRecoveryFailure();
    }
    if (!needsHuman) {
      trackFailureForAlert(task.label);
    }
  }

  // Post-completion reflection for autonomous tasks (skip for recovery agents —
  // session-level reflection already covers them, and per-agent LLM calls add latency)
  if (!task.label.startsWith("Fix: ")) {
    reflectOnCompletion({ ...task, status, exitCode: exitCode ?? undefined }, output).catch(() => {});
  }

  // Scar evaluation for successful Fix: agents — check if the repair qualifies as a scar
  if (task.label.startsWith("Fix: ") && status === "completed") {
    evaluateScar({ ...task, status, exitCode: exitCode ?? undefined }, output).catch(() => {});
  }

  // Batch continuation
  if (task.sessionId && sessionBatches.has(task.sessionId)) {
    const batch = sessionBatches.get(task.sessionId)!;
    batch.delete(task.id);

    if (!batchResults.has(task.sessionId)) {
      batchResults.set(task.sessionId, []);
    }
    batchResults.get(task.sessionId)!.push({ label: task.label, status });

    if (batch.size === 0) {
      sessionBatches.delete(task.sessionId);
      const allResults = batchResults.get(task.sessionId) ?? [{ label: task.label, status }];
      batchResults.delete(task.sessionId);
      if (onBatchComplete) {
        const sid = task.sessionId!;
        // 500ms settlement: task store writes are sync, just need metadata flush
        setTimeout(() => {
          logActivity({ source: "agent", summary: `Agent batch complete for session ${sid} (${allResults.length} agents)`, actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED", reason: "agent batch completed" });
          Promise.resolve(onBatchComplete!(sid, allResults)).catch((err) => {
            logActivity({ source: "agent", summary: `Auto-continue callback error: ${err instanceof Error ? err.message : String(err)}`, actionLabel: "AUTONOMOUS", reason: "batch continuation error" });
          });
        }, 500);
      }
    }
  }
}

/** Send agent failure alert email via Resend (fire-and-forget). */
async function sendFailureEmail(count: number, names: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("No RESEND_API_KEY — skipping agent failure email");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: `${getInstanceName()} <${getAlertEmailFrom()}>`,
        to: [resolveEnv("ALERT_EMAIL_TO") ?? ""].filter(Boolean),
        subject: `[AGENT ALERT] ${count} agent failures in the last few minutes`,
        html: `<div style="font-family:sans-serif;max-width:600px;">
          <div style="background:#f59e0b;color:white;padding:16px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;">Agent Failures</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;padding:16px;border-radius:0 0 8px 8px;">
            <p><strong>${count} agents</strong> failed within a 5-minute window.</p>
            <p><strong>Agents:</strong> ${names}</p>
            <p style="color:#6b7280;font-size:12px;">Check the agent logs at /ops for details. A phone call will follow only if failures continue to escalate.</p>
          </div>
        </div>`,
      }),
    });
    if (res.ok) {
      logActivity({ source: "agent", summary: `Emailed you about ${count} agent failures` });
    } else {
      log.error("Agent failure email failed", { status: res.status });
    }
  } catch (err) {
    log.error("Agent failure email exception", { error: String(err) });
  }
}

/** Track failure — email first, phone only as last resort. */
function trackFailureForAlert(label: string): void {
  const now = Date.now();
  recentFailures.push({ label, time: now });
  while (recentFailures.length > 0 && recentFailures[0].time < now - FAILURE_WINDOW_MS) {
    recentFailures.shift();
  }

  const count = recentFailures.length;
  const names = recentFailures.map((f) => f.label).join(", ");

  // Tier 1: Email at 2+ failures
  if (count >= EMAIL_THRESHOLD && now - lastEmailTime > EMAIL_COOLDOWN_MS) {
    lastEmailTime = now;
    sendFailureEmail(count, names).catch(() => {});
  }

  // Tier 2: Phone call at 5+ failures (last resort, after email)
  if (count >= CALL_THRESHOLD && now - lastCallTime > CALL_COOLDOWN_MS) {
    lastCallTime = now;
    makeCall({
      message: `Hey, it's ${getInstanceName()}. ${count} agents have failed in the last few minutes. I already sent you an email with details. This is getting serious — please check the logs.`,
    }).then((r) => {
      logActivity({ source: "agent", summary: r.ok ? `Called you about ${count} agent failures (escalated from email)` : `Failed to call: ${r.message}` });
    }).catch(() => {});
  }
}

/** Direct process spawning — original behavior without runtime pool. */
async function spawnDirect(task: AgentTask): Promise<void> {
  const stdoutPath = join(LOGS_DIR, `${task.id}.stdout.log`);
  const stderrPath = join(LOGS_DIR, `${task.id}.stderr.log`);
  const promptPath = join(LOGS_DIR, `${task.id}.prompt.txt`);

  // Write prompt to file to avoid shell escaping issues
  writeFileSync(promptPath, task.prompt, "utf-8");

  // Clean environment: remove CLAUDECODE to allow nested Claude Code sessions.
  // Claude CLI refuses to run inside another session if this env var is set.
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  // Use node as the wrapper — avoids all shell encoding/escaping issues.
  // spawnSync with windowsHide prevents claude from opening a console window.
  const wrapperScript = `
    const fs = require("fs");
    const { spawnSync } = require("child_process");
    const prompt = fs.readFileSync(${JSON.stringify(promptPath)}, "utf-8");
    const r = spawnSync("claude", [
      "--print", "--output-format", "text", "--dangerously-skip-permissions", prompt
    ], {
      cwd: ${JSON.stringify(task.cwd)},
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: ${task.timeoutMs ?? 600000},
      windowsHide: true
    });
    fs.writeFileSync(${JSON.stringify(stdoutPath)}, r.stdout || "", "utf-8");
    fs.writeFileSync(${JSON.stringify(stderrPath)}, r.stderr || "", "utf-8");
    process.exit(r.status || 0);
  `;

  const child = spawn(process.execPath, ["--eval", wrapperScript], {
    cwd: task.cwd,
    detached: true,
    stdio: "ignore",
    env: cleanEnv,
    windowsHide: true,
  });

  // Let the instance exit without killing the child
  child.unref();

  task.status = "running";
  task.pid = child.pid;
  task.startedAt = new Date().toISOString();
  await writeTask(task);

  activeProcesses.set(task.id, child);

  // Move board task to in_progress and write back the agent task ID for causal backrefs
  if (task.boardTaskId) {
    updateBoardTaskState(task.boardTaskId, { state: "in_progress", assignee: `${getInstanceNameLower()}-agent`, agentTaskId: task.id });
  }

  // Track batch: group tasks by sessionId so we know when a batch finishes
  if (task.sessionId) {
    if (!sessionBatches.has(task.sessionId)) {
      sessionBatches.set(task.sessionId, new Set());
    }
    sessionBatches.get(task.sessionId)!.add(task.id);
  }

  recordAgentSpawn();
  logActivity({
    source: "agent",
    summary: `Spawned agent: ${task.label}`,
    detail: `PID ${child.pid}, task ${task.id}`,
    actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
    reason: task.origin === "ai" ? "planner selected from backlog" : "user chat triggered agent",
  });

  // Exit handler
  child.on("exit", async (code) => {
    log.info(`Agent process exited: ${task.label}`, { taskId: task.id, exitCode: code, pid: child.pid });
    activeProcesses.delete(task.id);
    clearTaskTimer(task.id);

    // Release file locks held by this agent
    releaseLocks(task.id).catch((err) => {
      log.warn(`Failed to release locks for agent ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Brief delay to ensure file buffers are flushed.
    // writeFileSync in the wrapper script guarantees data is on disk,
    // but the OS may still be updating file metadata. 100ms is sufficient.
    await new Promise((r) => setTimeout(r, 100));

    const output = await readTaskOutput(task.id);
    const resultSummary = output.trim().slice(0, 1000) || undefined;

    // Determine success: exit 0 is clean success, but a null/non-zero exit code
    // with substantial output likely means the agent did its work but the process
    // exited uncleanly (signal, timeout, claude CLI quirk). Trust the output.
    const hasSubstantialOutput = output.trim().length > 100;
    const finalStatus = code === 0 || (code == null && hasSubstantialOutput)
      ? "completed"
      : "failed";

    // Record agent completion metric
    if (task.startedAt) {
      const durationMs = Date.now() - new Date(task.startedAt).getTime();
      recordAgentCompletion(durationMs, finalStatus === "completed");
    }

    await updateTask(task.id, {
      status: finalStatus,
      exitCode: code ?? undefined,
      finishedAt: new Date().toISOString(),
      resultSummary,
    });

    // DASH-143: Record cooldown IMMEDIATELY on failure — before setting
    // board task back to "todo". Prevents autonomous re-planning race.
    if (finalStatus === "failed" && task.boardTaskId) {
      TaskCooldownManager.getInstance().recordFailure(
        task.boardTaskId,
        task.label,
        `Direct spawn failure (exit ${code})`,
      );
    }

    // Update board task state: done on success, back to todo on failure
    if (task.boardTaskId) {
      if (finalStatus === "completed") {
        await updateBoardTaskState(task.boardTaskId, { state: "done" });
        notifyInsightResolved(task.label);
      } else {
        await updateBoardTaskState(task.boardTaskId, { state: "todo", assignee: null });
      }
    }

    // Durable memory — survives restarts, retrievable by future turns
    rememberTaskOutcome({ ...task, status: finalStatus, exitCode: code ?? undefined }, output).catch(() => {});

    // Post-completion reflection for autonomous tasks (skip for recovery agents —
    // session-level reflection already covers them, and per-agent LLM calls add latency)
    if (!task.label.startsWith("Fix: ")) {
      reflectOnCompletion({ ...task, status: finalStatus, exitCode: code ?? undefined }, output).catch(() => {});
    }

    // Scar evaluation for successful Fix: agents — check if the repair qualifies as a scar
    if (task.label.startsWith("Fix: ") && finalStatus === "completed") {
      evaluateScar({ ...task, status: finalStatus, exitCode: code ?? undefined }, output).catch(() => {});
    }

    logActivity({
      source: "agent",
      summary: `Agent ${finalStatus}: ${task.label}`,
      detail: `Exit code ${code}, task ${task.id}`,
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: `agent ${finalStatus}`,
    });

    const outputSnippet = resultSummary
      ? `\nOutput:\n${resultSummary}`
      : "";
    pushNotification({
      timestamp: new Date().toISOString(),
      source: "agent",
      message: `Agent task "${task.label}" ${finalStatus} (exit ${code}).${outputSnippet}`,
    });

    // Triage: check if agent surfaced questions for the human
    const needsHuman = await triageAgentOutput(
      { ...task, status: finalStatus, exitCode: code ?? undefined },
      output,
    ).catch(() => false);

    // On failure: attempt recovery ONLY if not blocked on human questions
    // and not a pool-fallback task (pool already handles retries)
    if (finalStatus === "failed" && !needsHuman) {
      // Record if this was itself a recovery agent that failed
      if (task.label.startsWith("Fix: ")) {
        recordRecoveryFailure();
      }

      const isPoolFallback = poolFallbackTasks.has(task.id);
      if (isPoolFallback) {
        poolFallbackTasks.delete(task.id);
        logActivity({
          source: "agent",
          summary: `Skipping recovery for pool-fallback task: ${task.label}`,
          actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
          reason: "pool-fallback task — no double retry",
        });
      } else {
        attemptRecovery(
          { ...task, status: "failed", exitCode: code ?? undefined },
          output,
        ).catch(() => {});
      }

      trackFailureForAlert(task.label);
    }

    // Check if this was the last agent in a batch → trigger continuation
    if (task.sessionId && sessionBatches.has(task.sessionId)) {
      const batch = sessionBatches.get(task.sessionId)!;
      batch.delete(task.id);

      // Collect this agent's result
      if (!batchResults.has(task.sessionId)) {
        batchResults.set(task.sessionId, []);
      }
      batchResults.get(task.sessionId)!.push({ label: task.label, status: finalStatus });

      if (batch.size === 0) {
        sessionBatches.delete(task.sessionId);
        const allResults = batchResults.get(task.sessionId) ?? [{ label: task.label, status: finalStatus }];
        batchResults.delete(task.sessionId);
        // All agents done — pass all results to continuation
        if (onBatchComplete) {
          const sid = task.sessionId!;
          // 500ms settlement: task store writes are sync, just need metadata flush
          setTimeout(() => {
            logActivity({ source: "agent", summary: `Agent batch complete for session ${sid} (${allResults.length} agents)`, actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED", reason: "agent batch completed" });
            Promise.resolve(onBatchComplete!(sid, allResults)).catch((err) => {
              logActivity({ source: "agent", summary: `Auto-continue callback error: ${err instanceof Error ? err.message : String(err)}`, actionLabel: "AUTONOMOUS", reason: "batch continuation error" });
            });
          }, 500);
        }
      }
    }
  });

  // Error handler (spawn failure)
  child.on("error", async (err) => {
    activeProcesses.delete(task.id);
    clearTaskTimer(task.id);
    poolFallbackTasks.delete(task.id);

    // Record agent failure metric — balances the in-flight gauge from recordAgentSpawn()
    if (task.startedAt) {
      const durationMs = Date.now() - new Date(task.startedAt).getTime();
      recordAgentCompletion(durationMs, false);
    } else {
      // Spawned but never got startedAt — still need to decrement in-flight
      recordAgentCompletion(0, false);
    }

    // Release file locks held by this agent
    releaseLocks(task.id).catch(() => {});

    await updateTask(task.id, {
      status: "failed",
      error: err.message,
      finishedAt: new Date().toISOString(),
    });

    rememberTaskOutcome({ ...task, status: "failed", error: err.message }).catch(() => {});

    logActivity({
      source: "agent",
      summary: `Agent spawn error: ${task.label}`,
      detail: err.message,
      actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "agent spawn error",
    });

    pushNotification({
      timestamp: new Date().toISOString(),
      source: "agent",
      message: `Agent task "${task.label}" failed to spawn: ${err.message}`,
    });

    // Clean up batch membership so batch completion isn't stuck
    if (task.sessionId && sessionBatches.has(task.sessionId)) {
      const batch = sessionBatches.get(task.sessionId)!;
      batch.delete(task.id);

      if (!batchResults.has(task.sessionId)) {
        batchResults.set(task.sessionId, []);
      }
      batchResults.get(task.sessionId)!.push({ label: task.label, status: "failed" });

      if (batch.size === 0) {
        sessionBatches.delete(task.sessionId);
        const allResults = batchResults.get(task.sessionId) ?? [{ label: task.label, status: "failed" }];
        batchResults.delete(task.sessionId);
        if (onBatchComplete) {
          const sid = task.sessionId!;
          setTimeout(() => {
            Promise.resolve(onBatchComplete!(sid, allResults)).catch(() => {});
          }, 2000);
        }
      }
    }
  });

  // Timeout
  if (task.timeoutMs && task.timeoutMs > 0) {
    const timer = setTimeout(() => {
      if (activeProcesses.has(task.id)) {
        logActivity({
          source: "agent",
          summary: `Agent timed out: ${task.label}`,
          detail: `Killing PID ${child.pid} after ${task.timeoutMs}ms`,
          actionLabel: task.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
          reason: "agent timeout exceeded",
        });
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
          } else {
            child.kill("SIGTERM");
          }
        } catch {}
      }
    }, task.timeoutMs);
    activeTimers.set(task.id, timer);
  }
}

/** Cancel a running agent task. Tries pool first, then direct process kill. */
export async function cancelAgent(taskId: string): Promise<boolean> {
  // Try cancelling via pool (it tracks runtime instances by taskId)
  if (agentPool) {
    const instance = agentPool.runtimeManager.getByTaskId(taskId);
    if (instance) {
      try {
        await agentPool.terminate(instance.id, "Cancelled by user");
      } catch {
        // Fall through to direct cancellation
      }
    }
  }

  // Direct process kill (for legacy/direct spawns)
  const child = activeProcesses.get(taskId);
  if (child) {
    activeProcesses.delete(taskId);
    clearTaskTimer(taskId);
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }

  // Release file locks held by this agent
  releaseLocks(taskId).catch((err) => {
    log.warn(`Failed to release locks on cancel for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Record cancellation as a failed completion to keep in-flight gauge accurate
  const taskRecord = await readTask(taskId);
  if (taskRecord?.startedAt) {
    const durationMs = Date.now() - new Date(taskRecord.startedAt).getTime();
    recordAgentCompletion(durationMs, false);
  }

  const updated = await updateTask(taskId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
  });

  if (updated) {
    logActivity({
      source: "agent",
      summary: `Agent cancelled: ${updated.label}`,
      detail: `Task ${taskId}`,
      actionLabel: updated.origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
      reason: "agent cancelled by user",
    });
    pushNotification({
      timestamp: new Date().toISOString(),
      source: "agent",
      message: `Agent task "${updated.label}" was cancelled.`,
    });
  }

  return updated !== null;
}

// ─── Reflection ───────────────────────────────────────────────────────────────

const reflectionLog = createLogger("reflection");

const REFLECTION_PROMPT = `You are reflecting on a completed autonomous agent task. Answer concisely in JSON:
{
  "movedGoalForward": true/false,
  "hitGuardrail": true/false,
  "adjustment": "what to do differently next time, or null if nothing",
  "summary": "1 sentence: what happened and was it useful?"
}
Be honest. If the task failed or produced nothing useful, say so.`;

async function reflectOnCompletion(task: AgentTask, output: string): Promise<void> {
  // Only reflect on autonomous actions
  if (task.origin !== "ai") return;

  try {
    // Tier 1: Micro-reflection for routine successes — skip LLM call
    const isRoutineSuccess = task.exitCode === 0 && output.trim().length > 100;
    if (isRoutineSuccess) {
      const microReflection = {
        movedGoalForward: true,
        hitGuardrail: false,
        adjustment: undefined,
        summary: `Completed "${task.label}" successfully.`,
      };
      await updateTask(task.id, { reflection: microReflection });
      reflectionLog.info(`Micro-reflection (routine success): "${task.label}"`);
      return;
    }

    // Tier 2: Full LLM reflection for non-routine completions
    const provider = resolveAgentProvider();
    const model = await resolveAgentModelAsync();

    const response = await completeChat({
      messages: [
        { role: "system", content: REFLECTION_PROMPT },
        { role: "user", content: JSON.stringify({
          label: task.label,
          status: task.status,
          output: output.slice(0, 1000),
          exitCode: task.exitCode,
        }) },
      ],
      model,
      provider,
    });

    // Parse JSON response — strip markdown fences if present
    const jsonStr = response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const reflection = JSON.parse(jsonStr);

    // Write reflection to task record
    await updateTask(task.id, { reflection });

    // Log reflective activity entry (only for non-routine cases that warranted LLM analysis)
    logActivity({
      source: "agent",
      summary: `Reflection on "${task.label}": ${reflection.summary}`,
      actionLabel: "REFLECTIVE",
      reason: "post-completion autonomous reflection",
      backref: task.id,
    });

    reflectionLog.info(`Reflected on "${task.label}": ${reflection.summary}`);
  } catch (err) {
    reflectionLog.warn(`Reflection failed for "${task.label}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Scar Evaluation ──────────────────────────────────────────────────────────

const SCAR_EVAL_PROMPT = `You are evaluating whether a completed "Fix:" agent's work qualifies as a scar — a self-repair proven by code, tests, and validation.

A fix qualifies as a scar ONLY if the output shows ALL of these:
1. A clear root cause was identified (the "anchor")
2. Code was changed to correct the defect
3. Tests or validation were added/run to prove the fix works

Respond in JSON:
{
  "isScar": true/false,
  "anchor": "root cause description (or null if not a scar)",
  "woundSummary": "one-line description of the original failure (or null)",
  "artifacts": {
    "prevention": ["measures added to prevent recurrence"],
    "detection": ["signals added to detect the issue earlier"],
    "correction": ["code changes that corrected the defect"],
    "regressionTests": ["test files/cases that guard against regression"]
  }
}

If the fix was partial, untested, or just a workaround, set isScar to false.`;

/**
 * Evaluate whether a completed Fix: agent produced a scar-worthy repair.
 * Called for successful Fix: agents after completion.
 */
async function evaluateScar(task: AgentTask, output: string): Promise<void> {
  // Only evaluate successful Fix: agents
  if (!task.label.startsWith("Fix: ")) return;
  if (task.status !== "completed") return;

  try {
    const provider = resolveAgentProvider();
    const model = await resolveAgentModelAsync();

    const response = await completeChat({
      messages: [
        { role: "system", content: SCAR_EVAL_PROMPT },
        { role: "user", content: JSON.stringify({
          label: task.label,
          output: output.slice(0, 2000),
          exitCode: task.exitCode,
        }) },
      ],
      model,
      provider,
    });

    const jsonStr = response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const evaluation = JSON.parse(jsonStr);

    if (!evaluation.isScar) {
      reflectionLog.info(`Fix "${task.label}" did not qualify as scar`);
      return;
    }

    await recordScar({
      anchor: evaluation.anchor,
      woundSummary: evaluation.woundSummary,
      healedAt: new Date().toISOString(),
      agentId: task.id,
      artifacts: {
        prevention: evaluation.artifacts?.prevention ?? [],
        detection: evaluation.artifacts?.detection ?? [],
        correction: evaluation.artifacts?.correction ?? [],
        regressionTests: evaluation.artifacts?.regressionTests ?? [],
      },
    });

    logActivity({
      source: "agent",
      summary: `Scar recorded for "${task.label}": ${evaluation.woundSummary}`,
      actionLabel: "REFLECTIVE",
      reason: "fix agent produced validated self-repair",
      backref: task.id,
    });
  } catch (err) {
    reflectionLog.warn(`Scar evaluation failed for "${task.label}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Bridge Report ────────────────────────────────────────────────────────────

interface BridgeReport {
  taskId: string;
  taskLabel: string;
  failureCount: number;
  attempts: Array<{ round: number; exitCode: number | null; outputSnippet: string; timestamp: string }>;
  rootCauses: string[];
  recoveryAttempts: string[];
  recommendation: string;
}

/**
 * Generate a consolidated handoff report when a board task hits 3+ failures.
 * Persists to brain/agents/bridge-reports/ and pushes a notification.
 */
export async function generateBridgeReport(
  boardTaskId: string,
  taskLabel: string,
  failureCount: number,
): Promise<void> {
  try {
    const allTasks = await listTasks();
    const related = allTasks
      .filter((t) => t.label === taskLabel || t.label === `Fix: ${taskLabel}`)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    const attempts = related
      .filter((t) => t.label === taskLabel)
      .map((t, i) => ({
        round: i + 1,
        exitCode: t.exitCode ?? null,
        outputSnippet: (t.resultSummary ?? "").slice(0, 300),
        timestamp: t.finishedAt ?? t.createdAt ?? "",
      }));

    const recoveryAttempts = related
      .filter((t) => t.label.startsWith("Fix: "))
      .map((t) => `Recovery ${t.status}: ${(t.resultSummary ?? "").slice(0, 200)}`);

    const rootCauses: string[] = [];
    for (const t of related) {
      if (t.reflection?.adjustment) rootCauses.push(t.reflection.adjustment);
    }

    const report: BridgeReport = {
      taskId: boardTaskId,
      taskLabel,
      failureCount,
      attempts,
      rootCauses: [...new Set(rootCauses)],
      recoveryAttempts,
      recommendation: rootCauses.length > 0
        ? `Repeated root cause: ${rootCauses[0]}. Manual investigation needed.`
        : `${failureCount} failures with no clear root cause. Check agent logs for ${taskLabel}.`,
    };

    const reportText = [
      `## Bridge Report: "${taskLabel}"`,
      `**${failureCount} consecutive failures** — handing off to human.`,
      ``,
      `### Attempts`,
      ...attempts.map((a) => `- Round ${a.round} (exit ${a.exitCode}): ${a.outputSnippet.slice(0, 100)}...`),
      ``,
      `### Root Causes Identified`,
      ...(rootCauses.length > 0 ? rootCauses.map((r) => `- ${r}`) : ["- No root causes identified by reflection"]),
      ``,
      `### Recovery Attempts`,
      ...(recoveryAttempts.length > 0 ? recoveryAttempts.map((r) => `- ${r}`) : ["- None"]),
      ``,
      `### Recommendation`,
      report.recommendation,
    ].join("\n");

    pushNotification({
      timestamp: new Date().toISOString(),
      source: "agent",
      message: reportText,
    });

    recordBridgeReportMetric();
    logActivity({
      source: "agent",
      summary: `Bridge report generated for "${taskLabel}" (${failureCount} failures)`,
      detail: JSON.stringify(report),
      actionLabel: "AUTONOMOUS",
      reason: "structural impasse — repeated same-task failures",
    });

    // Persist as brain document for future reference
    const reportsDir = join(
      BRAIN_DIR,
      "agents", "bridge-reports",
    );
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, `${boardTaskId}-${Date.now()}.md`);
    writeFileSync(reportPath, reportText, "utf-8");
  } catch (err) {
    reflectionLog.warn(`Bridge report failed for "${taskLabel}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

function clearTaskTimer(taskId: string): void {
  const timer = activeTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(taskId);
  }
}

/**
 * Notify the insight engine that a board task (potentially insight-generated) was resolved.
 * Lazy import to avoid circular dependencies.
 */
function notifyInsightResolved(label: string): void {
  import("../services/traceInsights.js")
    .then((mod) => mod.markPatternResolved(label))
    .catch(() => {}); // best-effort
}
