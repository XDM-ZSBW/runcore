/**
 * OpenRouter LLM provider for Core.
 * Wraps the existing OpenRouter streaming + completion logic behind the LLMProvider interface.
 */

import type { ContextMessage } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { classifyApiError } from "../errors.js";
import { createLogger } from "../../utils/logger.js";
import { resolveEnv, getInstanceName } from "../../instance.js";

const log = createLogger("llm.provider.openrouter");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4";
const DEFAULT_UTILITY_MODEL = "meta-llama/llama-3.1-8b-instruct";

function getApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

function formatMessages(messages: ContextMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://runcore.sh",
    "X-Title": getInstanceName(),
  };
}

export const openRouterProvider: LLMProvider = {
  name: "openrouter",
  defaultChatModel: DEFAULT_CHAT_MODEL,
  defaultUtilityModel: DEFAULT_UTILITY_MODEL,

  async streamChat(options: StreamOptions): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) {
      options.onError(new Error("OPENROUTER_API_KEY not set"));
      return;
    }

    const model =
      options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_CHAT_MODEL;
    log.debug("Streaming chat request", {
      model,
      messageCount: options.messages.length,
    });

    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          model,
          messages: formatMessages(options.messages),
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Stream connection failed", { model, error: error.message });
      options.onError(error);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("OpenRouter stream API error", {
        status: response.status,
        body: text,
        model,
      });
      options.onError(classifyApiError("OpenRouter", response.status, text, model));
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
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
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            options.onDone();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) options.onToken(delta);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
      options.onDone();
    } catch (err) {
      if (options.signal?.aborted) return;
      options.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reader.releaseLock();
    }
  },

  async completeChat(
    messages: ContextMessage[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

    const resolvedModel =
      model ?? resolveEnv("EXTRACTION_MODEL") ?? DEFAULT_UTILITY_MODEL;
    log.debug("Completion request", {
      model: resolvedModel,
      messageCount: messages.length,
    });

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        model: resolvedModel,
        messages: formatMessages(messages),
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("OpenRouter API error", {
        status: response.status,
        body: text,
        model: resolvedModel,
      });
      throw classifyApiError("OpenRouter", response.status, text, resolvedModel);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in OpenRouter response");
    log.debug("Completion received", {
      model: resolvedModel,
      responseLength: content.length,
    });
    return content;
  },

  async isAvailable(): Promise<boolean> {
    return !!getApiKey();
  },
};
