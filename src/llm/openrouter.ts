/**
 * Streaming OpenRouter client.
 * Sends messages to OpenRouter's chat/completions endpoint and yields SSE tokens.
 */

import type { ContextMessage } from "../types.js";
import { classifyApiError } from "./errors.js";
import { createLogger } from "../utils/logger.js";
import { recordLlmRequest } from "../metrics/collector.js";

/** @deprecated Import StreamOptions from "./providers/types.js" instead. */
export type { StreamOptions } from "./providers/types.js";
import type { StreamOptions } from "./providers/types.js";
import { getInstanceName } from "../instance.js";

const log = createLogger("llm.openrouter");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/**
 * Stream a chat completion from OpenRouter.
 * Calls onToken for each content delta, onDone when finished, onError on failure.
 */
export async function streamChat(options: StreamOptions): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    options.onError(new Error("OPENROUTER_API_KEY not set"));
    return;
  }

  const model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  log.debug("Streaming chat request", { model, messageCount: options.messages.length });

  const startMs = performance.now();
  let inputChars = 0;
  for (const m of options.messages) {
    if (typeof m.content === "string") inputChars += m.content.length;
  }
  const inputTokens = Math.ceil(inputChars / 4);
  let outputChars = 0;

  const body = {
    model,
    messages: options.messages.map((m) => ({
      role: m.role,
      content: m.content, // string or ContentBlock[] — OpenRouter handles both
    })),
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://runcore.sh",
        "X-Title": getInstanceName(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    log.error("Stream connection failed", { model, error: (err instanceof Error ? err : new Error(String(err))).message });
    recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, 0, false);
    options.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    log.error("OpenRouter stream API error", { status: response.status, body: text, model });
    recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, 0, false);
    options.onError(classifyApiError("OpenRouter", response.status, text, model));
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, 0, false);
    options.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, Math.ceil(outputChars / 4), true);
          options.onDone();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            outputChars += delta.length;
            options.onToken(delta);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
    // Stream ended without [DONE]
    recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, Math.ceil(outputChars / 4), true);
    options.onDone();
  } catch (err) {
    recordLlmRequest("openrouter", model, Math.round(performance.now() - startMs), inputTokens, Math.ceil(outputChars / 4), false);
    if (options.signal?.aborted) return;
    options.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    reader.releaseLock();
  }
}
