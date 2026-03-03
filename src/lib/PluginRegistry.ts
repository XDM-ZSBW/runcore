/**
 * Plugin registry — manages plugin lifecycle and provides unified access.
 *
 * Responsibilities:
 * - Track registered plugins and their states
 * - Orchestrate init → authenticate → start lifecycle
 * - Provide context providers to the chat loop for injection
 * - Graceful shutdown of all plugins
 *
 * See docs/plugin-system.md for the developer guide.
 */

import { createLogger } from "../utils/logger.js";
import type {
  Plugin,
  PluginContext,
  PluginContextProvider,
  PluginRegistry as IPluginRegistry,
  PluginState,
  PluginStatus,
  PluginStatusMap,
  AuthResult,
} from "../types/plugin.js";

const log = createLogger("plugin.registry");

interface PluginEntry {
  plugin: Plugin;
  state: PluginState;
  error?: string;
}

export class PluginRegistry implements IPluginRegistry {
  private plugins = new Map<string, PluginEntry>();

  /**
   * Register a plugin. Validates config and calls init().
   * Transitions plugin from "loaded" → "ready" (or "error").
   */
  async register(plugin: Plugin, ctx: PluginContext): Promise<void> {
    const name = plugin.manifest.name;

    if (this.plugins.has(name)) {
      log.warn("Plugin already registered, skipping", { name });
      return;
    }

    const entry: PluginEntry = { plugin, state: "loaded" };
    this.plugins.set(name, entry);

    try {
      await plugin.init(ctx);
      entry.state = "ready";
      log.info("Plugin registered", { name, capabilities: plugin.manifest.capabilities });
    } catch (err) {
      entry.state = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      log.error("Plugin registration failed", { name, error: entry.error });
    }
  }

  /** Get a registered plugin by name. */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  /** List all registered plugin names. */
  list(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Remove and stop a plugin.
   */
  async unregister(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;

    try {
      if (entry.state === "active") {
        await entry.plugin.stop();
      }
    } catch (err) {
      log.error("Error stopping plugin during unregister", { name, error: err });
    }

    this.plugins.delete(name);
    log.info("Plugin unregistered", { name });
  }

  /**
   * Authenticate all registered plugins that have credentials.
   * Skips plugins in "error" state or those already authenticated.
   */
  async authenticateAll(ctx: PluginContext): Promise<Map<string, AuthResult>> {
    const results = new Map<string, AuthResult>();

    for (const [name, entry] of this.plugins) {
      if (entry.state === "error") {
        results.set(name, { ok: false, message: `Plugin in error state: ${entry.error}` });
        continue;
      }

      if (entry.state === "authed" || entry.state === "active") {
        results.set(name, { ok: true, message: "Already authenticated" });
        continue;
      }

      try {
        const result = await entry.plugin.authenticate(ctx);
        if (result.ok) {
          entry.state = "authed";
          entry.error = undefined;
        }
        results.set(name, result);
      } catch (err) {
        entry.state = "error";
        entry.error = err instanceof Error ? err.message : String(err);
        results.set(name, { ok: false, message: entry.error });
        log.error("Plugin authentication error", { name, error: entry.error });
      }
    }

    return results;
  }

  /**
   * Start all authenticated plugins.
   * Only starts plugins in "authed" or "ready" state.
   */
  async startAll(ctx: PluginContext): Promise<void> {
    for (const [name, entry] of this.plugins) {
      // Start authed plugins, and also "ready" plugins that don't require auth
      // (authType: "none" or plugins that can function without full auth)
      if (entry.state !== "authed" && entry.state !== "ready") {
        continue;
      }

      try {
        await entry.plugin.start(ctx);
        entry.state = "active";
        entry.error = undefined;
      } catch (err) {
        entry.state = "error";
        entry.error = err instanceof Error ? err.message : String(err);
        log.error("Plugin start failed", { name, error: entry.error });
      }
    }
  }

  /**
   * Stop all active plugins. Called on server shutdown.
   * Stops in reverse registration order for clean teardown.
   */
  async stopAll(): Promise<void> {
    const entries = Array.from(this.plugins.entries()).reverse();

    for (const [name, entry] of entries) {
      if (entry.state !== "active") continue;

      try {
        await entry.plugin.stop();
        entry.state = "stopped";
      } catch (err) {
        entry.state = "error";
        entry.error = err instanceof Error ? err.message : String(err);
        log.error("Plugin stop failed", { name, error: entry.error });
      }
    }
  }

  /**
   * Get all context providers from active plugins.
   * Used by the chat loop for keyword-triggered context injection.
   */
  getContextProviders(): Array<{ name: string; provider: PluginContextProvider }> {
    const providers: Array<{ name: string; provider: PluginContextProvider }> = [];

    for (const [name, entry] of this.plugins) {
      if (entry.state === "active" && entry.plugin.context) {
        providers.push({ name, provider: entry.plugin.context });
      }
    }

    return providers;
  }

  /**
   * Get status summary for all plugins.
   */
  getStatus(): PluginStatusMap {
    const status: PluginStatusMap = {};

    for (const [name, entry] of this.plugins) {
      status[name] = {
        name,
        state: entry.state,
        configured: entry.plugin.auth.isConfigured(),
        authenticated: entry.plugin.auth.isAuthenticated(),
        capabilities: entry.plugin.manifest.capabilities,
        error: entry.error,
        health: entry.plugin.client.getHealth(),
      };
    }

    return status;
  }
}
