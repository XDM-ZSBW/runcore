/**
 * Agent Runtime Environment — Claude CLI agent driver.
 *
 * Spawns `claude` directly as an async child process with real-time
 * streaming output to log files. Replaces the old spawnSync wrapper
 * approach that buffered all output until exit.
 *
 * Stale detection: instead of a hard timeout kill, monitors the last
 * time the agent produced output. If no output arrives for `staleAfterMs`,
 * the agent is terminated. An absolute `timeoutMs` ceiling remains as
 * a safety net.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { AgentDriver, AgentInstance } from "./types.js";
import { LOGS_DIR } from "../store.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("agent-driver");

// ---------------------------------------------------------------------------
// Process tracking
// ---------------------------------------------------------------------------

/** Map of instance ID → child process (only for current session). */
const processes = new Map<string, ChildProcess>();

/** Map of instance ID → stale-check interval. */
const staleCheckers = new Map<string, ReturnType<typeof setInterval>>();

/** Map of instance ID → absolute timeout timer. */
const absoluteTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Map of instance ID → timestamp of last output received. */
const lastOutputAt = new Map<string, number>();

/** Map of instance ID → open write streams (for cleanup). */
const streams = new Map<string, WriteStream[]>();

/** Exit handlers registered per instance. */
const exitHandlers = new Map<string, (code: number | null) => void>();

// ---------------------------------------------------------------------------
// Claude CLI Driver
// ---------------------------------------------------------------------------

export class ClaudeCliDriver implements AgentDriver {
  readonly name = "claude-cli";

  /** Register a callback for when a process exits. */
  onExit(instanceId: string, handler: (code: number | null) => void): void {
    exitHandlers.set(instanceId, handler);
  }

  async spawn(instance: AgentInstance): Promise<number | undefined> {
    const stdoutPath = join(LOGS_DIR, `${instance.taskId}.stdout.log`);
    const stderrPath = join(LOGS_DIR, `${instance.taskId}.stderr.log`);
    const promptPath = join(LOGS_DIR, `${instance.taskId}.prompt.txt`);

    // Resolve prompt: if resuming with checkpoint, prepend context
    const prompt = instance.checkpointData
      ? `[Resuming from previous session]\n\nPrevious context:\n${instance.checkpointData}\n\nContinue the task.`
      : this.resolvePrompt(instance);

    writeFileSync(promptPath, prompt, "utf-8");

    // Clean env to allow nested Claude Code sessions
    const cleanEnv = { ...process.env, ...instance.config.env };
    delete cleanEnv.CLAUDECODE;

    const taskCwd = instance.cwd || process.cwd();

    // Spawn claude directly — output streams to files in real time
    const child = spawn(
      "claude",
      ["--print", "--output-format", "text", "--dangerously-skip-permissions", prompt],
      {
        cwd: taskCwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv,
        windowsHide: true,
      },
    );

    child.unref();
    processes.set(instance.id, child);
    lastOutputAt.set(instance.id, Date.now());

    // Open file streams for incremental writes
    const stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(stderrPath, { flags: "w" });
    streams.set(instance.id, [stdoutStream, stderrStream]);

    // Pipe stdout to file, updating last-output timestamp
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        lastOutputAt.set(instance.id, Date.now());
        stdoutStream.write(chunk);
      });
    }

    // Pipe stderr to file, also updating last-output timestamp
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        lastOutputAt.set(instance.id, Date.now());
        stderrStream.write(chunk);
      });
    }

    log.info("Agent process spawned (streaming)", {
      instanceId: instance.id,
      taskId: instance.taskId,
      pid: child.pid,
      label: instance.metadata.label,
      timeoutMs: instance.config.timeoutMs,
      staleAfterMs: instance.config.staleAfterMs,
    });

    // Wire exit handler — classify exit reason for diagnostics
    child.on("exit", (code, signal) => {
      const reason = signal
        ? `signal:${signal}`
        : code === null
          ? "exit:null (likely timeout or OOM)"
          : code === 0
            ? "clean exit"
            : `exit code ${code}`;
      log.info("Agent process exited", {
        instanceId: instance.id,
        taskId: instance.taskId,
        exitCode: code,
        signal,
        reason,
      });

      // Log stderr content for failed exits to aid debugging
      if (code !== 0) {
        import("node:fs/promises").then(({ readFile }) =>
          readFile(stderrPath, "utf-8").then((stderr) => {
            if (stderr.trim()) {
              log.warn("Agent stderr output", { instanceId: instance.id, stderr: stderr.slice(-1000) });
            }
          }),
        ).catch(() => {});
      }

      cleanupInstance(instance.id);
      const handler = exitHandlers.get(instance.id);
      if (handler) {
        exitHandlers.delete(instance.id);
        // Small delay for file flush
        setTimeout(() => handler(code), 300);
      }
    });

    // Wire error handler
    child.on("error", (err) => {
      log.error("Agent process error", {
        instanceId: instance.id,
        taskId: instance.taskId,
        error: (err as Error).message,
      });
      cleanupInstance(instance.id);
      const handler = exitHandlers.get(instance.id);
      if (handler) {
        exitHandlers.delete(instance.id);
        handler(-1);
      }
    });

    // ── Stale detection ──
    // Check every 30s whether the agent has gone silent.
    const staleMs = instance.config.staleAfterMs;
    if (staleMs > 0) {
      const checker = setInterval(() => {
        const last = lastOutputAt.get(instance.id);
        if (!last) return;
        const silent = Date.now() - last;
        if (silent >= staleMs) {
          log.warn("Agent stale — no output detected, terminating", {
            instanceId: instance.id,
            taskId: instance.taskId,
            silentMs: silent,
            staleAfterMs: staleMs,
          });
          this.terminate(instance).catch(() => {});
        }
      }, 30_000);
      staleCheckers.set(instance.id, checker);
    }

    // ── Absolute timeout (safety net) ──
    if (instance.config.timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (processes.has(instance.id)) {
          log.warn("Agent hit absolute timeout ceiling, terminating", {
            instanceId: instance.id,
            taskId: instance.taskId,
            timeoutMs: instance.config.timeoutMs,
          });
          this.terminate(instance).catch(() => {});
        }
      }, instance.config.timeoutMs);
      absoluteTimers.set(instance.id, timer);
    }

    return child.pid;
  }

  async pause(instance: AgentInstance): Promise<string | undefined> {
    log.info("Pausing agent process", { instanceId: instance.id, taskId: instance.taskId });
    // Claude CLI processes can't be truly paused. We kill the process
    // and save partial output as checkpoint data for resumption.
    const child = processes.get(instance.id);
    if (!child) return undefined;

    // Read any output so far as checkpoint
    let checkpoint: string | undefined;
    try {
      const { readFile } = await import("node:fs/promises");
      const stdout = await readFile(
        join(LOGS_DIR, `${instance.taskId}.stdout.log`),
        "utf-8",
      );
      if (stdout.trim()) {
        checkpoint = stdout.trim().slice(0, 2000);
      }
    } catch {
      // No output yet
    }

    // Kill the process
    await this.terminate(instance);

    return checkpoint;
  }

  async resume(instance: AgentInstance, checkpoint?: string): Promise<number | undefined> {
    // Store checkpoint data on the instance for spawn to use
    if (checkpoint) {
      instance.checkpointData = checkpoint;
    }
    return this.spawn(instance);
  }

  async terminate(instance: AgentInstance): Promise<void> {
    log.info("Terminating agent process", {
      instanceId: instance.id,
      taskId: instance.taskId,
      pid: instance.pid,
    });
    const child = processes.get(instance.id);
    cleanupInstance(instance.id);
    exitHandlers.delete(instance.id);

    if (!child) return;

    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      log.debug("Process already exited during terminate", { instanceId: instance.id });
    }
  }

  isAlive(instance: AgentInstance): boolean {
    // Check our tracked processes first
    if (processes.has(instance.id)) return true;

    // Fall back to PID check for recovered processes
    if (instance.pid) {
      try {
        process.kill(instance.pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private resolvePrompt(instance: AgentInstance): string {
    // The prompt is stored on the linked AgentTask.
    // The runtime manager will set this before calling spawn.
    return (instance as AgentInstance & { _prompt?: string })._prompt ?? "";
  }

  /** Get the process for an instance (for monitoring). */
  getProcess(instanceId: string): ChildProcess | undefined {
    return processes.get(instanceId);
  }

  /** Get all tracked instance IDs. */
  getActiveIds(): string[] {
    return Array.from(processes.keys());
  }

  /** Get the timestamp of last output for an instance (for external monitoring). */
  getLastOutputAt(instanceId: string): number | undefined {
    return lastOutputAt.get(instanceId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clean up all tracking state for an instance (timers, streams, maps). */
function cleanupInstance(instanceId: string): void {
  processes.delete(instanceId);

  // Clear stale checker
  const checker = staleCheckers.get(instanceId);
  if (checker) {
    clearInterval(checker);
    staleCheckers.delete(instanceId);
  }

  // Clear absolute timeout
  const timer = absoluteTimers.get(instanceId);
  if (timer) {
    clearTimeout(timer);
    absoluteTimers.delete(instanceId);
  }

  // Close write streams
  const openStreams = streams.get(instanceId);
  if (openStreams) {
    for (const s of openStreams) {
      try { s.end(); } catch { /* already closed */ }
    }
    streams.delete(instanceId);
  }

  lastOutputAt.delete(instanceId);
}
