/**
 * Global fetch interceptor — defense-in-depth for privateMode + sensitive data redaction.
 *
 * Two layers:
 * 1. privateMode enforcement — blocks outbound requests to known cloud LLM API hosts.
 * 2. Sensitive data redaction — strips secrets/PII from LLM request bodies before network egress.
 *
 * The function-level guard in guard.ts → assertProviderAllowed() remains the
 * primary enforcement. This is the safety net.
 */

import { isPrivateMode, PrivateModeError } from "./guard.js";
import { redactRequestBody } from "./redact.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.fetch-guard");

const BLOCKED_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "api.perplexity.ai",
]);

/** Hosts where outbound request bodies should be redacted (LLM API endpoints). */
const LLM_HOSTS = new Set([
  ...BLOCKED_HOSTS,
  "generativelanguage.googleapis.com",
  "localhost",
  "127.0.0.1",
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
    let hostname: string | undefined;
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      hostname = new URL(raw).hostname;
    } catch {
      // URL parse failure — skip host-based logic
    }

    // Layer 1: privateMode enforcement
    if (isPrivateMode() && hostname && BLOCKED_HOSTS.has(hostname)) {
      log.error("Fetch guard blocked outbound request", { host: hostname });
      throw new PrivateModeError("cloud-api" as any);
    }

    // Layer 2: redact sensitive data from LLM request bodies
    if (hostname && LLM_HOSTS.has(hostname) && init?.body && typeof init.body === "string") {
      const redacted = redactRequestBody(init.body);
      if (redacted !== init.body) {
        init = { ...init, body: redacted };
      }
    }

    return originalFetch.call(globalThis, input, init);
  };

  log.info("Fetch guard installed — privateMode enforcement + sensitive data redaction");
}
