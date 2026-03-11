/**
 * Tool-calling layer — barrel export.
 *
 * Provides the foundation for chat model function calling:
 * types, schemas, registry, and handler factory.
 */

export type {
  ChatTool,
  ChatToolCall,
  ChatToolResult,
  ToolDefinition,
} from "./types.js";

export {
  memoryRetrieveSchema,
  memoryLearnSchema,
  memoryListSchema,
  readBrainFileSchema,
  filesSearchSchema,
  getSettingsSchema,
  listLockedSchema,
  listRoomsSchema,
  whiteboardPlantSchema,
  whiteboardStatusSchema,
  voucherIssueSchema,
  voucherCheckSchema,
  sendAlertSchema,
  loopOpenSchema,
  loopListSchema,
  loopResolveSchema,
  dashStatusSchema,
} from "./schemas.js";

export { ToolRegistry } from "./registry.js";

export { createToolHandlers } from "./handlers.js";
export type { ToolHandlerContext } from "./handlers.js";
