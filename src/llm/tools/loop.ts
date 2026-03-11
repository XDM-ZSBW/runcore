/**
 * Tool-calling orchestration loop.
 *
 * Wraps a provider's streamChat to handle multi-round tool calling.
 * The loop: stream → detect tool calls → execute → append results → stream again.
 * Caps at MAX_ROUNDS to prevent infinite loops.
 */

import type { ContextMessage } from "../../types.js";
import type { StreamOptions } from "../providers/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ChatToolCall } from "./types.js";
import type { TierName } from "../../tier/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.tools.loop");

const MAX_ROUNDS = 5;

export interface ToolLoopOptions {
  /** The provider's streamChat function. */
  streamFn: (options: StreamOptions) => Promise<void>;
  /** Conversation messages to send to the model. */
  messages: ContextMessage[];
  /** Model to use (passed through to streamFn). */
  model?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Tool registry providing tier-gated tool definitions and execution. */
  registry: ToolRegistry;
  /** Current tier — determines which tools are available. */
  tier: TierName;

  // Callbacks
  /** Called for each streamed text token. */
  onToken: (token: string) => void;
  /** Called when streaming is complete (no more tool calls). */
  onDone: () => void;
  /** Called on error. */
  onError: (error: Error) => void;
  /** Optional — called when the model requests a tool call. */
  onToolCall?: (call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => void;
  /** Optional — called after a tool has been executed. */
  onToolResult?: (
    name: string,
    result: string,
    isError?: boolean,
  ) => void;
}

/**
 * Stream with tool-calling support.
 *
 * If the registry has no tools for the given tier, falls through to plain
 * streaming with no overhead. Otherwise enters the tool loop.
 */
export async function streamWithTools(
  options: ToolLoopOptions,
): Promise<void> {
  const tools = options.registry.getToolsForTier(options.tier);
  log.debug("Tools resolved for tier", { tier: options.tier, count: tools.length });

  // No tools available — fall through to plain streaming
  if (tools.length === 0) {
    log.debug("No tools for tier, falling through to plain stream", {
      tier: options.tier,
    });
    return options.streamFn({
      messages: options.messages,
      model: options.model,
      onToken: options.onToken,
      onDone: options.onDone,
      onError: options.onError,
      signal: options.signal,
    });
  }

  const messages: ContextMessage[] = [...options.messages];
  let round = 0;

  while (round < MAX_ROUNDS) {
    let toolCalls: ChatToolCall[] = [];
    let roundText = "";

    // Run one streaming round
    try {
      await new Promise<void>((resolve, reject) => {
        options
          .streamFn({
            messages,
            model: options.model,
            tools,
            signal: options.signal,
            onToken: (token) => {
              roundText += token;
              options.onToken(token);
            },
            onToolCalls: (calls) => {
              toolCalls = calls;
              resolve();
            },
            onDone: () => resolve(),
            onError: (err) => reject(err),
          })
          .catch(reject);
      });
    } catch (err) {
      options.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
      return;
    }

    // No tool calls — model finished naturally
    if (toolCalls.length === 0) {
      options.onDone();
      return;
    }

    log.debug("Tool calls received", {
      round,
      count: toolCalls.length,
      names: toolCalls.map((tc) => tc.function.name),
      textLength: roundText.length,
    });

    // Append assistant message with tool_calls (include any text produced before the calls)
    messages.push({
      role: "assistant",
      content: roundText,
      tool_calls: toolCalls,
    });

    // Execute each tool call sequentially
    for (const call of toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
        log.warn("Failed to parse tool call arguments", {
          name: call.function.name,
          raw: call.function.arguments,
        });
      }

      // Notify caller about the tool call
      options.onToolCall?.({
        id: call.id,
        name: call.function.name,
        arguments: args,
      });

      // Execute via registry
      const result = await options.registry.execute(
        call.function.name,
        args,
      );

      log.debug("Tool executed", {
        name: call.function.name,
        isError: result.isError,
        resultLength: result.content.length,
      });

      // Notify caller about the result
      options.onToolResult?.(
        call.function.name,
        result.content,
        result.isError,
      );

      // Append tool result to conversation
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content,
      });
    }

    round++;
  }

  // Max rounds reached — end gracefully
  log.warn("Tool loop hit max rounds", { maxRounds: MAX_ROUNDS });
  options.onDone();
}
