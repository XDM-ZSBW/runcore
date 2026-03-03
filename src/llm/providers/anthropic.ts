/**
 * Direct Anthropic API provider for Core.
 * Uses the Messages API (https://docs.anthropic.com/en/api/messages).
 * No SDK dependency — raw fetch with SSE parsing.
 */

import type { ContextMessage, ContentBlock } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { classifyApiError } from "../errors.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.provider.anthropic");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_CHAT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_UTILITY_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 4096;

function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

/**
 * Anthropic requires system messages in a top-level `system` field,
 * not in the messages array. Also convert ContentBlock[] to Anthropic format.
 */
function prepareRequest(messages: ContextMessage[]) {
  let systemPrompt: string | undefined;
  const apiMessages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string; source?: unknown }>;
  }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      // Concatenate system messages
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content as ContentBlock[])
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      continue;
    }

    if (typeof m.content === "string") {
      apiMessages.push({ role: m.role as "user" | "assistant", content: m.content });
    } else {
      // Convert ContentBlock[] to Anthropic format
      const blocks = (m.content as ContentBlock[]).map((b) => {
        if (b.type === "text") return { type: "text" as const, text: b.text };
        // Convert image_url to Anthropic image source format
        return {
          type: "image" as const,
          source: { type: "url" as const, url: b.image_url.url },
        };
      });
      apiMessages.push({ role: m.role as "user" | "assistant", content: blocks });
    }
  }

  return { systemPrompt, messages: apiMessages };
}

export const anthropicProvider: LLMProvider = {
  name: "anthropic",
  defaultChatModel: DEFAULT_CHAT_MODEL,
  defaultUtilityModel: DEFAULT_UTILITY_MODEL,

  async streamChat(options: StreamOptions): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) {
      options.onError(new Error("ANTHROPIC_API_KEY not set"));
      return;
    }

    const model = options.model ?? DEFAULT_CHAT_MODEL;
    const { systemPrompt, messages } = prepareRequest(options.messages);
    log.debug("Streaming chat request", { model, messageCount: messages.length });

    const body: Record<string, unknown> = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (systemPrompt) body.system = systemPrompt;

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
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
      log.error("Anthropic stream API error", { status: response.status, body: text, model });
      options.onError(classifyApiError("Anthropic", response.status, text, model));
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
          try {
            const parsed = JSON.parse(data);

            // Anthropic SSE events: content_block_delta has the text
            if (
              parsed.type === "content_block_delta" &&
              parsed.delta?.type === "text_delta"
            ) {
              options.onToken(parsed.delta.text);
            } else if (parsed.type === "message_stop") {
              options.onDone();
              return;
            }
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
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const resolvedModel = model ?? DEFAULT_UTILITY_MODEL;
    const { systemPrompt, messages: apiMessages } = prepareRequest(messages);
    log.debug("Completion request", { model: resolvedModel, messageCount: apiMessages.length });

    const body: Record<string, unknown> = {
      model: resolvedModel,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: apiMessages,
    };
    if (systemPrompt) body.system = systemPrompt;

    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("Anthropic API error", { status: response.status, body: text, model: resolvedModel });
      throw classifyApiError("Anthropic", response.status, text, resolvedModel);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((b) => b.type === "text");
    if (!textBlock?.text) throw new Error("No text content in Anthropic response");
    log.debug("Completion received", { model: resolvedModel, responseLength: textBlock.text.length });
    return textBlock.text;
  },

  async isAvailable(): Promise<boolean> {
    return !!getApiKey();
  },
};
