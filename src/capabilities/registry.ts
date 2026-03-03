/**
 * Capability Registry — single source of truth for capability
 * definition, prompt injection, parsing, and execution.
 *
 * Handles three capability patterns:
 *   - action:  Tagged JSON blocks → parse + execute one-by-one
 *   - context: Data injection into LLM prompt before response
 *   - meta:    Tagged JSON blocks → batch processing (e.g. agent spawning)
 *
 * Follows the same singleton + factory pattern as SkillRegistry/ModuleRegistry.
 */

import { createLogger } from "../utils/logger.js";
import type {
  CapabilityDefinition,
  ActionBlockCapability,
  ContextProviderCapability,
  MetaCapability,
  ParsedActionBlock,
  ActionExecutionResult,
  MetaExecutionResult,
  ContextInjection,
  ActionContext,
  ActionOrigin,
} from "./types.js";
import { isActionBlock, isContextProvider, isMetaCapability } from "./types.js";

const log = createLogger("capabilities");

export class CapabilityRegistry {
  private capabilities = new Map<string, CapabilityDefinition>();

  /** Register a capability definition. */
  register(def: CapabilityDefinition): void {
    if (this.capabilities.has(def.id)) {
      log.warn(`Capability "${def.id}" already registered — overwriting`);
    }
    this.capabilities.set(def.id, def);
    log.info(`Registered capability: ${def.id} [${def.pattern}]`);
  }

  /** All registered capability definitions. */
  list(): CapabilityDefinition[] {
    return [...this.capabilities.values()];
  }

  /** Get a single capability by id. */
  get(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  get size(): number {
    return this.capabilities.size;
  }

  // ─── Filtered accessors by pattern ──────────────────────────────────────

  /** All action block capabilities. */
  actions(): ActionBlockCapability[] {
    return this.list().filter(isActionBlock);
  }

  /** All context provider capabilities. */
  contextProviders(): ContextProviderCapability[] {
    return this.list().filter(isContextProvider);
  }

  /** All meta capabilities. */
  metas(): MetaCapability[] {
    return this.list().filter(isMetaCapability);
  }

  /** Capabilities that use tags (action + meta). */
  private taggedCapabilities(): (ActionBlockCapability | MetaCapability)[] {
    return this.list().filter(
      (d): d is ActionBlockCapability | MetaCapability =>
        isActionBlock(d) || isMetaCapability(d),
    );
  }

  /**
   * Scout: which capabilities are relevant to a message?
   * Simple keyword matching — sufficient for a handful of capabilities.
   */
  resolve(message: string): CapabilityDefinition[] {
    const lower = message.toLowerCase();
    return this.list().filter((def) =>
      def.keywords.some((kw) => lower.includes(kw))
    );
  }

  /**
   * Generate prompt instructions for all (or filtered) capabilities.
   * Returns a string ready for system prompt injection.
   *
   * - `filter`: only include these capability IDs
   * - `exclude`: include all EXCEPT these capability IDs
   * - Neither: include all capabilities
   */
  getPromptInstructions(ctx: ActionContext & { filter?: string[]; exclude?: string[] }): string {
    let defs = this.list();
    if (ctx.filter) {
      defs = defs.filter((d) => ctx.filter!.includes(d.id));
    } else if (ctx.exclude) {
      defs = defs.filter((d) => !ctx.exclude!.includes(d.id));
    }

    if (defs.length === 0) return "";

    const sections: string[] = [];
    for (const def of defs) {
      // Check for origin-specific override first
      const override = def.getPromptOverride?.(ctx.origin);
      sections.push(override ?? def.getPromptInstructions(ctx));
    }
    return sections.join("\n\n");
  }

  /**
   * Return a concise manifest of all registered capabilities.
   * Injected into the system prompt so the LLM knows its full toolset.
   */
  getSummary(): string {
    const actionDefs = this.actions();
    const providers = this.contextProviders();
    const metaDefs = this.metas();
    const lines: string[] = [`## Your capabilities (from registry)`];
    if (actionDefs.length) {
      lines.push(`Action blocks: ${actionDefs.map(a => `${a.tag} (${a.id})`).join(', ')}`);
    }
    if (providers.length) {
      lines.push(`Context providers: ${providers.map(p => p.id).join(', ')}`);
    }
    if (metaDefs.length) {
      lines.push(`Meta: ${metaDefs.map(m => `${m.tag} (${m.id})`).join(', ')}`);
    }
    lines.push(`These are your ACTUAL capabilities. Do not claim capabilities not listed here.`);
    return lines.join('\n');
  }

  // ─── Context injection ────────────────────────────────────────────────────

  /**
   * Check all context providers and return injections for relevant ones.
   */
  async getContextInjections(
    message: string,
    ctx: ActionContext,
  ): Promise<ContextInjection[]> {
    const providers = this.contextProviders();
    const injections: ContextInjection[] = [];

    for (const provider of providers) {
      try {
        const should = await provider.shouldInject(message, ctx);
        if (!should) continue;

        const injection = await provider.getContext(message, ctx);
        if (injection) injections.push(injection);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Context provider "${provider.id}" error`, { error: msg });
      }
    }

    return injections;
  }

  // ─── Parsing ────────────────────────────────────────────────────────────────

  /**
   * Extract all action blocks from an LLM response.
   * Matches [TAG_NAME]{...json...}[/TAG_NAME] for every registered
   * action and meta capability.
   */
  parseActionBlocks(response: string): ParsedActionBlock[] {
    const blocks: ParsedActionBlock[] = [];
    for (const def of this.taggedCapabilities()) {
      const regex = new RegExp(
        `\\[${def.tag}\\]\\s*(\\{[\\s\\S]*?\\})\\s*\\[\\/${def.tag}\\]`,
        "g",
      );
      for (const match of response.matchAll(regex)) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(match[1]);
        } catch {
          log.warn(`Invalid JSON in [${def.tag}] block`);
        }
        blocks.push({
          capabilityId: def.id,
          tag: def.tag,
          rawJson: match[1],
          payload,
        });
      }
    }
    return blocks;
  }

  /**
   * Strip all known action/meta blocks from a response string.
   * Returns the cleaned response text.
   */
  stripActionBlocks(response: string): string {
    let cleaned = response;
    for (const def of this.taggedCapabilities()) {
      const regex = new RegExp(
        `\\s*\\[${def.tag}\\][\\s\\S]*?\\[\\/${def.tag}\\]\\s*`,
        "g",
      );
      cleaned = cleaned.replace(regex, "");
    }
    return cleaned.trim();
  }

  // ─── Execute ────────────────────────────────────────────────────────────────

  /**
   * Parse all action/meta blocks, execute them, strip blocks from response.
   * Returns cleaned response + array of execution results.
   *
   * Action blocks are executed one-by-one via execute().
   * Meta blocks are batched per capability and processed via processBlocks().
   */
  async processResponse(
    response: string,
    ctx: ActionContext,
  ): Promise<{ cleaned: string; results: ActionExecutionResult[]; metaResults: MetaExecutionResult[] }> {
    const blocks = this.parseActionBlocks(response);
    const cleaned = blocks.length > 0 ? this.stripActionBlocks(response) : response;

    const results: ActionExecutionResult[] = [];
    const metaResults: MetaExecutionResult[] = [];

    // Partition blocks by capability pattern
    const actionBlocks: ParsedActionBlock[] = [];
    const metaBlocksByCapability = new Map<string, ParsedActionBlock[]>();

    for (const block of blocks) {
      const def = this.capabilities.get(block.capabilityId);
      if (!def) continue;

      if (isMetaCapability(def)) {
        const existing = metaBlocksByCapability.get(block.capabilityId) ?? [];
        existing.push(block);
        metaBlocksByCapability.set(block.capabilityId, existing);
      } else {
        actionBlocks.push(block);
      }
    }

    // Execute action blocks one-by-one
    for (const block of actionBlocks) {
      if (!block.payload) {
        results.push({ capabilityId: block.capabilityId, ok: false, message: "Invalid JSON" });
        continue;
      }
      const def = this.capabilities.get(block.capabilityId);
      if (!def || !isActionBlock(def)) continue;

      try {
        const result = await def.execute(block.payload, ctx);
        results.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Capability ${block.capabilityId} execution error`, { error: msg });
        results.push({ capabilityId: block.capabilityId, ok: false, message: msg });
      }
    }

    // Process meta blocks in batches per capability
    for (const [capId, capBlocks] of metaBlocksByCapability) {
      const def = this.capabilities.get(capId);
      if (!def || !isMetaCapability(def)) continue;

      try {
        const result = await def.processBlocks(capBlocks, ctx);
        metaResults.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Meta capability ${capId} processing error`, { error: msg });
        metaResults.push({ capabilityId: capId, blocksProcessed: 0, results: [{ ok: false, message: msg }] });
      }
    }

    return { cleaned, results, metaResults };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: CapabilityRegistry | null = null;

/** Create and store the singleton registry. */
export function createCapabilityRegistry(): CapabilityRegistry {
  _instance = new CapabilityRegistry();
  return _instance;
}

/** Retrieve the singleton (or null if not yet created). */
export function getCapabilityRegistry(): CapabilityRegistry | null {
  return _instance;
}
