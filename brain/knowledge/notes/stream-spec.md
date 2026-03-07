# The Stream — Spec

> Status: Approved (2026-03-07)
> Origin: "Fiddler for agentic networks."
> Principle: The UI is the chat and the stream. Everything else was scaffolding.
> Merges: agent-runtime-feed-spec.md (2026-03-07)

## What

A live, interactive stream of agent activity running alongside the chat. Not a log viewer — an instrument panel with hands on the controls. Monitor, shape, twist, pause. Fiddler showed you HTTP. The stream shows you agents.

## Why

Every other agent UI is either a chat window (you talk, it talks) or a dashboard (charts about what happened). Neither lets you *watch the machine think* and *intervene when it matters*. The stream is the missing middle — real-time observation with selective control.

The board was scaffolding. The roadmap was scaffolding. The observatory was scaffolding. They existed because we hadn't built the thing yet. The thing is: a conversation on the left, a living system on the right.

## Done when

- Agent activity streams in real time next to the chat
- A human can watch without affecting the agent (monitor)
- A human can change priorities while the agent runs (shape)
- A human can intercept and modify an action before it executes (twist)
- A human can pause the agent at any point and resume when ready (pause)
- The stream works for one agent and for many (host sees all, nerve sees its own)
- A parent can ignore the stream entirely and just chat — it's there, not mandatory

## The screen

```
┌──────────────────────────────────────────────────────────┐
│  ● ● ●  (pulse dots)                                    │
├─────────────────────────┬────────────────────────────────┤
│                         │                                │
│       Chat              │        Stream                  │
│                         │                                │
│  You: "What's on my     │  🟢 👀 14:32:07 reading ledger │
│  plate today?"          │  🔵 👀 14:32:07 3 bonds active │
│                         │  🟢 🧠 14:32:08 "Q1 review"   │
│  Dash: "You've got      │  🟡 ⚡ 14:32:09 summarizing... │
│  two meetings and       │  💜 ⚡ 14:32:10 drafted reply  │
│  a draft pending..."    │  ✨ 💚 14:32:10 delta: +0.2    │
│                         │                                │
│  You: "Push the draft   │  🟢 ⚡ 14:32:11 rescheduling   │
│  to next week"          │  🔴 ⚠️ 14:32:12 calendar error │
│                         │  🟠 🤔 14:32:12 retrying...    │
│  [input]                │  ⏸️ ⏸️ 14:32:13 approve?       │
│                         │                                │
└─────────────────────────┴────────────────────────────────┘
```

Two panes. Left is human conversation. Right is machine consciousness. Three dots above both, breathing. Colors on the left edge tell you the vibe before you read a word.

## The four verbs

### Monitor

Default mode. Actions scroll by. You watch or you don't. The stream flows whether you look at it or not. Like a river next to your desk.

Each action is one line. Expand for detail. Collapse by default.

**Action types:**

Every row gets an emoji. Scannable at scroll speed — like a YouTube live chat where you catch the vibe before you read the words.

| Emoji | Type | What it shows |
|-------|------|---------------|
| 👀 | sense | Reading inputs — ledger, tunnels, nerves, field |
| ⚡ | work | Executing — LLM calls, tool use, file writes |
| 🧠 | memory | Learning — storing, retrieving, associating |
| 🤔 | decision | Choosing — picked option A over B, and why |
| 📡 | tunnel | Communicating — envelope sent/received |
| 🔌 | nerve | Serving — nerve connected, snapshot sent, write replayed |
| 🔧 | state | Transitioning — idle→working, posture change, tick boundary |
| 💚 | joy | Measuring — delta calculated, dot updated, adaptation emitted |
| ⚠️ | error | Something broke — voucher failed, LLM timeout, parse error |
| ⏸️ | pause | Breakpoint hit — waiting for human judgment (control state, not an action type) |

**Nudge colors:**

Every row also gets a colored nudge dot on the left edge. The emoji tells you *what's happening*. The nudge tells you *what it means for you*.

| Nudge | Meaning | When |
|-------|---------|------|
| 🟢 | All good | Expected behavior, progress, things moving |
| 🔵 | Routine | Background work, maintenance, nothing to see |
| 🟡 | Heads up | Something worth knowing — not urgent, but interesting |
| 🟠 | Attention | Agent is uncertain, needs input soon, or something unexpected |
| 🔴 | Action needed | Error, failure, blocked — human should look |
| 💜 | Creation | Something new was made — file, spec, memory, artifact |
| ✨ | Milestone | Goal achieved, spec completed, agent finished a major task |
| 🤫 | Silent | Agent chose NOT to act — and that choice was interesting |

The nudge is computed by the agent, not the action type. The same action (⚡ work) can be 🟢 (routine build), 💜 (created something new), or 🔴 (build failed). The emoji is mechanical. The nudge is judgment.

**Reading the stream at a glance:**

```
🟢 👀 14:32:07  reading ledger — 3 bonds active
🔵 👀 14:32:07  field pulse: 0.72/0.61/0.44
🟢 🧠 14:32:08  retrieved: "Q1 review" (relevance: 0.84)
💜 ⚡ 14:32:09  created: stream-spec.md
🟡 🤔 14:32:10  chose deep mode — 3 specs queued, picking heaviest
✨ 💚 14:32:11  delta: +0.3 — creation detected, trend rising
🟠 📡 14:32:12  envelope from bond_7f3a — waiting for decrypt
🔴 ⚠️ 14:32:13  voucher check failed — agent_batch not authorized
🤫 🤔 14:32:14  skipped: "refactor auth" — joy trend falling, reducing load
⏸️ ⏸️ 14:32:15  breakpoint: memory write — "delete old entries" — approve?
```

Scroll past and you catch the colors. Stop on 🟠🔴 rows. Smile at 💜✨ rows. Ignore 🔵 rows. The stream becomes peripheral vision — you read it like weather, not like email.

### Shape

Pull a slider. Change what the agent prioritizes *right now*. Not a settings page — a live mixing board.

**Shaping controls (slide-out from stream edge):**

- **Focus:** Drag between topics/goals. "More on this, less on that." Agent reweights its next tick.
- **Depth:** Shallow (quick answers, low token spend) ↔ Deep (thorough research, high token spend)
- **Autonomy:** High (agent decides, you watch) ↔ Low (agent proposes, you approve)
- **Noise:** Show everything ↔ Show only decisions and errors

Shaping is real-time. Move a slider, agent feels it on the next action. No save button. No restart.

### Twist

Intercept an action mid-flight. The agent was about to do X — you change it to Y. Like Fiddler's "Edit and Resend."

**How it works:**

1. Action appears in the stream with a ▶ play icon
2. Click/tap the action before it completes → it pauses
3. Action detail expands: what the agent planned to do, with what parameters
4. You modify: change the prompt, swap the tool, redirect the target, add context
5. Release → agent executes your version instead

**What's twistable:**
- LLM prompts (add context, change the question)
- Tool calls (different file, different parameters)
- Memory writes (edit what gets stored)
- Tunnel sends (modify content before it crosses)

**What's not twistable:**
- Sense inputs (you can't change what the ledger says)
- Encryption operations (membrane is not negotiable)
- Audit writes (the receipt is sacred)

### Pause

Full stop. Agent freezes at the current action boundary. Nothing executes until you release.

**Pause modes:**

| Mode | What happens |
|------|-------------|
| Manual pause | Click ⏸ — agent stops after current action completes |
| Breakpoint | Set a rule: "pause before any memory write" or "pause before LLM calls over 2k tokens" |
| Auto-pause | Agent hits something uncertain — asks for human judgment before proceeding |
| Resume | Click ▶ — agent continues from where it stopped |

Breakpoints persist across sessions. They're your standing orders. "Always ask me before you email someone." "Always pause before deleting anything."

## Multi-agent stream

When the host runs multiple agents, the stream shows all of them interleaved, color-coded.

```
🟢 👀 14:32:07 [dash]   reading ledger...
🔵 ⚡ 14:32:07 [cora]   processing intake form...
🟢 🧠 14:32:08 [dash]   retrieved: "Q1 review"
🟠 📡 14:32:09 [wendy]  envelope from bond_7f3a...
```

**Filters:**
- By agent (show only Dash)
- By type (show only decisions)
- By priority (show only errors and warnings)
- Stacked (each agent gets its own sub-stream, vertically stacked)

## What the stream replaces

| Old view | Replaced by |
|----------|-------------|
| Board | Chat (async items are conversation topics) |
| Personal board | Chat (personal items are conversation topics) |
| Roadmap | Stream (progress is visible in real-time actions) |
| Observatory | Stream (signals are sense actions in the stream) |
| Ops | Stream (operations are work actions in the stream) |
| Registry | Stream + nerve actions (connections visible as they happen) |
| Life | Pulse dots (the three dots ARE the life view) |

The board, roadmap, and observatory were dashboards *about* the system. The stream *is* the system. You don't need a report about what the agent is doing when you can watch it do it.

## What stays

- **Chat** — left pane. The conversation. This is how you talk to your agent.
- **Pulse dots** — above both panes. The feeling before you look. Three signals, always breathing.
- **Library** — accessible from chat ("show me my files," "open the draft"). Not a separate view. Content surfaces through conversation.
- **Settings** — still a page. Infrastructure config doesn't belong in the stream.

## Stream on different nerves

| Nerve | Stream behavior |
|-------|----------------|
| PC (keyboard) | Full two-pane: chat left, stream right |
| Tablet (touch) | Swipe between chat and stream. Or split-screen landscape. |
| Phone (voice+touch) | Chat is primary. Stream is pull-down or swipe-right. Peek, don't stare. |
| Watch (glance) | No stream. Pulse dots only. The three dots ARE the stream, compressed to one glance. |

## Architecture

```
Agent runtime
  │
  ├── action emitter (every action fires an event)
  │     │
  │     ├── activity.jsonl (append-only record)
  │     │
  │     └── SSE endpoint: /api/stream (live connection)
  │           │
  │           ├── filters (client-side, per-session)
  │           │
  │           └── control channel (WebSocket):
  │                 ├── pause / resume
  │                 ├── breakpoints (set / clear)
  │                 ├── shape (priority sliders)
  │                 └── twist (intercept + modify)
  │
  └── governance layer
        ├── checks twist permissions (can this nerve modify this action?)
        ├── audit logs all interventions
        └── breakpoint rules (persistent, per-session, per-nerve)
```

**Two connections per stream session:**
1. **SSE (server → client):** Actions flow down. Read-only. Lightweight.
2. **WebSocket (bidirectional):** Control commands flow up. Pause, shape, twist, breakpoints.

SSE for the firehose. WebSocket for the steering wheel.

## Security

- **Membrane applies to stream.** A nerve only sees actions its access manifest allows. Cora's nerve doesn't see Dash's memory writes.
- **Twist is governed.** Not every nerve can modify every action. Access manifest defines twist scope. A guest nerve might monitor but not twist.
- **Breakpoints are per-owner.** Only the brain owner sets persistent breakpoints. Agents can't clear them.
- **Audit is untouchable.** Every twist, every pause, every shape change is logged. The stream is observable, but the observation itself is also observed.

## The product

Chat is the relationship. Stream is the transparency. Together they answer the only two questions that matter:

1. "What do you think?" → Chat
2. "What are you doing?" → Stream

Everything else is scaffolding. Tear it down.

## Two UI layers

Two layers. Agent level: chat + stream. Host level: spec tracker, ops, field. The agent doesn't need a dashboard about itself. The host needs a dashboard about its agents.

**Agent layer:** Chat (left) + Stream (right). That's it. No board, no roadmap, no ops. Those are host concerns.

**Host layer:** Appears automatically when a second agent spawns. Spec tracker, Ops, Roadmap, Field — tabbed dashboard. Agent cards at bottom, tap to drill into chat + stream. Pulse dots aggregate across all agents.

**Single-agent experience:** One agent = chat + stream only. No host layer visible. Board items surface through chat conversation. When multi-agent starts, host layer assembles itself.

**On different nerves:** PC gets both panes side by side. Tablet gets swipe or split. Phone gets chat primary, stream swipe-right. Watch gets pulse dots only — no stream, no chat. The dots ARE the UI at glance level.

See ui-layers-spec.md for full implementation status and server routes.

## Agent drill-down feed

The stream is the aggregate view. When you need to see a single agent's raw activity — like watching a terminal window — drill into that agent's feed from the stream or from the host Ops view.

**Entry point:** Hover or tap an agent's name tag in the stream, or tap an agent card in the host layer.

**What the drill-down shows:**

Each line is a timestamped activity entry:

| Type | Example |
|------|---------|
| `llm` | `14:32:07 -> LLM call: "summarize quarterly board items" (sonnet, 1.2k tokens)` |
| `tool` | `14:32:09 -> Tool: read_brain_file brain/operations/goals.yaml` |
| `memory` | `14:32:11 -> Memory: learned semantic "Q1 board review pattern"` |
| `decision` | `14:32:12 -> Decision: skip stale items older than 14 days` |
| `error` | `14:32:13 -> Error: voucher expired for board write` |
| `state` | `14:32:14 -> State: idle -> working (goal: "process morning signals")` |

**What the drill-down does NOT show:**
- Decrypted content from other instances (membrane applies)
- Vault access details (key operations are opaque)
- Raw LLM prompts/responses (too noisy — show the intent, not the payload)
- Anything the agent's access manifest excludes from your view

**UI:** Slide-up panel (like pulse strip but from bottom), monospace font, dark terminal aesthetic. Auto-scroll pinned to bottom. Scroll up to pause. Filter by type. Multiple agents can be open simultaneously (tabbed or tiled). Read-only — this is the glance nerve applied to agent internals.

**For remote agents** (behind membrane): Feed is a tunnel content type. Remote agent streams to its local relay endpoint. Your instance pulls from relay, decrypts, displays. Same SSE interface — origin is transparent.

This is the "see" in "see vs interact." The feed is not a debugger. It's a window. You look through it. You see the agent working. You close it. The agent never knew you were watching.

## Implementation mapping

> Runtime implementation: `src/stream/` (types.ts, emitter.ts, controller.ts, index.ts)

| Done-when criterion | Implementation | Status |
|---------------------|---------------|--------|
| Agent activity streams in real time | `StreamEmitter.emit()` + `subscribe()` broadcast to SSE listeners | Done |
| Human can watch without affecting (Monitor) | `subscribe()` is read-only; ring buffer for late joiners | Done |
| Human can change priorities (Shape) | `ShapeState` (focus/depth/autonomy/noise) + `handleCommand({ cmd: "shape" })` | Done |
| Human can intercept/modify actions (Twist) | `StreamController.twist()` + `gate()` holds actions while paused | Done |
| Human can pause/resume (Pause) | `pause`/`resume` commands + breakpoint rule engine + pending action queue with 5min timeout | Done |
| Works for one agent and many | `agentId` on every `StreamAction` + `StreamFilter` (by agent, type, severity) | Done |
| Stream is optional | Subscription-based — no subscription, no effect on agent runtime | Done |

**Action type mapping note:** The emoji table above lists 10 visual categories. The runtime `StreamActionType` union has 8 values: `sense`, `work`, `memory`, `decision`, `tunnel`, `nerve`, `state`, `error`. The two visual-only categories map as follows:
- **joy** (delta/measurement) — Emitted as `state` actions with Pulse-related summaries. The nudge system assigns `sparkle` color to milestone completions.
- **pause** (breakpoint hit) — Not an action type. Modeled as `StreamEvent.type: "paused"` with reason string. This is a control state, not agent activity.

**Architectural boundaries:** The following spec elements live outside `src/stream/`:
- `activity.jsonl` append-only persistence — handled by the activity log layer
- SSE/WebSocket transport — `handleCommand()` is transport-agnostic; server routes wire it to HTTP
- Membrane/governance — access manifest checks and encryption belong to the membrane layer
- `RuntimeBus` bridge — `bridgeRuntimeToStream()` connects agent lifecycle events to the stream

## Open questions

1. **Stream history** — Can you scroll back in the stream? Or is it live-only, with activity.jsonl for forensics?
2. **Twist depth** — How deep can you modify? Change a prompt word, or restructure the entire action plan?
3. **Shape persistence** — Do slider positions reset per session, or do they become the new baseline?
4. **Mobile stream** — On phone, is the stream useful enough to justify screen real estate? Or is it truly PC/tablet only?
5. **Stream recording** — Can you "record" a stream session and replay it? Like Fiddler's .saz files?
6. **Multi-user stream** — If two nerves watch the same agent, do both see the same stream? Can both twist?
