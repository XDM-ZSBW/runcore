# Spec Lifecycle — Spec

> Status: Draft (2026-03-07)
> Origin: "You dump → I spec → you approve → anyone builds."
> Depends on: stream-spec.md, tick-cycle-spec.md, agent-archetypes-spec.md, board-retirement-spec.md

## What

Specs replace the board as the organizing principle. A spec is a unit of intention — what, why, done-when. The lifecycle tracks a spec from raw idea to shipped code. Four states, strict order, visible in the stream, buildable by any agent.

## Why

Boards are flat. Everything is a card. A vague idea sits next to a detailed plan sits next to a completed task. No lifecycle. No progression. No way to know what's ready to build vs what's still half-baked.

Specs have structure. The lifecycle enforces it. You can't build a spec that hasn't been approved. You can't approve a spec that doesn't have done-when criteria. The lifecycle is a quality gate — not bureaucracy, but clarity.

## Done when

- Every unit of work starts as a spec (not a board item, not a chat message, not a TODO)
- Specs move through four states: Draft → Approved → Building → Done
- State transitions are visible in the stream
- Agents can autonomously build from Approved specs
- The planner reads specs, not board items
- A human can see all specs and their states at a glance
- Specs are files, not database rows — portable, diffable, version-controlled

## The four states

### Draft

The spec exists but isn't ready to build. Missing details, open questions, no done-when criteria, or just an idea that needs refinement.

**Who creates drafts:**
- The human (dumps an idea, agent specs it)
- The Creator (identifies a pattern gap, writes a spec)
- Any agent (discovers a need during work, writes a spec for later)

**What a draft must have:**
- `## What` — one paragraph minimum
- `## Why` — one sentence minimum
- `> Status: Draft`

**What a draft may lack:**
- Done-when criteria
- Architecture details
- Dependency list
- Open questions resolved

**Transition to Approved:** Human says "approve" or "build this" or "yes." That's it. No committee. No review board. One human, one decision.

### Approved

The spec is ready to build. Done-when criteria are clear. Dependencies are identified. An agent can pick it up and execute.

**What Approved requires (in addition to Draft):**
- `## Done when` — specific, testable criteria
- `## Depends on` — other specs this needs (or "none")
- All open questions either resolved or explicitly deferred
- `> Status: Approved`

**Who approves:**
- The human. Only. Agents can suggest approval ("This draft looks ready — approve?") but cannot self-approve.

**What happens on approval:**
- Spec file updated: status line changes to Approved
- Stream event: `✨ 🔧 spec approved: stream-spec.md`
- Planner picks it up on next sense phase
- If auto-build is enabled, agents can start building immediately

### Building

An agent is actively working on this spec. Code is being written. Tests are being run. The spec is in progress.

**Transition to Building:** Automatic — when the planner assigns the spec to an agent and work begins.

**What happens during Building:**
- Spec file updated: `> Status: Building`
- Stream shows build activity linked to this spec
- Agent references done-when criteria as acceptance tests
- Multiple agents can build from the same spec (parallel work on different criteria)

**Stuck detection:** If a spec stays in Building for longer than expected (no progress events in N ticks), the brain flags it:
- Stream: `🟠 🔧 spec stalled: stream-spec.md (no progress in 2 hours)`
- Joy impact: stalled specs contribute to work pain

### Done

All done-when criteria are met. The spec is complete.

**Transition to Done:** Agent declares done when all criteria pass. Human can also manually mark done.

**What happens:**
- Spec file updated: `> Status: Done (date)`
- Stream event: `✨ 💚 spec done: stream-spec.md`
- Joy delta: positive (creation detected)
- Spec stays in the notes directory — it's documentation now, not a task

**Done is not deleted.** A done spec is a record of what was built and why. It becomes reference material. Future specs can `Depends on` completed specs.

## Spec file format

Every spec is a markdown file in `brain/knowledge/notes/` with a consistent structure:

```markdown
# [Name] — Spec

> Status: Draft (date)
> Origin: "The sentence that started this."
> Depends on: other-spec.md, another-spec.md

## What

[One paragraph: what is this thing]

## Why

[One paragraph: why does it matter]

## Done when

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## [Detail sections as needed]

## Open questions

1. Question 1
2. Question 2
```

**Required sections:** What, Why, Status line.
**Required for Approved:** Done when.
**Optional:** Origin quote, Depends on, Architecture, Open questions, any other detail sections.

The format is simple enough to write in 2 minutes and structured enough for an agent to parse programmatically.

## Spec and the planner

The planner's job changes from "read the board" to "read the specs":

```
Sense phase:
  → Scan brain/knowledge/notes/*-spec.md
  → Parse status from each spec
  → Identify: Approved specs (ready to build)
  → Identify: Building specs (check progress)
  → Identify: Stalled specs (flag for attention)

Work phase:
  → For each Approved spec:
    → Read done-when criteria
    → Assess: can an agent build this now?
    → If yes: spawn agent with spec as context
    → If no: note blocker, move to next
  → For each Building spec:
    → Check agent progress against criteria
    → If stalled: flag in stream

Joy phase:
  → Count: specs completed this tick
  → Count: specs stalled
  → Delta: net progress on spec portfolio
```

## Spec and the stream

Spec lifecycle events appear in the stream with their own emoji + nudge:

```
💜 🔧 14:32:07  spec created: bond-handshake-spec.md (Draft)
✨ 🔧 14:35:12  spec approved: bond-handshake-spec.md
🟢 ⚡ 14:35:15  building: bond-handshake-spec.md (agent spawned)
🔵 ⚡ 14:40:00  progress: bond-handshake-spec.md (3/5 criteria met)
🟠 🔧 16:00:00  stalled: bond-handshake-spec.md (no progress in 2h)
✨ 💚 16:15:00  spec done: bond-handshake-spec.md (5/5 criteria)
```

## Spec and the host

At the host level (multi-agent view), the spec tracker replaces the board:

```
┌─────────────────────────────────────────────┐
│  Spec Tracker                               │
├──────────────┬──────────────┬───────────────┤
│ Draft (3)    │ Approved (2) │ Building (1)  │
│              │              │               │
│ guest-auth   │ posture-sys  │ stream-ui     │
│ pain-signal  │ calibration  │   3/5 done    │
│ vault-ledger │              │   agent: Dash │
│              │              │               │
├──────────────┴──────────────┴───────────────┤
│ Done (14)                        [expand ▾] │
└─────────────────────────────────────────────┘
```

Three columns. Kanban-shaped but spec-driven. Done specs collapse by default — they're the archive.

## Spec dependencies

Specs can depend on other specs. The planner respects dependencies:

```
feed-business-model-spec.md
  Depends on: the-fields-spec.md (Done), runcore-sh-spec.md (Building)
  → Cannot start building until runcore-sh-spec.md is Done
```

Circular dependencies are a spec bug, not a system feature. The planner flags them:
```
🔴 ⚠️ circular dependency: spec-a depends on spec-b depends on spec-a
```

## The principle

A spec is a promise with criteria. "I will build this, and here's how you'll know it's done." The lifecycle makes that promise visible, trackable, and accountable. No more vague cards on a board that nobody reads. No more half-finished features that nobody remembers starting.

The board was a junk drawer. Specs are blueprints. The lifecycle is the construction schedule. Together they replace ad-hoc planning with structured intention.

## Open questions

1. **Spec ownership** — Does each spec have an assigned agent? Or does the planner assign dynamically?
2. **Spec priority** — How does the planner choose between multiple Approved specs? First-in? Dependencies? Human priority signal?
3. **Spec splitting** — Can a large spec be split into sub-specs? Or should large specs be rewritten as multiple smaller specs?
4. **Spec rejection** — Can an Approved spec go back to Draft? What triggers that?
5. **Spec versioning** — When a Done spec needs changes, is it a new spec or a version of the old one?
