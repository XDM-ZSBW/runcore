/**
 * ToolRegistry — manages tool definitions with tier-based access control.
 *
 * Converts internal ToolDefinition[] into OpenAI-format ChatTool[] filtered
 * by the caller's tier level. Dispatches tool execution by name.
 */

import type { TierName } from "../../tier/types.js";
import { TIER_LEVEL } from "../../tier/types.js";
import type { ToolDefinition, ChatTool } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool definition. Overwrites if name already exists. */
  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  /** Register multiple tool definitions at once. */
  registerAll(defs: ToolDefinition[]): void {
    for (const def of defs) {
      this.register(def);
    }
  }

  /** Get OpenAI-format tools array filtered by tier level. */
  getToolsForTier(tier: TierName): ChatTool[] {
    const level = TIER_LEVEL[tier];
    return [...this.tools.values()]
      .filter((t) => TIER_LEVEL[t.tier] <= level)
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  /** Get all registered tool names (for debugging/logging). */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Check if a tool exists and is accessible at the given tier. */
  isAvailable(name: string, tier: TierName): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    return TIER_LEVEL[tier] >= TIER_LEVEL[tool.tier];
  }

  /** Execute a tool call by name, return result string. */
  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    try {
      return await tool.handler(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Tool error: ${message}`, isError: true };
    }
  }
}
