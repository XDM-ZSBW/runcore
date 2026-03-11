/**
 * Twilio plugin wrapper.
 *
 * Wraps the existing Twilio voice call module behind the standard Plugin
 * interface for PluginRegistry lifecycle management.
 *
 * Delegates to:
 * - src/twilio/call.ts — voice call via REST API
 */

import { BasePlugin } from "../../lib/BasePlugin.js";
import type {
  PluginManifest,
  PluginAuthProvider,
  PluginClient,
  PluginClientHealth,
  PluginResult,
  AuthResult,
  PluginContext,
} from "../../types/plugin.js";

// Twilio is byok-tier — dynamic import
let _callMod: typeof import("../../twilio/call.js") | null = null;
async function getCallMod() {
  if (!_callMod) { try { _callMod = await import("../../twilio/call.js"); } catch {} }
  return _callMod;
}

// Eagerly start loading
getCallMod();

// ── Auth Provider ────────────────────────────────────────────────────────────

class TwilioAuthProvider implements PluginAuthProvider {
  isConfigured(): boolean {
    return !!process.env.TWILIO_ACCOUNT_SID
      && !!process.env.TWILIO_AUTH_TOKEN
      && !!process.env.TWILIO_PHONE_NUMBER;
  }

  isAuthenticated(): boolean {
    // Twilio uses API key auth — if configured, it's authenticated
    return this.isConfigured();
  }

  clearCredentials(): void {
    // No token cache — credentials come from process.env
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

class TwilioPluginClient implements PluginClient {
  readonly pluginName = "twilio";
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return !!process.env.TWILIO_ACCOUNT_SID
      && !!process.env.TWILIO_AUTH_TOKEN
      && !!process.env.TWILIO_PHONE_NUMBER;
  }

  getHealth(): PluginClientHealth {
    return {
      available: this.isAvailable(),
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date().toISOString();
  }

  clearError(): void {
    this.lastError = null;
    this.lastErrorAt = null;
  }

  /** Make a voice call. Convenience method exposing the underlying module. */
  async makeCall(opts?: { to?: string; message?: string; voice?: string }): Promise<PluginResult<string>> {
    const mod = await getCallMod();
    if (!mod) return { ok: false, message: "Twilio call module unavailable" };

    const result = await mod.makeCall(opts);
    if (result.ok) {
      this.clearError();
      return { ok: true, data: result.sid, message: result.message };
    }
    this.recordError(result.message);
    return { ok: false, message: result.message };
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class TwilioPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    name: "twilio",
    version: "1.0.0",
    description: "Twilio integration — voice calls via REST API.",
    authType: "api_key",
    requiredConfig: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
    optionalConfig: ["HUMAN_PHONE_NUMBER"],
    capabilities: ["notify"],
  };

  readonly auth = new TwilioAuthProvider();
  readonly client = new TwilioPluginClient();

  protected override async onAuthenticate(_ctx: PluginContext): Promise<AuthResult> {
    if (this.auth.isConfigured()) {
      return { ok: true, message: "Twilio credentials present" };
    }
    return { ok: false, message: "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER" };
  }
}

/** Create a Twilio plugin instance. */
export function createTwilioPlugin(): TwilioPlugin {
  return new TwilioPlugin();
}
