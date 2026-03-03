/**
 * Avatar sidecar lifecycle manager.
 * Spawns the MuseTalk FastAPI server and monitors its health.
 * Graceful degradation — if MuseTalk isn't installed, Core falls back to TalkingHead/placeholder.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { getAvatarConfig } from "../settings.js";
import { checkAvatarSidecar } from "./client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("avatar-sidecar");

const HEALTH_POLL_INTERVAL = 1000; // ms
const HEALTH_POLL_TIMEOUT = 60_000; // ms — model loading is slow on first run

let sidecarProcess: ChildProcess | null = null;
let available = false;

function pythonCommand(): string {
  // Use the MuseTalk venv Python if it exists (has all the right deps)
  const config = getAvatarConfig();
  if (config.musetalkPath) {
    const venvPython = process.platform === "win32"
      ? join(config.musetalkPath, ".venv", "Scripts", "python.exe")
      : join(config.musetalkPath, ".venv", "bin", "python");
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Start the MuseTalk avatar sidecar.
 * Verifies the MuseTalk path exists, spawns the FastAPI server, polls for health.
 * Returns true if sidecar is available after startup.
 */
export async function startAvatarSidecar(): Promise<boolean> {
  const config = getAvatarConfig();
  if (!config.enabled) {
    available = false;
    return false;
  }

  if (!config.musetalkPath) {
    log.info(" No musetalkPath configured — avatar disabled");
    available = false;
    return false;
  }

  // Check if already running externally
  if (await checkAvatarSidecar()) {
    available = true;
    return true;
  }

  // Verify MuseTalk path exists
  try {
    await access(config.musetalkPath);
  } catch {
    log.info(` MuseTalk path not found: ${config.musetalkPath}`);
    available = false;
    return false;
  }

  const python = pythonCommand();
  const port = String(config.port);
  const serverScript = join(process.cwd(), "sidecar", "avatar", "server.py");

  try {
    sidecarProcess = spawn(
      python,
      [serverScript, "--port", port, "--musetalk-path", config.musetalkPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      }
    );

    sidecarProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log.info(` ${msg}`);
    });

    sidecarProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log.info(` ${msg}`);
    });

    sidecarProcess.on("error", (err) => {
      log.info(` Failed to start: ${err.message}`);
      available = false;
      sidecarProcess = null;
    });

    sidecarProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log.info(` Exited with code ${code}`);
      }
      available = false;
      sidecarProcess = null;
    });

    // Poll until ready or timeout
    const start = Date.now();
    while (Date.now() - start < HEALTH_POLL_TIMEOUT) {
      if (await checkAvatarSidecar()) {
        available = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    log.info(" Timed out waiting for health check");
    stopAvatarSidecar();
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(` Spawn failed: ${msg}`);
    return false;
  }
}

/** Check if the avatar sidecar is currently available. */
export function isAvatarAvailable(): boolean {
  return available;
}

/** Stop the avatar sidecar process. */
export function stopAvatarSidecar(): void {
  if (sidecarProcess) {
    try {
      sidecarProcess.kill();
    } catch {
      // Already dead
    }
    sidecarProcess = null;
  }
  available = false;
}
