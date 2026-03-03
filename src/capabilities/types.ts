/**
 * Capability Registry — Core types.
 *
 * A "capability" is something the system can do, expressed as one of three patterns:
 *
 *   1. **Action block** — The LLM emits a tagged JSON block in its response
 *      (e.g. [CALENDAR_ACTION]{...}[/CALENDAR_ACTION]). The registry parses
 *      the block and calls execute(). Calendar, email, and docs use this pattern.
 *
 *   2. **Context provider** — The system injects data INTO the LLM's context
 *      before it responds (e.g. web search results, today's calendar, inbox
 *      summary). No action blocks — the capability decides whether to inject
 *      and returns content for the system prompt.
 *
 *   3. **Meta capability** — Structural/control-flow blocks the LLM emits that
 *      affect orchestration rather than calling an external API (e.g.
 *      AGENT_REQUEST blocks that spawn sub-agents). Parsed like action blocks
 *      but processed with custom logic rather than a simple execute().
 *
 * The `pattern` field is the discriminant for the union type.
 */

/** Origin of the LLM call — determines actionLabel and prompt phrasing. */
export type ActionOrigin = "chat" | "email" | "autonomous";

/** Context passed to execute() and prompt generators. */
export interface ActionContext {
  origin: ActionOrigin;
  /** Human-readable name of the paired user (for prompt personalization). */
  name?: string;
  sessionId?: string;
  /** Per-request hints for context providers (e.g. { detectedUrl: true }). */
  hints?: Record<string, unknown>;
}

/** A single parsed action block extracted from an LLM response. */
export interface ParsedActionBlock {
  /** Which capability owns this block (e.g. "calendar", "email", "docs"). */
  capabilityId: string;
  /** The tag name used in the response (e.g. "CALENDAR_ACTION"). */
  tag: string;
  /** Raw JSON string from inside the block. */
  rawJson: string;
  /** Parsed payload (or null if JSON was invalid). */
  payload: Record<string, unknown> | null;
}

/** Result of executing a single action block. */
export interface ActionExecutionResult {
  capabilityId: string;
  ok: boolean;
  message: string;
  /** Optional structured data returned by the action (e.g. board view issues). */
  data?: unknown;
}

// ─── Capability patterns (discriminated union) ──────────────────────────────

/** The three capability patterns. */
export type CapabilityPattern = "action" | "context" | "meta";

/**
 * Fields shared by all capability patterns.
 */
interface BaseCapability {
  /** Unique id (e.g. "calendar", "email", "web-search"). */
  id: string;

  /** Discriminant — determines which fields are available. */
  pattern: CapabilityPattern;

  /** Keywords that signal this capability is relevant to a message. */
  keywords: string[];

  /**
   * Generate prompt instructions for this capability.
   * Called by getPromptInstructions() — can vary by origin.
   */
  getPromptInstructions(ctx: ActionContext): string;

  /**
   * Optional origin-specific prompt override.
   * If provided, replaces getPromptInstructions for that origin.
   */
  getPromptOverride?(origin: ActionOrigin): string | null;
}

/**
 * Action block capability — the LLM emits tagged JSON that gets parsed and executed.
 * Used by: calendar, email, docs.
 */
export interface ActionBlockCapability extends BaseCapability {
  pattern: "action";

  /** The tag name in LLM responses, WITHOUT brackets (e.g. "CALENDAR_ACTION"). */
  tag: string;

  /**
   * Execute a single parsed action block.
   * Returns a result indicating success/failure.
   */
  execute(
    payload: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult>;
}

/**
 * Content returned by a context provider for injection into the LLM prompt.
 */
export interface ContextInjection {
  /** Label for the injected section (e.g. "Web search results"). */
  label: string;
  /** The content to inject. */
  content: string;
}

/**
 * Context provider capability — injects data into the LLM's context before
 * it responds. The system calls shouldInject() to check relevance, then
 * getContext() to retrieve the content.
 * Used by: web search, calendar data, gmail inbox.
 */
export interface ContextProviderCapability extends BaseCapability {
  pattern: "context";

  /**
   * Should this provider inject context for the given message?
   * Can be async (e.g. to classify the message with a small model).
   */
  shouldInject(
    message: string,
    ctx: ActionContext,
  ): Promise<boolean> | boolean;

  /**
   * Retrieve context content to inject into the prompt.
   * Returns null if nothing to inject (e.g. search returned no results).
   */
  getContext(
    message: string,
    ctx: ActionContext,
  ): Promise<ContextInjection | null>;
}

/**
 * Result of processing meta capability blocks.
 */
export interface MetaExecutionResult {
  capabilityId: string;
  blocksProcessed: number;
  results: Array<{ ok: boolean; message: string }>;
}

/**
 * Meta capability — structural/control-flow blocks that affect orchestration.
 * Parsed like action blocks (tagged JSON) but processed with custom logic
 * rather than a simple execute().
 * Used by: AGENT_REQUEST (spawns sub-agents).
 */
export interface MetaCapability extends BaseCapability {
  pattern: "meta";

  /** The tag name in LLM responses, WITHOUT brackets (e.g. "AGENT_REQUEST"). */
  tag: string;

  /**
   * Process all matched blocks for this meta capability.
   * Unlike action blocks which are executed one-by-one, meta capabilities
   * receive all their blocks at once for batch/orchestration logic.
   */
  processBlocks(
    blocks: ParsedActionBlock[],
    ctx: ActionContext,
  ): Promise<MetaExecutionResult>;
}

// ─── Union type ─────────────────────────────────────────────────────────────

/**
 * A capability definition — the single source of truth for one capability.
 * Discriminated union on `pattern`.
 */
export type CapabilityDefinition =
  | ActionBlockCapability
  | ContextProviderCapability
  | MetaCapability;

// ─── Type guards ────────────────────────────────────────────────────────────

/** Check if a capability uses the action block pattern. */
export function isActionBlock(def: CapabilityDefinition): def is ActionBlockCapability {
  return def.pattern === "action";
}

/** Check if a capability is a context provider. */
export function isContextProvider(def: CapabilityDefinition): def is ContextProviderCapability {
  return def.pattern === "context";
}

/** Check if a capability is a meta capability. */
export function isMetaCapability(def: CapabilityDefinition): def is MetaCapability {
  return def.pattern === "meta";
}
