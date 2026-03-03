/**
 * OpenAI API provider for Core.
 * Compatible with OpenAI's chat completions endpoint.
 * Also works with OpenAI-compatible APIs via OPENAI_BASE_URL.
 */

import type { ContextMessage } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { classifyApiError } from "../errors.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.provider.openai");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHAT_MODEL = "gpt-4o";
const DEFAULT_UTILITY_MODEL = "gpt-4o-mini";

function getApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

function getBaseUrl(): string {
  return process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
}

function formatMessages(messages: ContextMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const openAIProvider: LLMProvider = {
  name: "openai",
  defaultChatModel: DEFAULT_CHAT_MODEL,
  defaultUtilityModel: DEFAULT_UTILITY_MODEL,

  async streamChat(options: StreamOptions): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) {
      options.onError(new Error("OPENAI_API_KEY not set"));
      return;
    }

    const model = options.model ?? DEFAULT_CHAT_MODEL;
    const baseUrl = getBaseUrl();
    log.debug("Streaming chat request", { model, messageCount: options.messages.length });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
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
      log.error("OpenAI stream API error", { status: response.status, body: text, model });
      options.onError(classifyApiError("OpenAI", response.status, text, model));
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
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const resolvedModel = model ?? DEFAULT_UTILITY_MODEL;
    const baseUrl = getBaseUrl();
    log.debug("Completion request", { model: resolvedModel, messageCount: messages.length });

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: formatMessages(messages),
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("OpenAI API error", { status: response.status, body: text, model: resolvedModel });
      throw classifyApiError("OpenAI", response.status, text, resolvedModel);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in OpenAI response");
    log.debug("Completion received", { model: resolvedModel, responseLength: content.length });
    return content;
  },

  async isAvailable(): Promise<boolean> {
    return !!getApiKey();
  },
};
