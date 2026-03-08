/**
 * Plugin status API helpers.
 *
 * Provides a summary of all registered plugins and their states.
 * Mount as GET /api/plugins in server.ts.
 */

import type { PluginStatusMap } from "../types/plugin.js";
import { registry } from "./index.js";

/** Return the current status of all registered plugins. */
export function getPluginStatusSummary(): PluginStatusMap {
  return registry.getStatus();
}
