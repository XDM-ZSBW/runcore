/**
 * Search sidecar lifecycle manager.
 * Spawns the Python FastAPI sidecar process and monitors its health.
 * Graceful degradation — if Python or sidecar isn't available, the instance works normally.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { checkSearchSidecar } from "./client.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnv } from "../instance.js";

const log = createLogger("search-sidecar");

const SIDECAR_PORT = resolveEnv("SEARCH_PORT") ?? "3578";
const SIDECAR_DIR = join(process.cwd(), "sidecar", "search");
const HEALTH_POLL_INTERVAL = 500; // ms
const HEALTH_POLL_TIMEOUT = 10_000; // ms

let sidecarProcess: ChildProcess | null = null;
let available = false;

/**
 * Get the right Python command for the current platform.
 */
function pythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Start the search sidecar.
 * First checks if one is already running externally, then spawns if not.
 * Returns true if sidecar is available after startup.
 */
export async function startSidecar(): Promise<boolean> {
  // Check if already running (e.g. started externally)
  if (await checkSearchSidecar()) {
    available = true;
    return true;
  }

  // Spawn the sidecar process
  const python = pythonCommand();
  const script = join(SIDECAR_DIR, "server.py");

  try {
    sidecarProcess = spawn(python, [script, "--port", SIDECAR_PORT], {
      cwd: SIDECAR_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Log stderr for debugging
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

    // Poll /health until ready or timeout
    const start = Date.now();
    while (Date.now() - start < HEALTH_POLL_TIMEOUT) {
      if (await checkSearchSidecar()) {
        available = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    // Timeout — sidecar didn't come up
    log.info(" Timed out waiting for health check");
    stopSidecar();
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(` Spawn failed: ${msg}`);
    return false;
  }
}

/**
 * Check if the sidecar is currently available.
 */
export function isSidecarAvailable(): boolean {
  return available;
}

/**
 * Stop the sidecar process.
 */
export function stopSidecar(): void {
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
