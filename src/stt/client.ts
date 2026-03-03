/**
 * STT client — sends audio to whisper-server and returns transcribed text.
 * All functions are safe — they return null on any failure.
 */

import { getSttConfig } from "../settings.js";
import { getInstanceName } from "../instance.js";

function baseUrl(): string {
  return `http://127.0.0.1:${getSttConfig().port}`;
}

/**
 * Health probe — whisper-server serves an HTML page at root.
 * 2-second timeout, returns false on any failure.
 */
export async function checkSttSidecar(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Transcribe audio via whisper-server.
 * Sends raw audio as multipart form data to /inference.
 * Handles both response formats: { text } and { result: [{ text }] }.
 * Returns transcribed text, or null on failure.
 */
export async function transcribe(audioBuffer: Buffer): Promise<string | null> {
  try {
    // Build multipart form data with the audio file
    const blob = new Blob([audioBuffer], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("response_format", "json");
    // Prompt biasing — helps Whisper recognize the wake word and domain terms
    form.append("prompt", `Hey ${getInstanceName()}`);

    const res = await fetch(`${baseUrl()}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;

    // Handle { text: "..." } format
    if (typeof data.text === "string") {
      return data.text.trim() || null;
    }

    // Handle { result: [{ text: "..." }] } format
    if (Array.isArray(data.result) && data.result.length > 0) {
      const first = data.result[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return first.text.trim() || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export { isSttAvailable } from "./sidecar.js";
