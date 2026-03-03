/**
 * Slack webhook signature verification, event processing, and slash command handling.
 * Processes incoming Events API payloads, slash commands, and interactive payloads.
 *
 * Webhook setup: Configure in Slack App settings → Event Subscriptions.
 * URL: https://<your-domain>/api/slack/events
 * Slash commands: https://<your-domain>/api/slack/commands
 * Interactivity: https://<your-domain>/api/slack/interactions
 */

import { logActivity } from "../activity/log.js";
import { getClient } from "./client.js";
import type {
  SlackEventEnvelope,
  SlackEvent,
  SlackSlashCommand,
  SlackInteractionPayload,
} from "./types.js";
import { hmacSha256Hex, timingSafeCompare, isTimestampFresh } from "../webhooks/registry.js";
import { createSlackStyleProvider, safeHandler } from "../webhooks/handlers.js";
import { getInstanceName, getInstanceNameLower } from "../instance.js";

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verify a Slack request signature using the signing secret.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Slack sends:
 * - X-Slack-Request-Timestamp: Unix timestamp
 * - X-Slack-Signature: v0=<hmac-sha256>
 *
 * Base string: `v0:{timestamp}:{body}`
 * Uses generic signature helpers from webhooks/registry.
 */
export function verifySignature(
  body: string,
  signature: string,
  timestamp: string,
  signingSecret: string,
): boolean {
  // Reject requests older than 5 minutes (replay attack prevention)
  const requestTime = parseInt(timestamp, 10);
  if (!isTimestampFresh(requestTime)) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const computed = `v0=${hmacSha256Hex(baseString, signingSecret)}`;
  return timingSafeCompare(signature, computed);
}

// ── Event processing ──────────────────────────────────────────────────────────

/**
 * Process a Slack Events API payload.
 * Handles URL verification challenge and routes events to handlers.
 */
export async function processEvent(
  envelope: SlackEventEnvelope,
): Promise<{ handled: boolean; message: string; challenge?: string }> {
  // URL verification: return challenge immediately
  if (envelope.type === "url_verification") {
    return { handled: true, message: "URL verified", challenge: envelope.challenge };
  }

  // Rate limited notification
  if (envelope.type === "app_rate_limited") {
    logActivity({ source: "slack", summary: "App rate limited by Slack" });
    return { handled: true, message: "Rate limit acknowledged" };
  }

  // Event callback
  if (envelope.type !== "event_callback" || !envelope.event) {
    return { handled: false, message: `Unknown envelope type: ${envelope.type}` };
  }

  return routeEvent(envelope.event);
}

/** Route an individual event to its handler. */
async function routeEvent(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  // Ignore bot messages to prevent loops
  if (event.bot_id || event.subtype === "bot_message") {
    return { handled: true, message: "Ignored bot message" };
  }

  switch (event.type) {
    case "app_mention":
      return handleAppMention(event);
    case "message":
      return handleMessage(event);
    case "reaction_added":
      return handleReactionAdded(event);
    case "reaction_removed":
      return handleReactionRemoved(event);
    case "member_joined_channel":
      return handleMemberJoined(event);
    case "app_home_opened":
      return handleAppHomeOpened(event);
    default:
      return { handled: false, message: `Unhandled event type: ${event.type}` };
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleAppMention(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  const mentionText = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();

  logActivity({
    source: "slack",
    summary: `App mention from <@${event.user}>: "${mentionText}"`,
    detail: `channel=${event.channel} ts=${event.ts}`,
  });

  // Auto-acknowledge with a reaction
  const client = getClient();
  if (client && event.channel && event.ts) {
    await client.addReaction(event.channel, event.ts, "eyes");
  }

  return { handled: true, message: `App mention from ${event.user}` };
}

async function handleMessage(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  // Only process DMs (im) — channel messages are handled via app_mention
  if (event.channel_type !== "im") {
    return { handled: true, message: "Channel message (not DM), skipped" };
  }

  logActivity({
    source: "slack",
    summary: `DM from <@${event.user}>: "${event.text}"`,
    detail: `channel=${event.channel} ts=${event.ts}`,
  });

  return { handled: true, message: `DM from ${event.user}` };
}

async function handleReactionAdded(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  logActivity({
    source: "slack",
    summary: `Reaction :${event.reaction}: added by <@${event.user}> in ${event.item?.channel}`,
  });

  return { handled: true, message: `Reaction added: ${event.reaction}` };
}

async function handleReactionRemoved(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  return { handled: true, message: `Reaction removed: ${event.reaction}` };
}

async function handleMemberJoined(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  logActivity({
    source: "slack",
    summary: `<@${event.user}> joined <#${event.channel}>`,
  });

  return { handled: true, message: `Member joined channel` };
}

async function handleAppHomeOpened(
  event: SlackEvent,
): Promise<{ handled: boolean; message: string }> {
  // Could publish an App Home view here using views.publish
  return { handled: true, message: `App Home opened by ${event.user}` };
}

// ── Slash commands ────────────────────────────────────────────────────────────

/**
 * Process an incoming slash command.
 * Returns the response text/blocks to send back to the user.
 */
export async function processSlashCommand(
  cmd: SlackSlashCommand,
): Promise<{ ok: boolean; response_type?: "in_channel" | "ephemeral"; text: string; blocks?: any[] }> {
  logActivity({
    source: "slack",
    summary: `Slash command ${cmd.command} from @${cmd.user_name}: "${cmd.text}"`,
    detail: `channel=${cmd.channel_name} team=${cmd.team_domain}`,
  });

  switch (cmd.command) {
    case `/${getInstanceNameLower()}`:
      return handleDashCommand(cmd);
    case "/status":
      return handleStatusCommand(cmd);
    default:
      return {
        ok: true,
        response_type: "ephemeral",
        text: `Unknown command: ${cmd.command}. Try /${getInstanceNameLower()} help`,
      };
  }
}

async function handleDashCommand(
  cmd: SlackSlashCommand,
): Promise<{ ok: boolean; response_type: "in_channel" | "ephemeral"; text: string }> {
  const args = cmd.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase() || "help";

  switch (subcommand) {
    case "help":
      return {
        ok: true,
        response_type: "ephemeral",
        text: [
          `*${getInstanceName()} Commands:*`,
          `\`/${getInstanceNameLower()} help\` — Show this help message`,
          `\`/${getInstanceNameLower()} status\` — Check ${getInstanceName()} connection status`,
          `\`/${getInstanceNameLower()} ping\` — Test connectivity`,
        ].join("\n"),
      };

    case "ping":
      return {
        ok: true,
        response_type: "ephemeral",
        text: `Pong! ${getInstanceName()} is connected and listening.`,
      };

    case "status":
      return handleStatusCommand(cmd);

    default:
      return {
        ok: true,
        response_type: "ephemeral",
        text: `Unknown subcommand: ${subcommand}. Try \`/${getInstanceNameLower()} help\``,
      };
  }
}

async function handleStatusCommand(
  _cmd: SlackSlashCommand,
): Promise<{ ok: boolean; response_type: "in_channel" | "ephemeral"; text: string }> {
  const client = getClient();
  if (!client) {
    return { ok: true, response_type: "ephemeral", text: `${getInstanceName()} is not connected (no bot token).` };
  }

  const auth = await client.testAuth();
  if (!auth.ok) {
    return { ok: true, response_type: "ephemeral", text: `${getInstanceName()} connection error: ${auth.message}` };
  }

  return {
    ok: true,
    response_type: "ephemeral",
    text: `${getInstanceName()} is connected to *${auth.team}* as <@${auth.userId}>.`,
  };
}

// ── Interactive payloads ──────────────────────────────────────────────────────

/**
 * Process an interactive payload (button clicks, menu selections, etc.).
 */
// ── Registry integration ────────────────────────────────────────────────────

/** Slack Events API webhook provider (deferred registration). */
export const slackEventsProvider = createSlackStyleProvider({
  name: "slack-events",
  process: safeHandler("slack-events", async (payload) => {
    const envelope = payload as SlackEventEnvelope;
    const result = await processEvent(envelope);
    if (result.challenge !== undefined) {
      return { handled: result.handled, message: result.message, data: { challenge: result.challenge } };
    }
    return result;
  }),
});

/** Slack slash commands webhook provider (deferred registration). */
export const slackCommandsProvider = createSlackStyleProvider({
  name: "slack-commands",
  process: safeHandler("slack-commands", async (payload) => {
    // Slash command payloads arrive as URL-encoded form data.
    // When routed via createWebhookRoute, parsed is Record<string, string>.
    const raw = payload as Record<string, string>;
    const cmd: SlackSlashCommand = {
      token: raw.token ?? "",
      team_id: raw.team_id ?? "",
      team_domain: raw.team_domain ?? "",
      channel_id: raw.channel_id ?? "",
      channel_name: raw.channel_name ?? "",
      user_id: raw.user_id ?? "",
      user_name: raw.user_name ?? "",
      command: raw.command ?? "",
      text: raw.text ?? "",
      response_url: raw.response_url ?? "",
      trigger_id: raw.trigger_id ?? "",
      api_app_id: raw.api_app_id ?? "",
    };
    const result = await processSlashCommand(cmd);
    return { handled: result.ok, message: result.text, data: result as unknown as Record<string, unknown> };
  }),
});

/** Slack interactions webhook provider (deferred registration). */
export const slackInteractionsProvider = createSlackStyleProvider({
  name: "slack-interactions",
  process: safeHandler("slack-interactions", async (payload) => {
    // Interactive payloads arrive as URL-encoded form with a "payload" JSON field.
    // When routed via createWebhookRoute, parsed is Record<string, string>.
    let interactionPayload: SlackInteractionPayload;
    const raw = payload as Record<string, unknown>;
    if (typeof raw.payload === "string") {
      interactionPayload = JSON.parse(raw.payload) as SlackInteractionPayload;
    } else if (raw.type && raw.user) {
      // Already parsed (direct call)
      interactionPayload = payload as SlackInteractionPayload;
    } else {
      return { handled: false, message: "Slack interactions: missing payload field" };
    }
    return processInteraction(interactionPayload);
  }),
});

export async function processInteraction(
  payload: SlackInteractionPayload,
): Promise<{ handled: boolean; message: string }> {
  logActivity({
    source: "slack",
    summary: `Interaction (${payload.type}) from @${payload.user.username}`,
    detail: payload.actions?.[0]?.action_id,
  });

  if (payload.type === "block_actions" && payload.actions) {
    for (const action of payload.actions) {
      switch (action.action_id) {
        case "task_action":
          // Handle task-related button clicks
          logActivity({
            source: "slack",
            summary: `Task action: ${action.value} by ${payload.user.username}`,
          });
          break;
        default:
          break;
      }
    }
    return { handled: true, message: "Block actions processed" };
  }

  return { handled: false, message: `Unhandled interaction type: ${payload.type}` };
}
