/**
 * Google plugin wrapper.
 *
 * Wraps the existing Google OAuth, Calendar, Gmail, and Tasks integrations
 * behind the standard Plugin interface so the PluginRegistry can manage
 * the lifecycle uniformly.
 *
 * This is a WRAPPER — it delegates to existing code in google/auth.ts,
 * google/calendar-timer.ts, google/gmail-timer.ts, and google/tasks-timer.ts.
 */

import type {
  Plugin,
  PluginManifest,
  PluginContext,
  PluginAuthProvider,
  PluginClient,
  PluginTimerProvider,
  PluginContextProvider,
  PluginClientHealth,
  AuthResult,
  PluginResult,
  ContextInjection,
} from "../types/plugin.js";

import {
  isGoogleConfigured,
  isGoogleAuthenticated,
  getAccessToken,
  getAuthUrl,
  exchangeCode,
  clearTokenCache,
  GOOGLE_SCOPES,
} from "./auth.js";

import { startCalendarTimer, stopCalendarTimer, isCalendarTimerRunning } from "./calendar-timer.js";
import { startGmailTimer, stopGmailTimer, isGmailTimerRunning } from "./gmail-timer.js";
import { startTasksTimer, stopTasksTimer, isTasksTimerRunning } from "./tasks-timer.js";

// ── Manifest ────────────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  name: "google",
  version: "1.0.0",
  description: "Google Workspace integration — Calendar, Gmail, Tasks, and Drive.",
  authType: "oauth2",
  requiredConfig: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  optionalConfig: ["GOOGLE_REFRESH_TOKEN"],
  scopes: GOOGLE_SCOPES,
  contextKeywords: /\b(calendar|schedule|meeting|event|email|gmail|inbox|task|tasks)\b/i,
  capabilities: ["read", "write", "poll", "context", "oauth"],
};

// ── Auth Provider ───────────────────────────────────────────────────────────

class GoogleAuthProvider implements PluginAuthProvider {
  isConfigured(): boolean {
    return isGoogleConfigured();
  }

  isAuthenticated(): boolean {
    return isGoogleAuthenticated();
  }

  getAuthUrl(redirectUri: string): PluginResult<string> {
    const result = getAuthUrl(redirectUri);
    return {
      ok: result.ok,
      data: result.url,
      message: result.message,
    };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<AuthResult> {
    const result = await exchangeCode(code, redirectUri);
    const credentials: Record<string, string> = {};
    if (result.refreshToken) credentials.GOOGLE_REFRESH_TOKEN = result.refreshToken;
    if (result.accessToken) credentials.GOOGLE_ACCESS_TOKEN = result.accessToken;

    return {
      ok: result.ok,
      message: result.message,
      credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    };
  }

  async getAccessToken(): Promise<PluginResult<string>> {
    const result = await getAccessToken();
    return {
      ok: result.ok,
      data: result.token,
      message: result.message,
    };
  }

  clearCredentials(): void {
    clearTokenCache();
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

class GoogleClient implements PluginClient {
  readonly pluginName = "google";

  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return isGoogleAuthenticated();
  }

  getHealth(): PluginClientHealth {
    return {
      available: this.isAvailable(),
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /** Record an error (called internally if needed). */
  recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date().toISOString();
  }
}

// ── Timer Provider ──────────────────────────────────────────────────────────

class GoogleTimerProvider implements PluginTimerProvider {
  startTimer(intervalMs?: number): void {
    startCalendarTimer(intervalMs);
    startGmailTimer(intervalMs);
    startTasksTimer(intervalMs);
  }

  stopTimer(): void {
    stopCalendarTimer();
    stopGmailTimer();
    stopTasksTimer();
  }

  isTimerRunning(): boolean {
    return isCalendarTimerRunning() || isGmailTimerRunning() || isTasksTimerRunning();
  }
}

// ── Context Provider ────────────────────────────────────────────────────────

class GoogleContextProvider implements PluginContextProvider {
  readonly contextKeywords = /\b(calendar|schedule|meeting|event|email|gmail|inbox|task|tasks)\b/i;

  async getContext(_userMessage: string): Promise<ContextInjection | null> {
    // The existing context injection in server.ts handles Google context.
    // This is a future migration path — for now, return null.
    return null;
  }
}

// ── Plugin Implementation ───────────────────────────────────────────────────

class GooglePlugin implements Plugin {
  readonly manifest = manifest;
  readonly auth = new GoogleAuthProvider();
  readonly client = new GoogleClient();
  readonly context = new GoogleContextProvider();
  readonly timer = new GoogleTimerProvider();

  async init(ctx: PluginContext): Promise<void> {
    // Validate that required config keys exist
    const missing = manifest.requiredConfig.filter(
      (key) => !ctx.getVaultKey(key),
    );
    if (missing.length > 0) {
      ctx.logActivity({
        source: "google",
        summary: `Plugin init: missing config keys: ${missing.join(", ")}`,
      });
    }
  }

  async authenticate(ctx: PluginContext): Promise<AuthResult> {
    if (!this.auth.isConfigured()) {
      return {
        ok: false,
        message: "Google OAuth not configured — missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET",
      };
    }

    if (this.auth.isAuthenticated()) {
      ctx.logActivity({
        source: "google",
        summary: "Plugin authenticated (refresh token present)",
      });
      return { ok: true, message: "Already authenticated" };
    }

    return {
      ok: false,
      message: "Not authenticated — no GOOGLE_REFRESH_TOKEN. Complete OAuth flow first.",
    };
  }

  async start(ctx: PluginContext): Promise<void> {
    this.timer.startTimer();
    ctx.logActivity({
      source: "google",
      summary: "Plugin started — Calendar, Gmail, and Tasks timers running",
    });
  }

  async stop(): Promise<void> {
    this.timer.stopTimer();
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Google plugin instance.
 * Use with the PluginRegistry: `registry.register(createGooglePlugin(), ctx)`
 */
export function createGooglePlugin(): Plugin {
  return new GooglePlugin();
}
