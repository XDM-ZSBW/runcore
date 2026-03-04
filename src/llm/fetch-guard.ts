/**
 * Global fetch interceptor — defense-in-depth for privateMode.
 *
 * When privateMode is enabled, blocks outbound requests to known cloud LLM API
 * hosts before they leave the machine. This catches any code path that bypasses
 * the provider-level guard (e.g. raw fetch() calls).
 *
 * The function-level guard in guard.ts → assertProviderAllowed() remains the
 * primary enforcement. This is the safety net.
 */

import { isPrivateMode, PrivateModeError } from "./guard.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.fetch-guard");

const BLOCKED_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "api.perplexity.ai",
]);

let installed = false;

/**
 * Monkey-patch globalThis.fetch to block cloud LLM hosts in privateMode.
 * Safe to call multiple times — only installs once.
 */
export function installFetchGuard(): void {
  if (installed) return;
  installed = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (isPrivateMode()) {
      try {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const url = new URL(raw);
        if (BLOCKED_HOSTS.has(url.hostname)) {
          log.error("Fetch guard blocked outbound request", { host: url.hostname });
          throw new PrivateModeError("cloud-api" as any);
        }
      } catch (err) {
        if (err instanceof PrivateModeError) throw err;
        // URL parse failure — let it through, original fetch will handle it
      }
    }
    return originalFetch.call(globalThis, input, init);
  };

  log.info("Fetch guard installed — cloud LLM hosts blocked in privateMode");
}
