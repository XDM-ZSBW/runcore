# Slack Integration Specification

> **Status:** Draft
> **Last updated:** 2026-02-27
> **Owner:** Dash runtime team

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Authentication & OAuth 2.0](#3-authentication--oauth-20)
4. [Webhook Endpoints for Board Updates](#4-webhook-endpoints-for-board-updates)
5. [Slash Commands](#5-slash-commands)
6. [DM Bot](#6-dm-bot)
7. [Channel Notifications](#7-channel-notifications)
8. [Message Formatting](#8-message-formatting)
9. [Rate Limiting](#9-rate-limiting)
10. [Error Handling & Fallbacks](#10-error-handling--fallbacks)
11. [Integration with Notification System](#11-integration-with-notification-system)
12. [Security](#12-security)
13. [Configuration](#13-configuration)
14. [Implementation Guide](#14-implementation-guide)

---

## 1. Overview

### Purpose

Slack integration turns Dash into a two-way channel between the user's Slack workspace and the Dash agent runtime. Users can spawn agents, query board status, and receive task notifications — all without leaving Slack.

### Goals

- **Board visibility:** Automatic notifications when tasks are created, completed, assigned, or need human input.
- **Agent control:** Spawn, monitor, and cancel agents via slash commands.
- **Conversational access:** DM the bot for status queries, task creation, and interactive commands.
- **Thread-based context:** Completed-task notifications use threads for follow-up discussion and result summaries.
- **Graceful degradation:** Slack being unavailable never blocks Dash core operations.

### Existing Implementation

The following modules are already built and form the foundation for this spec:

| Module | Path | What exists |
|--------|------|-------------|
| Types | `src/slack/types.ts` | Full type definitions: events, commands, interactions, Block Kit, message templates |
| Client | `src/slack/client.ts` | `SlackClient` singleton with auth, messaging, reactions, DMs, file sharing, health |
| Retry | `src/slack/retry.ts` | Error classification (auth/transient/permanent), exponential backoff with jitter |
| Channels | `src/slack/channels.ts` | List, join, info, post, thread reply, history, topic/purpose |
| Webhooks | `src/slack/webhooks.ts` | Signature verification, event routing, slash command processing, interaction handling |

### What this spec adds

- Board-event webhook notifications (task lifecycle → Slack messages)
- Extended slash commands (`spawn-agent`, `board`, `cancel`)
- DM bot intelligence (status queries, task creation, interactive responses)
- Threading strategy for completed tasks
- `SlackNotificationChannel` for the alerting system
- Configuration schema and channel mapping

---

## 2. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Slack Workspace                          │
│                                                                 │
│  #dash-updates ◄──── Board notifications (task lifecycle)       │
│  #dash-alerts  ◄──── Health alerts, agent failures              │
│  DM with @Dash ◄───► Conversational bot (status, commands)      │
│  /dash command  ────► Slash command handler                      │
│                                                                 │
└──────┬──────────────────┬──────────────────┬────────────────────┘
       │ Events API       │ Commands         │ Interactions
       ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Hono Server (src/server.ts)                                     │
│                                                                  │
│  POST /api/slack/events ──────► processEvent()                   │
│  POST /api/slack/commands ────► processSlashCommand()            │
│  POST /api/slack/interactions ► processInteraction()             │
│  GET  /api/slack/oauth ───────► OAuth redirect                   │
│  GET  /api/slack/oauth/callback► exchangeOAuthCode()             │
└──────┬──────────────────┬──────────────────┬────────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────┐
│ SlackClient │  │ QueueStore   │  │ Agent Store + Spawn          │
│ (singleton) │  │ (board ops)  │  │ (src/agents/)                │
└─────────────┘  └──────────────┘  └─────────────────────────────┘
       │                  │
       ▼                  ▼
┌─────────────────────────────────┐
│ NotificationDispatcher          │
│ (src/notifications/channel.ts)  │
│                                 │
│ Channels: email, sms, webhook,  │
│           slack (new)           │
└─────────────────────────────────┘
```

### Key Design Principles

1. **Existing patterns first.** Follow the lazy-singleton + retry + never-throw pattern from `src/slack/client.ts` and `src/linear/client.ts`.
2. **File-backed state.** Channel mappings stored in `brain/settings.json` under a `slack` key. No new databases.
3. **Board as source of truth.** Slack is a view layer — the `QueueStore` and agent system remain authoritative.
4. **Activity logging.** Every Slack interaction logged via `logActivity()` from `src/activity/log.ts`.

---

## 3. Authentication & OAuth 2.0

### Current State

OAuth and token management already exist in `src/slack/client.ts`:

- `getOAuthUrl(redirectUri)` — Builds the Slack authorization URL
- `exchangeOAuthCode(code, redirectUri)` — Exchanges auth code for bot token
- `isSlackConfigured()` / `isSlackAuthenticated()` — Env checks
- `SLACK_BOT_SCOPES` — Defined scopes list

### Vault Keys

| Key | Purpose | Storage |
|-----|---------|---------|
| `SLACK_BOT_TOKEN` | Bot user OAuth token (`xoxb-...`) | Vault (encrypted, never exposed to LLM) |
| `SLACK_CLIENT_ID` | OAuth app client ID | Vault |
| `SLACK_CLIENT_SECRET` | OAuth app client secret | Vault |
| `SLACK_SIGNING_SECRET` | Request signature verification | Vault |

### OAuth Flow

#### Step 1: Initiate — `GET /api/slack/oauth`

```typescript
// Route handler
app.get("/api/slack/oauth", (c) => {
  const redirectUri = `${getBaseUrl(c)}/api/slack/oauth/callback`;
  const result = getOAuthUrl(redirectUri);
  if (!result.ok) return c.json({ error: result.message }, 400);
  return c.redirect(result.url!);
});
```

#### Step 2: Callback — `GET /api/slack/oauth/callback`

```typescript
app.get("/api/slack/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  if (error) return c.json({ error: `OAuth denied: ${error}` }, 400);
  if (!code) return c.json({ error: "Missing authorization code" }, 400);

  const redirectUri = `${getBaseUrl(c)}/api/slack/oauth/callback`;
  const result = await exchangeOAuthCode(code, redirectUri);
  if (!result.ok) return c.json({ error: result.message }, 500);

  // Store bot token in vault
  await setVaultKey("SLACK_BOT_TOKEN", result.botToken!, vaultKey, "Slack Bot Token");

  // Store team metadata in settings
  await updateSettings({
    slack: {
      teamId: result.teamId,
      teamName: result.teamName,
      botUserId: result.botUserId,
      installedAt: new Date().toISOString(),
    },
  });

  logActivity({ source: "slack", summary: `Connected to workspace: ${result.teamName}` });
  return c.json({ ok: true, team: result.teamName });
});
```

#### Step 3: Token Refresh

Slack bot tokens (`xoxb-`) do not expire. If the token becomes invalid (revoked or workspace uninstalled), the client detects this via `classifyError() → "auth"` and pauses Slack operations — mirroring how `src/queue/timer.ts` handles Linear auth failures.

### Required Bot Token Scopes

Already defined in `src/slack/client.ts` as `SLACK_BOT_SCOPES`:

```
app_mentions:read    channels:history    channels:join
channels:read        chat:write          commands
files:read           files:write         groups:read
im:history           im:read             im:write
mpim:read            reactions:read      reactions:write
users:read           users:read.email
```

### Additional Scopes Needed

For the features in this spec, add these to `SLACK_BOT_SCOPES`:

| Scope | Reason |
|-------|--------|
| `chat:write.public` | Post to channels the bot hasn't joined |
| `users.profile:read` | Display names in notifications |

---

## 4. Webhook Endpoints for Board Updates

### Event Source: QueueStore Hooks

The `QueueStore` (`src/queue/store.ts`) is the single source of truth for task state. Board notifications fire when tasks transition states.

### Event Types

```typescript
// New file: src/slack/board-events.ts

type BoardEventType =
  | "task:created"
  | "task:completed"
  | "task:assigned"
  | "task:state_changed"
  | "task:needs_human"
  | "task:cancelled";

interface BoardEvent {
  type: BoardEventType;
  task: QueueTask;
  previousState?: QueueTaskState;
  triggeredBy: string;    // "user" | "dash-agent" | "linear-sync" | "autonomous"
  timestamp: string;
}
```

### Hook Point

Add an event emitter to `QueueStore` that fires after successful writes:

```typescript
// In src/queue/store.ts — extend existing class

type BoardEventListener = (event: BoardEvent) => void;
private listeners: BoardEventListener[] = [];

onBoardEvent(listener: BoardEventListener): () => void {
  this.listeners.push(listener);
  return () => {
    this.listeners = this.listeners.filter(l => l !== listener);
  };
}

private emit(event: BoardEvent): void {
  for (const listener of this.listeners) {
    try { listener(event); } catch { /* never block store ops */ }
  }
}
```

Call `this.emit()` at the end of `create()`, `update()`, and `archive()`.

### Notification Router

```typescript
// New file: src/slack/board-events.ts

import { getClient } from "./client.js";
import { postMessage, postThreadReply } from "./channels.js";
import { MessageTemplates } from "./types.js";
import { getSlackConfig } from "./config.js";
import type { BoardEvent } from "./types.js";

/** Thread tracking: taskId → Slack message ts (for threading follow-ups). */
const taskThreads = new Map<string, { channel: string; ts: string }>();

export async function handleBoardEvent(event: BoardEvent): Promise<void> {
  const client = getClient();
  if (!client) return; // Slack not configured — silent no-op

  const config = getSlackConfig();
  const channel = config.channels.boardUpdates;
  if (!channel) return;

  switch (event.type) {
    case "task:created":
      return notifyTaskCreated(channel, event);
    case "task:completed":
      return notifyTaskCompleted(channel, event);
    case "task:assigned":
      return notifyTaskAssigned(channel, event);
    case "task:state_changed":
      return notifyTaskStateChanged(channel, event);
    case "task:needs_human":
      return notifyNeedsHuman(channel, event);
    case "task:cancelled":
      return notifyTaskCancelled(channel, event);
  }
}
```

### Notification Messages

#### Task Created

```typescript
async function notifyTaskCreated(channel: string, event: BoardEvent): Promise<void> {
  const { task } = event;
  const blocks = MessageTemplates.taskNotification(
    `New Task: ${task.identifier}`,
    [
      `*${task.title}*`,
      task.description ? `> ${task.description.slice(0, 200)}` : "",
      `Priority: ${priorityLabel(task.priority)} | State: \`${task.state}\``,
      task.assignee ? `Assigned to: *${task.assignee}*` : "_Unassigned_",
    ].filter(Boolean).join("\n"),
    "View Task",
    task.id,
  );

  const result = await postMessage(channel, `New task: ${task.identifier} — ${task.title}`, { blocks });
  if (result.ok && result.ts) {
    taskThreads.set(task.id, { channel, ts: result.ts });
  }
}
```

**Example payload sent to Slack:**

```json
{
  "channel": "C0123UPDATES",
  "text": "New task: DASH-42 — Implement Slack board notifications",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "New Task: DASH-42", "emoji": true }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Implement Slack board notifications*\n> Send rich notifications to a Slack channel when tasks change state\nPriority: High | State: `todo`\nAssigned to: *dash-agent*"
      }
    },
    { "type": "divider" },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Task", "emoji": true },
          "action_id": "task_action",
          "value": "task_abc123",
          "style": "primary"
        }
      ]
    }
  ]
}
```

#### Task Completed (Threaded)

```typescript
async function notifyTaskCompleted(channel: string, event: BoardEvent): Promise<void> {
  const { task } = event;
  const existing = taskThreads.get(task.id);

  const completionText = [
    `*${task.identifier} completed* — ${task.title}`,
    task.assignee ? `Completed by: *${task.assignee}*` : "",
    `Duration: ${formatDuration(task.createdAt, task.updatedAt)}`,
  ].filter(Boolean).join("\n");

  const blocks = MessageTemplates.statusUpdate(
    `Completed: ${task.identifier}`,
    {
      "Task": task.title,
      "Assignee": task.assignee ?? "Unassigned",
      "State": "`done`",
      "Completed": new Date(task.updatedAt).toLocaleDateString(),
    },
  );

  if (existing) {
    // Reply in the original task thread
    await postThreadReply(existing.channel, existing.ts, completionText, { blocks });
    // Also post a summary to the main channel (not threaded)
    await postMessage(channel, `${task.identifier} completed — ${task.title}`);
  } else {
    await postMessage(channel, completionText, { blocks });
  }
}
```

#### Task Needs Human (Urgent)

```typescript
async function notifyNeedsHuman(channel: string, event: BoardEvent): Promise<void> {
  const { task } = event;

  // Extract questions from the latest exchange
  const lastExchange = task.exchanges[task.exchanges.length - 1];
  const questions = lastExchange?.body ?? "Agent needs input — check the board.";

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Needs Human Input", emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${task.identifier}*: ${task.title}\n\n${questions}`,
      },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Respond", emoji: true },
          action_id: "task_respond",
          value: task.id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel Task", emoji: true },
          action_id: "task_cancel",
          value: task.id,
          style: "danger",
        },
      ],
    },
  ];

  await postMessage(channel, `[NEEDS HUMAN] ${task.identifier}: ${task.title}`, { blocks });
}
```

### Priority Labels

```typescript
function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Urgent";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return "None";
  }
}
```

---

## 5. Slash Commands

### Existing Commands

Already implemented in `src/slack/webhooks.ts`:

- `/dash help` — Show help
- `/dash ping` — Test connectivity
- `/dash status` — Check connection status

### New Commands

Extend `handleDashCommand()` in `src/slack/webhooks.ts`.

#### `/dash spawn-agent <prompt>`

Spawn a new agent with the given task description.

```typescript
case "spawn-agent": {
  const prompt = args.slice(1).join(" ");
  if (!prompt) {
    return {
      ok: true,
      response_type: "ephemeral",
      text: "Usage: `/dash spawn-agent <task description>`\nExample: `/dash spawn-agent Review PR #42 for security issues`",
    };
  }

  const task = await agentStore.createTask({
    label: `Slack: ${prompt.slice(0, 60)}`,
    prompt,
    origin: "user",
  });
  await spawnAgent(task);

  return {
    ok: true,
    response_type: "in_channel",
    text: `Agent spawned: *${task.id}*\n> ${prompt.slice(0, 200)}`,
    blocks: MessageTemplates.taskNotification(
      "Agent Spawned",
      `*${task.label}*\nID: \`${task.id}\`\nStatus: \`pending\``,
      "Check Status",
      task.id,
    ),
  };
}
```

**Example interaction:**

```
User:    /dash spawn-agent Review the auth middleware for token expiry bugs
Dash:    Agent Spawned
         Review the auth middleware for token expiry bugs
         ID: agent_1772255476477_f8acf30f
         Status: pending
         [Check Status]
```

#### `/dash board [filter]`

Show current board state. Optional filter: `mine`, `in_progress`, `todo`, `urgent`.

```typescript
case "board": {
  const filter = args[1]?.toLowerCase();
  const store = getQueueStore();
  let tasks = await store.list();

  if (filter === "mine") {
    tasks = tasks.filter(t => t.assignee === "dash-agent" || t.assignee === cmd.user_name);
  } else if (filter === "in_progress") {
    tasks = tasks.filter(t => t.state === "in_progress");
  } else if (filter === "todo") {
    tasks = tasks.filter(t => t.state === "todo");
  } else if (filter === "urgent") {
    tasks = tasks.filter(t => t.priority === 1);
  }

  const top = tasks.slice(0, 10);
  const lines = top.map(t =>
    `${stateEmoji(t.state)} \`${t.identifier}\` ${t.title} (${priorityLabel(t.priority)})`
  );

  return {
    ok: true,
    response_type: "ephemeral",
    text: lines.length > 0
      ? `*Board* (${tasks.length} tasks):\n${lines.join("\n")}`
      : "No tasks match that filter.",
  };
}
```

**Example output:**

```
Board (7 tasks):
🔵 DASH-38 Implement Slack board notifications (High)
🟢 DASH-37 Add retry logic to Linear sync (Medium)
⚪ DASH-36 Write spec for email templates (Low)
🔴 DASH-35 Fix auth token expiry bug (Urgent)
...
```

#### `/dash cancel <task-id | identifier>`

Cancel a running agent or board task.

```typescript
case "cancel": {
  const target = args[1];
  if (!target) {
    return { ok: true, response_type: "ephemeral", text: "Usage: `/dash cancel <task-id or DASH-N>`" };
  }

  // Try agent cancellation first
  const cancelled = await cancelAgent(target);
  if (cancelled) {
    return { ok: true, response_type: "in_channel", text: `Agent \`${target}\` cancelled.` };
  }

  // Try board task
  const store = getQueueStore();
  const task = target.startsWith("DASH-")
    ? await store.getByIdentifier(target)
    : await store.get(target);

  if (!task) {
    return { ok: true, response_type: "ephemeral", text: `Task not found: \`${target}\`` };
  }

  await store.update(task.id, { state: "cancelled" });
  return { ok: true, response_type: "in_channel", text: `Task \`${task.identifier}\` cancelled.` };
}
```

#### `/dash agents`

List running agents and their status.

```typescript
case "agents": {
  const tasks = await agentStore.listTasks();
  const running = tasks.filter(t => t.status === "running" || t.status === "pending");

  if (running.length === 0) {
    return { ok: true, response_type: "ephemeral", text: "No agents currently running." };
  }

  const lines = running.map(t =>
    `${t.status === "running" ? "🟢" : "⏳"} \`${t.id.slice(-12)}\` ${t.label} (${t.status})`
  );

  return {
    ok: true,
    response_type: "ephemeral",
    text: `*Active Agents* (${running.length}):\n${lines.join("\n")}`,
  };
}
```

### Updated Help Text

```typescript
case "help":
  return {
    ok: true,
    response_type: "ephemeral",
    text: [
      "*Dash Commands:*",
      "`/dash help` — Show this help message",
      "`/dash status` — Check Dash connection status",
      "`/dash ping` — Test connectivity",
      "`/dash board [filter]` — Show board (filters: mine, in_progress, todo, urgent)",
      "`/dash spawn-agent <prompt>` — Spawn an agent with a task",
      "`/dash agents` — List running agents",
      "`/dash cancel <id>` — Cancel an agent or task",
    ].join("\n"),
  };
```

### Slash Command API Endpoint

Already registered in `src/server.ts`:

```
POST /api/slack/commands
```

Signature verification with `verifySignature()` from `src/slack/webhooks.ts` must be applied as middleware. The signing secret comes from `SLACK_SIGNING_SECRET` in the vault.

---

## 6. DM Bot

### Overview

When a user DMs the Dash bot, the message arrives as a `message` event with `channel_type: "im"`. The existing handler in `src/slack/webhooks.ts` (`handleMessage()`) currently just logs and returns. This spec extends it to provide conversational responses.

### Intent Detection

```typescript
// New file: src/slack/dm-bot.ts

type DmIntent =
  | { type: "status" }
  | { type: "board"; filter?: string }
  | { type: "create_task"; title: string; description?: string }
  | { type: "agent_status"; agentId?: string }
  | { type: "help" }
  | { type: "conversation"; text: string };

export function classifyDmIntent(text: string): DmIntent {
  const lower = text.toLowerCase().trim();

  if (/^(status|how are you|health)/.test(lower)) return { type: "status" };
  if (/^(board|tasks?|backlog|todo)/.test(lower)) return { type: "board", filter: extractFilter(lower) };
  if (/^(create|add|new)\s+task/i.test(lower)) return { type: "create_task", title: lower.replace(/^(create|add|new)\s+task\s*/i, "") };
  if (/^(agents?|running|spawned)/.test(lower)) return { type: "agent_status" };
  if (/^help/.test(lower)) return { type: "help" };

  return { type: "conversation", text };
}
```

### DM Handler

```typescript
export async function handleDmMessage(
  userId: string,
  text: string,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const intent = classifyDmIntent(text);

  switch (intent.type) {
    case "status": {
      const health = getHealthSummary();
      const syncHealth = getSyncHealth();
      await client.sendMessage(channel, formatStatusResponse(health, syncHealth), { thread_ts: threadTs });
      break;
    }

    case "board": {
      const store = getQueueStore();
      const tasks = await store.list();
      const filtered = applyFilter(tasks, intent.filter);
      await client.sendMessage(channel, formatBoardResponse(filtered), { thread_ts: threadTs });
      break;
    }

    case "create_task": {
      const store = getQueueStore();
      const task = await store.create({
        title: intent.title,
        state: "triage",
        priority: 3,
      });
      await client.sendMessage(
        channel,
        `Task created: *${task.identifier}* — ${task.title}\nState: \`triage\` | Priority: Medium`,
        { thread_ts: threadTs },
      );
      break;
    }

    case "agent_status": {
      const tasks = await agentStore.listTasks();
      const running = tasks.filter(t => t.status === "running" || t.status === "pending");
      await client.sendMessage(channel, formatAgentStatusResponse(running), { thread_ts: threadTs });
      break;
    }

    case "help": {
      await client.sendMessage(channel, DM_HELP_TEXT, { thread_ts: threadTs });
      break;
    }

    case "conversation": {
      // Forward to the Brain for a conversational response
      // Uses the same chat pipeline as the web UI (src/server.ts chat route)
      const response = await getBrainResponse(intent.text, `slack:${userId}`);
      await client.sendMessage(channel, formatForSlack(response), { thread_ts: threadTs });
      break;
    }
  }
}

const DM_HELP_TEXT = [
  "*Dash DM Commands:*",
  "• `status` — System health and sync status",
  "• `board` / `tasks` — Show current board",
  "• `board todo` / `board urgent` — Filtered board view",
  "• `create task <title>` — Create a new task",
  "• `agents` — Show running agents",
  "• `help` — This message",
  "• _Or just chat naturally — I'll do my best to help._",
].join("\n");
```

### Interactive Responses

DM responses can include action buttons for common follow-up actions:

```typescript
function boardResponseWithActions(tasks: QueueTask[]): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Board Overview", emoji: true } },
    ...tasks.slice(0, 5).map(task => ({
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `${stateEmoji(task.state)} \`${task.identifier}\` *${task.title}*\n${priorityLabel(task.priority)} · ${task.assignee ?? "Unassigned"}`,
      },
    })),
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Refresh", emoji: true },
          action_id: "dm_refresh_board",
          value: "board",
        },
      ],
    },
  ];

  return {
    text: `Board: ${tasks.length} tasks`,
    blocks,
  };
}
```

### Wiring into the Event Router

Update `handleMessage()` in `src/slack/webhooks.ts`:

```typescript
async function handleMessage(event: SlackEvent): Promise<{ handled: boolean; message: string }> {
  if (event.channel_type !== "im") {
    return { handled: true, message: "Channel message (not DM), skipped" };
  }

  logActivity({
    source: "slack",
    summary: `DM from <@${event.user}>: "${event.text}"`,
    detail: `channel=${event.channel} ts=${event.ts}`,
  });

  // Route to DM bot
  if (event.user && event.text && event.channel) {
    await handleDmMessage(event.user, event.text, event.channel, event.thread_ts);
  }

  return { handled: true, message: `DM from ${event.user} processed` };
}
```

---

## 7. Channel Notifications

### Channel Mapping

Configurable in `brain/settings.json` under the `slack` key:

```json
{
  "slack": {
    "teamId": "T0123ABC",
    "teamName": "Dash Workspace",
    "botUserId": "U0123BOT",
    "channels": {
      "boardUpdates": "C0123UPDATES",
      "alerts": "C0456ALERTS",
      "agentLogs": "C0789LOGS"
    },
    "notifications": {
      "taskCreated": true,
      "taskCompleted": true,
      "taskAssigned": true,
      "taskCancelled": false,
      "needsHuman": true,
      "agentSpawned": true,
      "agentFailed": true,
      "healthAlerts": true
    }
  }
}
```

### Threading Strategy

Threads keep the channel readable while preserving context:

| Event | Behavior |
|-------|----------|
| `task:created` | New top-level message. Store `{ taskId → { channel, ts } }` mapping. |
| `task:assigned` | Thread reply under original task message (if exists), otherwise new message. |
| `task:state_changed` | Thread reply under original task message. |
| `task:completed` | Thread reply with summary + short top-level "completed" message. |
| `task:needs_human` | New top-level message (high visibility). |
| `task:cancelled` | Thread reply under original task message. |
| Agent spawned for task | Thread reply under the task's message. |
| Agent output/error | Thread reply under the task's message. |

### Thread Map Persistence

The in-memory `taskThreads` map is volatile. For persistence across restarts, store thread mappings as a lightweight JSONL file:

```
brain/slack/thread-map.jsonl
```

Schema:

```json
{"taskId": "abc123", "channel": "C0123UPDATES", "ts": "1709123456.001200", "createdAt": "2026-02-27T10:00:00Z"}
```

Load on startup, append on new thread creation. Compact when >500 lines.

### Completed Task Notification (Full Example)

When `DASH-42` completes:

**Top-level message (brief):**
> DASH-42 completed — Implement Slack board notifications

**Thread reply (detailed):**

```
┌─────────────────────────────────┐
│ ✅ Completed: DASH-42           │
├─────────────────────────────────┤
│ Task     │ Implement Slack...   │
│ Assignee │ dash-agent           │
│ State    │ done                 │
│ Duration │ 2h 14m               │
│ Completed│ Feb 27, 2026         │
└─────────────────────────────────┘
```

If the task has an agent `resultSummary`, it's included below the status card:

```
*Agent Summary:*
> Added board event hooks in queue/store.ts. Created slack/board-events.ts
> with handlers for all lifecycle events. Updated server.ts routes.
> 3 files changed, 247 insertions.
```

---

## 8. Message Formatting

### Existing Templates

`MessageTemplates` in `src/slack/types.ts` provides:

- `notification(header, body)` — Simple text notification
- `statusUpdate(title, fields)` — Key-value status card
- `taskNotification(title, description, actionLabel, actionValue)` — Task with action button

### Additional Templates

```typescript
// Extend MessageTemplates in src/slack/types.ts

/** Agent output with code block. */
agentOutput(title: string, output: string, truncated: boolean): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${output.slice(0, 2900)}\n\`\`\`${truncated ? "\n_Output truncated. Full log available via `/dash agents`._" : ""}`,
      },
    },
  ];
  return blocks;
},

/** Error alert. */
errorAlert(title: string, error: string, recoveryHint?: string): SlackBlock[] {
  return [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*Error:* ${error}` } },
    ...(recoveryHint ? [{
      type: "context" as const,
      elements: [{ type: "mrkdwn" as const, text: `💡 ${recoveryHint}` }],
    }] : []),
  ];
},

/** Board summary with emoji state indicators. */
boardSummary(tasks: Array<{ identifier: string; title: string; state: string; priority: number }>): SlackBlock[] {
  const lines = tasks.map(t =>
    `${stateEmoji(t.state)} \`${t.identifier}\` ${t.title} (${priorityLabel(t.priority)})`
  );
  return [
    { type: "header", text: { type: "plain_text", text: "Board Summary", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") || "_No tasks._" } },
  ];
},
```

### Formatting Rules

1. **Slack mrkdwn, not Markdown.** Use `*bold*`, `_italic_`, `~strike~`, `` `code` ``, `> blockquote`. No `#` headers (use Block Kit headers instead).
2. **Block Kit for structured content.** Always include both `text` (plaintext fallback) and `blocks` (rich display).
3. **Code output in triple backticks.** Slack renders these as monospace blocks. Limit to 2900 chars (Block Kit text limit is 3000).
4. **User mentions as `<@U123>`** — never raw display names.
5. **Channel links as `<#C123>`** — auto-expands to channel name.
6. **Timestamps as `<!date^UNIX^{date_short} at {time}|fallback>`** — Slack renders in user's local timezone.

### State Emoji Map

```typescript
function stateEmoji(state: string): string {
  switch (state) {
    case "triage":      return "🟡";
    case "backlog":     return "⚪";
    case "todo":        return "🔵";
    case "in_progress": return "🟢";
    case "done":        return "✅";
    case "cancelled":   return "⛔";
    default:            return "❓";
  }
}
```

---

## 9. Rate Limiting

### Slack API Limits

| API Tier | Rate Limit | Methods |
|----------|-----------|---------|
| Tier 1 (Special) | 1 req/min | `files.upload`, `admin.*` |
| Tier 2 (Post) | ~1 req/sec | `chat.postMessage`, `chat.update` |
| Tier 3 (Read) | ~50 req/min | `conversations.history`, `users.info` |
| Tier 4 (High) | ~100 req/min | `auth.test`, `conversations.list` |

When rate-limited, Slack returns `429 Too Many Requests` with a `Retry-After` header.

### Strategy: Three-Layer Defense

#### Layer 1: Existing Retry Logic

`src/slack/retry.ts` already handles 429 responses — `classifyError()` returns `"transient"`, and `withRetry()` applies exponential backoff. This is the last line of defense.

#### Layer 2: Per-Method Rate Tracker

```typescript
// New file: src/slack/rate-limit.ts

interface RateBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;     // tokens per second
  lastRefill: number;     // timestamp ms
}

const buckets = new Map<string, RateBucket>();

const TIER_LIMITS: Record<string, { maxTokens: number; refillRate: number }> = {
  "chat.postMessage":   { maxTokens: 1, refillRate: 1 },     // Tier 2: 1/sec
  "chat.update":        { maxTokens: 1, refillRate: 1 },
  "conversations.history": { maxTokens: 50, refillRate: 0.83 }, // Tier 3: 50/min
  "conversations.list": { maxTokens: 100, refillRate: 1.67 },   // Tier 4: 100/min
  "users.info":         { maxTokens: 50, refillRate: 0.83 },
  "default":            { maxTokens: 20, refillRate: 0.33 },    // Conservative default
};

export async function waitForSlot(method: string): Promise<void> {
  const config = TIER_LIMITS[method] ?? TIER_LIMITS["default"];
  let bucket = buckets.get(method);

  if (!bucket) {
    bucket = { tokens: config.maxTokens, maxTokens: config.maxTokens, refillRate: config.refillRate, lastRefill: Date.now() };
    buckets.set(method, bucket);
  }

  // Refill tokens based on elapsed time
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;

  // Wait if no tokens available
  if (bucket.tokens < 1) {
    const waitMs = ((1 - bucket.tokens) / bucket.refillRate) * 1000;
    await sleep(waitMs);
    bucket.tokens = 0;
    bucket.lastRefill = Date.now();
  } else {
    bucket.tokens -= 1;
  }
}
```

#### Layer 3: Notification Batching

For high-frequency board events (e.g., bulk import creating many tasks), batch notifications:

```typescript
// In src/slack/board-events.ts

const BATCH_WINDOW_MS = 2000; // 2-second window
let pendingEvents: BoardEvent[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

export function queueBoardEvent(event: BoardEvent): void {
  pendingEvents.push(event);

  if (!batchTimer) {
    batchTimer = setTimeout(async () => {
      const events = pendingEvents;
      pendingEvents = [];
      batchTimer = null;

      if (events.length === 1) {
        await handleBoardEvent(events[0]);
      } else {
        await handleBatchedBoardEvents(events);
      }
    }, BATCH_WINDOW_MS);
  }
}

async function handleBatchedBoardEvents(events: BoardEvent[]): Promise<void> {
  const config = getSlackConfig();
  const channel = config.channels.boardUpdates;
  if (!channel) return;

  const summary = events.map(e => `• ${e.type}: ${e.task.identifier} — ${e.task.title}`).join("\n");
  await postMessage(channel, `*${events.length} board updates:*\n${summary}`);
}
```

---

## 10. Error Handling & Fallbacks

### Error Classification (Existing)

`src/slack/retry.ts` classifies errors into three kinds:

| Kind | Examples | Behavior |
|------|----------|----------|
| `auth` | `invalid_auth`, `token_revoked`, `401`, `403`, `missing_scope` | Fail immediately, mark Slack unavailable |
| `transient` | `429`, `500-504`, `ECONNRESET`, `ETIMEDOUT`, network errors | Retry with exponential backoff (max 3 attempts, max delay 30s) |
| `permanent` | Everything else (`channel_not_found`, `not_in_channel`, etc.) | Fail immediately, log error |

### Fallback Chain

When Slack delivery fails, fall through to other notification channels:

```
Slack → Webhook → SMS → Email (or whatever's configured)
```

```typescript
// In NotificationDispatcher (src/notifications/channel.ts)

async sendWithFallback(alert: Alert, preferredChannel: string, fallbacks: string[]): Promise<boolean> {
  // Try preferred channel
  const sent = await this.sendTo(preferredChannel, alert);
  if (sent) return true;

  // Try fallbacks in order
  for (const fallback of fallbacks) {
    const fallbackSent = await this.sendTo(fallback, alert);
    if (fallbackSent) {
      logActivity({
        source: "notifications",
        summary: `Alert sent via fallback: ${fallback} (${preferredChannel} failed)`,
      });
      return true;
    }
  }

  return false;
}
```

### Specific Failure Scenarios

| Scenario | Detection | Response |
|----------|-----------|----------|
| Token revoked | `classifyError() → "auth"` | Mark Slack unavailable. Log. Don't retry. Notify via other channels. |
| Channel archived/deleted | `channel_not_found` (permanent) | Remove from channel mapping. Log warning. |
| Bot not in channel | `not_in_channel` (permanent) | Attempt `joinChannel()`. If fails, log and skip. |
| Slack outage | Repeated transient errors | Backoff handled by `withRetry()`. Queue events for later. |
| Message too long | `msg_too_long` (permanent) | Truncate to 3000 chars, retry once. |
| Rate limited | `429` (transient) | Handled by retry logic + rate limiter. |

### Health Integration

Slack health is already tracked via `SlackClient.getHealth()`. Register a health check:

```typescript
// In src/server.ts during startup

healthChecker.register("slack", () => {
  const client = getClient();
  if (!client) return { status: "healthy", detail: "not configured" };

  const health = client.getHealth();
  if (!health.available) return { status: "unhealthy", detail: "no token" };
  if (health.lastError === "auth") return { status: "unhealthy", detail: health.lastErrorMessage ?? "auth error" };
  if (health.lastError === "transient") return { status: "degraded", detail: health.lastErrorMessage ?? "transient errors" };
  return { status: "healthy", detail: "connected" };
}, { critical: false });
```

---

## 11. Integration with Notification System

### SlackNotificationChannel

Add Slack as a channel in the `NotificationDispatcher`:

```typescript
// New file: src/notifications/slack.ts

import { getClient } from "../slack/client.js";
import { postMessage } from "../slack/channels.js";
import { MessageTemplates } from "../slack/types.js";
import { getSlackConfig } from "../slack/config.js";
import type { Alert } from "../health/alert-types.js";
import type { NotificationChannel } from "../health/alert-types.js";

export interface SlackChannelConfig {
  channel: string;       // Channel ID for alerts
  enabled?: boolean;
}

export class SlackNotificationChannel implements NotificationChannel {
  name = "slack";
  enabled: boolean;
  private channel: string;

  constructor(config: SlackChannelConfig) {
    this.enabled = config.enabled ?? true;
    this.channel = config.channel;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!this.enabled) return false;

    const client = getClient();
    if (!client) return false;

    const emoji = alert.severity === "critical" ? "🔴" : "🟡";
    const blocks = MessageTemplates.notification(
      `${emoji} ${alert.severity.toUpperCase()}: ${alert.checkName}`,
      [
        `*${alert.message}*`,
        `Metric: \`${alert.metric}\` = ${alert.value} (threshold: ${alert.threshold})`,
        `State: ${alert.state} | Fired: ${new Date(alert.firedAt).toLocaleString()}`,
      ].join("\n"),
    );

    const result = await postMessage(
      this.channel,
      `[${alert.severity.toUpperCase()}] ${alert.checkName}: ${alert.message}`,
      { blocks },
    );

    return result.ok;
  }
}
```

### Registration

In `src/server.ts`, when the notification dispatcher is set up:

```typescript
// After existing email/sms/webhook channel registration
const slackConfig = getSlackConfig();
if (slackConfig.channels.alerts) {
  dispatcher.add(new SlackNotificationChannel({
    channel: slackConfig.channels.alerts,
  }));
}
```

### Alert → Channel Preference Mapping

In the `AlertConfig` (`brain/settings.json` or defaults):

```json
{
  "notifications": [
    { "channel": "slack", "minSeverity": "warning" },
    { "channel": "sms", "minSeverity": "critical" },
    { "channel": "email", "minSeverity": "warning" }
  ]
}
```

---

## 12. Security

### Request Verification

All incoming Slack requests must be verified using the signing secret. This is already implemented in `verifySignature()` (`src/slack/webhooks.ts`):

```typescript
// Middleware for all /api/slack/* routes
app.use("/api/slack/*", async (c, next) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return c.json({ error: "Slack not configured" }, 503);

  const signature = c.req.header("X-Slack-Signature") ?? "";
  const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
  const body = await c.req.text();

  if (!verifySignature(body, signature, timestamp, signingSecret)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Re-parse body for downstream handlers
  c.set("rawBody", body);
  await next();
});
```

Protections:
- **HMAC-SHA256** signature verification
- **5-minute replay window** — requests older than 5 minutes are rejected
- **Timing-safe comparison** via `crypto.timingSafeEqual`

### Token Security

| Principle | Implementation |
|-----------|---------------|
| Bot tokens never in code | Stored in vault (`brain/vault/keys.json`, AES-256-GCM encrypted) |
| Tokens never exposed to LLM | `SLACK_BOT_TOKEN` not in the `SAFE_` prefix list in vault store |
| Token rotation | Revoke old token in Slack admin → re-run OAuth flow → vault auto-updates |
| Signing secret separate | `SLACK_SIGNING_SECRET` stored in vault, only used for verification |

### Permission Scopes (Principle of Least Privilege)

Only request scopes actually needed. Current scope list in `SLACK_BOT_SCOPES` is appropriate. Do not add:

- `admin.*` — Not needed, dangerous
- `channels:manage` — Bot should not create/delete channels
- `usergroups:*` — Not needed
- `team:read` — Minimal team info available via `auth.test`

### Input Validation

```typescript
// Slash command input sanitization
function sanitizeCommandInput(text: string): string {
  // Strip Slack formatting that could be injection vectors
  return text
    .replace(/<[^>]+>/g, "")      // Remove Slack links/mentions
    .replace(/[`*_~]/g, "")       // Remove formatting chars
    .slice(0, 500);               // Limit length
}

// Task title from Slack must be sanitized before board creation
function sanitizeTaskTitle(title: string): string {
  return title.replace(/[<>]/g, "").trim().slice(0, 200);
}
```

### Bot Loop Prevention

Already handled in `src/slack/webhooks.ts`:

```typescript
if (event.bot_id || event.subtype === "bot_message") {
  return { handled: true, message: "Ignored bot message" };
}
```

This prevents the bot from responding to its own messages or other bots, avoiding infinite loops.

### HTTPS Requirement

Slack requires all webhook URLs to use HTTPS. In production, Dash should be behind a reverse proxy (nginx/Caddy) with TLS termination. For development, use a tunnel like `ngrok` or Cloudflare Tunnel.

---

## 13. Configuration

### Full Settings Schema

Addition to `brain/settings.json`:

```typescript
interface SlackSettings {
  /** Team metadata (set during OAuth). */
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  installedAt?: string;

  /** Channel mapping. Values are Slack channel IDs (C0123...). */
  channels: {
    /** Board updates: task created, completed, assigned, etc. */
    boardUpdates?: string;
    /** Health alerts and agent failures. */
    alerts?: string;
    /** Verbose agent execution logs (optional). */
    agentLogs?: string;
  };

  /** Per-event notification toggles. */
  notifications: {
    taskCreated: boolean;
    taskCompleted: boolean;
    taskAssigned: boolean;
    taskCancelled: boolean;
    needsHuman: boolean;
    agentSpawned: boolean;
    agentFailed: boolean;
    healthAlerts: boolean;
  };

  /** DM bot configuration. */
  dmBot: {
    /** Enable conversational responses (uses Brain + LLM). */
    conversationalMode: boolean;
    /** Allowed user IDs for DM interaction. Empty = all users. */
    allowedUsers: string[];
  };
}
```

### Defaults

```typescript
// New file: src/slack/config.ts

const DEFAULT_SLACK_CONFIG: SlackSettings = {
  channels: {},
  notifications: {
    taskCreated: true,
    taskCompleted: true,
    taskAssigned: true,
    taskCancelled: false,
    needsHuman: true,
    agentSpawned: true,
    agentFailed: true,
    healthAlerts: true,
  },
  dmBot: {
    conversationalMode: true,
    allowedUsers: [],
  },
};
```

### Vault Keys Required

| Key | Required | Description |
|-----|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes (for any Slack features) | Bot user OAuth token |
| `SLACK_CLIENT_ID` | Yes (for OAuth flow) | App client ID |
| `SLACK_CLIENT_SECRET` | Yes (for OAuth flow) | App client secret |
| `SLACK_SIGNING_SECRET` | Yes (for webhook verification) | Request signing secret |

### Slack App Manifest

For easy app creation, provide a manifest template:

```yaml
display_information:
  name: Dash
  description: AI agent operating system
  background_color: "#1a1a2e"

features:
  bot_user:
    display_name: Dash
    always_online: true
  slash_commands:
    - command: /dash
      url: https://<your-domain>/api/slack/commands
      description: Interact with Dash agent
      usage_hint: "[help | status | board | spawn-agent | agents | cancel]"
      should_escape: false

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:join
      - channels:read
      - chat:write
      - chat:write.public
      - commands
      - files:read
      - files:write
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
      - users.profile:read

settings:
  event_subscriptions:
    request_url: https://<your-domain>/api/slack/events
    bot_events:
      - app_mention
      - message.im
      - reaction_added
      - reaction_removed
      - member_joined_channel
      - app_home_opened
  interactivity:
    is_enabled: true
    request_url: https://<your-domain>/api/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
```

---

## 14. Implementation Guide

### New Files

| File | Purpose |
|------|---------|
| `src/slack/board-events.ts` | Board event → Slack notification router + thread tracking |
| `src/slack/dm-bot.ts` | DM intent classification + response handlers |
| `src/slack/config.ts` | Configuration loading, defaults, validation |
| `src/slack/rate-limit.ts` | Token-bucket rate limiter per API method |
| `src/notifications/slack.ts` | `SlackNotificationChannel` for alert dispatcher |
| `brain/slack/thread-map.jsonl` | Persistent task → Slack thread mapping |

### Modified Files

| File | Changes |
|------|---------|
| `src/slack/webhooks.ts` | Extend slash command router, wire DM handler |
| `src/slack/types.ts` | Add new `MessageTemplates` (`agentOutput`, `errorAlert`, `boardSummary`) |
| `src/slack/client.ts` | Add `chat:write.public` and `users.profile:read` to `SLACK_BOT_SCOPES` |
| `src/queue/store.ts` | Add event emitter (`onBoardEvent`, `emit`) |
| `src/server.ts` | Register Slack notification channel, board event listener, health check, OAuth routes |
| `src/notifications/index.ts` | Export `SlackNotificationChannel` |
| `brain/settings.json` | Add `slack` configuration block |

### Implementation Order

1. **Config layer** — `src/slack/config.ts` with defaults and validation
2. **Board events** — Event emitter in `QueueStore`, `src/slack/board-events.ts`
3. **Slash commands** — Extend `handleDashCommand()` with `spawn-agent`, `board`, `cancel`, `agents`
4. **DM bot** — `src/slack/dm-bot.ts`, wire into `handleMessage()`
5. **Notification channel** — `src/notifications/slack.ts`, register in dispatcher
6. **Rate limiter** — `src/slack/rate-limit.ts`, integrate into `SlackClient.request()`
7. **Thread persistence** — `brain/slack/thread-map.jsonl` load/save
8. **OAuth routes** — `GET /api/slack/oauth` and callback in `src/server.ts`
9. **Health check** — Register Slack availability check

### Dependencies

No new npm packages required. The existing `fetch` API (Node 18+), `crypto`, and Hono are sufficient.
