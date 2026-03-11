# Whiteboard Spec

**Status:** Pass 2 — spec and build
**Surface:** Board posture
**Route:** `/whiteboard` (standalone page), `/api/whiteboard/*` (API)

---

## Overview

The Whiteboard is a shared collaboration surface between human and agent. Work items form a tree — goals branch into tasks, tasks branch into subtasks, and any node can carry a **question** that blocks downstream work until the human answers it.

It is NOT the existing kanban board (`/board`). The board tracks workflow states (icebox → done). The Whiteboard tracks **work structure** — what's in play, what branches from what, and where the agent is stuck. They coexist. A whiteboard item can optionally link to a board task, but most won't.

---

## Data Model

### WhiteboardNode

Stored in `brain/log/whiteboard.jsonl` (append-only).

```typescript
interface WhiteboardNode {
  id: string;                    // "wb_<timestamp>_<8hex>"
  parentId: string | null;       // null = root node
  title: string;                 // Short label: "Plugin wrappers"
  body?: string;                 // Markdown detail (optional)
  type: "goal" | "task" | "question" | "decision" | "note";
  status: "open" | "done" | "archived";
  tags: string[];                // ["engineering", "p1"]
  plantedBy: "agent" | "human";  // Who created it

  // Question-specific
  question?: string;             // The actual question text
  answer?: string;               // Human's response
  answeredAt?: string;           // ISO timestamp

  // Attention weight (computed, not stored — or cached on write)
  weight?: number;               // 0-1, higher = more attention needed

  // Links
  boardTaskId?: string;          // Optional link to QueueTask

  // Timestamps
  createdAt: string;
  updatedAt: string;

  // Append-only lifecycle
  _archived?: boolean;           // Soft delete
}
```

### Weight Calculation

Weight determines visual prominence. Computed on read, not stored:

```
weight = base + age_factor + downstream_factor

base:
  question (unanswered) = 0.6
  task (open)           = 0.2
  goal (open)           = 0.1
  decision (open)       = 0.5
  note                  = 0.0
  anything done         = 0.0

age_factor:
  For unanswered questions: min(0.3, days_since_created * 0.05)
  For everything else: 0

downstream_factor:
  0.03 * count(open descendants blocked by this node)
```

Cap at 1.0. Items with weight > 0.5 get visual emphasis.

---

## Store

`src/whiteboard/store.ts`

Follows the same pattern as `src/queue/store.ts` and `src/files/store.ts`: in-memory Map cache, append-only JSONL, last-occurrence-wins.

```typescript
class WhiteboardStore {
  constructor(brainDir: string)

  // CRUD
  list(filter?: WhiteboardFilter): Promise<WhiteboardNode[]>
  get(id: string): Promise<WhiteboardNode | null>
  create(fields: Omit<WhiteboardNode, "id" | "createdAt" | "updatedAt">): Promise<WhiteboardNode>
  update(id: string, patch: Partial<WhiteboardNode>): Promise<WhiteboardNode | null>
  archive(id: string): Promise<{ ok: boolean; message: string }>

  // Tree operations
  getChildren(parentId: string): Promise<WhiteboardNode[]>
  getSubtree(rootId: string): Promise<WhiteboardNode[]>  // All descendants
  getRoots(): Promise<WhiteboardNode[]>                   // Top-level nodes
  getAncestors(id: string): Promise<WhiteboardNode[]>     // Path to root

  // Questions
  getOpenQuestions(): Promise<WhiteboardNode[]>            // All unanswered questions
  answerQuestion(id: string, answer: string): Promise<WhiteboardNode | null>

  // Attention
  getWeighted(): Promise<Array<WhiteboardNode & { weight: number }>>  // Sorted by weight desc

  // Compaction
  compact(): Promise<{ before: number; after: number }>
}
```

### Filter

```typescript
interface WhiteboardFilter {
  type?: WhiteboardNode["type"];
  status?: WhiteboardNode["status"];
  tags?: string[];
  plantedBy?: "agent" | "human";
  parentId?: string;              // Direct children only
  search?: string;                // Title + body + question + answer
  hasOpenQuestions?: boolean;      // Nodes with unanswered question descendants
}
```

### Storage Path

`brain/log/whiteboard.jsonl`

Schema header:
```json
{"_schema":"whiteboard","version":1,"fields":["id","parentId","title","body","type","status","tags","plantedBy","question","answer","answeredAt","weight","boardTaskId","createdAt","updatedAt"]}
```

---

## API Routes

All routes require `sessionId` query param and gate to `requireSurface("pages")`.

### `GET /api/whiteboard`

List nodes. Query params:
- `view`: `"tree"` (default) | `"flat"` | `"questions"` | `"weighted"`
- `root`: root node ID (subtree view)
- `status`: `"open"` | `"done"` | `"archived"`
- `type`: node type filter
- `tags`: comma-separated tag filter
- `search`: text search

**Tree view** returns nested structure:
```json
{
  "nodes": [
    {
      "id": "wb_...",
      "title": "Engine",
      "type": "goal",
      "status": "open",
      "children": [
        {
          "id": "wb_...",
          "title": "Plugin wrappers",
          "type": "task",
          "status": "done",
          "children": []
        },
        {
          "id": "wb_...",
          "title": "Mesh networking",
          "type": "task",
          "status": "open",
          "children": [
            {
              "id": "wb_...",
              "title": "mDNS or relay-first?",
              "type": "question",
              "status": "open",
              "question": "Should mesh use mDNS discovery or relay-first with mDNS as optimization?",
              "weight": 0.75,
              "children": []
            }
          ]
        }
      ]
    }
  ]
}
```

**Questions view** returns flat list of unanswered questions sorted by weight.

**Weighted view** returns flat list sorted by attention weight descending.

### `POST /api/whiteboard`

Create a node. Body:
```json
{
  "title": "Plugin wrappers",
  "type": "task",
  "parentId": "wb_...",
  "tags": ["engineering"],
  "plantedBy": "human",
  "body": "Wrap Slack, GitHub, Twilio in Plugin interface",
  "question": null
}
```

Returns: the created node with `id`, `createdAt`, `weight`.

### `PATCH /api/whiteboard/:id`

Update a node. Body: partial fields. Cannot change `id`, `createdAt`, `plantedBy`.

### `POST /api/whiteboard/:id/answer`

Answer a question. Body:
```json
{
  "answer": "Relay-first. mDNS is a local optimization, not the foundation."
}
```

Sets `answer`, `answeredAt`, and transitions `status` to `"done"` (questions resolve when answered). Agent can re-open by creating a follow-up question as a child.

### `DELETE /api/whiteboard/:id`

Archives the node (sets `_archived: true, status: "archived"`). Does NOT delete children — they become new roots or get archived too (configurable via `?cascade=true`).

### `GET /api/whiteboard/:id/path`

Returns ancestors from root to this node. For breadcrumb navigation.

### `GET /api/whiteboard/summary`

Dashboard summary:
```json
{
  "total": 47,
  "open": 32,
  "done": 15,
  "openQuestions": 5,
  "topWeighted": [ /* top 3 by weight */ ],
  "byTag": { "engineering": 18, "product": 8, "business": 4, "operations": 2 }
}
```

---

## UI

### Page: `/whiteboard`

Standalone HTML page (like `/board`). Three view modes toggled in the header:

#### Tree View (default)

```
┌──────────────────────────────────────────────────────┐
│  WHITEBOARD          [Tree] [Questions] [Weighted]   │
│                                              [+ New] │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ▼ Engine                                 engineering│
│    ├── ✓ Plugin wrappers                             │
│    ├── ● Mesh networking                             │
│    │   └── ◆ mDNS or relay-first?          ░░░░ 0.75│
│    ├── ○ File lifecycle                              │
│    └── ○ Core-brain shared dep                       │
│                                                      │
│  ▼ Product                                   product │
│    ├── ◆ Whiteboard ← you are here                   │
│    ├── ○ Delegation model                            │
│    └── ● Revocable PDF                               │
│        └── ◆ Gate at Core or viewer?       ░░░░ 0.65│
│                                                      │
│  ▸ Business                                 business │
│  ▸ Operations                            operations  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Node indicators:**
- `▼` / `▸` — collapsible goal/parent (expanded/collapsed)
- `✓` — done
- `●` — open task (has activity)
- `○` — open task (no recent activity)
- `◆` — question (unanswered) — **diamond draws the eye**
- `■` — decision (recorded)

**Weight bar:** Small horizontal bar next to questions, opacity/fill proportional to weight. High-weight items glow subtly (CSS animation, not JS).

**Interactions:**
- Click node → expand inline detail panel (title, body, question, answer box)
- Click question diamond → opens answer input directly (no modal, inline)
- Click `+ New` → inline form at cursor position in tree
- Collapse/expand branches
- Drag to reparent (optional, v2)

#### Questions View

Flat list of unanswered questions, sorted by weight descending. Each shows:
- The question text
- Breadcrumb path (Engine → Mesh networking → ?)
- Weight bar
- Answer input box
- Time since planted

This is the **"walk the field"** view. Human opens it, answers 2-3 questions, closes it. Work gets unstuck.

#### Weighted View

All open items sorted by attention weight. Shows the full field — what's hot, what's cold. Goals and tasks included, not just questions. Good for the human who wants the big picture.

---

## Agent Integration

### MCP Tool: `whiteboard_plant`

The agent uses this to add items from the MCP server:

```typescript
{
  name: "whiteboard_plant",
  description: "Plant a work item or question on the whiteboard",
  inputSchema: {
    title: string,           // required
    type: "task" | "question" | "decision" | "note",
    parentId?: string,       // attach to existing branch
    tags?: string[],
    body?: string,
    question?: string,       // if type=question
  }
}
```

### MCP Tool: `whiteboard_status`

```typescript
{
  name: "whiteboard_status",
  description: "Get whiteboard summary — open items, unanswered questions, top weighted",
}
```

### Auto-planting

The agent should plant items when:
- Work is completed → plant `done` node under appropriate parent
- A decision point is reached → plant `question` node
- A new goal is identified → plant `goal` root node
- Work is blocked → plant `question` explaining what's needed

The agent should NOT:
- Plant every micro-step (keep it meaningful)
- Answer its own questions (that defeats the purpose)
- Create deep nesting beyond 4 levels (flatten if needed)

---

## Relationship to Existing Board

The kanban board (`/board`) and whiteboard coexist:

| | Board | Whiteboard |
|---|-------|------------|
| Structure | Flat list in columns | Tree/hierarchy |
| Focus | Workflow state | Work structure |
| Interaction | Drag between states | Answer questions |
| Who writes | Mostly agent | Both equally |
| Granularity | Individual tasks | Goals → tasks → subtasks |
| View | Kanban columns | Tree / questions / weighted |

A whiteboard node can optionally link to a board task via `boardTaskId`. When the board task moves to `done`, the whiteboard node auto-completes. But most whiteboard items won't have board tasks — they're higher-level or question-type.

---

## Implementation Plan

### Step 1: Types + Store
- `src/whiteboard/types.ts` — WhiteboardNode, WhiteboardFilter
- `src/whiteboard/store.ts` — JSONL store with tree operations
- `src/whiteboard/weight.ts` — Weight calculation

### Step 2: API Routes
- Wire into `src/server.ts` — all `/api/whiteboard/*` endpoints
- Gate behind `requireSurface("pages")`

### Step 3: MCP Tools
- `whiteboard_plant` and `whiteboard_status` in `src/mcp-server.ts`

### Step 4: UI
- `public/whiteboard.html` — tree view, questions view, weighted view
- Inline answer input, collapse/expand, weight bars
- Link from board header / nav

### Step 5: Agent Auto-planting
- Wire into agent completion hooks
- Plant questions when decisions are needed

---

## Agent-Side Flow (Spawn Throttle)

The whiteboard changes how Dash decides to spawn agents.

### Before whiteboard
```
encounter ambiguity → spawn agent to figure it out → agent guesses
```

### With whiteboard
```
encounter ambiguity → plant question → wait → human answers → resume
```

### Goals Loop Integration

The goals loop (`src/goals/loop.ts`) gains a new step at the top of its decision cycle:

1. **Check answered questions** — `GET /api/whiteboard/answered?since=<last_check>`
2. If any answers came in, those are actionable work — prioritize over goals.yaml scanning
3. An answered question with children = a task that was waiting for direction. The answer IS the direction.

### Spawn Decision Gate

Before spawning an agent, the decision logic evaluates:

| Condition | Action |
|-----------|--------|
| Clear task, no ambiguity | Spawn agent |
| Ambiguous task, human could clarify | Plant question, don't spawn |
| Ambiguous but time-sensitive | Plant question AND spawn with best-guess (mark as "provisional") |
| Question already exists for this work | Don't duplicate — wait for answer |

### Agent Prompt Guidance

Add to agent system prompts:
```
If you encounter a decision point where the human's preference matters,
plant a whiteboard question instead of guessing. Use whiteboard_plant
with type="question". The human will answer it. Do not spawn agents
to resolve ambiguity that the human should weigh in on.
```

### Resume Trigger

When a question is answered via `POST /api/whiteboard/:id/answer`:
- The goals loop picks it up on next scan (polling, not push)
- No additional spawn needed — the loop re-evaluates with the answer as new context
- The answer can reference the whiteboard node ID for traceability

---

## Design Principles

1. **Questions are the product.** The tree is structure. The questions are the interaction. If the human never sees a question, the whiteboard failed.
2. **Attention is earned.** Weight accumulates naturally. Nothing blinks, nothing badges. Unresolved things just feel... unfinished.
3. **Both sides write.** This is not a status report. The human plants goals, the agent plants tasks and questions. The tree grows from both directions.
4. **Shallow trees.** Max 4 levels recommended: goal → task → subtask → question. Deeper means the work should be restructured.
5. **Answer and move on.** The ideal interaction is: open whiteboard, answer the top question, close whiteboard. 30 seconds. Work unblocks.
