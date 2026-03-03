/**
 * Abstract base class for Core plugins.
 *
 * Implements the Plugin interface from src/types/plugin.ts with shared
 * lifecycle management, state tracking, and logging. Subclasses provide
 * the manifest, auth provider, and client — BasePlugin handles the
 * init → authenticate → start → stop state machine.
 *
 * Usage:
 *   class GooglePlugin extends BasePlugin { ... }
 *
 * See docs/plugin-system.md for the full developer guide.
 */

import { createLogger } from "../utils/logger.js";
import type {
  Plugin,
  PluginManifest,
  PluginAuthProvider,
  PluginClient,
  PluginContextProvider,
  PluginTimerProvider,
  PluginWebhookProvider,
  PluginContext,
  PluginState,
  PluginStatus,
  AuthResult,
} from "../types/plugin.js";

export abstract class BasePlugin implements Plugin {
  private _state: PluginState = "loaded";
  private _error: string | undefined;
  private _log: ReturnType<typeof createLogger> | undefined;

  /** Lazy logger — deferred because `manifest` is abstract and unavailable in constructor. */
  protected get log() {
    if (!this._log) {
      this._log = createLogger(`plugin.${this.manifest.name}`);
    }
    return this._log;
  }

  // ── Abstract — subclasses must provide ────────────────────────────────────

  abstract readonly manifest: PluginManifest;
  abstract readonly auth: PluginAuthProvider;
  abstract readonly client: PluginClient;

  // ── Optional providers — subclasses override if needed ────────────────────

  readonly context?: PluginContextProvider;
  readonly timer?: PluginTimerProvider;
  readonly webhooks?: PluginWebhookProvider;

  // ── State ─────────────────────────────────────────────────────────────────

  get state(): PluginState {
    return this._state;
  }

  getStatus(): PluginStatus {
    return {
      name: this.manifest.name,
      state: this._state,
      configured: this.auth.isConfigured(),
      authenticated: this.auth.isAuthenticated(),
      capabilities: this.manifest.capabilities,
      error: this._error,
      health: this.client.getHealth(),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Validate config and check dependencies.
   * Override `onInit()` to add plugin-specific initialization.
   */
  async init(ctx: PluginContext): Promise<void> {
    const name = this.manifest.name;
    this.log.info("Initializing plugin");

    // Validate required config keys exist
    const missing = this.manifest.requiredConfig.filter(
      (key) => !ctx.getVaultKey(key),
    );
    if (missing.length > 0) {
      const msg = `Missing required config: ${missing.join(", ")}`;
      this.log.warn(msg);
      // Not fatal — plugin can still be registered, just won't authenticate
    }

    try {
      await this.onInit(ctx);
      this._state = "ready";
      ctx.logActivity({
        source: name,
        summary: `Plugin initialized (${this.manifest.capabilities.join(", ")})`,
      });
    } catch (err) {
      this._state = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this.log.error("Init failed", { error: this._error });
      throw err;
    }
  }

  /**
   * Establish auth. Handles state transitions and error tracking.
   * Override `onAuthenticate()` to add plugin-specific auth logic.
   */
  async authenticate(ctx: PluginContext): Promise<AuthResult> {
    const name = this.manifest.name;

    if (!this.auth.isConfigured()) {
      const msg = "Not configured — missing credentials in vault";
      this.log.info(msg);
      return { ok: false, message: msg };
    }

    try {
      const result = await this.onAuthenticate(ctx);

      if (result.ok) {
        this._state = "authed";
        this._error = undefined;
        // Persist any returned credentials
        if (result.credentials) {
          for (const [key, value] of Object.entries(result.credentials)) {
            await ctx.setVaultKey(key, value);
          }
        }
        ctx.logActivity({ source: name, summary: "Authenticated" });
      } else {
        this.log.warn("Authentication failed", { message: result.message });
      }

      return result;
    } catch (err) {
      this._state = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this.log.error("Authentication error", { error: this._error });
      return { ok: false, message: this._error };
    }
  }

  /**
   * Start background work (timers, webhooks).
   * Override `onStart()` to add plugin-specific startup logic.
   */
  async start(ctx: PluginContext): Promise<void> {
    const name = this.manifest.name;

    if (this._state !== "authed" && this._state !== "ready") {
      this.log.warn("start() called in unexpected state", { state: this._state });
    }

    try {
      // Register webhook providers if the plugin has them
      if (this.webhooks) {
        for (const provider of this.webhooks.getWebhookProviders()) {
          ctx.registerWebhookProvider(provider);
        }
        this.log.info("Webhook providers registered");
      }

      // Start polling timers if the plugin has them
      if (this.timer) {
        this.timer.startTimer();
        this.log.info("Polling timer started");
      }

      await this.onStart(ctx);
      this._state = "active";
      ctx.logActivity({ source: name, summary: "Plugin started" });
    } catch (err) {
      this._state = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this.log.error("Start failed", { error: this._error });
      throw err;
    }
  }

  /**
   * Stop background work and release resources. Idempotent.
   * Override `onStop()` to add plugin-specific cleanup.
   */
  async stop(): Promise<void> {
    if (this._state === "stopped") return;

    try {
      if (this.timer) {
        this.timer.stopTimer();
      }

      await this.onStop();
      this._state = "stopped";
      this.log.info("Plugin stopped");
    } catch (err) {
      this._state = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this.log.error("Stop failed", { error: this._error });
    }
  }

  // ── Hooks for subclasses ──────────────────────────────────────────────────

  /** Called during init(). Override for plugin-specific setup. */
  protected async onInit(_ctx: PluginContext): Promise<void> {}

  /** Called during authenticate(). Must return AuthResult. */
  protected async onAuthenticate(ctx: PluginContext): Promise<AuthResult> {
    // Default: check if already authenticated (works for API key plugins)
    if (this.auth.isAuthenticated()) {
      return { ok: true, message: "Already authenticated" };
    }
    return { ok: false, message: "Not authenticated" };
  }

  /** Called during start(), after webhooks/timers are auto-registered. */
  protected async onStart(_ctx: PluginContext): Promise<void> {}

  /** Called during stop(), before state transition. */
  protected async onStop(): Promise<void> {}
}
