/**
 * Slack plugin wrapper.
 *
 * Wraps the existing Slack OAuth client and webhook handlers behind the
 * standard Plugin interface for PluginRegistry lifecycle management.
 *
 * Delegates to:
 * - src/slack/client.ts — OAuth, messaging, reactions, DMs
 * - src/slack/webhooks.ts — event processing, slash commands, interactions
 */

import { BasePlugin } from "../../lib/BasePlugin.js";
import type {
  PluginManifest,
  PluginAuthProvider,
  PluginClient,
  PluginClientHealth,
  PluginWebhookProvider,
  PluginResult,
  PluginRoute,
  AuthResult,
  PluginContext,
} from "../../types/plugin.js";
import type { WebhookProvider } from "../../webhooks/registry.js";

// All slack modules are byok-tier — dynamic imports
let _clientMod: typeof import("../../slack/client.js") | null = null;
async function getClientMod() {
  if (!_clientMod) { try { _clientMod = await import("../../slack/client.js"); } catch {} }
  return _clientMod;
}

let _webhooksMod: typeof import("../../slack/webhooks.js") | null = null;
async function getWebhooksMod() {
  if (!_webhooksMod) { try { _webhooksMod = await import("../../slack/webhooks.js"); } catch {} }
  return _webhooksMod;
}

// Eagerly start loading
getClientMod();
getWebhooksMod();

// ── Auth Provider ────────────────────────────────────────────────────────────

class SlackAuthProvider implements PluginAuthProvider {
  isConfigured(): boolean {
    return _clientMod?.isSlackConfigured() ?? false;
  }

  isAuthenticated(): boolean {
    return _clientMod?.isSlackAuthenticated() ?? false;
  }

  getAuthUrl(redirectUri: string): PluginResult<string> {
    if (!_clientMod) return { ok: false, message: "Slack client module unavailable" };
    const result = _clientMod.getOAuthUrl(redirectUri);
    return { ok: result.ok, data: result.url, message: result.message };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<AuthResult> {
    const mod = await getClientMod();
    if (!mod) return { ok: false, message: "Slack client module unavailable" };
    const result = await mod.exchangeOAuthCode(code, redirectUri);
    if (!result.ok) return { ok: false, message: result.message };

    const credentials: Record<string, string> = {};
    if (result.botToken) credentials.SLACK_BOT_TOKEN = result.botToken;
    if (result.teamId) credentials.SLACK_TEAM_ID = result.teamId;

    return {
      ok: true,
      message: `Connected to ${result.teamName ?? "Slack workspace"}`,
      credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    };
  }

  clearCredentials(): void {
    // No token cache to clear — Slack uses a static bot token
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

class SlackPluginClient implements PluginClient {
  readonly pluginName = "slack";
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return _clientMod?.isSlackAuthenticated() ?? false;
  }

  getHealth(): PluginClientHealth {
    const client = _clientMod?.getClient();
    if (client) {
      const h = client.getHealth();
      return {
        available: h.available,
        lastError: h.lastErrorMessage,
        lastErrorAt: this.lastErrorAt,
      };
    }
    return {
      available: false,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date().toISOString();
  }
}

// ── Webhook Provider ─────────────────────────────────────────────────────────

class SlackWebhookProvider implements PluginWebhookProvider {
  getWebhookProviders(): WebhookProvider[] {
    if (!_webhooksMod) return [];
    return [
      _webhooksMod.slackEventsProvider,
      _webhooksMod.slackCommandsProvider,
      _webhooksMod.slackInteractionsProvider,
    ];
  }

  getRoutes(): PluginRoute[] {
    // Routes are registered via webhook registry, not plugin routes
    return [];
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class SlackPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    name: "slack",
    version: "1.0.0",
    description: "Slack integration — messaging, slash commands, and event handling.",
    authType: "oauth2",
    requiredConfig: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    optionalConfig: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    scopes: [
      "app_mentions:read", "channels:history", "channels:join", "channels:read",
      "chat:write", "commands", "files:read", "files:write", "groups:read",
      "im:history", "im:read", "im:write", "mpim:read", "reactions:read",
      "reactions:write", "users:read", "users:read.email",
    ],
    capabilities: ["read", "write", "notify", "webhook", "oauth"],
  };

  readonly auth = new SlackAuthProvider();
  readonly client = new SlackPluginClient();
  readonly webhooks = new SlackWebhookProvider();

  protected override async onAuthenticate(ctx: PluginContext): Promise<AuthResult> {
    if (this.auth.isAuthenticated()) {
      // Validate the token
      const mod = await getClientMod();
      const client = mod?.getClient();
      if (client) {
        const result = await client.validateAuth();
        if (result.valid) {
          return { ok: true, message: `Connected as bot in team ${result.teamId ?? "unknown"}` };
        }
        return { ok: false, message: result.error ?? "Token validation failed" };
      }
      return { ok: true, message: "Bot token present" };
    }
    return { ok: false, message: "SLACK_BOT_TOKEN not set — complete OAuth flow first" };
  }
}

/** Create a Slack plugin instance. */
export function createSlackPlugin(): SlackPlugin {
  return new SlackPlugin();
}
