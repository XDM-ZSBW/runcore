/**
 * Slack Web API client — lazy singleton with retry logic.
 * Raw fetch, no SDK. Follows src/google/auth.ts + src/linear/client.ts pattern.
 *
 * Bot token stored in vault as SLACK_BOT_TOKEN (xoxb-...).
 * OAuth credentials: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET.
 *
 * Never throws in public methods — returns { ok, data?, error? }.
 */

import { withRetry, classifyError, SlackApiError } from "./retry.js";
import type { ErrorKind } from "./retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack.client");
import type {
  SlackAuthTestResult,
  SlackOAuthResponse,
  SlackMessage,
  SlackMessagePayload,
  SlackUserInfoResponse,
  SlackUser,
  SlackConversationInfoResponse,
  SlackConversationListResponse,
  SlackChannel,
  SlackFileUploadResult,
  SlackBlock,
} from "./types.js";

// ── OAuth config ──────────────────────────────────────────────────────────────

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_API_BASE = "https://slack.com/api";

/** Bot scopes requested during OAuth install. */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
];

const REQUIRED_OAUTH_VARS = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"] as const;

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Check if Slack OAuth is configured (client ID + secret in vault).
 */
export function isSlackConfigured(): boolean {
  return !!process.env.SLACK_CLIENT_ID && !!process.env.SLACK_CLIENT_SECRET;
}

/**
 * Check if Slack is authenticated (bot token exists).
 */
export function isSlackAuthenticated(): boolean {
  return !!process.env.SLACK_BOT_TOKEN;
}

/**
 * Build the Slack OAuth authorization URL for the Add to Slack flow.
 */
export function getOAuthUrl(redirectUri: string): { ok: boolean; url?: string; message: string } {
  const missing = REQUIRED_OAUTH_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    log.warn("OAuth URL generation failed: missing vault keys", { missing });
    return {
      ok: false,
      message: `Missing vault keys: ${missing.join(", ")}. Add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in vault settings.`,
    };
  }

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: redirectUri,
  });

  log.debug("OAuth URL generated", { redirectUri });
  return {
    ok: true,
    url: `${SLACK_OAUTH_URL}?${params.toString()}`,
    message: "OAuth URL generated",
  };
}

/**
 * Exchange an authorization code for a bot access token.
 * Returns the bot token to be stored in vault.
 */
export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<{ ok: boolean; botToken?: string; teamId?: string; teamName?: string; botUserId?: string; message: string }> {
  const missing = REQUIRED_OAUTH_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    return { ok: false, message: `Missing vault keys: ${missing.join(", ")}` };
  }

  log.debug("Exchanging OAuth code for bot token", { redirectUri });

  try {
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error("OAuth token exchange HTTP error", { status: res.status, body });
      return { ok: false, message: `Slack token error (${res.status}): ${body}` };
    }

    const data = (await res.json()) as SlackOAuthResponse;
    if (!data.ok || !data.access_token) {
      log.error("OAuth token exchange returned error", { error: data.error ?? "No token returned" });
      return { ok: false, message: data.error ?? "No token returned" };
    }

    log.info("OAuth token exchanged successfully", { teamId: data.team?.id, teamName: data.team?.name });
    return {
      ok: true,
      botToken: data.access_token,
      teamId: data.team?.id,
      teamName: data.team?.name,
      botUserId: data.bot_user_id,
      message: "Bot token exchanged successfully",
    };
  } catch (err: any) {
    log.error("OAuth token exchange failed", { error: err.message });
    return { ok: false, message: `Token exchange failed: ${err.message}` };
  }
}

// ── Lazy singleton client ─────────────────────────────────────────────────────

let _client: SlackClient | null = null;
let _lastToken = "";

/** Auth validation cache. */
let _authValid: boolean | null = null;
let _authCheckedAt = 0;
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get or create the singleton Slack client.
 * Returns null if SLACK_BOT_TOKEN is not set.
 */
export function getClient(): SlackClient | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    log.debug("getClient called but SLACK_BOT_TOKEN not set");
    return null;
  }
  if (token !== _lastToken) {
    log.info("Creating new SlackClient instance (token changed)");
    _client = new SlackClient(token);
    _lastToken = token;
    _authValid = null;
    _authCheckedAt = 0;
  }
  return _client;
}

// ── Client class ──────────────────────────────────────────────────────────────

export class SlackClient {
  /** Last error kind for health reporting. */
  lastErrorKind: ErrorKind | null = null;
  lastErrorMessage: string | null = null;

  constructor(private readonly token: string) {}

  // ── Low-level request ───────────────────────────────────────────────────

  /**
   * Make an authenticated Slack API request (JSON body).
   * Throws SlackApiError on failure.
   */
  private async request<T = any>(
    endpoint: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const url = `${SLACK_API_BASE}/${endpoint}`;
    log.debug("API request starting", { endpoint });
    const options: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      signal: AbortSignal.timeout(15_000),
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const data = (await res.json()) as any;

    if (!data.ok) {
      const kind = classifyError(data.error ?? `HTTP ${res.status}`);
      if (kind === "rate_limit") {
        log.warn("Rate limited by Slack API", { endpoint, status: res.status });
      } else {
        log.error("Slack API error response", { endpoint, error: data.error, status: res.status, kind });
      }
      throw new SlackApiError(
        data.error ?? `Slack API error (${res.status})`,
        kind,
        res.status,
      );
    }

    return data as T;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  /**
   * Validate the bot token by calling auth.test.
   * Caches the result for 5 minutes.
   */
  async validateAuth(): Promise<{ valid: boolean; userId?: string; teamId?: string; error?: string }> {
    if (_authValid !== null && Date.now() - _authCheckedAt < AUTH_CACHE_TTL_MS) {
      log.debug("Auth validation returned from cache", { valid: _authValid });
      return _authValid ? { valid: true } : { valid: false, error: "Token invalid (cached)" };
    }

    log.debug("Validating auth token via auth.test");
    try {
      const data = await withRetry(
        () => this.request<SlackAuthTestResult>("auth.test"),
        { label: "validateAuth", maxAttempts: 2 },
      );
      _authValid = true;
      _authCheckedAt = Date.now();
      this.lastErrorKind = null;
      this.lastErrorMessage = null;
      log.info("Auth validation succeeded", { userId: data.user_id, teamId: data.team_id });
      return { valid: true, userId: data.user_id, teamId: data.team_id };
    } catch (err) {
      _authValid = false;
      _authCheckedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = msg;
      log.error("Auth validation failed", { error: msg, errorKind: this.lastErrorKind });
      return { valid: false, error: msg };
    }
  }

  /**
   * Test auth and return basic info. Never throws.
   */
  async testAuth(): Promise<{ ok: boolean; userId?: string; teamId?: string; team?: string; message: string }> {
    log.debug("Testing auth via auth.test");
    try {
      const data = await withRetry(
        () => this.request<SlackAuthTestResult>("auth.test"),
        { label: "testAuth" },
      );
      this.lastErrorKind = null;
      log.info("Auth test succeeded", { userId: data.user_id, teamId: data.team_id, team: data.team });
      return { ok: true, userId: data.user_id, teamId: data.team_id, team: data.team, message: "Auth successful" };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Auth test failed", { error: this.lastErrorMessage, errorKind: this.lastErrorKind });
      return { ok: false, message: this.lastErrorMessage };
    }
  }

  // ── Messages ────────────────────────────────────────────────────────────

  /**
   * Send a message to a channel or DM.
   */
  async sendMessage(
    channel: string,
    text: string,
    opts?: { thread_ts?: string; blocks?: SlackBlock[]; unfurl_links?: boolean },
  ): Promise<SlackMessage> {
    log.debug("Sending message", { channelId: channel, threadTs: opts?.thread_ts, hasBlocks: !!opts?.blocks });
    try {
      const payload: SlackMessagePayload = {
        channel,
        text,
        thread_ts: opts?.thread_ts,
        blocks: opts?.blocks,
        unfurl_links: opts?.unfurl_links,
      };

      const result = await withRetry(
        () => this.request<SlackMessage>("chat.postMessage", payload),
        { label: "sendMessage" },
      );
      this.lastErrorKind = null;
      log.info("Message sent", { channelId: channel, ts: result.ts });
      return { ok: true, channel, ts: result.ts, message: result.message };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to send message", { channelId: channel, error: this.lastErrorMessage, errorKind: this.lastErrorKind });
      return { ok: false, channel, ts: "", error: this.lastErrorMessage };
    }
  }

  /**
   * Update an existing message.
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    opts?: { blocks?: SlackBlock[] },
  ): Promise<SlackMessage> {
    log.debug("Updating message", { channelId: channel, ts });
    try {
      const result = await withRetry(
        () => this.request<SlackMessage>("chat.update", {
          channel,
          ts,
          text,
          blocks: opts?.blocks,
        }),
        { label: "updateMessage" },
      );
      this.lastErrorKind = null;
      log.info("Message updated", { channelId: channel, ts: result.ts });
      return { ok: true, channel, ts: result.ts, message: result.message };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to update message", { channelId: channel, ts, error: this.lastErrorMessage });
      return { ok: false, channel, ts: "", error: this.lastErrorMessage };
    }
  }

  /**
   * Delete a message.
   */
  async deleteMessage(channel: string, ts: string): Promise<{ ok: boolean; error?: string }> {
    log.debug("Deleting message", { channelId: channel, ts });
    try {
      await withRetry(
        () => this.request("chat.delete", { channel, ts }),
        { label: "deleteMessage" },
      );
      this.lastErrorKind = null;
      log.info("Message deleted", { channelId: channel, ts });
      return { ok: true };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to delete message", { channelId: channel, ts, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  /**
   * Reply in a thread (shorthand for sendMessage with thread_ts).
   */
  async replyInThread(
    channel: string,
    threadTs: string,
    text: string,
    opts?: { blocks?: SlackBlock[] },
  ): Promise<SlackMessage> {
    return this.sendMessage(channel, text, { thread_ts: threadTs, blocks: opts?.blocks });
  }

  // ── Reactions ───────────────────────────────────────────────────────────

  async addReaction(channel: string, ts: string, emoji: string): Promise<{ ok: boolean; error?: string }> {
    log.debug("Adding reaction", { channelId: channel, ts, emoji });
    try {
      await withRetry(
        () => this.request("reactions.add", { channel, timestamp: ts, name: emoji }),
        { label: "addReaction" },
      );
      this.lastErrorKind = null;
      return { ok: true };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to add reaction", { channelId: channel, ts, emoji, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  async removeReaction(channel: string, ts: string, emoji: string): Promise<{ ok: boolean; error?: string }> {
    log.debug("Removing reaction", { channelId: channel, ts, emoji });
    try {
      await withRetry(
        () => this.request("reactions.remove", { channel, timestamp: ts, name: emoji }),
        { label: "removeReaction" },
      );
      this.lastErrorKind = null;
      return { ok: true };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to remove reaction", { channelId: channel, ts, emoji, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async getUser(userId: string): Promise<{ ok: boolean; user?: SlackUser; error?: string }> {
    log.debug("Fetching user info", { userId });
    try {
      const data = await withRetry(
        () => this.request<SlackUserInfoResponse>("users.info", { user: userId }),
        { label: "getUser" },
      );
      if (!data.user) {
        log.warn("User lookup returned no data", { userId });
        return { ok: false, error: "No user data returned" };
      }
      this.lastErrorKind = null;
      log.debug("User info retrieved", { userId, userName: data.user.name });
      return {
        ok: true,
        user: {
          id: data.user.id,
          name: data.user.name,
          real_name: data.user.real_name,
          display_name: data.user.profile?.display_name,
          email: data.user.profile?.email,
          is_bot: data.user.is_bot ?? false,
          is_admin: data.user.is_admin,
          tz: data.user.tz,
          avatar: data.user.profile?.image_48,
        },
      };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to fetch user info", { userId, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  async lookupUserByEmail(email: string): Promise<{ ok: boolean; user?: SlackUser; error?: string }> {
    log.debug("Looking up user by email", { email });
    try {
      const data = await withRetry(
        () => this.request<SlackUserInfoResponse>("users.lookupByEmail", { email }),
        { label: "lookupUserByEmail" },
      );
      if (!data.user) {
        log.warn("Email lookup returned no user", { email });
        return { ok: false, error: "No user data returned" };
      }
      this.lastErrorKind = null;
      log.debug("User found by email", { email, userId: data.user.id });
      return {
        ok: true,
        user: {
          id: data.user.id,
          name: data.user.name,
          real_name: data.user.real_name,
          display_name: data.user.profile?.display_name,
          email: data.user.profile?.email,
          is_bot: data.user.is_bot ?? false,
          is_admin: data.user.is_admin,
          tz: data.user.tz,
          avatar: data.user.profile?.image_48,
        },
      };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to look up user by email", { email, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  // ── Files ───────────────────────────────────────────────────────────────

  /**
   * Share a remote file link in a channel.
   * For actual file uploads, use files.uploadV2 via form-data (not yet implemented).
   */
  async shareFileUrl(
    channel: string,
    url: string,
    title: string,
  ): Promise<{ ok: boolean; error?: string }> {
    log.debug("Sharing file URL", { channelId: channel, title });
    try {
      // Use chat.unfurl or just send a link — Slack auto-unfurls file URLs
      const result = await this.sendMessage(channel, `<${url}|${title}>`);
      if (result.ok) {
        log.info("File URL shared", { channelId: channel, title });
      }
      return { ok: result.ok, error: result.error };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to share file URL", { channelId: channel, title, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  // ── DMs ─────────────────────────────────────────────────────────────────

  /**
   * Open a DM channel with a user and return the conversation ID.
   */
  async openDm(userId: string): Promise<{ ok: boolean; channelId?: string; error?: string }> {
    log.debug("Opening DM conversation", { userId });
    try {
      const data = await withRetry(
        () => this.request<{ ok: boolean; channel?: { id: string }; error?: string }>(
          "conversations.open",
          { users: userId },
        ),
        { label: "openDm" },
      );
      this.lastErrorKind = null;
      log.debug("DM conversation opened", { userId, channelId: data.channel?.id });
      return { ok: true, channelId: data.channel?.id };
    } catch (err) {
      this.lastErrorKind = classifyError(err);
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to open DM conversation", { userId, error: this.lastErrorMessage });
      return { ok: false, error: this.lastErrorMessage };
    }
  }

  /**
   * Send a DM to a user (opens conversation first, then sends message).
   */
  async sendDm(
    userId: string,
    text: string,
    opts?: { blocks?: SlackBlock[] },
  ): Promise<SlackMessage> {
    log.debug("Sending DM", { userId });
    const dm = await this.openDm(userId);
    if (!dm.ok || !dm.channelId) {
      log.error("Failed to send DM: could not open conversation", { userId, error: dm.error });
      return { ok: false, channel: "", ts: "", error: dm.error ?? "Failed to open DM" };
    }
    return this.sendMessage(dm.channelId, text, { blocks: opts?.blocks });
  }

  // ── Health ──────────────────────────────────────────────────────────────

  getHealth(): { available: boolean; lastError: ErrorKind | null; lastErrorMessage: string | null } {
    return {
      available: !!this.token,
      lastError: this.lastErrorKind,
      lastErrorMessage: this.lastErrorMessage,
    };
  }
}
