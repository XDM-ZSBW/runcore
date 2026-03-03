# Skills Library — Specification

This document specifies the Skills Library: the TypeScript runtime that loads, registers, resolves, and manages skills for the Dash agent. It bridges the file-based skills system (`skills/`, `brain/registry/installed/`) and the runtime (`src/`), giving the Brain class programmatic access to skill content and metadata.

---

## 1. Problem statement

Skills today are passive Markdown files. The agent loads them by convention — reading `skills/README.md`, pattern-matching the user's intent, then reading the relevant `.md` file. There is no runtime abstraction to:

- Parse a skill file into structured metadata + body.
- Resolve which skill applies to a given intent (beyond the AGENT.md decision table).
- Track which skills are loaded in a turn (for debugging, context budgets, and tracing).
- Manage the lifecycle of registry-installed skills programmatically.
- Validate skill files before they enter the system.

The Skills Library solves this by introducing a `Skill` interface, a `SkillRegistry` class, and a `SkillLoader` that parses the existing file format into runtime objects.

---

## 2. Design principles

1. **Files remain the source of truth.** The runtime reads from `skills/` and `brain/registry/installed/`. It never generates or transpiles skill files.
2. **Same format, no migration.** Existing skills (YAML frontmatter + Markdown) work unchanged. The library parses them, not the other way around.
3. **Follow established patterns.** `SkillRegistry` mirrors `AgentRegistry` (in-memory Map + file-backed persistence). Resolution follows `BoardProvider`-style abstraction.
4. **Progressive disclosure.** Metadata is loaded eagerly (lightweight); body content is loaded lazily (only when the skill is activated for a turn).
5. **Append-only audit.** Skill install/uninstall/update events are logged to `brain/registry/manifest.jsonl`. No destructive rewrites.

---

## 3. Skill interface

### 3.1 Core types (`src/skills/types.ts`)

```typescript
// ---------------------------------------------------------------------------
// Skill slot — how the skill is triggered
// ---------------------------------------------------------------------------

/** How the skill is invoked. */
export type SkillSlot = "task" | "reference";

/** Lifecycle state of a skill in the registry. */
export type SkillState =
  | "discovered"   // Known but not loaded (registry metadata only)
  | "registered"   // Parsed and in the registry map
  | "active"       // Currently loaded into a turn's context
  | "disabled"     // Explicitly disabled by the user
  | "archived";    // Soft-deleted (append-only — never removed)

/** Valid state transitions. */
export const SKILL_TRANSITIONS: Record<SkillState, SkillState[]> = {
  discovered:  ["registered", "archived"],
  registered:  ["active", "disabled", "archived"],
  active:      ["registered"],               // deactivate after turn
  disabled:    ["registered", "archived"],    // re-enable or archive
  archived:    [],                           // terminal
};

// ---------------------------------------------------------------------------
// Skill metadata — parsed from YAML frontmatter
// ---------------------------------------------------------------------------

/** Metadata extracted from a skill file's YAML frontmatter. */
export interface SkillMeta {
  /** Unique skill identifier (the `name` field in frontmatter). */
  name: string;

  /** Human-readable description / when to load. */
  description: string;

  /** Can the user invoke this skill by name or slash command? */
  userInvocable: boolean;

  /**
   * If true, the agent only runs this skill when the user explicitly
   * invokes it (not via auto-routing).
   */
  disableModelInvocation: boolean;

  /** Derived from frontmatter flags. */
  slot: SkillSlot;

  /** Version string (for registry-installed skills). */
  version?: string;

  /** Source origin. */
  source: SkillSource;
}

/** Where the skill came from. */
export type SkillSource =
  | { type: "local"; path: string }                    // skills/ directory
  | { type: "registry"; package: string; path: string } // brain/registry/installed/
  | { type: "inline" };                                 // programmatically created

// ---------------------------------------------------------------------------
// Skill — the full runtime representation
// ---------------------------------------------------------------------------

/** A fully parsed skill: metadata + body content. */
export interface Skill {
  /** Metadata from frontmatter. */
  meta: SkillMeta;

  /** Markdown body (the instructions). Loaded lazily. */
  body: string | null;

  /** Files this skill references (extracted from body). */
  referencedFiles: string[];

  /** Current lifecycle state. */
  state: SkillState;

  /** When this skill was first registered. */
  registeredAt: string;

  /** When metadata or body was last refreshed from disk. */
  refreshedAt: string;
}

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

/** Result of resolving a skill for a given intent. */
export interface SkillResolution {
  /** The resolved skill. */
  skill: Skill;

  /** Why this skill was selected. */
  reason: "exact-match" | "intent-match" | "auto-load" | "rule-trigger";

  /** Confidence score (0–1). Exact match = 1. */
  confidence: number;

  /** Source priority (lower = higher priority). Local = 0, registry = 10. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Skill validation
// ---------------------------------------------------------------------------

/** Result of validating a skill file. */
export interface SkillValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

### 3.2 Design notes

- **`SkillSlot`** is derived, not declared. If `userInvocable: true` → `"task"`. If `userInvocable: false` → `"reference"`. This matches the existing convention without adding a new frontmatter field.
- **`body: string | null`** — `null` means the body hasn't been loaded yet (lazy loading). Call `registry.loadBody(name)` to populate it.
- **`referencedFiles`** — Extracted by scanning the body for paths matching `brain/...` (regex: `brain\/[\w\-\/]+\.\w+`). Used for dependency validation and context budgeting.

---

## 4. SkillLoader (`src/skills/loader.ts`)

Parses skill files from disk into `Skill` objects. Stateless — pure functions.

```typescript
export interface SkillLoader {
  /**
   * Parse a skill file into metadata + body.
   * Splits YAML frontmatter from Markdown body.
   * Returns null if the file is not a valid skill (no frontmatter).
   */
  parse(filePath: string, content: string): Skill | null;

  /**
   * Parse only the frontmatter (for eager metadata loading).
   * Cheaper than full parse — skips body processing.
   */
  parseMeta(filePath: string, content: string): SkillMeta | null;

  /**
   * Validate a skill file against the schema.
   * Checks: required fields, valid field values, body not empty,
   * referenced files use relative brain paths.
   */
  validate(filePath: string, content: string): SkillValidation;

  /**
   * Extract referenced file paths from skill body content.
   * Scans for patterns like `brain/identity/tone-of-voice.md`.
   */
  extractReferences(body: string): string[];
}
```

### 4.1 Frontmatter parsing rules

| Frontmatter field | Required | Type | Default |
|---|---|---|---|
| `name` | Yes | string | — |
| `description` | Yes | string | — |
| `user-invocable` | No | boolean | `false` |
| `disable-model-invocation` | No | boolean | `false` |
| `version` | No | string | `"0.0.0"` |

### 4.2 Validation rules

| Check | Severity | Description |
|---|---|---|
| Missing `name` | Error | Every skill must have a name |
| Missing `description` | Error | Every skill must describe when to load |
| Empty body | Error | A skill with no instructions is useless |
| `user-invocable: true` + `disable-model-invocation: false` | Warning | Task skills should typically disable model invocation |
| Referenced file outside `brain/` | Warning | Skills should only reference brain module files |
| Duplicate `name` in directory | Error | Names must be unique within a source |

---

## 5. SkillRegistry (`src/skills/registry.ts`)

In-memory registry of all known skills, with file-backed persistence. Mirrors the `AgentRegistry` pattern.

```typescript
import { readdir, readFile } from "node:fs/promises";
import type { Skill, SkillMeta, SkillState, SkillResolution, SkillValidation } from "./types.js";

export class SkillRegistry {
  /** In-memory skill map, keyed by skill name. */
  private readonly skills = new Map<string, Skill>();

  /** Ordered list of source directories (priority order). */
  private readonly sourceDirs: string[];

  /** Path to brain directory (for registry-installed skills). */
  private readonly brainDir: string;

  private initialized = false;

  constructor(opts: {
    skillsDir: string;      // e.g. "skills/"
    brainDir: string;       // e.g. "brain/"
  }) {
    this.brainDir = opts.brainDir;
    this.sourceDirs = [
      opts.skillsDir,                                      // Priority 0: local
      `${opts.brainDir}/registry/installed`,               // Priority 1: registry
    ];
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Scan all source directories and register discovered skills.
   * Loads metadata eagerly, body lazily.
   */
  async init(): Promise<void>;

  /**
   * Re-scan source directories. Picks up new/changed/removed files.
   * Does not unregister skills that were loaded programmatically.
   */
  async refresh(): Promise<void>;

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /** Get a skill by name. */
  get(name: string): Skill | undefined;

  /** Check if a skill is registered. */
  has(name: string): boolean;

  /** Register a skill (from loader or programmatic creation). */
  register(skill: Skill): void;

  /** Unregister a skill (sets state to "archived", does not delete file). */
  archive(name: string): void;

  /** Enable a previously disabled skill. */
  enable(name: string): void;

  /** Disable a skill (skipped during resolution). */
  disable(name: string): void;

  /** List all skills, optionally filtered. */
  list(filter?: {
    state?: SkillState;
    slot?: "task" | "reference";
    source?: "local" | "registry";
  }): Skill[];

  // -------------------------------------------------------------------------
  // Body loading (lazy)
  // -------------------------------------------------------------------------

  /**
   * Load the full body content for a skill.
   * No-op if body is already loaded.
   * Reads from the skill's source file path.
   */
  async loadBody(name: string): Promise<string | null>;

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve which skill(s) apply to a given intent.
   *
   * Resolution order:
   * 1. Exact name match (e.g., "/write-blog" → skill named "write-blog")
   * 2. Intent keyword matching against skill descriptions
   * 3. Auto-load reference skills whose descriptions match the task type
   * 4. Rule-trigger matching from registry-installed package rules
   *
   * Returns results sorted by priority (local > registry) then confidence.
   */
  resolve(intent: string, opts?: {
    /** Include reference skills that auto-load for this task type. */
    includeReference?: boolean;
    /** Maximum results to return. */
    limit?: number;
  }): SkillResolution[];

  /**
   * Resolve a single skill by exact name.
   * Checks local skills/ first, then registry.
   */
  resolveByName(name: string): Skill | undefined;

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Validate a skill file before registration. */
  validate(filePath: string, content: string): SkillValidation;

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /** Count skills by state. */
  countByState(): Record<SkillState, number>;

  /** Total registered skills. */
  get size(): number;
}
```

### 5.1 Resolution algorithm

```
resolve(intent):

  results = []

  1. EXACT MATCH
     - Strip leading "/" from intent
     - If skills.has(stripped), push with reason="exact-match", confidence=1.0

  2. INTENT MATCH (task skills only)
     - For each registered task skill:
       - Tokenize intent and skill.description
       - Score = |intersection| / |union| (Jaccard similarity)
       - If score > 0.3, push with reason="intent-match"

  3. AUTO-LOAD (reference skills only, if opts.includeReference)
     - For each registered reference skill:
       - Check if intent's task type matches the skill's description keywords
       - E.g., "write", "draft", "edit" → matches voice-guide
       - Push with reason="auto-load"

  4. RULE TRIGGER (registry skills with package rules)
     - Evaluate rules from brain/registry/routes.yaml
     - Push matches with reason="rule-trigger"

  Sort by: priority ASC (local=0, registry=10), then confidence DESC
  Deduplicate by skill name (keep highest priority)
  Return results[0..limit]
```

### 5.2 Priority ordering

| Source | Priority | Rationale |
|---|---|---|
| `skills/` (local) | 0 | User-authored, always wins |
| `brain/registry/installed/` | 10 | Validated but third-party |
| Inline (programmatic) | 5 | Runtime-created, trusted but overridable |

---

## 6. Skill lifecycle

### 6.1 State machine

```
                  ┌─────────────┐
                  │ discovered  │  (metadata known, file not parsed)
                  └──────┬──────┘
                         │ parse + register
                         ▼
                  ┌─────────────┐
         ┌───────│ registered  │◄──────┐
         │       └──────┬──────┘       │
         │              │ load into    │ deactivate
         │              │ turn context │ (turn ends)
         │              ▼              │
         │       ┌─────────────┐       │
         │       │   active    │───────┘
         │       └─────────────┘
         │
         │ disable          enable
         ▼                    │
  ┌─────────────┐             │
  │  disabled   │─────────────┘
  └──────┬──────┘
         │ archive
         ▼
  ┌─────────────┐
  │  archived   │  (terminal — append-only record)
  └─────────────┘
```

### 6.2 Creation

A skill enters the system through one of three paths:

**Path A: Local authoring (most common)**

```
1. User creates skills/my-skill.md with YAML frontmatter + Markdown body
2. On next registry.init() or registry.refresh():
   a. SkillLoader.parseMeta() extracts metadata
   b. SkillRegistry.register() adds to in-memory map (state: "registered")
   c. Body remains null (lazy)
3. When the skill is needed for a turn:
   a. registry.resolve(intent) matches the skill
   b. registry.loadBody(name) reads the Markdown body from disk
   c. State transitions to "active" for the duration of the turn
   d. Body content is injected into ContextSections.instructions
4. After the turn, state returns to "registered"
```

**Path B: Registry install**

```
1. User says "install the okr-tracker skill"
2. RegistryManager.install("okr-tracker"):
   a. Downloads package to brain/registry/installed/okr-tracker/
   b. Validates package.yaml + skill file
   c. Appends to manifest.jsonl (state: "installed")
   d. Regenerates brain/registry/routes.yaml
3. SkillRegistry.refresh() picks up the new skill:
   a. Scans brain/registry/installed/okr-tracker/*.md
   b. Parses metadata, registers with source: { type: "registry", ... }
4. Skill is now resolvable via intent matching or rule triggers
```

**Path C: Programmatic (inline)**

```
1. Runtime code creates a Skill object directly:
   registry.register({
     meta: { name: "quick-note", description: "...", ... },
     body: "## Instructions\n...",
     state: "registered",
     source: { type: "inline" },
     ...
   });
2. Skill lives only in memory — no file backing
3. Lost on process restart unless persisted by the caller
```

### 6.3 Updating

Skills are updated by modifying the source file. The registry detects changes on `refresh()`.

```
1. User edits skills/write-blog.md (changes the draft sequence)
2. registry.refresh():
   a. Re-reads all source directories
   b. For each file, compares parseMeta() result against stored skill
   c. If metadata changed: updates in-memory Skill.meta, sets refreshedAt
   d. If file was loaded (body != null): clears body to force re-read
3. Next resolution picks up the updated skill automatically
```

For registry-installed skills, updates go through `RegistryManager.update()`:

```
1. User says "update okr-tracker"
2. RegistryManager.update("okr-tracker"):
   a. Fetches latest version from provider
   b. Downloads new package to temp dir
   c. Validates (schema, checksum, dependencies)
   d. Replaces files in brain/registry/installed/okr-tracker/
   e. Appends new manifest entry (state: "installed", new version)
   f. Archives previous manifest entry
3. registry.refresh() picks up the updated files
```

### 6.4 Deletion (archival)

Skills are never truly deleted — they are archived (append-only principle).

**Local skill removal:**

```
1. User deletes skills/my-skill.md from disk
2. registry.refresh():
   a. Detects that a registered skill's source file no longer exists
   b. Sets state to "archived"
   c. Skill is no longer resolvable but remains in memory for audit
3. If the skill was registry-installed, manifest.jsonl gets an archive entry
```

**Explicit archival:**

```
1. registry.archive("my-skill"):
   a. Sets state to "archived" (terminal — no transitions out)
   b. If source is registry: appends to manifest.jsonl with status: "archived"
   c. Skill remains in the Map for audit/history queries
   d. Does NOT delete the source file (user can do that manually)
```

**Disable (reversible soft-removal):**

```
1. registry.disable("my-skill"):
   a. Sets state to "disabled"
   b. Skill is skipped during resolution (not matched to any intent)
   c. Can be re-enabled with registry.enable("my-skill")
```

---

## 7. Integration with Brain

### 7.1 Context assembly

The `Brain.getContextForTurn()` method gains a skill resolution step:

```typescript
async getContextForTurn(options: GetContextOptions): Promise<GetContextResult> {
  // ... existing LTM retrieval ...

  // NEW: Skill resolution
  const taskSkills = this.skillRegistry.resolve(options.userInput, {
    includeReference: true,
  });

  for (const resolution of taskSkills) {
    await this.skillRegistry.loadBody(resolution.skill.meta.name);
    // Inject into context sections based on slot:
    //   reference → supportingContent (background guidance)
    //   task      → instructions (primary directive)
  }

  // ... existing context assembly ...
}
```

### 7.2 Slot-to-section mapping

| Skill slot | Context section | Rationale |
|---|---|---|
| `reference` | `supportingContent` | Background guidance (voice, style) that applies alongside the main task |
| `task` | `instructions` | The primary directive — the skill IS the task |

### 7.3 Server routes

Add to `src/server.ts`:

| Route | Method | Description |
|---|---|---|
| `/api/skills` | GET | List all registered skills (metadata only) |
| `/api/skills/:name` | GET | Get a single skill (metadata + body) |
| `/api/skills/:name/resolve` | POST | Test resolution for a given intent |
| `/api/skills/resolve` | POST | Resolve intent → matching skills |
| `/api/skills/:name/validate` | POST | Validate a skill file |

---

## 8. Concrete first skills

The three existing skills become the first entries in the registry. No file changes needed — the loader parses them as-is.

### 8.1 voice-guide (reference)

```
Name:        voice-guide
Slot:        reference (auto-load)
Source:      skills/voice-guide.md
Triggers:    Any intent containing "write", "draft", "edit", "blog", "post", "email", "thread"
References:  brain/identity/tone-of-voice.md, brain/identity/anti-patterns.md
Behavior:    Loaded into supportingContent. Applies voice checkpoints, banned-word scans,
             em-dash limits to all writing output.
```

### 8.2 write-blog (task)

```
Name:        write-blog
Slot:        task (user-invoked)
Source:      skills/write-blog.md
Triggers:    Exact match on "/write-blog" or "write a blog post"
References:  brain/identity/tone-of-voice.md, brain/identity/brand.md,
             brain/content/templates/blog.md, brain/knowledge/research/*
Behavior:    Loaded into instructions. Four-step sequence: load context → outline →
             draft (with voice checkpoints) → edit. Output to drafts/ or chat.
Co-loads:    voice-guide (reference, auto)
```

### 8.3 log-decision (task)

```
Name:        log-decision
Slot:        task (user-invoked)
Source:      skills/log-decision.md
Triggers:    Exact match on "/log-decision", or intents matching
             "log this decision", "remember we decided", "record decision"
References:  brain/memory/README.md
Behavior:    Loaded into instructions. Appends one JSONL line to
             brain/memory/decisions.jsonl with date, context, options,
             reasoning, outcome, status fields.
```

### 8.4 Proposed new skills

These are natural next additions based on the existing brain modules:

| Skill | Slot | Trigger | What it does |
|---|---|---|---|
| `log-experience` | task | "log this experience", "remember this" | Appends to `brain/memory/experiences.jsonl` |
| `log-failure` | task | "log this failure", "we messed up" | Appends to `brain/memory/failures.jsonl` with root cause + prevention |
| `research-topic` | task | "/research \<topic\>" | Runs research workflow, outputs to `brain/knowledge/research/` |
| `weekly-review` | task | "weekly review", "what happened this week" | Loads operations + goals + memory, generates review summary |
| `goal-check` | reference | Any planning/prioritization task | Auto-loads `brain/operations/goals.yaml` as supportingContent |

---

## 9. File layout

After implementation, the `src/skills/` directory will contain:

```
src/skills/
├── types.ts          # Skill, SkillMeta, SkillState, SkillResolution, SkillValidation
├── loader.ts         # SkillLoader — parse frontmatter + body from .md files
├── registry.ts       # SkillRegistry — in-memory map, resolution, lifecycle
└── index.ts          # Public API re-exports
```

This mirrors the existing `src/agents/runtime/` structure (types → registry → manager → index).

---

## 10. Token budget considerations

Skills consume context window tokens. The registry tracks this to prevent overloading.

```typescript
/** Estimate token count for a skill's body. */
function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4); // Same heuristic as context assembler
}
```

Guardrails:
- **Reference skills:** Soft limit of 500 tokens per skill body. If exceeded, log a warning.
- **Task skills:** Soft limit of 2,000 tokens. Task skills are the primary directive, so they get more budget.
- **Total skill budget per turn:** Configurable via `BrainConfig`. Default: 4,000 tokens (enough for 1 task skill + 2 reference skills).
- **If budget exceeded:** Drop lowest-confidence reference skills first. Never drop the task skill.

---

## 11. Error handling

| Scenario | Behavior |
|---|---|
| Skill file has invalid frontmatter | `parse()` returns null, logged as warning, file skipped |
| Skill file missing on `loadBody()` | Returns null, state stays "registered", logged as error |
| Duplicate name across sources | Local wins. Registry version is registered with a warning |
| Body exceeds token budget | Warning logged. Skill still loaded (soft limit) |
| Referenced brain file missing | Warning on validation. Skill still usable (file may be created later) |
| State transition invalid | Throws `SkillLifecycleError` with current state, attempted state, and skill name |

---

## 12. Migration path

### Phase 1 — Core library (no breaking changes)

1. Create `src/skills/types.ts`, `loader.ts`, `registry.ts`, `index.ts`.
2. Implement `SkillLoader` — parse existing skill files unchanged.
3. Implement `SkillRegistry` — init from `skills/` directory.
4. Add `skillRegistry` property to `Brain` class.
5. Wire `resolve()` into `getContextForTurn()` as an opt-in path.
6. The three existing skills work without modification.

### Phase 2 — Registry integration

1. Extend `SkillRegistry` source dirs to include `brain/registry/installed/`.
2. Wire `RegistryManager.install()` to trigger `SkillRegistry.refresh()`.
3. Add `/api/skills/*` routes to `src/server.ts`.
4. Implement rule-trigger resolution (reads `brain/registry/routes.yaml`).

### Phase 3 — Context budget enforcement

1. Add token estimation to `SkillRegistry`.
2. Wire budget checks into context assembler.
3. Add `maxSkillTokens` to `BrainConfig`.
4. Drop low-confidence reference skills when budget is exceeded.

### Phase 4 — New first-party skills

1. Implement `log-experience`, `log-failure`, `research-topic`.
2. Implement `weekly-review`, `goal-check`.
3. Package as registry packages in `brain/registry/installed/` for dogfooding.

---

## 13. Testing strategy

Using vitest (already configured in the project):

| Test file | What it covers |
|---|---|
| `test/skills/loader.test.ts` | Frontmatter parsing, validation, reference extraction |
| `test/skills/registry.test.ts` | Registration, resolution, lifecycle transitions, priority ordering |
| `test/skills/integration.test.ts` | End-to-end: file on disk → registry → resolve → context assembly |

Key test cases:
- Parse each of the 3 existing skill files and verify metadata extraction.
- Resolve "/write-blog" → exact match with confidence 1.0.
- Resolve "write a blog post about AI" → intent match on write-blog.
- Resolve "help me draft an email" → auto-loads voice-guide (reference).
- Local skill overrides registry skill with same name.
- Invalid frontmatter returns null, not a crash.
- State transitions: registered → active → registered, disabled → registered, archived → (no transitions).
- Token budget: task skill loaded, reference skills dropped in priority order.
