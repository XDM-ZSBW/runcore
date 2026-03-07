# Agent Runtime Feed — Spec

> Status: Retired (2026-03-07) — merged into stream-spec.md
> Origin: "I wish I could hover and see what's going on in that agent's world right now as terminal console output."

## What

A live stream of agent runtime activity, visible as console output when you drill into any agent. The lowest level of observation — raw activity, not summarized status. Like watching a terminal window for each running agent.

## Why

The pulse strip tells you the shape. The board tells you the intent. But when something feels off — or when curiosity hits — you need to see what's actually happening right now. Not a report. Not a summary. The raw stream. This is the glance nerve applied to agent internals: see without interacting.

Every agent already emits activity to JSONL logs. Nothing streams that live to anyone watching. The data exists. The pipe doesn't.

## Done when

- Any running agent's live output is visible from the operations view
- Hover or tap to open the stream — no navigation, no page change
- Stream shows real-time entries as they happen (not polling old logs)
- Closing the view has zero effect on the agent — observation doesn't disturb
- Works for local agents and (eventually) remote agents behind a membrane

## What the feed shows

Each line is a timestamped activity entry. Content types:

| Type | Example |
|------|---------|
| `llm` | `14:32:07 → LLM call: "summarize quarterly board items" (sonnet, 1.2k tokens)` |
| `tool` | `14:32:09 → Tool: read_brain_file brain/operations/goals.yaml` |
| `memory` | `14:32:11 → Memory: learned semantic "Q1 board review pattern"` |
| `decision` | `14:32:12 → Decision: skip stale items older than 14 days` |
| `error` | `14:32:13 → Error: voucher expired for board write` |
| `state` | `14:32:14 → State: idle → working (goal: "process morning signals")` |

## What the feed does NOT show

- Decrypted content from other instances (membrane applies)
- Vault access details (key operations are opaque)
- Raw LLM prompts/responses (too noisy — show the intent, not the payload)
- Anything the agent's access manifest excludes from your view

## Architecture

```
Agent runtime
  │
  ├── activity log (brain/ops/activity.jsonl) ← already exists
  │
  ├── live emitter (EventEmitter / WebSocket)
  │     │
  │     └── feed endpoint: /api/agents/:id/feed (SSE stream)
  │           │
  │           └── membrane filter (access manifest scoping)
  │
  └── UI: overlay panel on hover/tap in operations view
```

### Local agents (same host)

- Agent emits structured events to an EventEmitter (in-process) or writes to a named pipe
- Feed endpoint opens an SSE (Server-Sent Events) stream
- Client connects on hover, disconnects on close
- No buffering — live only. Want history? Read the JSONL.

### Remote agents (behind membrane)

- Feed is a tunnel content type: `feed` (added to tunnel policy)
- Remote agent streams to its local relay endpoint
- Your instance pulls from relay, decrypts, displays
- Same SSE interface on the client side — origin is transparent

## UI behavior

- **Entry point:** Operations view → agent card → hover or tap
- **Display:** Slide-up panel (like pulse strip but from bottom), monospace font, dark terminal aesthetic
- **Auto-scroll:** Pinned to bottom (newest). Scroll up to pause. Scroll back down to resume.
- **Filter:** Toggle by type (llm, tool, memory, decision, error, state). All on by default.
- **Multiple agents:** Can open feeds for multiple agents simultaneously (tabbed or tiled)
- **No interaction:** This is read-only. You watch. You don't type. Glance nerve, not keyboard nerve.

## The principle

This is the "see" in "see vs interact." The feed is not a debugger. It's not a REPL. It's a window. You look through it. You see the agent working. You close it. The agent never knew you were watching.

Observation without disturbance. The quantum mechanics of management.

## Layers

The pulse strip is the feeling. The board is the intent. The feed is the reality. Three levels of the same truth at different magnifications. Glance at the dots. Read the board. Watch the feed. Then close everything and trust the system.

## Open questions

1. Feed retention — stream only, or buffer last N lines for "just missed it" context?
2. Feed across instances — does a host see all node feeds, or only bonded ones?
3. Rate limiting — chatty agents could flood the stream. Throttle, or let it scroll?
4. Feed as content type — should feed snapshots be shareable through tunnels?
