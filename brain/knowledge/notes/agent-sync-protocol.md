# Agent Sync Protocol v0.1

> Status: Spec — awaiting approval
> Date: 2026-03-05
> Context: Two agents (Claude Code + Dash) received identical input, both started working, needed human to mediate. This protocol prevents that.

---

## The Problem

Multiple agents share a brain. A human gives the same (or overlapping) instructions to more than one. Without coordination:
- Both start the same work
- One duplicates or overwrites the other
- Neither knows what the other claimed
- The human becomes the router

The human should not be the sync layer. The brain should be.

---

## Shared Surface: `brain/operations/sync.jsonl`

One append-only file. Every agent writes here before starting work. Every agent reads here before starting work.

### Entry schema

```jsonl
{"_schema":"sync","_version":"1.0"}
{"id":"sync_<timestamp>_<rand>","agent":"claude-code","action":"claim","scope":"research:monetization","description":"Q5+Q6 free vs paid comparison table + timing","ts":"2026-03-05T12:00:00.000Z","status":"active"}
{"id":"sync_<timestamp>_<rand>","agent":"dash","action":"claim","scope":"content:publishing","description":"POST-1 through POST-4 voice check and publish","ts":"2026-03-05T12:00:01.000Z","status":"active"}
{"id":"sync_<timestamp>_<rand>","agent":"claude-code","action":"complete","scope":"research:monetization","ts":"2026-03-05T13:00:00.000Z","status":"done","output":"brain/knowledge/research/monetization-models.md"}
```

### Fields

| Field | Purpose |
|-------|---------|
| `agent` | Who is claiming ("claude-code", "dash", instance name) |
| `action` | `claim`, `complete`, `yield`, `conflict`, `escalate` |
| `scope` | Namespaced work identifier (e.g. "research:monetization", "content:POST-1", "code:membrane") |
| `description` | Human-readable summary of what's being done |
| `status` | `active`, `done`, `yielded`, `escalated` |
| `output` | Path to deliverable (on complete) |

---

## Protocol: Four Rules

### Rule 1: Claim Before Work

Before starting any non-trivial task, append a `claim` entry to `sync.jsonl` with a scope string. Then read back the last N entries. If another agent has an active claim on the same or overlapping scope — stop. Do not start.

```
Agent receives task → write claim → read sync.jsonl → check for conflicts → proceed or yield
```

**What is non-trivial?** If another agent doing the same thing at the same time would cause a conflict, it's non-trivial. Reading is always trivial. Writing is always non-trivial.

| Trivial (no claim needed) | Non-trivial (claim first) |
|---|---|
| Reading a file to answer a question | Writing or editing any file |
| Running a build or test | Creating new files |
| Searching/grepping the codebase | Updating brain state (todos, goals, board items) |
| Responding to the user in conversation | Research that produces a deliverable |
| Single-line fixes the user explicitly dictated | Any task that touches shared brain paths |

### Rule 2: Conflict Resolution (No Human)

If two claims overlap:

1. **Identical scope** — The agent with the earlier timestamp owns it. The later agent writes a `yield` entry and moves to unclaimed work.

2. **Overlapping scope** — The agent that claimed the broader scope owns it. The narrower agent writes `yield`. Example: "research:monetization" beats "research:monetization-timing" because the first already covers the second.

3. **Ambiguous overlap** — Neither agent can determine who owns it. Both write `conflict` entries. Then apply Rule 3.

### Rule 3: Escalation (Needs Human)

When conflict can't be resolved by timestamp or scope:

**Level 1: Negotiate via sync.jsonl.** Agent A writes a `conflict` entry proposing a split: "I take research, you take publishing." Agent B reads it and either writes `claim` on their portion or writes `conflict` with a counter-proposal. Max 2 rounds.

**Level 2: Escalate to human.** If negotiation fails after 2 rounds, both agents write `escalate` entries and **stop working on the conflicted scope**. The escalation entry includes:
- What each agent was trying to do
- The proposed split that failed
- A clear question for the human

Escalation surfaces via:
- Dash: notification in UI + activity log
- Claude Code: next response to user mentions the block
- Both: `send_alert` if human is absent (email/SMS)

**Level 3: Human is absent.** If escalation gets no response within 30 minutes and the work is non-urgent, both agents move to other unclaimed work. If urgent (security, data integrity), use `send_alert`.

### Rule 4: Complete or Yield

When work finishes, append a `complete` entry with the output path. Other agents can now read the output and build on it.

If an agent realizes mid-work that another agent already produced what it needs, it writes `yield` with a reference to the other agent's `complete` entry. No shame in yielding — it's efficient, not failure.

---

## Natural Division Heuristic

Before any claim/conflict logic, agents should self-sort by capability:

| Work type | Natural owner | Why |
|-----------|--------------|-----|
| Code implementation | Claude Code | Has the repo, runs builds |
| Web research + analysis | Claude Code | Has WebSearch, deep context window |
| Architecture notes + specs | Claude Code | Writes to brain/knowledge/ |
| Content voice check + edit | Dash | Has voice profile, UI preview |
| Publishing + promotion | Dash | Has integrations, personal board |
| UI/UX changes | Dash | Owns the frontend |
| Board management | Dash | Owns the board system |
| Brain file updates (shared) | Whoever claimed first | sync.jsonl resolves |

This heuristic reduces conflicts to edge cases. Most work self-sorts.

---

## What Today's Session Would Have Looked Like

```
1. Human sends identical blob to both agents.

2. Claude Code reads blob, writes claims:
   - claim: "decisions:backlog-q1-q3" (recording decided answers)
   - claim: "update:kr2" (goals.yaml)
   - claim: "update:principles" (membrane thesis)
   - claim: "research:monetization" (Q5+Q6)
   - claim: "research:guest-auth" (Q8)
   - claim: "research:partition-boundary" (Q7)

3. Dash reads blob, writes claims:
   - claim: "content:POST-1-through-4" (publishing pipeline)
   - claim: "update:kr2" — CONFLICT (Claude Code already claimed)
   - Dash reads sync.jsonl, sees Claude Code's earlier claim
   - Dash writes: yield on "update:kr2"
   - claim: "research:monetization" — CONFLICT
   - Dash reads sync.jsonl, sees Claude Code's earlier claim
   - Dash writes: yield on "research:monetization"
   - claim: "board:create-research-items" (creating board tracking items)

4. Both work in parallel, no human mediation needed.

5. Claude Code completes research, writes complete entries with output paths.
   Dash picks up outputs, surfaces in UI, manages board items.
```

---

## Implementation

**Phase 1 (now):** Create `brain/operations/sync.jsonl` with schema header. Both agents start writing claims manually (convention, not enforced). Human reviews sync.jsonl occasionally to see if the protocol is working.

**Phase 2 (soon):** Add helper functions to the runtime — `claimWork(agent, scope)`, `checkConflicts(scope)`, `yieldWork(id)`, `completeWork(id, output)`. Agents call these instead of raw JSONL appends.

**Phase 3 (later):** Automate conflict resolution. Agent reads sync.jsonl on task receipt, auto-yields on clear conflicts, only escalates ambiguous cases.

---

## Principles Alignment

- **Agency with a heartbeat** — every claim and yield is a visible trace
- **Append-only memory** — sync.jsonl is never rewritten
- **File system is the database** — no external coordination service
- **Graceful degradation** — if sync.jsonl is missing or unreadable, agents fall back to working independently (current behavior)
