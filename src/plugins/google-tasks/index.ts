/**
 * Google Tasks plugin — proof-of-concept plugin wrapping the existing
 * src/integrations/google-tasks.ts facade using the plugin interface.
 *
 * Demonstrates how existing integrations map to the BasePlugin pattern:
 * - Auth: wraps src/google/auth.ts functions
 * - Client: wraps src/google/tasks.ts operations
 * - Timer: wraps src/google/tasks-timer.ts polling
 * - Context: wraps getTasksSummary() for LLM injection
 *
 * Usage:
 *   import { GoogleTasksPlugin } from "./plugins/google-tasks/index.js";
 *   const registry = new PluginRegistry();
 *   await registry.register(new GoogleTasksPlugin(), ctx);
 */

import { BasePlugin } from "../../lib/BasePlugin.js";
import type {
  PluginManifest,
  PluginAuthProvider,
  PluginClient,
  PluginClientHealth,
  PluginContextProvider,
  PluginTimerProvider,
  PluginResult,
  ContextInjection,
  AuthResult,
  PluginContext,
} from "../../types/plugin.js";
// google/auth.js is byok-tier — dynamic import
let _authMod: typeof import("../../google/auth.js") | null = null;
async function getAuthMod() {
  if (!_authMod) { try { _authMod = await import("../../google/auth.js"); } catch {} }
  return _authMod;
}

// google/tasks.js is byok-tier — dynamic import
let _tasksMod: typeof import("../../google/tasks.js") | null = null;
async function getTasksMod() {
  if (!_tasksMod) { try { _tasksMod = await import("../../google/tasks.js"); } catch {} }
  return _tasksMod;
}

// google/tasks-timer.js is byok-tier — dynamic import
let _timerMod: typeof import("../../google/tasks-timer.js") | null = null;
async function getTimerMod() {
  if (!_timerMod) { try { _timerMod = await import("../../google/tasks-timer.js"); } catch {} }
  return _timerMod;
}

// Eagerly start loading so modules are ready when sync methods are called
getAuthMod();
getTasksMod();
getTimerMod();

// ── Auth Provider ────────────────────────────────────────────────────────────

class GoogleTasksAuth implements PluginAuthProvider {
  isConfigured(): boolean {
    return _authMod?.isGoogleConfigured() ?? false;
  }

  isAuthenticated(): boolean {
    return _authMod?.isGoogleAuthenticated() ?? false;
  }

  getAuthUrl(redirectUri: string): PluginResult<string> {
    if (!_authMod) return { ok: false, message: "Google auth module unavailable" };
    if (!this.isConfigured()) {
      return { ok: false, message: "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET" };
    }
    const result = _authMod.getAuthUrl(redirectUri);
    return { ok: true, data: result.url, message: "Auth URL generated" };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<AuthResult> {
    const authMod = await getAuthMod();
    if (!authMod) return { ok: false, message: "Google auth module unavailable" };
    const result = await authMod.exchangeCode(code, redirectUri);
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    return { ok: true, message: "OAuth tokens exchanged" };
  }

  clearCredentials(): void {
    _authMod?.clearTokenCache();
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

class GoogleTasksClient implements PluginClient {
  readonly pluginName = "google-tasks";
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return _tasksMod?.isTasksAvailable() ?? false;
  }

  getHealth(): PluginClientHealth {
    return {
      available: this.isAvailable(),
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /** Called by the plugin to track errors from timer/context operations. */
  recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date().toISOString();
  }

  clearError(): void {
    this.lastError = null;
    this.lastErrorAt = null;
  }
}

// ── Timer Provider ───────────────────────────────────────────────────────────

class GoogleTasksTimer implements PluginTimerProvider {
  startTimer(intervalMs?: number): void {
    _timerMod?.startTasksTimer(intervalMs);
  }

  stopTimer(): void {
    _timerMod?.stopTasksTimer();
  }

  isTimerRunning(): boolean {
    return _timerMod?.isTasksTimerRunning() ?? false;
  }
}

// ── Context Provider ─────────────────────────────────────────────────────────

class GoogleTasksContext implements PluginContextProvider {
  readonly contextKeywords = /\b(task|todo|reminder|due|overdue)\b/i;

  constructor(private client: GoogleTasksClient) {}

  async getContext(_userMessage: string): Promise<ContextInjection | null> {
    const tasksMod = await getTasksMod();
    if (!tasksMod?.isTasksAvailable()) return null;

    try {
      const result = await tasksMod.listTasks("@default", { showCompleted: false });
      if (!result.ok || !result.data || result.data.length === 0) return null;

      this.client.clearError();

      return {
        label: "Google Tasks",
        content: tasksMod.formatTasksForContext(result.data),
        priority: 60, // after calendar (40) and board (50)
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.client.recordError(msg);
      return null;
    }
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class GoogleTasksPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    name: "google-tasks",
    version: "0.1.0",
    description: "Google Tasks — personal task management and reminders",
    authType: "oauth2",
    requiredConfig: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalConfig: ["GOOGLE_REFRESH_TOKEN"],
    scopes: ["https://www.googleapis.com/auth/tasks"],
    contextKeywords: /\b(task|todo|reminder|due|overdue)\b/i,
    capabilities: ["read", "write", "poll", "context", "oauth"],
  };

  readonly auth = new GoogleTasksAuth();
  readonly client = new GoogleTasksClient();
  readonly timer = new GoogleTasksTimer();
  readonly context = new GoogleTasksContext(this.client as GoogleTasksClient);

  protected override async onAuthenticate(_ctx: PluginContext): Promise<AuthResult> {
    if (this.auth.isAuthenticated()) {
      return { ok: true, message: "Google OAuth tokens present" };
    }
    return { ok: false, message: "Run OAuth flow to authenticate (GOOGLE_REFRESH_TOKEN not set)" };
  }
}
