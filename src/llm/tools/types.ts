/**
 * Tool-calling types for the chat model function-calling layer.
 *
 * These map to OpenAI's tool-calling format, which OpenRouter and Ollama
 * both accept. The ToolDefinition type is the internal registration format
 * used by the ToolRegistry.
 */

import type { TierName } from "../../tier/types.js";

/** OpenAI-format tool definition sent to the model. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** A tool call requested by the model in its response. */
export interface ChatToolCall {
  id: string;
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result fed back to the model after tool execution. */
export interface ChatToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Internal tool registration — schema + handler + tier gate. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (from Zod)
  handler: (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
  tier: TierName;
}
