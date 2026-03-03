/**
 * TTS sidecar lifecycle manager.
 * Spawns the Piper HTTP server and monitors its health.
 * Graceful degradation — if Piper isn't installed, Core works normally as text chat.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getTtsConfig } from "../settings.js";
import { checkTtsSidecar } from "./client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tts-sidecar");

const VOICES_DIR = join(process.cwd(), "sidecar", "tts", "voices");

// First-run download can take a while; health poll after that is fast
const HEALTH_POLL_INTERVAL = 500; // ms
const HEALTH_POLL_TIMEOUT = 15_000; // ms
const DOWNLOAD_TIMEOUT = 120_000; // ms — model download can be ~100MB

let sidecarProcess: ChildProcess | null = null;
let available = false;

function pythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Resolve the .onnx file path for a voice name.
 * Piper stores downloaded voices as <voice_name>/<voice_name>.onnx inside the data dir.
 * Returns the path if found on disk, otherwise null.
 */
async function findVoiceModel(voice: string): Promise<string | null> {
  // Check both flat and nested layouts that Piper's downloader might use
  const candidates = [
    join(VOICES_DIR, voice, `${voice}.onnx`),
    join(VOICES_DIR, `${voice}.onnx`),
  ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  return null;
}

/**
 * Download a voice model using piper.download_voices if it's not already on disk.
 * Returns the .onnx path on success, null on failure.
 */
async function ensureVoiceModel(voice: string): Promise<string | null> {
  await mkdir(VOICES_DIR, { recursive: true });

  // Already downloaded?
  const existing = await findVoiceModel(voice);
  if (existing) return existing;

  log.info(` Downloading voice "${voice}" (first run, ~100MB)...`);

  const python = pythonCommand();
  return new Promise((resolve) => {
    execFile(
      python,
      ["-m", "piper.download_voices", "--download-dir", VOICES_DIR, voice],
      { timeout: DOWNLOAD_TIMEOUT },
      async (err, _stdout, stderr) => {
        if (err) {
          log.info(` Voice download failed: ${err.message}`);
          if (stderr) log.info(` ${stderr.trim()}`);
          resolve(null);
          return;
        }
        log.info(` Voice downloaded successfully`);
        resolve(await findVoiceModel(voice));
      }
    );
  });
}

/**
 * Start the Piper TTS sidecar.
 * Downloads the voice model if needed, then spawns the HTTP server.
 * Returns true if sidecar is available after startup.
 */
export async function startTtsSidecar(): Promise<boolean> {
  const config = getTtsConfig();
  if (!config.enabled) {
    available = false;
    return false;
  }

  // Check if already running externally
  if (await checkTtsSidecar()) {
    available = true;
    return true;
  }

  // Ensure the voice model .onnx file exists on disk
  const modelPath = await ensureVoiceModel(config.voice);
  if (!modelPath) {
    log.info(` No voice model available — TTS disabled`);
    return false;
  }

  const python = pythonCommand();
  const port = String(config.port);

  try {
    sidecarProcess = spawn(
      python,
      ["-m", "piper.http_server", "--model", modelPath, "--data-dir", VOICES_DIR, "--port", port],
      { stdio: ["ignore", "pipe", "pipe"], detached: false }
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
      if (await checkTtsSidecar()) {
        available = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    log.info(" Timed out waiting for health check");
    stopTtsSidecar();
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(` Spawn failed: ${msg}`);
    return false;
  }
}

/** Check if the TTS sidecar is currently available. */
export function isTtsAvailable(): boolean {
  return available;
}

/** Stop the TTS sidecar process. */
export function stopTtsSidecar(): void {
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
