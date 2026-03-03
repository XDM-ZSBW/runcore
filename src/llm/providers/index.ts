/**
 * LLM provider registry for Core.
 * Manages provider instances and provides a single entry point for LLM operations.
 */

import type { LLMProvider, ProviderName, StreamOptions } from "./types.js";
import { openRouterProvider } from "./openrouter.js";
import { anthropicProvider } from "./anthropic.js";
import { openAIProvider } from "./openai.js";
import { ollamaProvider } from "./ollama.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.providers");

// ── Registry ────────────────────────────────────────────────────────────────

const providers = new Map<ProviderName, LLMProvider>([
  ["openrouter", openRouterProvider],
  ["anthropic", anthropicProvider],
  ["openai", openAIProvider],
  ["ollama", ollamaProvider],
]);

/** Get a provider by name. Throws if unknown. */
export function getProvider(name: ProviderName): LLMProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`Unknown LLM provider: ${name}`);
  return provider;
}

/** Register a custom provider (for plugins or testing). */
export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
  log.info("Registered provider", { name: provider.name });
}

/** List all registered provider names. */
export function listProviders(): ProviderName[] {
  return [...providers.keys()];
}

/** Check which providers are currently available (have credentials/connectivity). */
export async function getAvailableProviders(): Promise<ProviderName[]> {
  const results = await Promise.all(
    [...providers.entries()].map(async ([name, provider]) => {
      const available = await provider.isAvailable();
      return available ? name : null;
    }),
  );
  return results.filter((n): n is ProviderName => n !== null);
}

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { LLMProvider, ProviderName, StreamOptions } from "./types.js";
export { openRouterProvider } from "./openrouter.js";
export { anthropicProvider } from "./anthropic.js";
export { openAIProvider } from "./openai.js";
export { ollamaProvider } from "./ollama.js";
export { LLMError, classifyApiError } from "../errors.js";
