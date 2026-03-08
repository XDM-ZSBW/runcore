# Core: Why Your AI Doesn't Learn (And What We Did About It)

*A new architecture for AI agents that actually get better over time*

---

## The Problem Nobody Talks About

Let's be fair upfront: modern AI platforms have memory now. ChatGPT remembers your preferences. Claude remembers your project context. Gemini knows your name. The "AI has no memory" criticism is a couple years out of date.

But here's what none of them do: **work on your behalf when you're not there.**

They remember you. They don't *act* on what they remember without being prompted. They won't notice at 2am that an open question from Tuesday's conversation just got answered by something that happened in your codebase. They won't reflect on why an approach failed and adjust their strategy before you wake up. They won't decide on their own that enough has piled up to justify doing some work.

They're brilliant assistants with good memories. But they only move when you push them.

Most AI agents are event-driven executors: prompt in, response out, wait for the next prompt. Core is an **adaptive** system — it processes experience into strategy so it doesn't drown in its own history. The gap isn't memory. It's autonomous agency with structured learning.

If you've ever watched an agent burn tokens repeating the same mistake three times in a row, Core is for you.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/XDM-ZSBW/core.git
cd core

# 2. Install
npm install

# 3. Create your .env (REQUIRED — server won't start without it)
cp .env.example .env
# Fill in at minimum: OPENROUTER_API_KEY (or OLLAMA_URL for local-only)

# 4. Configure your instance (optional — defaults to "Core")
# Edit brain/settings.json → set "instanceName" to your agent's name

# 5. Start
npm run chat
# Open http://localhost:3577 → pairing code shown → pair → chat!
```

### Personalize your instance

1. **Name:** Set `instanceName` in `brain/settings.json` (e.g. "Dash", "Atlas", "Nova")
2. **Personality:** Edit `brain/identity/personality.md`
3. **Voice:** Configure `brain/identity/tone-of-voice.md`
4. **Brand:** Fill in `brain/identity/brand.md`
5. **Goals:** Update `brain/operations/goals.yaml`

---

## What We're Actually Building

Core is an open-source personal AI agent — software that runs on your machine, manages tasks, executes work autonomously, and (here's the part that matters) **gets better at its job over time.**

Not "better" in the vague, marketing sense. Better in a measurable, auditable way: it compresses failures into root causes, tracks unresolved questions across sessions, adjusts its strategy based on structured reflection, and governs its own execution so it doesn't spiral into expensive loops of repeated mistakes.

Here's what that looks like concretely:

> On Monday, Core tries to refactor a module and fails three times — the import paths keep breaking. By Wednesday, it has compressed those failures into one root cause ("module paths in this area drift on every merge"). It updates its strategy to always verify import paths against the actual file tree before writing them. By Friday, it stops suggesting the broken pattern entirely. A stateless agent would still be failing the same way on Friday that it failed on Monday.

We call this **Adaptive Processing** — an architecture that treats experience as raw input to be refined, not just stored. Raw experiences go in. Structured knowledge comes out. What's not useful gets discarded. Entropy goes down.

This document covers the four pillars of that architecture, compares it honestly against existing approaches, and tells you exactly where the trade-offs are. No hand-waving.

---

## A Quick Orientation: What You're Looking At

Core runs as a local server on your computer. No cloud dependency, no data leaving your machine. Its "brain" is a set of plain text files — Markdown, YAML, and JSONL (one JSON object per line) — organized into modules: memory, operations, knowledge, identity, content.

```
Core/
├── CLAUDE.md          ← Repo map for AI assistants
├── AGENT.md           ← Core rules and decision table
├── SKILL.md           ← Routing: which module for which task
│
├── brain/             ← File-based brain (modules + data)
│   ├── memory/        ← Episodic: experiences, decisions, failures, semantic, procedural (.jsonl)
│   ├── identity/      ← Voice, brand, personality (.md)
│   ├── content/       ← Templates, drafts (.md)
│   ├── operations/    ← Goals, queue, projects (.yaml, .jsonl, .json)
│   └── knowledge/     ← Research, bookmarks, notes
│
├── skills/            ← Agent skills (YAML frontmatter + instructions)
├── docs/              ← Design docs
└── src/               ← TypeScript runtime: Brain class, context assembly, file-backed memory, HTTP server
```

There's no database. Everything is files. That means:

- **Total transparency.** Open any file in a text editor and read exactly what the AI knows, what it's decided, and why.
- **Git as version control.** Every change to the AI's memory is a git commit. Full audit trail. Full rollback capability.
- **Crash resilience.** Kill the process, restart it, and Core rebuilds its working state from files. The files *are* the brain. Everything else is derived.

The architecture is: **stateless programs + stateful filesystem.** Agents (worker programs that execute specific tasks) spawn fresh each time — no memory between runs. The orchestrator can restart and reconstitute. Only the files persist. It's the same operational model as a serverless function writing to S3, just applied to a cognitive system.

If you've built infra with files, git, and append-only logs, this will feel familiar by design.

With that foundation, here are the four pillars.

---

## Pillar 1: Durable Tension Tracking

### The Open Loop Protocol

In any real project, not every question gets answered immediately. You hit something you can't resolve right now — a dependency you're not sure about, a design decision that needs more context, a bug you can't reproduce yet. In a normal AI conversation, that unresolved question lives in the chat context and dies when the session ends.

Core treats unresolved questions as **first-class objects** — persistent data structures called Open Loops. Each one records:

- The unresolved tension itself
- What subject it relates to (the "anchor")
- Semantic search heuristics — keywords that act as magnets for relevant new information
- An expiration date (default: 7 days)

These loops don't just sit in a list. They **actively scan** for their own resolution. On a configurable interval (default: every 5 minutes), Core checks new activity — chat messages, agent outputs, system events, code commits — for anything semantically related to an active loop.

When a match is found, the loop transitions to "resonant" — new evidence has arrived. Core then evaluates: does this evidence actually *resolve* the question? If yes, the loop closes with a full audit trail. If not, it stays open but marked as having relevant context.

### Why This Isn't Just a To-Do List

Three properties make this different from a simple tracker:

**Temporal decay.** Loops that receive no resonance within 5 days are automatically archived. Tensions must earn their continued existence through relevance. This prevents the system's attention from being consumed by stale questions that no longer matter.

**Semantic merging.** When two loops are about essentially the same underlying question (measured by vector similarity or keyword overlap), they merge into one. This prevents the common failure mode where the same problem gets raised in five different conversations and tracked as five separate issues that never converge.

**Resolution coupling.** Loops are connected to the system's work output. When an agent completes a task that addresses an open tension, the loop can close automatically — with a record linking the original question to the resolving work.

**How this feels as a user:** You stop re-explaining the same unresolved architectural question every few days. The system carries that tension forward until reality answers it — or until it decays because it stopped mattering.

Without this, long-running AI systems drift. They revisit the same ground, fragment their attention across duplicate threads, and accumulate tracking overhead that scales linearly with usage. The Open Loop Protocol makes the system's attention a bounded, self-cleaning resource. This is digestion applied to attention — not storing every question forever, but processing each one until it resolves or expires.

---

## Pillar 2: Structured Learning

### Reflection as a System Primitive

After each batch of autonomous work completes, Core runs a structured reflection. This isn't logging — it's analysis. The reflection engine produces six components:

1. **Successes** — what worked, stated specifically ("correctly identified the renamed module and updated three import paths")
2. **Failures** — what went wrong, stated specifically
3. **Root causes** — *why* it went wrong, distinguishing symptoms from underlying issues ("assumed a dependency existed that was removed in a prior commit")
4. **Loop impact** — which open loops were affected by the work, and what should happen to them
5. **Strategy adjustments** — concrete directives for the next round ("verify module paths before writing imports")
6. **Confidence delta** — a scalar (-1 to +1) indicating whether the session improved or degraded overall system state

### The Causal Link

Here's the part that makes this architecture actually work, not just document:

**Reflection outputs feed directly into the next planning cycle.**

When Core plans its next batch of work, it reads the strategy adjustments and root causes from the previous reflection as explicit context. If the last round discovered "task X failed because file Y was renamed," the planner sees this and adapts — either choosing a different task or instructing the agent to verify assumptions before acting.

This is not sophisticated AI reasoning. It's structured information flow between execution cycles. But that flow is precisely what separates a system that repeats its mistakes from one that learns from them. The reflection doesn't just *record* what happened. It *changes* what happens next.

### The Memory Bridge

There's a subtle gap in most task-tracking systems: work gets recorded in the task tracker, but not in the AI's associative memory. The system *did* the work but doesn't *remember* having done it.

Core's task-level memory bridge closes this gap. When any task reaches a terminal state — done or cancelled, through any pathway (agent execution, chat interaction, UI drag-and-drop, or API call) — an episodic memory entry is written. The task tracker answers "what's in progress?" The memory store answers "what do I know about authentication work?" Both surfaces stay synchronized.

### What This Produces

Five capabilities that stateless systems can't match:

- **Failure compression**: individual failures are synthesized into root causes, not just logged
- **Root cause analysis**: the reflection distinguishes symptoms from structural problems
- **Cross-round learning**: each round benefits from the learnings of previous rounds within the same session
- **Durable decision history**: the reasoning behind every strategy change is preserved permanently
- **Universal work memory**: every task completion is recorded as episodic memory, regardless of the completion pathway

**How this feels as a user:** Instead of a growing pile of transcripts and logs, you get a compact history of what the system tried, why it failed, and what changed next time. You can read the decision log and trace exactly why the system made a particular choice on a particular day.

The one-liner: **without reflection, autonomy produces entropy. With reflection, autonomy produces learning.** This is the processing core of the architecture — raw activity refined into structured strategy.

---

## Pillar 3: Governed Autonomy

### The Activation System

How does an autonomous AI decide when to work?

The naive answer: a timer. Run every 15 minutes. But that's wasteful when nothing is happening and too slow when something urgent hits.

Core uses a **pressure-accumulation model** inspired by the integrate-and-fire pattern from computational neuroscience. Every meaningful system event deposits pressure into an integrator:

| Event | Pressure (mV) |
|---|---|
| Agent failure | 50 mV |
| User message | 30 mV |
| Open loop resonance | 25 mV |
| Code commit | 20 mV |
| Board state change | 15 mV |

Pressure decays exponentially between events. When accumulated pressure crosses a configurable threshold (default: 60 mV), the system fires — it wakes up and runs a full work cycle: plan, spawn agents, collect results, reflect.

After firing, a **cooldown period** kicks in: 60 seconds of absolute lockout, followed by 5 minutes where the threshold doubles. This prevents rapid re-firing.

**In practice:** A burst of agent failures or a flurry of commits will wake Core up. A quiet repo on a Sunday lets it go idle. The system's activity level is proportional to accumulated pressure — a measurable value you can observe on the dashboard.

Three modes are configurable: **Anxious** (low threshold, fires frequently — responsive but token-expensive), **Balanced** (default — fires when meaningful signals accumulate), and **Stoic** (high threshold — conservative with resources, accepts longer latency).

### Circuit Breakers

Autonomous AI without governance is a token furnace. Core implements four levels of protection:

**Batch-level breaker**: If every agent in a batch fails, the session stops immediately. A 100% failure rate indicates a systemic problem — retrying won't help.

**Cumulative failure cap**: If total failures across all rounds exceed 8, the session halts. This catches the pattern where a session stays alive by completing easy tasks while repeatedly failing on the same hard one.

**Round limit**: After 5 rounds of plan → execute → reflect, pause regardless of remaining work. No infinite loops.

**Credit protection**: If the LLM provider reports credit exhaustion, autonomous work pauses for 30 minutes and falls back to a local model.

### Escalating Cooldowns

When an agent fails on a specific task, that task enters exponential backoff — 30 minutes, then an hour, then 2 hours, capped at 4 hours. This prevents the system from repeatedly attacking a problem that clearly requires different conditions. The cooldown creates space for the surrounding system to evolve.

### Vagueness Detection

Under-specified prompts are an agent failure factory. If the planner generates a prompt containing red-flag words — "comprehensive," "robust," "production-ready," "enterprise," "scalable" — without concrete file paths, a heuristic rewrites it with constraints: read existing code first, pick one small concrete piece, build that well. If nothing concrete can be built, write a spec instead.

**How this feels as a user:** Core doesn't run your API bill up at 3am chasing its own tail. It works when there's reason to work, stops when it should stop, and backs off from problems it can't currently solve. The governance isn't a limitation — it's what makes unsupervised autonomy safe to leave running.

This is adaptive regulation — the system's activity level governed by accumulated pressure, not timers, with hard limits that prevent runaway consumption.

---

## Pillar 4: Ambient Self-Observation

### The Trace Correlation Engine

Core generates a continuous activity stream — agent spawns, task completions, failures, integration syncs, lifecycle events. Most systems treat this as an inert log.

Core runs an **analysis engine** over this stream (configurable interval, default: every 10 minutes), looking for patterns that no individual component would detect.

### How It Works

**Trace chain construction**: Related events are linked together. An agent spawning → that agent completing → the resulting task state change forms a chain. Events without explicit references are clustered by time window (5 minutes) and source affinity — related subsystems happening concurrently get grouped.

**LLM analysis**: Chains are submitted to a small, cheap model that classifies findings as patterns (recurring behaviors), anomalies (unusual events), correlations (connected activities from different subsystems), or bottlenecks (chains with unusual delay or repeated retries).

**Auto-escalation**: High-confidence bottlenecks and anomalies are automatically added to the task board. Deduplication prevents re-escalation of known issues. Patterns from resolved board items are permanently suppressed — the engine learns what the operator considers solved.

### The Pre-Analysis Firewall

Two filters prevent the engine from wasting tokens on noise:

- **Routine classifier**: Strips known-routine events (health checks, garbage collection, startup initialization) that are valuable for the log but uninformative for pattern analysis
- **Resolved pattern filter**: Strips events matching patterns from completed board items — if a bottleneck was already addressed, stop spending tokens rediscovering it

**How this feels as a user:** The system can notice "every time we touch the auth service, agents time out" and open a ticket for you — without you having to read through logs and spot the pattern yourself. You get the insight; it did the detective work.

This keeps self-observation cost-effective. The system watches itself, but intelligently — digesting its own behavioral patterns rather than drowning in raw telemetry.

---

## How It Compares

| System type | Memory shape | What happens over a month |
|---|---|---|
| Stateless agents | None beyond a session | Repeats the same mistakes on day 30 as day 1 |
| RAG-based agents | Ever-growing warehouse of documents | Retrieval gets noisier as the pile grows |
| Core (adaptive) | Structured, compressed, self-pruning | Fewer mistakes, clearer strategy, bounded state |

### The Timeline Difference

Core doesn't outperform these systems on any single task. It's not faster, and for one-shot questions, the processing overhead is pure waste.

The difference shows up over time:

- **Day 1**: Core and a stateless agent perform identically
- **Week 1**: Core has compressed 50 failures into 12 root causes, resolved 15 open loops, and adjusted its strategy 8 times
- **Month 1**: Core's planning context includes institutional knowledge from hundreds of execution cycles. The stateless agent is still starting fresh every time

The adaptive architecture is an investment in compounding returns. The cost is latency and complexity. The payoff is a system that gets more focused over time instead of more confused.

---

## The Honest Trade-Offs

No architecture is free. Here's what the adaptive approach costs:

**Latency**: Reflection adds seconds to tens of seconds between execution rounds. Systems that skip consolidation and proceed directly feel snappier for individual tasks. Core trades per-task speed for cross-session stability.

**Complexity**: The lifecycle layer requires vector similarity computation, decay policies with tuned time constants, merge logic, and integration points between scanners. You're adopting a small runtime, not just a library — that's a conscious choice in favor of local-first operation and auditability.

**Token cost**: Every reflection, every resonance confirmation, every resolution evaluation consumes tokens. For a personal agent on a modest budget, these costs are manageable (utility tasks use smaller, cheaper models). At scale, the reflection overhead becomes a meaningful line item.

**This is not for you if** you only ever ask one-shot questions. If your use case is "ask a question, get an answer, move on," you're paying for processing overhead you won't use. Core is built for continuous, autonomous work over days, weeks, and months — not single interactions.

These are not deficiencies. They're the price of the architecture. The question is whether semantic continuity, failure compression, strategic adaptation, and long-horizon stability justify those costs for your use case.

---

## What Core Is Not

**Not a new field of AI.** It's an engineering artifact within the agentic AI paradigm. Every primitive it uses — reflection, governance, memory, lifecycle management — exists in published research. The contribution is compositional: how known mechanisms are wired together, constrained, and operationalized.

**Not a general-purpose framework.** It's a single-agent runtime built for one user, running locally. The trade-offs (file-based storage, append-only JSONL, local-first operation) are appropriate for that context and inappropriate for multi-tenant platforms.

**Not a replacement for human judgment.** The governance layer bounds autonomy but doesn't eliminate oversight. Board items still need human grooming. Reflection produces strategy adjustments, not guarantees. The system is designed to be auditable precisely because it's not designed to be trusted without review.

**Not faster than stateless systems.** For any individual task, a system that skips reflection and proceeds immediately will outperform Core on latency. Core trades speed for stability over weeks and months.

---

## The Architectural Claim

Core is an **adaptive** system. It processes experience into strategy so it doesn't drown in its own history.

Six mechanisms make that concrete:

1. **Durable tension tracking** — unresolved questions persist as first-class objects that scan for their own resolution
2. **Reflection as a causal primitive** — structured analysis between execution rounds that changes what happens next
3. **Task-level memory bridging** — every task completion writes episodic memory, keeping transactional and associative records synchronized
4. **Lifecycle compression** — four entropy sinks prevent the information space from growing without bound
5. **Pressure-gated autonomy** — an activation system that fires work proportional to accumulated pressure
6. **Ambient self-observation** — a trace engine that discovers behavioral patterns across the system's own activity

The key innovation is not autonomy — many systems are autonomous. It's **adaptive processing** — and the self-awareness to know when processing is needed. That combination prevents intelligence from collapsing under its own complexity.

---

## For AI Assistants (Cursor, Claude Code, etc.)

1. **Read [CLAUDE.md](CLAUDE.md)** for the project map.
2. **Read [AGENT.md](AGENT.md)** for core rules and the decision table.
3. **Read [SKILL.md](SKILL.md)** to route: content → content module, memory → memory module, etc.
4. **Load only what you need.** Level 1 = SKILL + AGENT. Level 2 = module instruction file. Level 3 = data (JSONL lines, YAML, specific markdown). Do not load all files.
5. **Memory is append-only.** When writing to `brain/memory/*.jsonl`, append one line. Never overwrite the file.

---

## References

- **[The File System Is the New Database: How I Built a Personal OS for AI Agents](https://x.com/koylanai/status/2025286163641118915)** — Muratcan Koylan. Personal Brain OS, progressive disclosure, format-function mapping, skill system.
- [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering) — Skill format and patterns.
- [Agent Architecture: From Prompt to Context](https://www.agent32.org/agent-architecture-overview-from-prompt-to-context/) — Context engineering as the core discipline.
- [Beyond the Prompt (COALA)](https://medium.com/google-cloud/beyond-the-prompt-why-your-next-ai-agent-needs-a-brain-and-how-coala-research-paper-provides-an-ba187a906ea0) — Modular memory, internal/external actions.

---

*Bryant Herrman & Dash — The Herrman Group LLC — March 2026*
*https://herrmangroup.com*
