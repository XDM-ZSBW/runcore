/**
 * GitHub plugin wrapper.
 *
 * Wraps the existing GitHub REST client, webhook handlers, and integration
 * facade behind the standard Plugin interface for PluginRegistry lifecycle.
 *
 * Delegates to:
 * - src/github/client.ts — REST API (issues, PRs, commits, labels, etc.)
 * - src/github/webhooks.ts — event processing (PR, issue, push, comments)
 * - src/integrations/github.ts — facade (init, status, feature flags)
 */

import { BasePlugin } from "../../lib/BasePlugin.js";
import type {
  PluginManifest,
  PluginAuthProvider,
  PluginClient,
  PluginClientHealth,
  PluginContextProvider,
  PluginWebhookProvider,
  PluginResult,
  PluginRoute,
  AuthResult,
  ContextInjection,
  PluginContext,
} from "../../types/plugin.js";
import type { WebhookProvider } from "../../webhooks/registry.js";

// All GitHub modules are byok-tier — dynamic imports
let _clientMod: typeof import("../../github/client.js") | null = null;
async function getClientMod() {
  if (!_clientMod) { try { _clientMod = await import("../../github/client.js"); } catch {} }
  return _clientMod;
}

let _webhooksMod: typeof import("../../github/webhooks.js") | null = null;
async function getWebhooksMod() {
  if (!_webhooksMod) { try { _webhooksMod = await import("../../github/webhooks.js"); } catch {} }
  return _webhooksMod;
}

let _facadeMod: typeof import("../../integrations/github.js") | null = null;
async function getFacadeMod() {
  if (!_facadeMod) { try { _facadeMod = await import("../../integrations/github.js"); } catch {} }
  return _facadeMod;
}

// Eagerly start loading
getClientMod();
getWebhooksMod();
getFacadeMod();

// ── Auth Provider ────────────────────────────────────────────────────────────

class GitHubAuthProvider implements PluginAuthProvider {
  isConfigured(): boolean {
    return !!process.env.GITHUB_TOKEN;
  }

  isAuthenticated(): boolean {
    return _clientMod?.isAvailable() ?? !!process.env.GITHUB_TOKEN;
  }

  clearCredentials(): void {
    // No token cache to clear — token comes from process.env
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

class GitHubPluginClient implements PluginClient {
  readonly pluginName = "github";
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return _clientMod?.isAvailable() ?? false;
  }

  getHealth(): PluginClientHealth {
    if (_clientMod) {
      const h = _clientMod.getHealth();
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

// ── Context Provider ─────────────────────────────────────────────────────────

class GitHubContextProvider implements PluginContextProvider {
  readonly contextKeywords = /\b(github|pull\s*request|PR|issue|commit|repo|merge|branch)\b/i;

  async getContext(_userMessage: string): Promise<ContextInjection | null> {
    // GitHub context injection is handled by the facade in server.ts.
    // Future: inject PR status, issue counts, recent commits here.
    return null;
  }
}

// ── Webhook Provider ─────────────────────────────────────────────────────────

class GitHubWebhookProvider implements PluginWebhookProvider {
  getWebhookProviders(): WebhookProvider[] {
    if (!_webhooksMod) return [];
    return [_webhooksMod.githubProvider];
  }

  getRoutes(): PluginRoute[] {
    return [];
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class GitHubPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    name: "github",
    version: "1.0.0",
    description: "GitHub integration — PRs, issues, commits, webhooks, and repo health.",
    authType: "token",
    requiredConfig: ["GITHUB_TOKEN"],
    optionalConfig: ["GITHUB_WEBHOOK_SECRET", "GITHUB_DEFAULT_REPO"],
    capabilities: ["read", "write", "webhook", "context"],
  };

  readonly auth = new GitHubAuthProvider();
  readonly client = new GitHubPluginClient();
  readonly context = new GitHubContextProvider();
  readonly webhooks = new GitHubWebhookProvider();

  protected override async onAuthenticate(ctx: PluginContext): Promise<AuthResult> {
    if (!this.auth.isConfigured()) {
      return { ok: false, message: "GITHUB_TOKEN not set" };
    }

    const mod = await getClientMod();
    if (!mod) return { ok: false, message: "GitHub client module unavailable" };

    const result = await mod.validateAuth();
    if (result.valid) {
      return { ok: true, message: "GitHub token validated" };
    }
    return { ok: false, message: result.error ?? "Token validation failed" };
  }

  protected override async onStart(ctx: PluginContext): Promise<void> {
    // Initialize the GitHub facade (auto-triage, auto-review wiring)
    const facade = await getFacadeMod();
    if (facade) {
      const defaultRepo = ctx.getVaultKey("GITHUB_DEFAULT_REPO");
      facade.initGitHub({ defaultRepo });
    }
  }

  protected override async onStop(): Promise<void> {
    const facade = await getFacadeMod();
    facade?.shutdownGitHub();
  }
}

/** Create a GitHub plugin instance. */
export function createGitHubPlugin(): GitHubPlugin {
  return new GitHubPlugin();
}
