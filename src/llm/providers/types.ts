/**
 * LLM provider abstraction types for Core.
 * All providers implement LLMProvider to support both streaming and non-streaming completions.
 */

import type { ContextMessage } from "../../types.js";

/** Supported LLM provider names. */
export type ProviderName = "openrouter" | "anthropic" | "openai" | "ollama";

/** Options for streaming chat completions. */
export interface StreamOptions {
  messages: ContextMessage[];
  model?: string;
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  /** Optional tools array in OpenAI function-calling format. */
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  /** Callback fired when the model requests tool calls instead of finishing normally. */
  onToolCalls?: (
    calls: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>,
  ) => void;
}

/** Interface that all LLM providers must implement. */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly defaultChatModel: string;
  readonly defaultUtilityModel: string;

  /** Stream a chat completion, calling onToken/onDone/onError callbacks. */
  streamChat(options: StreamOptions): Promise<void>;

  /** Non-streaming chat completion. Returns the full assistant response. */
  completeChat(
    messages: ContextMessage[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<string>;

  /** Check if the provider is available (API key set, service reachable, etc.). */
  isAvailable(): Promise<boolean>;
}
