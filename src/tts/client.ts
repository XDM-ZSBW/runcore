/**
 * TTS client — sends text to the Piper HTTP server and returns WAV audio.
 * Piper's API is POST / with JSON body {"text": "..."}, returns WAV bytes.
 * All functions are safe — they return null on any failure.
 */

import { getTtsConfig } from "../settings.js";

function baseUrl(): string {
  return `http://127.0.0.1:${getTtsConfig().port}`;
}

/**
 * Health probe — hit GET /voices (a lightweight list endpoint).
 * 3-second timeout, returns false on any failure.
 */
export async function checkTtsSidecar(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/voices`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Synthesize text to WAV audio via Piper.
 * POST / with JSON {"text": "..."} → WAV bytes.
 * Returns a Buffer of WAV bytes, or null on failure.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${baseUrl()}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

export { isTtsAvailable } from "./sidecar.js";
