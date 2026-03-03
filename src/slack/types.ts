/**
 * Slack integration types.
 * Covers API responses, events, messages, and message templates.
 */

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface SlackAuthTestResult {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  is_enterprise_install?: boolean;
  error?: string;
}

export interface SlackOAuthResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string };
  authed_user?: { id: string; scope?: string; access_token?: string; token_type?: string };
  error?: string;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  display_name?: string;
  email?: string;
  is_bot: boolean;
  is_admin?: boolean;
  tz?: string;
  avatar?: string;
}

export interface SlackUserInfoResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      email?: string;
      image_48?: string;
    };
    is_bot?: boolean;
    is_admin?: boolean;
    tz?: string;
  };
  error?: string;
}

// ── Channels / Conversations ──────────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_member: boolean;
  num_members?: number;
  topic?: string;
  purpose?: string;
}

export interface SlackConversationInfoResponse {
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
}

export interface SlackConversationListResponse {
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
}

// ── Messages ──────────────────────────────────────────────────────────────────

export interface SlackMessage {
  ok: boolean;
  channel: string;
  ts: string;
  message?: {
    type: string;
    text: string;
    user?: string;
    ts: string;
    thread_ts?: string;
  };
  error?: string;
}

export interface SlackMessagePayload {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

// ── Files ─────────────────────────────────────────────────────────────────────

export interface SlackFileUploadResult {
  ok: boolean;
  file?: {
    id: string;
    name: string;
    mimetype: string;
    url_private: string;
    permalink: string;
  };
  error?: string;
}

// ── Block Kit (subset) ────────────────────────────────────────────────────────

export type SlackBlock =
  | SlackSectionBlock
  | SlackDividerBlock
  | SlackHeaderBlock
  | SlackContextBlock
  | SlackActionsBlock;

export interface SlackSectionBlock {
  type: "section";
  text: SlackTextObject;
  accessory?: SlackBlockElement;
  fields?: SlackTextObject[];
}

export interface SlackDividerBlock {
  type: "divider";
}

export interface SlackHeaderBlock {
  type: "header";
  text: SlackTextObject;
}

export interface SlackContextBlock {
  type: "context";
  elements: Array<SlackTextObject | SlackImageElement>;
}

export interface SlackActionsBlock {
  type: "actions";
  elements: SlackBlockElement[];
}

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

export type SlackBlockElement = SlackButtonElement | SlackImageElement;

export interface SlackButtonElement {
  type: "button";
  text: SlackTextObject;
  action_id: string;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
}

export interface SlackImageElement {
  type: "image";
  image_url: string;
  alt_text: string;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type SlackEventType =
  | "app_mention"
  | "message"
  | "reaction_added"
  | "reaction_removed"
  | "member_joined_channel"
  | "member_left_channel"
  | "channel_created"
  | "app_home_opened";

/** Outer envelope for Events API. */
export interface SlackEventEnvelope {
  token?: string;
  type: "url_verification" | "event_callback" | "app_rate_limited";
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  event_id?: string;
  event_time?: number;
}

export interface SlackEvent {
  type: SlackEventType;
  subtype?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  reaction?: string;
  item?: {
    type: string;
    channel: string;
    ts: string;
  };
  bot_id?: string;
  tab?: string;
}

// ── Slash Commands ────────────────────────────────────────────────────────────

export interface SlackSlashCommand {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  api_app_id: string;
}

// ── Interactive Payloads ──────────────────────────────────────────────────────

export interface SlackInteractionPayload {
  type: "block_actions" | "view_submission" | "shortcut";
  trigger_id: string;
  user: { id: string; username: string; name: string; team_id: string };
  channel?: { id: string; name: string };
  actions?: Array<{
    action_id: string;
    block_id: string;
    type: string;
    value?: string;
    selected_option?: { value: string };
  }>;
  response_url?: string;
}

// ── Message Templates ─────────────────────────────────────────────────────────

/** Helper to build common Block Kit message shapes. */
export const MessageTemplates = {
  /** Simple text notification with optional header. */
  notification(header: string, body: string): SlackBlock[] {
    const blocks: SlackBlock[] = [];
    if (header) {
      blocks.push({ type: "header", text: { type: "plain_text", text: header, emoji: true } });
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
    return blocks;
  },

  /** Status update with fields (key-value pairs). */
  statusUpdate(title: string, fields: Record<string, string>): SlackBlock[] {
    return [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      {
        type: "section",
        text: { type: "mrkdwn", text: " " },
        fields: Object.entries(fields).map(([k, v]) => ({
          type: "mrkdwn" as const,
          text: `*${k}*\n${v}`,
        })),
      },
    ];
  },

  /** Task notification with action button. */
  taskNotification(
    title: string,
    description: string,
    actionLabel: string,
    actionValue: string,
  ): SlackBlock[] {
    return [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: description } },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: actionLabel, emoji: true },
            action_id: "task_action",
            value: actionValue,
            style: "primary",
          },
        ],
      },
    ];
  },
} as const;
