/**
 * STT sidecar lifecycle manager.
 * Spawns whisper-server and monitors its health.
 * Graceful degradation — if whisper-server isn't installed, Core works normally as text chat.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { getSttConfig } from "../settings.js";
import { checkSttSidecar } from "./client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("stt-sidecar");

const SIDECAR_DIR = join(process.cwd(), "sidecar", "stt");
const HEALTH_POLL_INTERVAL = 500; // ms
const HEALTH_POLL_TIMEOUT = 15_000; // ms

let sidecarProcess: ChildProcess | null = null;
let available = false;

function binaryPath(): string {
  return process.platform === "win32"
    ? join(SIDECAR_DIR, "whisper-server.exe")
    : join(SIDECAR_DIR, "whisper-server");
}

/**
 * Start the Whisper STT sidecar.
 * Checks if already running, verifies binary + model exist, then spawns.
 * Returns true if sidecar is available after startup.
 */
export async function startSttSidecar(): Promise<boolean> {
  const config = getSttConfig();
  if (!config.enabled) {
    available = false;
    return false;
  }

  // Check if already running externally
  if (await checkSttSidecar()) {
    available = true;
    return true;
  }

  const binary = binaryPath();
  const modelPath = join(SIDECAR_DIR, "models", config.model);

  // Verify binary exists
  try {
    await access(binary);
  } catch {
    log.info(` Binary not found: ${binary}`);
    log.info(` See sidecar/stt/setup.md for install instructions`);
    return false;
  }

  // Verify model exists
  try {
    await access(modelPath);
  } catch {
    log.info(` Model not found: ${modelPath}`);
    log.info(` See sidecar/stt/setup.md for download instructions`);
    return false;
  }

  const port = String(config.port);

  try {
    sidecarProcess = spawn(
      binary,
      ["-m", modelPath, "--port", port, "--host", "127.0.0.1"],
      { cwd: SIDECAR_DIR, stdio: ["ignore", "pipe", "pipe"], detached: false }
    );

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
      if (await checkSttSidecar()) {
        available = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    log.info(" Timed out waiting for health check");
    stopSttSidecar();
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(` Spawn failed: ${msg}`);
    return false;
  }
}

/** Check if the STT sidecar is currently available. */
export function isSttAvailable(): boolean {
  return available;
}

/** Stop the STT sidecar process. */
export function stopSttSidecar(): void {
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
