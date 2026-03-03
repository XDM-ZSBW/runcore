/**
 * Slack channel management — list, join, info, post, and thread operations.
 * Wraps SlackClient methods with activity logging.
 * Follows src/linear/projects.ts pattern: standalone functions, never throw.
 */

import { getClient } from "./client.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import type { SlackChannel, SlackBlock } from "./types.js";

const log = createLogger("slack.channels");

// ── Channel listing ───────────────────────────────────────────────────────────

/**
 * List channels the bot can see. Supports pagination via cursor.
 */
export async function listChannels(opts?: {
  types?: string;
  limit?: number;
  cursor?: string;
  exclude_archived?: boolean;
}): Promise<{ ok: boolean; channels?: SlackChannel[]; nextCursor?: string; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Listing channels", { types: opts?.types, limit: opts?.limit, cursor: opts?.cursor });
  try {
    const data = await slackPost<{
      ok: boolean;
      channels?: Array<{
        id: string;
        name: string;
        is_channel?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
        is_member?: boolean;
        num_members?: number;
        topic?: { value: string };
        purpose?: { value: string };
      }>;
      response_metadata?: { next_cursor?: string };
      error?: string;
    }>("conversations.list", {
      types: opts?.types ?? "public_channel,private_channel",
      limit: opts?.limit ?? 100,
      cursor: opts?.cursor,
      exclude_archived: opts?.exclude_archived ?? true,
    });

    if (!data.ok) {
      log.error("Failed to list channels", { error: data.error });
      return { ok: false, message: data.error ?? "Failed to list channels" };
    }

    const channels: SlackChannel[] = (data.channels ?? []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_channel: ch.is_channel ?? true,
      is_im: ch.is_im ?? false,
      is_mpim: ch.is_mpim ?? false,
      is_private: ch.is_private ?? false,
      is_archived: ch.is_archived ?? false,
      is_member: ch.is_member ?? false,
      num_members: ch.num_members,
      topic: ch.topic?.value,
      purpose: ch.purpose?.value,
    }));

    log.info("Channels listed", { count: channels.length, hasMore: !!data.response_metadata?.next_cursor });
    return {
      ok: true,
      channels,
      nextCursor: data.response_metadata?.next_cursor || undefined,
      message: `Found ${channels.length} channels`,
    };
  } catch (err: any) {
    log.error("Channel listing failed", { error: err.message });
    return { ok: false, message: `Failed to list channels: ${err.message}` };
  }
}

/**
 * Get info about a specific channel.
 */
export async function getChannelInfo(channelId: string): Promise<{ ok: boolean; channel?: SlackChannel; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Fetching channel info", { channelId });
  try {
    const data = await slackPost<{
      ok: boolean;
      channel?: {
        id: string;
        name: string;
        is_channel?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
        is_member?: boolean;
        num_members?: number;
        topic?: { value: string };
        purpose?: { value: string };
      };
      error?: string;
    }>("conversations.info", { channel: channelId });

    if (!data.ok || !data.channel) {
      log.warn("Channel not found", { channelId, error: data.error });
      return { ok: false, message: data.error ?? "Channel not found" };
    }

    const ch = data.channel;
    log.debug("Channel info retrieved", { channelId, channelName: ch.name });
    return {
      ok: true,
      channel: {
        id: ch.id,
        name: ch.name,
        is_channel: ch.is_channel ?? true,
        is_im: ch.is_im ?? false,
        is_mpim: ch.is_mpim ?? false,
        is_private: ch.is_private ?? false,
        is_archived: ch.is_archived ?? false,
        is_member: ch.is_member ?? false,
        num_members: ch.num_members,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
      },
      message: `Channel: ${ch.name}`,
    };
  } catch (err: any) {
    log.error("Failed to get channel info", { channelId, error: err.message });
    return { ok: false, message: `Failed to get channel info: ${err.message}` };
  }
}

// ── Channel operations ────────────────────────────────────────────────────────

/**
 * Join a public channel.
 */
export async function joinChannel(channelId: string): Promise<{ ok: boolean; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Joining channel", { channelId });
  try {
    const data = await slackPost<{ ok: boolean; channel?: { name: string }; error?: string }>(
      "conversations.join",
      { channel: channelId },
    );

    if (!data.ok) {
      log.error("Failed to join channel", { channelId, error: data.error });
      return { ok: false, message: data.error ?? "Failed to join channel" };
    }

    log.info("Joined channel", { channelId, channelName: data.channel?.name });
    logActivity({ source: "slack", summary: `Joined channel ${data.channel?.name ?? channelId}` });
    return { ok: true, message: `Joined ${data.channel?.name ?? channelId}` };
  } catch (err: any) {
    log.error("Channel join failed", { channelId, error: err.message });
    return { ok: false, message: `Failed to join channel: ${err.message}` };
  }
}

/**
 * Set the channel topic.
 */
export async function setChannelTopic(
  channelId: string,
  topic: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Setting channel topic", { channelId });
  try {
    const data = await slackPost<{ ok: boolean; error?: string }>(
      "conversations.setTopic",
      { channel: channelId, topic },
    );

    if (!data.ok) {
      log.error("Failed to set channel topic", { channelId, error: data.error });
      return { ok: false, message: data.error ?? "Failed to set topic" };
    }
    log.info("Channel topic updated", { channelId });
    return { ok: true, message: "Topic updated" };
  } catch (err: any) {
    log.error("Channel topic update failed", { channelId, error: err.message });
    return { ok: false, message: `Failed to set topic: ${err.message}` };
  }
}

/**
 * Set the channel purpose.
 */
export async function setChannelPurpose(
  channelId: string,
  purpose: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Setting channel purpose", { channelId });
  try {
    const data = await slackPost<{ ok: boolean; error?: string }>(
      "conversations.setPurpose",
      { channel: channelId, purpose },
    );

    if (!data.ok) {
      log.error("Failed to set channel purpose", { channelId, error: data.error });
      return { ok: false, message: data.error ?? "Failed to set purpose" };
    }
    log.info("Channel purpose updated", { channelId });
    return { ok: true, message: "Purpose updated" };
  } catch (err: any) {
    log.error("Channel purpose update failed", { channelId, error: err.message });
    return { ok: false, message: `Failed to set purpose: ${err.message}` };
  }
}

// ── Posting ───────────────────────────────────────────────────────────────────

/**
 * Post a message to a channel with activity logging.
 */
export async function postMessage(
  channel: string,
  text: string,
  opts?: { thread_ts?: string; blocks?: SlackBlock[] },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const client = getClient();
  if (!client) return { ok: false, error: "SLACK_BOT_TOKEN not set" };

  log.debug("Posting message to channel", { channelId: channel, threadTs: opts?.thread_ts });
  const result = await client.sendMessage(channel, text, opts);
  if (result.ok) {
    log.info("Message posted to channel", { channelId: channel, ts: result.ts });
    logActivity({ source: "slack", summary: `Message posted to ${channel}` });
  } else {
    log.error("Failed to post message", { channelId: channel, error: result.error });
  }
  return { ok: result.ok, ts: result.ts || undefined, error: result.error };
}

/**
 * Post a threaded reply.
 */
export async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string,
  opts?: { blocks?: SlackBlock[] },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const client = getClient();
  if (!client) return { ok: false, error: "SLACK_BOT_TOKEN not set" };

  log.debug("Posting thread reply", { channelId: channel, threadTs });
  const result = await client.replyInThread(channel, threadTs, text, opts);
  if (result.ok) {
    log.info("Thread reply posted", { channelId: channel, threadTs, ts: result.ts });
    logActivity({ source: "slack", summary: `Thread reply posted in ${channel}` });
  } else {
    log.error("Failed to post thread reply", { channelId: channel, threadTs, error: result.error });
  }
  return { ok: result.ok, ts: result.ts || undefined, error: result.error };
}

// ── History ───────────────────────────────────────────────────────────────────

/**
 * Fetch recent messages from a channel.
 */
export async function getChannelHistory(
  channelId: string,
  opts?: { limit?: number; oldest?: string; latest?: string },
): Promise<{ ok: boolean; messages?: Array<{ user?: string; text: string; ts: string; thread_ts?: string }>; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  log.debug("Fetching channel history", { channelId, limit: opts?.limit });
  try {
    const data = await slackPost<{
      ok: boolean;
      messages?: Array<{ user?: string; text?: string; ts: string; thread_ts?: string }>;
      error?: string;
    }>("conversations.history", {
      channel: channelId,
      limit: opts?.limit ?? 20,
      oldest: opts?.oldest,
      latest: opts?.latest,
    });

    if (!data.ok) {
      log.error("Failed to fetch channel history", { channelId, error: data.error });
      return { ok: false, message: data.error ?? "Failed to get history" };
    }

    const messages = (data.messages ?? []).map((m) => ({
      user: m.user,
      text: m.text ?? "",
      ts: m.ts,
      thread_ts: m.thread_ts,
    }));

    log.debug("Channel history fetched", { channelId, messageCount: messages.length });
    return { ok: true, messages, message: `Fetched ${messages.length} messages` };
  } catch (err: any) {
    log.error("Channel history fetch failed", { channelId, error: err.message });
    return { ok: false, message: `Failed to get history: ${err.message}` };
  }
}

/**
 * Fetch thread replies.
 */
export async function getThreadReplies(
  channelId: string,
  threadTs: string,
  opts?: { limit?: number },
): Promise<{ ok: boolean; messages?: Array<{ user?: string; text: string; ts: string }>; message: string }> {
  const client = getClient();
  if (!client) return { ok: false, message: "SLACK_BOT_TOKEN not set" };

  try {
    const data = await slackPost<{
      ok: boolean;
      messages?: Array<{ user?: string; text?: string; ts: string }>;
      error?: string;
    }>("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: opts?.limit ?? 50,
    });

    if (!data.ok) return { ok: false, message: data.error ?? "Failed to get replies" };

    const messages = (data.messages ?? []).map((m) => ({
      user: m.user,
      text: m.text ?? "",
      ts: m.ts,
    }));

    return { ok: true, messages, message: `Fetched ${messages.length} replies` };
  } catch (err: any) {
    return { ok: false, message: `Failed to get replies: ${err.message}` };
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

/** Make a raw authenticated Slack API POST. Used by channel functions. */
async function slackPost<T = any>(endpoint: string, body: Record<string, any>): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  return (await res.json()) as T;
}
