/**
 * LLM request guard — enforces privateMode at the request layer.
 *
 * When privateMode is enabled, ALL outbound LLM API calls to cloud providers
 * are blocked. Only local providers (Ollama) are allowed through.
 * This is network-level isolation, not just provider swapping.
 */

import { getSettings } from "../settings.js";
import { createLogger } from "../utils/logger.js";
import type { ProviderName } from "./providers/types.js";

const log = createLogger("llm.guard");

/** Providers that are allowed in private mode (local-only, no outbound network). */
const LOCAL_PROVIDERS: ReadonlySet<ProviderName> = new Set(["ollama"]);

/**
 * Error thrown when a cloud LLM call is attempted in private mode.
 * Intentionally loud — this should never be silently swallowed.
 */
export class PrivateModeError extends Error {
  constructor(provider: ProviderName) {
    super(
      `[PRIVATE MODE] Blocked outbound LLM request to "${provider}". ` +
      `privateMode is enabled — only local providers (Ollama) are allowed. ` +
      `Disable privateMode in brain/settings.json to use cloud providers.`,
    );
    this.name = "PrivateModeError";
  }
}

/**
 * Check whether the current settings enforce private mode.
 * privateMode takes precedence over airplaneMode — it's the hard enforcement layer.
 */
export function isPrivateMode(): boolean {
  const settings = getSettings();
  return settings.privateMode === true;
}

/**
 * Assert that a provider is allowed under current mode.
 * Throws PrivateModeError if a cloud provider is requested while privateMode is on.
 * Call this at the request boundary, before any fetch() is made.
 */
export function assertProviderAllowed(provider: ProviderName): void {
  if (!isPrivateMode()) return;

  if (!LOCAL_PROVIDERS.has(provider)) {
    log.error("Blocked cloud LLM request in private mode", { provider });
    throw new PrivateModeError(provider);
  }
}

/**
 * Lightweight Ollama health probe. Returns a result object instead of throwing,
 * useful for non-critical paths (SSE error hints, status endpoints).
 */
export async function checkOllamaHealth(): Promise<{ ok: boolean; message: string }> {
  const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      return { ok: false, message: `Ollama responded with status ${res.status}` };
    }
    return { ok: true, message: "Ollama is reachable" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Ollama not available at ${baseUrl}: ${msg}` };
  }
}

/**
 * Check if Ollama is reachable. Used to fail loudly at startup when
 * privateMode is on but Ollama isn't available.
 */
export async function assertOllamaAvailable(): Promise<void> {
  const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`Ollama responded with status ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[PRIVATE MODE] Ollama is required but not available at ${baseUrl}. ` +
      `privateMode blocks all cloud providers — Ollama must be running. ` +
      `Error: ${msg}`,
    );
  }
}
