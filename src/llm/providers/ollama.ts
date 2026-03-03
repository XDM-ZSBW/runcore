/**
 * Ollama (local) LLM provider for Core.
 * Wraps the existing Ollama streaming + completion logic behind the LLMProvider interface.
 */

import type { ContextMessage } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.provider.ollama");

const DEFAULT_CHAT_MODEL = "llama3.1:8b";
const DEFAULT_UTILITY_MODEL = "llama3.1:8b";

function getBaseUrl(): string {
  return process.env.OLLAMA_URL ?? "http://localhost:11434";
}

function formatMessages(messages: ContextMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const ollamaProvider: LLMProvider = {
  name: "ollama",
  defaultChatModel: DEFAULT_CHAT_MODEL,
  defaultUtilityModel: DEFAULT_UTILITY_MODEL,

  async streamChat(options: StreamOptions): Promise<void> {
    const baseUrl = getBaseUrl();
    const model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_CHAT_MODEL;
    log.debug("Streaming chat request", { model, messageCount: options.messages.length });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      log.error("Ollama stream API error", { status: response.status, body: text, model });
      options.onError(new Error(`Ollama ${response.status}: ${text}`));
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
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);
            const content = parsed.message?.content;
            if (content) options.onToken(content);
            if (parsed.done) {
              options.onDone();
              return;
            }
          } catch {
            // Skip malformed lines
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
    const baseUrl = getBaseUrl();
    const resolvedModel = model ?? process.env.OLLAMA_MODEL ?? DEFAULT_UTILITY_MODEL;
    log.debug("Completion request", { model: resolvedModel, messageCount: messages.length });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        messages: formatMessages(messages),
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("Ollama API error", { status: response.status, body: text, model: resolvedModel });
      throw new Error(`Ollama ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };

    const content = data.message?.content;
    if (!content) throw new Error("No content in Ollama response");
    log.debug("Completion received", { model: resolvedModel, responseLength: content.length });
    return content;
  },

  async isAvailable(): Promise<boolean> {
    const baseUrl = getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
