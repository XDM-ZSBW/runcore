/**
 * Capability Registry — Public API.
 */

// Types
export type {
  CapabilityDefinition,
  CapabilityPattern,
  ActionBlockCapability,
  ContextProviderCapability,
  ContextInjection,
  MetaCapability,
  MetaExecutionResult,
  ParsedActionBlock,
  ActionExecutionResult,
  ActionContext,
  ActionOrigin,
} from "./types.js";

// Type guards
export {
  isActionBlock,
  isContextProvider,
  isMetaCapability,
} from "./types.js";

// Registry
export {
  CapabilityRegistry,
  createCapabilityRegistry,
  getCapabilityRegistry,
} from "./registry.js";

// Definitions — action blocks
export { calendarCapability } from "./definitions/calendar.js";
export { emailCapability } from "./definitions/email.js";
export { docsCapability } from "./definitions/docs.js";
export { boardCapability } from "./definitions/board.js";
export { browserCapability, closeBrowser } from "./definitions/browser.js";

// Definitions — meta capabilities
export { taskDoneCapability } from "./definitions/task-done.js";

// Definitions — context providers
export { calendarContextProvider } from "./definitions/calendar-context.js";
export { emailContextProvider } from "./definitions/email-context.js";
export { createWebSearchContextProvider } from "./definitions/web-search-context.js";
export type { WebSearchDeps, SearchClassification } from "./definitions/web-search-context.js";
export { vaultContextProvider } from "./definitions/vault-context.js";
