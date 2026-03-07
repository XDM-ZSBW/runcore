# Board Retirement — Spec

> Status: Draft (2026-03-07)
> Origin: "We have outgrown the board."
> Depends on: stream-spec.md, ui-layers-spec.md, core-os-spec.md

## What

The board is retired as a UI surface and as the organizing principle. Specs replace it as the source of work. The stream replaces it as the source of visibility. Chat replaces it as the place for async questions. The internal task queue survives as plumbing — the planner still needs a queue to assign agent work — but it's invisible infrastructure, not a view.

## Why

The board was the brain before the brain existed. It held todos, specs, status, handoffs, roadmap items, personal notes, and async questions — because there was nothing else. Now there is something else for each of those jobs, and the board is doing all of them poorly.

Symptoms:
- Stale items nobody clears (publish posts sitting for days)
- Duplicate entries from multiple sync writes
- Planner can't see specs because they're not board items
- Personal board items that belong in chat
- Status information that belongs in the stream
- Roadmap items that belong in specs

The board is a general-purpose surface in a system that now has specific-purpose surfaces. General purpose means no purpose.

## Done when

- No board UI exists at agent level
- No board UI exists at host level (replaced by spec tracker + stream)
- Specs drive all planned work — planner reads specs, breaks into tasks, spawns agents
- The internal task queue (`queue.jsonl`) remains as agent planner infrastructure
- Chat handles all async human-to-agent communication
- Stream handles all visibility into agent activity
- Zero user-facing workflow references "the board"
- Existing board items are migrated or archived

## What the board was doing → what replaces it

| Board function | Replacement | How |
|---|---|---|
| Todo tracking | Spec → planner → agent tasks | Specs have "Done when." Planner reads specs, creates tasks automatically. No manual todo entry. |
| Status display | Stream + pulse dots | Watch the stream for real-time. Glance at dots for aggregate. No board to check. |
| Async questions for human | Chat thread | Agent asks in chat. Human answers in chat. The conversation IS the board. |
| Cross-agent handoffs | Sync protocol | `notifications.jsonl` + `sync.jsonl`. Agents talk to agents through the protocol, not board items. |
| Roadmap / milestones | Spec "Done when" criteria | Each spec defines completion. Progress is visible in the stream. The specs ARE the roadmap. |
| Personal items | Chat with agent | "Remind me to call Dad" → chat. Not a board pin. The agent holds it in memory. |
| Collision detection | Still happens — on specs, not board items | Agents read specs from both sides of a tunnel, detect conflicts in approach. Same collision logic, different input. |
| Host-level overview | Spec tracker at host level | Which specs are Draft, Approved, Building, Done. That's the host's roadmap. |

## The spec lifecycle (replaces the board lifecycle)

```
Draft → Approved → Building → Done
  │                    │
  │                    └── Planner reads spec
  │                        Breaks into agent tasks
  │                        Agents build
  │                        "Done when" criteria checked
  │                        Spec marked Done
  │
  └── Written by architect (Core/human)
      Reviewed in chat
      Approved by human
```

The spec file itself tracks its status. Line 2 of every spec: `> Status: Draft (date)`. The planner reads this. No separate tracking system. The spec is the tracking system.

| Status | Meaning | Who changes it |
|---|---|---|
| Draft | Written, not yet approved | Architect writes it |
| Approved | Human said build it | Human approves in chat |
| Building | Planner has assigned agent tasks | Planner updates automatically |
| Done | All "Done when" criteria met | Agent or human marks complete |
| Retired | Superseded by another spec | Architect retires it |

## Migration — what happens to existing board items

### `queue.jsonl` (operational board)

- Items with clear "Done when" → become specs if big enough, or planner tasks if small
- Stale items (untouched 7+ days) → archived
- Items that are really questions → moved to chat
- Items that are really status → they'll appear in the stream naturally

### `queue-personal.jsonl` (personal board)

- Archived entirely (already done for publish items)
- Personal items belong in chat: "Hey Dash, remind me about X"
- If the human wants persistent personal items, that's memory — `brain/memory/experiences.jsonl`

### Board views in Dash UI

- `board.html` → removed
- `personal-board.html` → removed
- `/api/board/*` routes → deprecated, then removed
- Board provider (`src/board/`) → stays as internal task queue infrastructure, loses UI

## The internal task queue (what survives)

The planner still needs a mechanism to:
1. Read available work (now from specs, not board)
2. Create agent tasks with IDs
3. Track task state (pending, in_progress, done, failed)
4. Manage cooldowns and dedup

`queue.jsonl` stays as this mechanism. But it's internal — no human ever sees it. The human sees specs (what to build) and the stream (what's happening). The queue is the conveyor belt inside the factory. You don't put a window on the conveyor belt.

```
Spec (human-visible)
  │
  └── Planner reads spec
        │
        └── Creates tasks in queue.jsonl (internal)
              │
              └── Spawns agents
                    │
                    └── Agent work visible in stream (human-visible)
                          │
                          └── "Done when" checked against spec (human-visible)
```

## What the host sees instead of a board

At host level (ui-layers-spec.md), the board view is replaced by a **spec tracker**:

```
┌─────────────────────────────────────────────────┐
│  Specs                                          │
│                                                 │
│  Building:                                      │
│    ● stream-spec.md ████████░░ 3/5 criteria     │
│    ● nerve-spawn-spec.md ██░░░░░░ 1/6 criteria  │
│                                                 │
│  Approved (waiting):                            │
│    ○ ui-layers-spec.md                          │
│    ○ core-os-spec.md                            │
│                                                 │
│  Draft (needs approval):                        │
│    ◌ feed-business-model-spec.md                │
│    ◌ compost-quality-spec.md                    │
│                                                 │
│  Done:                                          │
│    ✓ privacy-as-membrane-spec.md                │
│    ✓ inter-instance-tunnels.md                  │
└─────────────────────────────────────────────────┘
```

Progress comes from "Done when" criteria in the spec. Each criterion is checkable. The spec tracker reads the spec, counts criteria, checks which are met. No separate progress tracking. The spec tracks itself.

## Open questions

1. **Small tasks** — Not everything deserves a spec. "Fix this bug" is a chat message, not a spec. Where's the line? Answer: if it has "Done when" with more than one criterion, it's a spec. Otherwise it's a chat instruction.
2. **Spec discovery** — Planner scans Core's notes directory. Should specs live in a dedicated `specs/` directory instead of mixed with notes?
3. **Approval flow** — Human approves in chat. How does that update the spec file's status line? Agent writes to the file? Or separate approval log?
4. **Collision detection without board** — The tunnel collision spec reads board items. Needs update to read specs instead. Same logic, different input source.
5. **Community specs** — Can bonded hosts share specs through tunnels? "Here's how I solved X" as a spec that your planner can adopt?
