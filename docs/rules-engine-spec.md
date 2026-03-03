# Rules Engine Spec

Dash needs a way to react to events and run actions automatically — without a human in the chat loop. The rules engine is the missing connective tissue between the board, agents, goals, and vault.

## Design principles

- **File-first.** Rules live in `brain/rules/` as YAML. No database, no UI builder.
- **Append-only audit.** Every rule execution is logged to `brain/rules/executions.jsonl`.
- **Fail-safe.** A broken rule never crashes the server. Rules that fail repeatedly get disabled automatically.
- **Progressive disclosure.** The engine loads the rule index, not every rule file. Individual rules are read on-demand when their trigger fires.

---

## 1. Rule types

### Reactive rules

Fire in response to an event. The engine evaluates conditions against the event payload and runs actions if matched.

```yaml
# brain/rules/on-task-done-notify.yaml
type: reactive
trigger: board:state-changed
conditions:
  - field: newState
    op: eq
    value: done
  - field: assignee
    op: eq
    value: dash
actions:
  - type: notify
    message: "Task {{identifier}} ({{title}}) completed by Dash."
  - type: log-activity
    source: rules
    summary: "Auto-notified on {{identifier}} completion."
```

### Scheduled rules

Fire on a cron-like schedule. No event payload — conditions evaluate against current system state (board contents, goal progress, time of day).

```yaml
# brain/rules/daily-standup.yaml
type: scheduled
schedule: "0 9 * * 1-5"   # weekdays at 9am
conditions: []              # always fire
actions:
  - type: spawn-agent
    prompt: >
      Review today's board. Summarize what's in progress,
      what's blocked, and what should be prioritized.
    label: daily-standup
    timeout: 120000
```

### Chained rules

Not a separate type — any rule can reference other rules in its actions via `emit`. This lets you compose pipelines without coupling rules to each other.

```yaml
actions:
  - type: emit
    event: custom:standup-complete
    payload:
      summary: "{{result}}"
```

---

## 2. Event system

### Event shape

Every event flowing through the engine has this structure:

```typescript
interface RuleEvent {
  type: string;           // namespaced: "board:state-changed"
  timestamp: string;      // ISO 8601
  payload: Record<string, unknown>;
  source: string;         // originating module: "board", "agent", "goal", "sync", "rules"
  correlationId?: string; // trace through chained rules
}
```

### Built-in events

These are emitted by existing systems. The rules engine subscribes to them — it does not modify the emitting code beyond adding a single `emitRuleEvent()` call at each hook point.

| Event | Source | Payload | Hook point |
|-------|--------|---------|------------|
| `board:state-changed` | board | `{ taskId, identifier, title, oldState, newState, assignee, priority }` | `QueueBoardProvider.updateIssue()` |
| `board:task-created` | board | `{ taskId, identifier, title, state, priority, assignee }` | `QueueBoardProvider.createIssue()` |
| `board:exchange-added` | board | `{ taskId, identifier, author, body, source }` | `QueueStore.addExchange()` |
| `agent:completed` | agent | `{ taskId, label, exitCode, resultSummary, origin, sessionId }` | Agent exit handler in `spawn.ts` |
| `agent:failed` | agent | `{ taskId, label, exitCode, error, origin, sessionId }` | Agent exit handler in `spawn.ts` |
| `agent:batch-complete` | agent | `{ sessionId, taskIds, results[] }` | `onBatchComplete` callback |
| `goal:action-taken` | goal | `{ goalId?, action, message }` | `runGoalCheck()` return |
| `sync:completed` | sync | `{ pushed, pulled, errors, authFailed }` | `syncWithLinear()` return |
| `sync:auth-failed` | sync | `{ provider }` | Sync push phase auth check |
| `vault:key-changed` | vault | `{ name, action: "set" \| "delete" }` | `setVaultKey()` / `deleteVaultKey()` |
| `system:startup` | server | `{ timestamp }` | Server init complete |
| `custom:*` | rules | User-defined payload | `emit` action in any rule |

### Custom events

Rules can emit events with the `custom:` prefix. This is how chained rules communicate. Custom events go through the same condition-matching pipeline as built-in events.

---

## 3. Rule syntax

### File format

Each rule is a single YAML file in `brain/rules/`. Filename is the rule ID (e.g., `on-task-done-notify.yaml` → rule ID `on-task-done-notify`).

```yaml
# Required
type: reactive | scheduled
actions: [...]

# Required for reactive
trigger: <event-type>

# Required for scheduled
schedule: <cron-expression>

# Optional
conditions: [...]
priority: 0-100           # default: 50
enabled: true | false      # default: true
cooldown: 60               # seconds, default: 0 (no cooldown)
maxFailures: 3             # auto-disable after N consecutive failures, default: 5
description: "Human-readable explanation"
tags: [board, notifications]
```

### Rule index

`brain/rules/_index.yaml` is an auto-generated manifest listing all rules, their type, trigger/schedule, enabled status, and last execution time. The engine rebuilds this on startup by scanning `brain/rules/*.yaml`. This avoids reading every rule file on every event.

```yaml
# brain/rules/_index.yaml (auto-generated, do not edit)
rules:
  - id: on-task-done-notify
    type: reactive
    trigger: board:state-changed
    enabled: true
    priority: 50
    lastExecuted: "2026-02-27T14:30:00Z"
  - id: daily-standup
    type: scheduled
    schedule: "0 9 * * 1-5"
    enabled: true
    priority: 50
    lastExecuted: "2026-02-27T09:00:00Z"
```

### Conditions

Conditions are evaluated top-to-bottom. All must pass (implicit AND). For OR logic, create separate rules.

```yaml
conditions:
  - field: <dotpath>      # dot-path into event payload or state
    op: <operator>
    value: <target>
```

**Operators:**

| Op | Meaning | Example |
|----|---------|---------|
| `eq` | Equals | `{ field: state, op: eq, value: done }` |
| `neq` | Not equals | `{ field: assignee, op: neq, value: null }` |
| `in` | Value in list | `{ field: state, op: in, value: [done, cancelled] }` |
| `gt`, `gte`, `lt`, `lte` | Numeric comparison | `{ field: priority, op: gte, value: 2 }` |
| `contains` | String contains | `{ field: title, op: contains, value: urgent }` |
| `matches` | Regex match | `{ field: label, op: matches, value: "^deploy-" }` |
| `exists` | Field is present and non-null | `{ field: resultSummary, op: exists }` |

**State queries** (for scheduled rules that need current state, not event payloads):

```yaml
conditions:
  - field: board.count(state=in_progress)
    op: gt
    value: 5
  - field: board.any(state=todo, priority=1)
    op: eq
    value: true
```

State query functions:

| Function | Returns | Example |
|----------|---------|---------|
| `board.count(filters)` | Number of matching tasks | `board.count(state=in_progress)` |
| `board.any(filters)` | Boolean: any task matches | `board.any(assignee=dash, state=todo)` |
| `board.oldest(filters)` | Age in hours of oldest match | `board.oldest(state=in_progress)` |
| `goals.progress(id)` | Current/target ratio (0–1) | `goals.progress(kr-1)` |

### Actions

Actions execute in order. If one fails, subsequent actions still run (fail-open per action, not per rule). Failures are logged.

```yaml
actions:
  - type: <action-type>
    # action-specific fields
```

**Action types:**

| Type | Fields | Effect |
|------|--------|--------|
| `notify` | `message` | Push to goal notification queue (shown next chat turn) |
| `log-activity` | `source`, `summary`, `detail?` | Append to activity log |
| `log-memory` | `memoryType`, `content`, `tags?` | Append to LTM (episodic/semantic/procedural) |
| `spawn-agent` | `prompt`, `label`, `timeout?` | Submit agent task via `submitTask()` |
| `update-board` | `taskId`, `changes` | Update a board issue (state, priority, assignee) |
| `create-board` | `title`, `description?`, `state?`, `priority?` | Create a board issue |
| `emit` | `event`, `payload?` | Emit a custom event (for chaining) |
| `set-setting` | `key`, `value` | Update a Dash setting |
| `webhook` | `url`, `method?`, `body?`, `headers?` | HTTP request (respects airplane mode) |
| `call` | `message` | Twilio call to user (emergency escalation) |

### Template syntax

String fields in actions support `{{mustache}}` interpolation from the event payload.

```yaml
message: "Task {{identifier}} moved to {{newState}} by {{assignee}}"
```

Built-in variables available in all templates:

| Variable | Value |
|----------|-------|
| `{{now}}` | Current ISO timestamp |
| `{{ruleId}}` | ID of the executing rule |
| `{{eventType}}` | The event type that triggered this rule |

---

## 4. Execution engine

### Architecture

```
┌─────────────┐     emitRuleEvent()      ┌──────────────┐
│  Board       │ ──────────────────────►  │              │
│  Agents      │                          │  Event Bus   │
│  Goals       │                          │  (in-memory) │
│  Sync        │                          │              │
│  Vault       │                          └──────┬───────┘
└─────────────┘                                  │
                                                 │ fan-out to matching rules
                                                 ▼
                                    ┌────────────────────────┐
                                    │  Rules Engine          │
                                    │                        │
                                    │  1. Load _index.yaml   │
                                    │  2. Filter by trigger  │
                                    │  3. Sort by priority   │
                                    │  4. For each match:    │
                                    │     a. Load rule YAML  │
                                    │     b. Eval conditions  │
                                    │     c. Check cooldown   │
                                    │     d. Execute actions  │
                                    │     e. Log execution    │
                                    └────────────────────────┘
```

### Module: `src/rules/engine.ts`

```typescript
interface RulesEngine {
  // Lifecycle
  start(): Promise<void>;          // Load index, start scheduler
  stop(): void;                    // Stop scheduler, flush pending

  // Event ingestion
  handleEvent(event: RuleEvent): Promise<ExecutionResult[]>;

  // Management
  reloadIndex(): Promise<void>;    // Re-scan brain/rules/
  enableRule(id: string): void;
  disableRule(id: string): void;
  getStatus(): EngineStatus;       // Active rules, last executions, failures
}
```

### Event bus: extend RuntimeBus

The agent runtime already has `RuntimeBus` (`src/agents/runtime/bus.ts`) — a typed pub/sub emitter with correlation IDs. Rather than creating a new bus, the rules engine subscribes to a shared bus instance that all modules publish to.

```typescript
// src/rules/bus.ts — thin wrapper
import { createBus } from "../agents/runtime/bus";

// Single shared bus for the entire server
export const eventBus = createBus();

// Helper used by board, agents, goals, etc.
export function emitRuleEvent(event: RuleEvent): void {
  eventBus.emit("rule-event", event);
}
```

Each source module gets a one-line addition:

```typescript
// In QueueBoardProvider.updateIssue(), after the store.update() call:
emitRuleEvent({
  type: "board:state-changed",
  timestamp: new Date().toISOString(),
  payload: { taskId, identifier, title, oldState, newState, assignee, priority },
  source: "board",
});
```

### Scheduled rule execution

A single `setInterval` loop runs every 60 seconds. On each tick:

1. Read current time.
2. For each scheduled rule in the index, check if `schedule` matches current minute (cron evaluation).
3. If matched and not in cooldown, load the rule, evaluate conditions (state queries), execute actions.

Use a lightweight cron parser (or inline one — the subset needed is small: minute, hour, day-of-month, month, day-of-week).

### Execution flow (reactive)

```
Event arrives via emitRuleEvent()
  │
  ├─ Filter _index: rules where trigger === event.type AND enabled === true
  ├─ Sort by priority (highest first, 100 → 0)
  │
  └─ For each matching rule:
       ├─ Check cooldown (skip if last execution < cooldown seconds ago)
       ├─ Load full YAML from brain/rules/{id}.yaml
       ├─ Evaluate conditions against event.payload
       │    └─ All must pass (short-circuit on first failure)
       ├─ If conditions pass:
       │    ├─ Execute actions sequentially
       │    ├─ Log to executions.jsonl
       │    ├─ Update _index lastExecuted
       │    └─ Reset consecutive failure count
       └─ If conditions fail: skip (no log entry)
```

### Error handling

- **Action failure**: Log the error, continue to next action. Increment rule's `consecutiveFailures`.
- **Condition evaluation error** (bad field path, type mismatch): Treat as condition-not-met. Log warning.
- **Rule file missing/unparseable**: Log error, disable rule in index, continue.
- **Auto-disable**: After `maxFailures` consecutive failures (default 5), set `enabled: false` in index. Log a notification so the user sees it next chat turn.
- **Infinite loop guard**: Track event chain depth via `correlationId`. If an `emit` action would exceed depth 10, abort and log.

---

## 5. Priority and conflict resolution

### Priority levels

Rules have a `priority` field (0–100, default 50). Higher priority rules execute first.

| Range | Intended use | Example |
|-------|-------------|---------|
| 90–100 | Safety / circuit breakers | "If 3+ agents failed in 5 min, pause all spawning" |
| 70–89 | Escalation | "If P1 task idle >2 hours, notify via call" |
| 50–69 | Standard automation | "On task done, log activity" |
| 30–49 | Convenience | "On new task, add default labels" |
| 0–29 | Background / analytics | "On any event, update weekly stats" |

### Conflict resolution

Rules don't block each other. Multiple rules can fire on the same event, and they all run. There is no mutex or exclusive execution.

**When you need mutual exclusion**, use cooldown + conditions:

```yaml
# Rule A: high priority, sets a board field
priority: 80
actions:
  - type: update-board
    taskId: "{{taskId}}"
    changes: { assignee: dash }

# Rule B: lower priority, only fires if not already assigned
priority: 40
conditions:
  - field: assignee
    op: eq
    value: null
```

Because Rule A runs first (higher priority) and updates the board, by the time Rule B's conditions are evaluated the assignee is no longer null — so Rule B skips naturally.

### Same-priority ordering

Rules with the same priority execute in alphabetical order by rule ID. This is deterministic and predictable.

---

## 6. Integration points

### Board (`src/board/`, `src/queue/`)

**Emits:**
- `board:state-changed` — from `QueueBoardProvider.updateIssue()` when state field changes
- `board:task-created` — from `QueueBoardProvider.createIssue()`
- `board:exchange-added` — from `QueueStore.addExchange()`

**Receives (via actions):**
- `update-board` action calls `provider.updateIssue()`
- `create-board` action calls `provider.createIssue()`

**Hook location**: `src/queue/provider.ts` — add `emitRuleEvent()` calls in `createIssue()` and `updateIssue()`.

### Agents (`src/agents/`)

**Emits:**
- `agent:completed` / `agent:failed` — from the exit handler in `spawn.ts`
- `agent:batch-complete` — from `onBatchComplete` callback

**Receives:**
- `spawn-agent` action calls `submitTask()` from `src/agents/spawn.ts`

**Hook location**: `src/agents/spawn.ts` — add `emitRuleEvent()` in the process exit handler, after `rememberTaskOutcome()`.

### Goals (`src/goals/`)

**Emits:**
- `goal:action-taken` — from `runGoalCheck()` in `loop.ts` after executing the LLM decision

**Receives:**
- `notify` action pushes to `pushNotification()` (same queue goals use)

**Hook location**: `src/goals/loop.ts` — add `emitRuleEvent()` after the action switch block.

### Vault (`src/vault/`)

**Emits:**
- `vault:key-changed` — from `setVaultKey()` and `deleteVaultKey()`

**Receives:** None directly. But rules can react to key changes — e.g., restart sync timer when `LINEAR_API_KEY` is set.

**Hook location**: `src/vault/store.ts` — add `emitRuleEvent()` at end of `setVaultKey()` and `deleteVaultKey()`.

### Sync (`src/queue/sync.ts`, `src/queue/timer.ts`)

**Emits:**
- `sync:completed` — from `syncWithLinear()` return path
- `sync:auth-failed` — from sync push phase when auth fails

**Receives:** None directly, but rules can trigger sync via `emit` → custom event → rule that calls the trigger endpoint.

**Hook location**: `src/queue/sync.ts` — add `emitRuleEvent()` before returning the sync result.

### Server (`src/server.ts`)

**Emits:**
- `system:startup` — at end of server initialization

**Wiring:**
- Import `RulesEngine`, create instance during startup
- Call `engine.start()` after all providers are initialized
- Subscribe `engine.handleEvent` to the shared event bus
- Add routes:
  - `GET /api/rules` — list all rules (from index)
  - `GET /api/rules/:id` — read rule YAML
  - `PUT /api/rules/:id/enable` — enable/disable
  - `GET /api/rules/executions` — recent execution log
  - `POST /api/rules/test` — dry-run: evaluate conditions against a mock event, return what would fire

---

## File layout

```
brain/rules/
  _index.yaml              # Auto-generated manifest
  executions.jsonl          # Append-only execution log
  on-task-done-notify.yaml  # Example reactive rule
  daily-standup.yaml        # Example scheduled rule
  escalate-stale-p1.yaml    # Example: P1 idle >2h → call

src/rules/
  engine.ts                 # RulesEngine class
  bus.ts                    # Shared event bus + emitRuleEvent helper
  conditions.ts             # Condition evaluator (operators, state queries)
  actions.ts                # Action executor (dispatch by type)
  scheduler.ts              # Cron tick loop for scheduled rules
  loader.ts                 # YAML loading, validation, index rebuild
  types.ts                  # RuleEvent, RuleDefinition, ExecutionResult
```

## Execution log schema

```jsonl
{"_schema":"rule-execution","_version":"1.0"}
{"ruleId":"on-task-done-notify","event":"board:state-changed","timestamp":"2026-02-27T14:30:00Z","conditionsPassed":true,"actionsRun":["notify","log-activity"],"errors":[],"durationMs":12,"correlationId":"evt_abc123"}
```

---

## Example rules

### Escalate stale P1 tasks

```yaml
# brain/rules/escalate-stale-p1.yaml
type: scheduled
schedule: "0 */2 * * *"    # every 2 hours
description: "Alert if any P1 task has been in_progress for over 4 hours"
priority: 75
conditions:
  - field: board.oldest(state=in_progress, priority=1)
    op: gt
    value: 4
actions:
  - type: notify
    message: "A P1 task has been in-progress for over 4 hours. Review the board."
  - type: log-activity
    source: rules
    summary: "Stale P1 escalation triggered"
```

### Auto-assign new tasks to Dash

```yaml
# brain/rules/auto-assign-triage.yaml
type: reactive
trigger: board:task-created
description: "Assign unassigned triage tasks to Dash for review"
priority: 40
conditions:
  - field: assignee
    op: eq
    value: null
  - field: state
    op: eq
    value: triage
actions:
  - type: update-board
    taskId: "{{taskId}}"
    changes:
      assignee: dash
  - type: spawn-agent
    label: "triage-{{identifier}}"
    prompt: "Review task {{identifier}}: {{title}}. Estimate priority (1-4) and suggest next steps."
    timeout: 60000
```

### Pause agents on repeated failures

```yaml
# brain/rules/circuit-breaker.yaml
type: reactive
trigger: agent:failed
description: "If 3+ agents fail in 5 minutes, notify immediately"
priority: 95
cooldown: 300
conditions: []
actions:
  - type: notify
    message: "Circuit breaker: agent {{label}} failed (exit {{exitCode}}). Multiple recent failures detected — review agent health."
  - type: log-activity
    source: rules
    summary: "Agent circuit breaker triggered for {{label}}"
```

### React to Linear API key being added

```yaml
# brain/rules/on-linear-key-set.yaml
type: reactive
trigger: vault:key-changed
description: "Trigger sync when Linear API key is set"
priority: 60
conditions:
  - field: name
    op: eq
    value: LINEAR_API_KEY
  - field: action
    op: eq
    value: set
actions:
  - type: notify
    message: "Linear API key updated. Sync will start on next timer tick."
  - type: log-activity
    source: rules
    summary: "LINEAR_API_KEY changed, sync will resume"
```
