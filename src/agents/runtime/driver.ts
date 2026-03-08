/**
 * Agent Runtime Environment — Claude CLI agent driver.
 *
 * Implements the AgentDriver interface using the existing Core agent
 * spawn machinery. This bridges the new runtime layer with the proven
 * process spawning in src/agents/spawn.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
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

/** Map of instance ID → timeout timer. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

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

    const wrapperScript = `
      const fs = require("fs");
      const { spawnSync } = require("child_process");
      const prompt = fs.readFileSync(${JSON.stringify(promptPath)}, "utf-8");
      const r = spawnSync("claude", [
        "--print", "--output-format", "text", "--dangerously-skip-permissions", prompt
      ], {
        cwd: ${JSON.stringify(taskCwd)},
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: ${instance.config.timeoutMs},
        windowsHide: true
      });
      fs.writeFileSync(${JSON.stringify(stdoutPath)}, r.stdout || "", "utf-8");
      fs.writeFileSync(${JSON.stringify(stderrPath)}, r.stderr || "", "utf-8");
      process.exit(r.status || 0);
    `;

    const child = spawn(process.execPath, ["--eval", wrapperScript], {
      cwd: taskCwd,
      detached: true,
      stdio: "ignore",
      env: cleanEnv,
      windowsHide: true,
    });

    child.unref();
    processes.set(instance.id, child);
    log.info("Agent process spawned", { instanceId: instance.id, taskId: instance.taskId, pid: child.pid, label: instance.metadata.label });

    // Wire exit handler — classify exit reason for diagnostics
    child.on("exit", (code, signal) => {
      const reason = signal
        ? `signal:${signal}` // killed externally or by timeout
        : code === null
          ? "exit:null (likely timeout or OOM)"
          : code === 0
            ? "clean exit"
            : `exit code ${code}`;
      log.info("Agent process exited", { instanceId: instance.id, taskId: instance.taskId, exitCode: code, signal, reason });

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

      processes.delete(instance.id);
      clearTimer(instance.id);
      const handler = exitHandlers.get(instance.id);
      if (handler) {
        exitHandlers.delete(instance.id);
        // Small delay for file flush
        setTimeout(() => handler(code), 300);
      }
    });

    // Wire error handler
    child.on("error", (err) => {
      log.error("Agent process error", { instanceId: instance.id, taskId: instance.taskId, error: (err as Error).message });
      processes.delete(instance.id);
      clearTimer(instance.id);
      const handler = exitHandlers.get(instance.id);
      if (handler) {
        exitHandlers.delete(instance.id);
        handler(-1);
      }
    });

    // Set timeout
    if (instance.config.timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (processes.has(instance.id)) {
          this.terminate(instance).catch(() => {});
        }
      }, instance.config.timeoutMs);
      timers.set(instance.id, timer);
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
    log.info("Terminating agent process", { instanceId: instance.id, taskId: instance.taskId, pid: instance.pid });
    const child = processes.get(instance.id);
    clearTimer(instance.id);
    exitHandlers.delete(instance.id);

    if (!child) return;

    processes.delete(instance.id);

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearTimer(instanceId: string): void {
  const timer = timers.get(instanceId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(instanceId);
  }
}
