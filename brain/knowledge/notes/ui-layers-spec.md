# UI Layers — Spec

> Status: Draft (2026-03-07)
> Origin: "Observability, operations, board, roadmap are host level concepts now."
> Depends on: stream-spec.md, nerve-spawn-spec.md, core-os-spec.md

## What

Two UI layers. Agent level: chat + stream. Host level: board, ops, roadmap, observatory. The agent doesn't need a dashboard about itself. The host needs a dashboard about its agents. Same views, different altitude.

## Why

We built board, roadmap, observatory, and ops as agent-level views because we didn't have the host/nerve split yet. Now we do. An individual agent's world is its conversation and its activity stream. That's it. The aggregate views — how the cluster is doing, what's stuck, what's moving — belong to whoever is watching the cluster: the host owner, the CEO, the parent.

An employee doesn't carry a dashboard of their own KPIs. Their manager does. The agent chats and works. The host observes the field.

## Done when

- Agent UI is exactly two things: chat (left) and stream (right)
- Host UI shows aggregate views across all agents/nodes in the cluster
- Drilling down from host view into an agent opens that agent's chat + stream
- A single-agent setup (most users) sees both layers seamlessly — chat + stream with aggregate hidden until there's something to aggregate
- The views we remove from agent level don't need to be rebuilt — they move up unchanged

## The two layers

### Agent layer — the individual

What one agent shows to the human talking to it.

```
┌──────────────────────────────────────────────────────┐
│  ● ● ●  (this agent's pulse)                        │
├─────────────────────────┬────────────────────────────┤
│                         │                            │
│       Chat              │        Stream              │
│                         │                            │
│  Conversation with      │  Live activity.            │
│  this agent.            │  Monitor, shape,           │
│  Ask, tell, listen.     │  twist, pause.             │
│                         │                            │
└─────────────────────────┴────────────────────────────┘
```

**That's it.** No board. No roadmap. No ops. No observatory. No registry. No life view. Those are host concerns.

The agent-level UI answers one question: **"What's happening between me and this agent right now?"**

### Host layer — the cluster

What the host owner sees when looking at the whole field. The aggregate. The nest. The family of agents and nodes.

```
┌──────────────────────────────────────────────────────┐
│  ● ● ●  (aggregate pulse — all agents)               │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │  Board   │ │   Ops   │ │ Roadmap │ │  Field  │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│                                                      │
│  Board:     Async items across all agents.           │
│             Questions, pins, tensions, collisions.   │
│                                                      │
│  Ops:       What's running. Health. Errors.          │
│             Which agents are active, idle, stuck.    │
│                                                      │
│  Roadmap:   Where the cluster is heading.            │
│             Goals, milestones, progress by agent.    │
│                                                      │
│  Field:     Signal from bonds and tunnels.           │
│             Presence, nudges, availability.          │
│             The shared layer between hosts.          │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Agents:  [Dash ●] [Cora ●] [Wendy ●]       │    │
│  │           tap any → opens agent chat+stream   │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

The host-level UI answers a different question: **"How is my world doing?"**

## What moves where

| View | Was | Becomes |
|------|-----|---------|
| Chat | Agent level | Agent level (stays) |
| Stream | New | Agent level |
| Board | Agent level | Host level — aggregate pins across all agents |
| Personal board | Agent level | Removed — board items go into chat or host board |
| Roadmap | Agent level | Host level — cluster progress |
| Observatory | Agent level | Host level → renamed "Field" — signal from bonds/tunnels |
| Ops | Agent level | Host level — agent health, errors, runtime status |
| Registry | Agent level | Host level — bonds, nerves, tunnel status |
| Library | Agent level | Removed as view — content surfaces through chat ("show me my files") |
| Life | Agent level | Removed — the three dots ARE the life view |
| Settings | Agent level | Host level — cluster config. Agent-specific settings through chat. |

## Drill-down model

Host → Agent is one click/tap.

```
Host: Ops view shows Dash has an error
  │
  └── Tap [Dash] → opens Dash's chat + stream
        │
        └── Stream shows the error in context
              │
              └── Twist or chat to resolve
```

Host → Agent → Host. Zoom in, fix it, zoom out. The stream is the microscope. The host view is the telescope.

## Single-agent experience

Most users start with one agent. They shouldn't see a "host layer" with one dot on it. That's empty infrastructure.

**When there's one agent:**
- Open the app → chat + stream. That's all.
- Pulse dots above. Settings accessible.
- No host view. No aggregate. No cluster dashboard.
- Board items, if any, appear as chat topics ("You've got 3 items pinned. Want to go through them?")

**When a second agent spawns:**
- Host layer appears automatically.
- Agent cards show at the bottom or in a nav.
- Board, Ops, Roadmap become accessible.
- The transition is seamless — chat + stream doesn't change, it just gains a parent view.

This is the posture system at the UI level. One agent = silent posture. Multiple agents = board posture. The interface assembles itself.

## Host views — what each shows

### Board (host level)

Async items that span the cluster. Not one agent's todos — the tensions, questions, and pins that affect the whole system.

- Items from all agents, grouped or interleaved
- Collision maps between agents (from tunnel spec)
- Human pins that haven't been assigned to any agent yet
- Tunnel board items from bonded hosts

### Ops (host level)

Runtime health of the cluster.

- Agent status: running, idle, errored, paused (from stream breakpoints)
- Nerve connections: which devices are connected, last sync
- Resource usage: LLM token spend, memory writes, tick frequency
- Errors: aggregated, clickable → drills into agent stream

### Roadmap (host level)

Where the cluster is heading.

- Goals from `brain/operations/goals.yaml`
- Progress by agent (who's contributing to which goal)
- Milestones with completion state
- Not a Gantt chart. A living map of intent → progress.

### Field (host level, was Observatory)

Signal from the shared layer. What's happening between hosts, not within them.

- Bond status: active, quiet, dehydrating
- Tunnel traffic: envelopes sent/received (volume, not content)
- Presence: which bonded hosts are online
- Nudges: inbound signals from other hosts
- Availability: shared calendar windows

## Navigation

No hamburger menu. No sidebar with 12 items. Two levels, direct access.

**Agent level:**
- Chat (default, left pane)
- Stream (right pane, always visible on PC/tablet)
- That's it.

**Host level (when multiple agents exist):**
- Agent cards (tap to enter agent chat+stream)
- Board / Ops / Roadmap / Field (tabs or swipe)
- Pulse dots (always visible, both levels)

**Switching:**
- From host → agent: tap agent card
- From agent → host: back gesture / button / swipe
- Pulse dots are always visible — they're the constant across both layers

## On different nerves

| Nerve | Agent layer | Host layer |
|-------|------------|------------|
| PC | Chat + Stream side by side | Full tabbed dashboard |
| Tablet | Chat + Stream (landscape) or swipe (portrait) | Tabs, touch-optimized |
| Phone | Chat primary, stream swipe-right | Agent cards, simplified views |
| Watch | Pulse dots only | Pulse dots only (aggregate) |

The watch never sees a dashboard. It sees three dots. That's the whole UI at glance level. If the dots are green, don't pick up your phone. If amber, maybe look. The dots are the UI at the lowest nerve.

## Architecture

```
┌─── Host Layer ──────────────────────────────────┐
│                                                  │
│  Board ─── reads all agents' board items         │
│  Ops ───── reads all agents' health + stream     │
│  Roadmap ─ reads goals.yaml + agent progress     │
│  Field ─── reads tunnel state + bond status      │
│                                                  │
│  ┌─── Agent: Dash ────┐  ┌─── Agent: Cora ────┐ │
│  │  Chat    │  Stream  │  │  Chat    │  Stream  │ │
│  │  (human) │  (agent) │  │  (human) │  (agent) │ │
│  └─────────────────────┘  └─────────────────────┘ │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Data flow:**
- Each agent emits actions to its stream (SSE)
- Host layer aggregates streams for Ops view
- Board items flow up from agents, down from human pins
- Field data comes from tunnel client, not from agents
- Pulse dots aggregate across all agents at host level, per-agent at agent level

## The principle

An agent works and talks. A host watches and steers. A nerve connects and renders. Three roles, three UIs, one brain.

The agent doesn't need to know how the cluster is doing. The host doesn't need to be in every conversation. The nerve doesn't need to understand the architecture. Each layer knows exactly what it needs and nothing more.

## Implementation status (2026-03-07)

### Agent layer — DONE

- `index.html`: Chat (left) + Stream (right) only
- Header nav contains only: pulse dots, agent name, Dashboard link (hidden in single-agent), thread toggle, stream toggle, share, settings
- No board, roadmap, ops, observatory, registry, library, or life links at agent level
- Mobile: Chat/Stream tabs for switching between panes
- First-run mode: hides stream pane and nav until pairing is complete

### Host layer — DONE

- `host.html`: Tabbed dashboard with Specs, Board, Ops, Roadmap, Field
- Specs tab: fetches `/api/specs`, parses `specs/*.md` for status and criteria progress
- Board tab: fetches `/api/host/board`, shows active board items grouped by state (triage/backlog/in-progress)
- Ops tab: iframe → `/ops?embed=1`
- Roadmap tab: iframe → `/roadmap?embed=1`
- Field tab: iframe → `/observatory?embed=1` (renamed from Observatory in UI)
- Agent cards at bottom: primary agent + background agents from `/api/ops/agents`
- Pulse dots: aggregate state refreshed every 30s

### Drill-down — DONE

- Agent cards link to `/` (agent chat+stream)
- Host header has `← Chat` back link
- Direct access to `/ops`, `/roadmap`, `/observatory`, `/registry` redirects to `/host` (unless `?embed=1`)
- Retired views (`/library`, `/life`, `/browser`) redirect to `/`

### Single-agent experience — DONE

- `agentCount` returned by `/api/status` (currently hardcoded to 1)
- When `agentCount <= 1`: Dashboard link hidden in agent header and settings
- User sees only chat + stream. No host layer visible.
- Board items surface through chat conversation in single-agent mode
- When multi-agent is implemented: `agentCount` will query nerve registry, Dashboard link auto-appears

### Server routes

| Route | Behavior |
|-------|----------|
| `/` | Agent chat+stream (index.html) |
| `/host` | Host dashboard (host.html) |
| `/ops?embed=1` | Ops view (iframe-only) |
| `/roadmap?embed=1` | Roadmap view (iframe-only) |
| `/observatory?embed=1` | Field view (iframe-only) |
| `/registry?embed=1` | Registry view (iframe-only, not linked) |
| `/ops`, `/roadmap`, `/observatory`, `/registry` | Redirect → `/host` |
| `/library`, `/life`, `/browser` | Redirect → `/` |
| `/nerve` | Guest pairing + encrypted chat (separate entry) |
| `/api/specs` | Spec file scanner for host Specs tab |
| `/api/host/board` | Board items for host Board tab |
| `/api/ops/*` | Health, agents, queue, projects, settings |
| `/api/stream` | SSE stream for agent activity |

### What's deferred

- Multi-agent `agentCount` from nerve registry (currently hardcoded to 1)
- Agent-specific drill-down with `?agent=<id>` routing
- Host-level chat ("talk to the cluster")
- Transition animations between layers
- Watch-level UI (pulse dots only)

## Open questions

1. **Host-level chat** — Should there be a "talk to the cluster" mode? Or always talk to one agent at a time?
2. **Agent-level board** — Some agents might want their own scratch board. Is that stream + twist, or does a minimal board survive at agent level?
3. **Notification routing** — When an error happens, does it appear in the host Ops view, the agent stream, or both?
4. **Host on phone** — Is the host layer useful on a phone? Or is phone always agent-level with dots?
5. **Transition animation** — How does the UI communicate "you're zooming out to host level" vs "you're entering an agent"? Spatial metaphor? Fade?
