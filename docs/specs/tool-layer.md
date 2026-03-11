# Core Tool Layer — Chat Model Function Calling

## Problem

Dash (the chat model running through OpenRouter/Ollama) has no tool-calling capability. The `streamChat()` function sends `{ model, messages, stream: true }` with no `tools` array. When the system prompt says "call whiteboard_status", the model outputs a tool call as literal text because it has no other option.

17 MCP tools exist but are only accessible to Claude Code via stdio. The chat model can read (via context injection) and talk (stream text), but cannot act.

## Solution

A tool-calling loop that sits between the chat endpoint and the LLM providers. It:
1. Converts MCP tool definitions (Zod schemas) to OpenAI function-calling format
2. Passes a tier-gated `tools[]` array to OpenRouter/Ollama
3. Handles the multi-round loop: model requests tool → server executes → feeds result back → model continues
4. Streams tool events to the UI via SSE

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  /api/chat   │ ──> │  Tool Loop   │ ──> │ OpenRouter/Ollama │
│  (server.ts) │     │  (loop.ts)   │     │   streamChat()    │
└──────────────┘     └──────┬───────┘     └────────┬─────────┘
                            │                      │
                    execute tools             stream tokens
                            │                      │
                     ┌──────▼───────┐        ┌─────▼──────┐
                     │ Tool Registry │        │  onToken() │
                     │ (registry.ts) │        │  → SSE     │
                     └──────┬───────┘        └────────────┘
                            │
                  ┌─────────▼─────────┐
                  │ Shared Handlers   │
                  │ (same logic as    │
                  │  MCP server uses) │
                  └───────────────────┘
```

## New Files

### `src/llm/tools/types.ts`

```typescript
/** OpenAI-format tool definition */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** A tool call requested by the model */
export interface ChatToolCall {
  id: string;
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result fed back to the model */
export interface ChatToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Internal registration */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (from Zod)
  handler: (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
  tier: "local" | "byok" | "spawn" | "hosted";
}
```

### `src/llm/tools/schemas.ts`

Extract Zod schemas from `mcp-server.ts` into importable constants. Both the MCP server and tool registry import from here.

```typescript
import { z } from "zod";

export const memoryRetrieveSchema = z.object({
  query: z.string().max(500),
  type: z.enum(["episodic", "semantic", "procedural"]).optional(),
  max: z.number().int().min(1).max(50).default(10),
});

export const memoryLearnSchema = z.object({
  type: z.enum(["episodic", "semantic", "procedural"]),
  content: z.string().min(1).max(10000),
  meta: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const whiteboardPlantSchema = z.object({
  title: z.string(),
  type: z.enum(["goal", "task", "question", "decision", "note"]),
  parentId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  body: z.string().optional(),
  question: z.string().optional(),
});

// ... etc for all 17 tools
```

### `src/llm/tools/registry.ts`

```typescript
import type { ToolDefinition, ChatTool } from "./types.js";
import type { TierName } from "../../tier/gate.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  /** Get OpenAI-format tools array filtered by tier */
  getToolsForTier(tier: TierName): ChatTool[] {
    const level = tierLevel(tier);
    return [...this.tools.values()]
      .filter((t) => tierLevel(t.tier) <= level)
      .map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
  }

  /** Execute a tool call, return result string */
  async execute(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    try {
      return await tool.handler(args);
    } catch (err: any) {
      return { content: `Tool error: ${err.message}`, isError: true };
    }
  }
}
```

### `src/llm/tools/handlers.ts`

Factory that creates tool handlers using per-session state (brain, ltm, etc.). Same logic as MCP server, no duplication.

```typescript
export function createToolHandlers(ctx: {
  brain: Brain;
  ltm: LongTermMemoryStore;
  brainDir: string;
  encryptionKey?: string;
}): ToolDefinition[] {
  return [
    {
      name: "memory_retrieve",
      description: "Search long-term memory for relevant entries",
      parameters: zodToJsonSchema(memoryRetrieveSchema),
      tier: "local",
      handler: async (args) => {
        // Same logic as mcp-server.ts memory_retrieve handler
        const results = await hallwayScanMemory(ctx.brainDir, args.query, ...);
        return { content: formatResults(results) };
      },
    },
    {
      name: "whiteboard_plant",
      description: "Plant a node on the shared whiteboard",
      parameters: zodToJsonSchema(whiteboardPlantSchema),
      tier: "local",
      handler: async (args) => {
        const store = new WhiteboardStore(ctx.brainDir);
        const node = await store.create({ ...args, plantedBy: "agent" });
        return { content: `Planted: ${node.title} (${node.id})` };
      },
    },
    // ... all 17 tools
  ];
}
```

### `src/llm/tools/loop.ts`

The orchestration loop — wraps a provider's `streamChat` to handle tool calls.

```typescript
const MAX_ROUNDS = 5;

interface ToolLoopOptions {
  streamFn: (options: StreamOptions) => Promise<void>;
  messages: ContextMessage[];
  model?: string;
  signal?: AbortSignal;
  registry: ToolRegistry;
  tier: TierName;

  // Callbacks
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  onToolCall?: (call: ChatToolCall) => void;
  onToolResult?: (name: string, result: string) => void;
}

export async function streamWithTools(options: ToolLoopOptions): Promise<void> {
  const tools = options.registry.getToolsForTier(options.tier);
  if (tools.length === 0) {
    // No tools available — fall through to plain streaming
    return options.streamFn({
      messages: options.messages,
      model: options.model,
      onToken: options.onToken,
      onDone: options.onDone,
      onError: options.onError,
      signal: options.signal,
    });
  }

  let messages = [...options.messages];
  let round = 0;

  while (round < MAX_ROUNDS) {
    let toolCalls: ChatToolCall[] = [];
    let hasContent = false;

    await new Promise<void>((resolve, reject) => {
      options.streamFn({
        messages,
        model: options.model,
        tools,
        signal: options.signal,
        onToken: (token) => {
          hasContent = true;
          options.onToken(token);
        },
        onToolCalls: (calls) => {
          toolCalls = calls;
          resolve();
        },
        onDone: () => resolve(),
        onError: (err) => reject(err),
      });
    });

    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      options.onDone();
      return;
    }

    // Execute each tool call
    // Append assistant message with tool_calls
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      options.onToolCall?.(call);
      const args = JSON.parse(call.function.arguments);
      const result = await options.registry.execute(call.function.name, args);
      options.onToolResult?.(call.function.name, result.content);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content,
      });
    }

    round++;
  }

  // Max rounds reached — end gracefully
  options.onDone();
}
```

## Provider Changes

### `src/llm/providers/types.ts`

Extend `StreamOptions`:

```typescript
interface StreamOptions {
  messages: ContextMessage[];
  model?: string;
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  // New:
  tools?: ChatTool[];
  onToolCalls?: (calls: ChatToolCall[]) => void;
}
```

### `src/llm/providers/openrouter.ts`

In `streamChat`:
- If `options.tools` provided, add `tools` to the request body
- In the stream parser, accumulate `delta.tool_calls` fragments
- On `finish_reason: "tool_calls"`, fire `options.onToolCalls` instead of `options.onDone`

### `src/llm/providers/ollama.ts`

Same pattern. Ollama's `/api/chat` accepts `tools` in OpenAI format.

## SSE Events

New event types alongside existing `{ token }`, `{ done }`:

```typescript
// Model requested a tool call
{ toolCall: { id: string, name: string, arguments: object } }

// Server executed the tool
{ toolResult: { id: string, name: string, result: string, isError?: boolean } }
```

The UI can show "Using whiteboard_plant..." between text chunks.

## Server Integration (`src/server.ts`)

In the `/api/chat` streamSSE block, replace the direct `stream_fn()` call:

```typescript
// Before:
stream_fn({ messages, model, onToken, onDone, onError, signal });

// After:
streamWithTools({
  streamFn: stream_fn,
  messages, model, signal,
  registry: chatToolRegistry,
  tier: activeTier,
  onToken,
  onDone,
  onError,
  onToolCall: (call) => {
    stream.writeSSE({ data: JSON.stringify({ toolCall: call }) });
  },
  onToolResult: (name, result) => {
    stream.writeSSE({ data: JSON.stringify({ toolResult: { name, result } }) });
  },
});
```

## Tier Gating

| Tool | Min Tier | Why |
|------|----------|-----|
| `memory_retrieve` | local | Core brain access |
| `memory_learn` | local | Core brain access |
| `memory_list` | local | Core brain access |
| `read_brain_file` | local | Core brain access |
| `files_search` | local | Core brain access |
| `get_settings` | local | Self-knowledge |
| `list_locked` | local | Self-knowledge |
| `list_rooms` | local | Self-knowledge |
| `whiteboard_plant` | local | Collaboration |
| `whiteboard_status` | local | Collaboration |
| `loop_open` | local | Crystallizer |
| `loop_list` | local | Crystallizer |
| `loop_resolve` | local | Crystallizer |
| `dash_status` | byok | Cross-instance |
| `send_alert` | byok | External comms |
| `voucher_issue` | spawn | Security |
| `voucher_check` | spawn | Security |

## ContextMessage Type Change

```typescript
// src/types.ts
export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;          // For role: "tool" results
  tool_calls?: ChatToolCall[];    // For assistant messages requesting tools
}
```

## Coexistence with Action Blocks

The existing capability registry (calendar, email, docs, board action blocks) continues working. The tool loop wraps streaming; action blocks are parsed post-stream in `onDone`. Over time, capabilities can migrate from action blocks to tool calling, but both pipelines coexist.

## Implementation Sessions

### Session 1: Foundation
1. `src/llm/tools/types.ts` — types
2. `src/llm/tools/schemas.ts` — extract Zod schemas from mcp-server
3. `src/llm/tools/registry.ts` — registry with tier gating
4. `src/llm/tools/handlers.ts` — handler factory
5. Refactor `src/mcp-server.ts` to import shared schemas

### Session 2: Provider integration
1. Extend `StreamOptions` in `src/llm/providers/types.ts`
2. Add tool_calls accumulation to `src/llm/providers/openrouter.ts`
3. Add tool_calls accumulation to `src/llm/providers/ollama.ts`
4. `src/llm/tools/loop.ts` — the orchestration loop

### Session 3: Server wiring + UI
1. Wire `streamWithTools` into `/api/chat` in `src/server.ts`
2. Add SSE event handling for toolCall/toolResult in `public/index.html`
3. Show tool activity indicators in chat UI
4. Remove whiteboard context injection (no longer needed — model reads it via tool)

### Session 4: Testing + polish
1. Verify tool calling with OpenRouter (Opus, Sonnet)
2. Verify tool calling with Ollama (qwen2.5-coder:7b)
3. Graceful fallback for models that don't support tools
4. Remove stale "call MCP tools directly" prompt language
