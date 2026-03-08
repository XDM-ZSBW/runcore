/**
 * Plugin initialization — singleton registry + lifecycle orchestration.
 *
 * Creates the shared PluginRegistry, builds the PluginContext that all plugins
 * receive, and exposes init/shutdown functions for the server to call.
 */

import { PluginRegistry } from "../lib/PluginRegistry.js";
import type { PluginContext } from "../types/plugin.js";
import { BRAIN_DIR } from "../lib/paths.js";
import { logActivity } from "../activity/log.js";
import { registerProvider } from "../webhooks/registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plugins");

// ── Singleton registry ────────────────────────────────────────────────────────

export const registry = new PluginRegistry();

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build the PluginContext passed to all plugin lifecycle methods.
 * Vault keys read from process.env for now — real vault integration later.
 */
export function buildPluginContext(): PluginContext {
  return {
    brainDir: BRAIN_DIR,

    logActivity(opts: { source: string; summary: string; detail?: string }) {
      logActivity({
        source: opts.source as "system",
        summary: opts.summary,
        detail: opts.detail,
      });
    },

    pushNotification(opts: { timestamp: string; source: string; message: string }) {
      // Stub — real notification dispatch lives in Dash, not Core.
      log.info("Notification (stub)", {
        source: opts.source,
        message: opts.message,
        timestamp: opts.timestamp,
      });
    },

    getVaultKey(key: string): string | undefined {
      return process.env[key];
    },

    async setVaultKey(key: string, value: string): Promise<void> {
      // Write to process.env for the lifetime of this process.
      // Persistent vault storage comes later.
      process.env[key] = value;
      log.debug("Vault key set (env-only)", { key });
    },

    registerWebhookProvider: registerProvider,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Initialize all registered plugins: authenticate then start.
 * Call this after plugins have been registered with `registry.register()`.
 */
export async function initPlugins(): Promise<void> {
  const ctx = buildPluginContext();
  const pluginNames = registry.list();

  if (pluginNames.length === 0) {
    log.info("No plugins registered, skipping init");
    return;
  }

  log.info("Authenticating plugins", { count: pluginNames.length });
  const authResults = await registry.authenticateAll(ctx);

  for (const [name, result] of authResults) {
    if (result.ok) {
      log.info("Plugin authenticated", { name });
    } else {
      log.warn("Plugin auth failed", { name, message: result.message });
    }
  }

  log.info("Starting plugins");
  await registry.startAll(ctx);

  const status = registry.getStatus();
  const active = Object.values(status).filter((s) => s.state === "active").length;
  const errored = Object.values(status).filter((s) => s.state === "error").length;

  log.info("Plugin init complete", {
    total: pluginNames.length,
    active,
    errored,
  });
}

/**
 * Gracefully stop all active plugins. Call on server shutdown.
 */
export async function shutdownPlugins(): Promise<void> {
  log.info("Shutting down plugins");
  await registry.stopAll();
  log.info("All plugins stopped");
}
