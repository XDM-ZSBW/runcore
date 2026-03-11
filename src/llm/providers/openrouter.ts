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
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
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
      toolCount: options.tools?.length ?? 0,
    });
    const fetchStartMs = performance.now();

    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model,
        messages: formatMessages(options.messages),
        stream: true,
      };
      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools;
        body.tool_choice = "auto";
      }
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Stream connection failed", { model, error: error.message });
      options.onError(error);
      return;
    }

    log.debug("OpenRouter response received", {
      status: response.status,
      fetchMs: Math.round(performance.now() - fetchStartMs),
      model,
    });

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
    let firstTokenMs = 0;
    let tokenCount = 0;

    // Accumulator for tool call deltas streamed across multiple chunks
    const toolCallAccum: Array<{
      id: string;
      function: { name: string; arguments: string };
    }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.debug("Reader done (stream closed)", { model, tokenCount, totalMs: Math.round(performance.now() - fetchStartMs) });
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            log.debug("Stream [DONE]", { model, tokenCount, totalMs: Math.round(performance.now() - fetchStartMs), pendingToolCalls: toolCallAccum.length });
            // If tool calls were accumulated but no explicit finish_reason fired, deliver them
            if (toolCallAccum.length > 0 && options.onToolCalls) {
              options.onToolCalls(toolCallAccum);
            } else {
              options.onDone();
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);
            // Log errors from OpenRouter that arrive inside the SSE stream
            if (parsed.error) {
              log.error("OpenRouter stream error in SSE", { error: parsed.error });
              options.onError(new Error(typeof parsed.error === "string" ? parsed.error : parsed.error.message || JSON.stringify(parsed.error)));
              return;
            }
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            // Accumulate tool call deltas
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0;
                if (!toolCallAccum[idx]) {
                  toolCallAccum[idx] = {
                    id: tc.id ?? "",
                    function: { name: tc.function?.name ?? "", arguments: "" },
                  };
                }
                if (tc.id) toolCallAccum[idx].id = tc.id;
                if (tc.function?.name) toolCallAccum[idx].function.name = tc.function.name;
                if (tc.function?.arguments) {
                  toolCallAccum[idx].function.arguments += tc.function.arguments;
                }
              }
            }

            // Stream text content as before
            const content = delta?.content;
            if (content) {
              tokenCount++;
              if (tokenCount === 1) {
                firstTokenMs = performance.now() - fetchStartMs;
                log.debug("First token received", { model, ttftMs: Math.round(firstTokenMs) });
              }
              options.onToken(content);
            }

            // Check finish_reason
            const finishReason = choice?.finish_reason;
            if (finishReason) {
              log.debug("Stream finish", { model, finishReason, tokenCount, totalMs: Math.round(performance.now() - fetchStartMs), toolCalls: toolCallAccum.length });
            }
            if (finishReason === "tool_calls") {
              if (options.onToolCalls && toolCallAccum.length > 0) {
                options.onToolCalls(toolCallAccum);
              } else {
                options.onDone();
              }
              return;
            }
            if (finishReason === "stop") {
              options.onDone();
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
      // Stream ended without explicit finish — deliver what we have
      if (toolCallAccum.length > 0 && options.onToolCalls) {
        options.onToolCalls(toolCallAccum);
      } else {
        options.onDone();
      }
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
