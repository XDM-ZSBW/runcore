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
// webhooks/registry.js is byok-tier — dynamic import
let _webhookMod: typeof import("../webhooks/registry.js") | null = null;
async function getWebhookMod() {
  if (!_webhookMod) { try { _webhookMod = await import("../webhooks/registry.js"); } catch {} }
  return _webhookMod;
}

import { createLogger } from "../utils/logger.js";

const log = createLogger("plugins");

// ── Singleton registry ────────────────────────────────────────────────────────

export const registry = new PluginRegistry();

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build the PluginContext passed to all plugin lifecycle methods.
 * Vault keys read from process.env for now — real vault integration later.
 */
// Eagerly load webhook module so it's available for sync registerWebhookProvider calls
getWebhookMod();

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

    registerWebhookProvider: (...args: Parameters<typeof import("../webhooks/registry.js").registerProvider>) => {
      if (_webhookMod) _webhookMod.registerProvider(...args);
      else log.warn("registerWebhookProvider called but webhooks module unavailable");
    },
  };
}

// ── Auto-registration ─────────────────────────────────────────────────────────

/**
 * Discover and register all available plugins.
 * Each plugin is loaded dynamically (byok-tier) and registered if the
 * module is available. Failures are logged and skipped — never fatal.
 */
async function registerPlugins(ctx: PluginContext): Promise<void> {
  const factories: Array<{ name: string; load: () => Promise<{ create: () => import("../types/plugin.js").Plugin } | null> }> = [
    {
      name: "google",
      load: async () => {
        try {
          const mod = await import("../google/plugin.js");
          return { create: mod.createGooglePlugin };
        } catch { return null; }
      },
    },
    {
      name: "slack",
      load: async () => {
        try {
          const mod = await import("./slack/index.js");
          return { create: mod.createSlackPlugin };
        } catch { return null; }
      },
    },
    {
      name: "github",
      load: async () => {
        try {
          const mod = await import("./github/index.js");
          return { create: mod.createGitHubPlugin };
        } catch { return null; }
      },
    },
    {
      name: "twilio",
      load: async () => {
        try {
          const mod = await import("./twilio/index.js");
          return { create: mod.createTwilioPlugin };
        } catch { return null; }
      },
    },
  ];

  for (const factory of factories) {
    try {
      const loaded = await factory.load();
      if (!loaded) {
        log.debug("Plugin module not available", { name: factory.name });
        continue;
      }
      const plugin = loaded.create();
      await registry.register(plugin, ctx);
      log.info("Plugin registered", { name: factory.name });
    } catch (err) {
      log.warn("Plugin registration failed", {
        name: factory.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Discover, register, authenticate, and start all available plugins.
 */
export async function initPlugins(): Promise<void> {
  const ctx = buildPluginContext();

  // Auto-discover and register all available plugins
  await registerPlugins(ctx);

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
