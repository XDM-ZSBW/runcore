# Template & Skill Sharing Registry — Design Document

This document specifies the design for a registry system that enables sharing, discovery, and installation of skills, templates, and brain module extensions between Core instances. It integrates with the existing skills system (`skills/`), brain module structure (`brain/`), and follows established Core patterns: file-backed storage, append-only JSONL, provider abstraction, and progressive disclosure.

---

## 1. Problem statement

Today, skills and templates are local to a single Core instance. There is no way to:

- Publish a skill or template so others can use it.
- Discover community-contributed skills for new task types.
- Install a third-party skill and have it integrate with the existing routing table.
- Version or update skills after installation.
- Validate that a skill is safe and compatible before loading it into context.

The registry solves these problems while preserving Core's principles: files are the database, context is progressively disclosed, and nothing requires an external API to function locally.

---

## 2. Concepts

### 2.1 Package

A **package** is the unit of sharing. It wraps one or more related files into a distributable unit.

```yaml
# package.yaml — lives at the root of every package
name: "write-blog"
version: "1.2.0"
type: "skill"                    # skill | template | module-extension
description: "Full workflow to write a long-form blog post."
author: "dash-core"
license: "MIT"
core-compat: ">=0.1.0"          # minimum Core version

# What this package provides
provides:
  - kind: skill
    path: write-blog.md
    slot: task                   # task | reference
  - kind: template
    path: templates/blog.md
    slot: content

# What this package requires from the host brain
requires:
  modules: ["identity", "content"]
  files:
    - brain/identity/tone-of-voice.md
    - brain/content/CONTENT.md

# Optional: rules for auto-loading (see §5)
rules:
  - trigger: { intent: "write *" }
    action: load
    priority: 50
```

### 2.2 Registry

A **registry** is a source of packages. Three tiers, from local to remote:

| Tier | Name | Location | Requires network |
|------|------|----------|-----------------|
| 0 | Local | `brain/registry/installed/` | No |
| 1 | Workspace | Shared filesystem or Git repo | LAN only |
| 2 | Remote | HTTPS index (static JSON or API) | Yes |

The runtime queries tiers in order (local first). Offline operation always works because Tier 0 is self-contained.

### 2.3 Manifest

The **registry manifest** is the local index of all known packages (installed and available). Stored as append-only JSONL at `brain/registry/manifest.jsonl`.

```jsonl
{"_schema":"registry-manifest","version":"1.0","description":"Append-only index of registry packages."}
{"id":"pkg_write-blog_1.2.0","name":"write-blog","version":"1.2.0","type":"skill","source":"local","state":"installed","installedAt":"2026-02-27T10:00:00Z","checksum":"sha256:abc123...","status":"active"}
{"id":"pkg_log-okr_0.1.0","name":"log-okr","version":"0.1.0","type":"skill","source":"remote:dash-community","state":"available","discoveredAt":"2026-02-27T12:00:00Z","status":"active"}
```

Entry states: `available` → `installing` → `installed` → `updating` → `installed` | `uninstalled` (archived).

State transitions follow the same validation pattern as the agent runtime (`VALID_TRANSITIONS` + `isValidTransition()`).

---

## 3. File layout

```
brain/registry/
├── manifest.jsonl          # Append-only package index
├── sources.yaml            # Configured registry sources (Tier 1 & 2)
└── installed/
    ├── write-blog/
    │   ├── package.yaml    # Package metadata
    │   ├── write-blog.md   # The skill file
    │   └── templates/
    │       └── blog.md     # Bundled template
    └── log-okr/
        ├── package.yaml
        └── log-okr.md
```

`sources.yaml` defines non-local registries:

```yaml
sources:
  - name: dash-community
    type: git
    url: https://github.com/dash-brain/community-skills.git
    branch: main
    path: packages/
  - name: team-internal
    type: filesystem
    path: /mnt/shared/dash-skills/
```

---

## 4. Integration with the existing skills system

The current skills system (`skills/README.md`) is the **primary skill location**. The registry is an additional source, not a replacement. The loader checks both locations.

### 4.1 Skill resolution order

When the agent routes a task (via AGENT.md decision table), the skill loader resolves in this order:

1. `skills/` directory (local, hand-authored — always wins)
2. `brain/registry/installed/` (registry-installed packages)

If the same `name` exists in both locations, the local `skills/` version takes precedence. This ensures the user can always override a registry skill by placing a file in `skills/`.

### 4.2 Routing table extension

Installed packages can add rows to the decision table. The registry does **not** modify `AGENT.md` directly. Instead, it maintains a supplemental routing file:

```
brain/registry/routes.yaml
```

```yaml
# Auto-generated from installed packages. Do not edit manually.
routes:
  - intent: "log an OKR"
    skill: log-okr
    source: registry
    steps:
      - "Load brain/operations/OPERATIONS.md + goals"
      - "Append to brain/operations/okrs.jsonl"
      - "Confirm with user"
```

The agent reads `AGENT.md` first, then `brain/registry/routes.yaml` for supplemental routes. AGENT.md routes always take priority.

### 4.3 Skill format compatibility

Registry skills use the same format as local skills — YAML frontmatter + Markdown body. No new format is introduced. A registry skill can be "ejected" into `skills/` by copying the `.md` file, with no conversion needed.

---

## 5. Rules engine synergies

Core doesn't have a formal rules engine today, but conditional logic is embedded in the goal loop, sync rules, and memory extraction heuristics. The registry introduces a lightweight **rule evaluation layer** that can later generalize into a standalone rules engine.

### 5.1 Package rules

Each package can declare rules in `package.yaml` (see §2.1). Rules follow a `trigger → condition → action` model:

```yaml
rules:
  - trigger: { intent: "write *" }           # Glob match on user intent
    condition: { module_loaded: "content" }   # Optional guard
    action: load                              # load | suggest | block
    priority: 50                              # Lower = higher priority
```

**Trigger types:**

| Trigger | Matches on | Example |
|---------|-----------|---------|
| `intent` | User intent string (glob) | `"write *"`, `"log * decision"` |
| `task_type` | Skill slot type | `"writing"`, `"operations"` |
| `file_changed` | Brain file path (glob) | `"brain/operations/goals.yaml"` |
| `schedule` | Cron expression | `"0 9 * * MON"` (Monday 9am) |
| `event` | Runtime event name | `"agent:completed"`, `"sync:done"` |

**Actions:**

| Action | Effect |
|--------|--------|
| `load` | Auto-load the skill/template into context |
| `suggest` | Surface a suggestion to the user ("You might want to use X") |
| `block` | Prevent execution if a condition is unmet (e.g., missing dependency) |

### 5.2 Rule evaluation

Rules are evaluated in two phases:

1. **Static phase** (at routing time): Check `intent` and `task_type` triggers. This extends the existing "route first" logic in AGENT.md without changing its file.
2. **Dynamic phase** (at runtime): Check `file_changed`, `schedule`, and `event` triggers. These integrate with the existing goal loop and sync timer infrastructure.

Rules from all installed packages are merged, sorted by priority, and deduplicated. Conflicts (two rules with the same trigger and different actions) are resolved by:

1. Local `skills/` rules always win over registry rules.
2. Lower `priority` number wins.
3. If still tied, `block` > `load` > `suggest`.

### 5.3 Path to a standalone rules engine

The rule evaluation logic lives in a single module (`src/registry/rules.ts`). This module is designed so it can later be extracted into a general-purpose `src/rules/engine.ts` that the goal loop, sync system, and memory extractor can also use. The key interface:

```typescript
interface Rule {
  id: string;
  trigger: RuleTrigger;
  condition?: RuleCondition;
  action: RuleAction;
  priority: number;
  source: string;            // "local" | package name
}

interface RuleEngine {
  evaluate(context: RuleContext): RuleResult[];
  register(rules: Rule[]): void;
  unregister(source: string): void;
}
```

This is intentionally minimal — no RETE algorithm, no forward chaining. Just sorted filter + match, which is sufficient for Core's scale (tens of rules, not thousands).

---

## 6. TypeScript runtime integration

### 6.1 New types (`src/registry/types.ts`)

```typescript
export interface PackageMeta {
  id: string;                    // "pkg_{name}_{version}"
  name: string;
  version: string;
  type: "skill" | "template" | "module-extension";
  description: string;
  author: string;
  license: string;
  coreCompat: string;
  provides: PackageProvide[];
  requires: PackageRequires;
  rules: PackageRule[];
  checksum: string;
}

export type PackageState =
  | "available"
  | "installing"
  | "installed"
  | "updating"
  | "uninstalled";

export interface ManifestEntry {
  id: string;
  name: string;
  version: string;
  type: string;
  source: string;
  state: PackageState;
  installedAt?: string;
  discoveredAt?: string;
  checksum?: string;
  status: "active" | "archived";
}

export interface PackageProvide {
  kind: "skill" | "template" | "module-extension";
  path: string;
  slot: string;
}

export interface PackageRequires {
  modules: string[];
  files: string[];
}

export interface PackageRule {
  trigger: Record<string, string>;
  condition?: Record<string, string>;
  action: "load" | "suggest" | "block";
  priority: number;
}
```

### 6.2 RegistryProvider interface (`src/registry/provider.ts`)

Follows the same abstraction pattern as `BoardProvider`:

```typescript
export interface RegistryProvider {
  readonly name: string;

  /** Check if this source is reachable. */
  isAvailable(): Promise<boolean>;

  /** Search packages by query. */
  search(query: string, opts?: {
    type?: string;
    limit?: number;
  }): Promise<PackageMeta[]>;

  /** Fetch full package metadata by name and version. */
  getPackage(name: string, version?: string): Promise<PackageMeta | null>;

  /** Download package files to a temp directory. Returns the path. */
  download(name: string, version: string): Promise<string | null>;

  /** List all available packages (paginated). */
  list(opts?: {
    offset?: number;
    limit?: number;
    type?: string;
  }): Promise<PackageMeta[]>;
}
```

**Implementations:**

| Provider | Source | Notes |
|----------|--------|-------|
| `LocalRegistryProvider` | `brain/registry/installed/` | Always available, reads package.yaml files |
| `GitRegistryProvider` | Git repo URL | Clones/pulls on demand, caches locally |
| `HttpRegistryProvider` | HTTPS endpoint | Fetches a static `index.json` or queries an API |

### 6.3 RegistryManager (`src/registry/manager.ts`)

Central orchestrator, analogous to the agent `RuntimeManager`:

```typescript
export class RegistryManager {
  constructor(
    private brainDir: string,
    private providers: RegistryProvider[],
  ) {}

  /** Initialize manifest, load installed packages. */
  async init(): Promise<void>;

  /** Search across all providers. */
  async search(query: string): Promise<PackageMeta[]>;

  /** Install a package: download → validate → copy → update manifest. */
  async install(name: string, version?: string): Promise<InstallResult>;

  /** Uninstall: archive manifest entry, remove files. */
  async uninstall(name: string): Promise<boolean>;

  /** Update a package to a new version. */
  async update(name: string): Promise<InstallResult>;

  /** List installed packages. */
  listInstalled(): ManifestEntry[];

  /** Get merged rules from all installed packages. */
  getRules(): PackageRule[];

  /** Resolve a skill name: check skills/ first, then registry. */
  resolveSkill(name: string): string | null;  // Returns file path
}
```

### 6.4 Integration points

| Existing component | Integration |
|-------------------|-------------|
| `Brain.getContextForTurn()` | After standard skill loading, check `RegistryManager.getRules()` for additional auto-load triggers |
| `src/server.ts` | Add `/api/registry/*` routes: search, install, uninstall, list |
| Goal loop (`src/goals/loop.ts`) | Evaluate `schedule` and `event` rule triggers during loop tick |
| Agent runtime | Emit events that rules can trigger on (`agent:completed`, etc.) |
| Context assembler | Registry-loaded skills feed into `instructions` or `supportingContent` sections |

---

## 7. Installation flow

```
User: "install the okr-tracker skill"

 1. RegistryManager.search("okr-tracker")
    → queries providers in tier order (local → workspace → remote)

 2. User confirms package: okr-tracker v1.0.0 by dash-community
    → display: name, description, requires, provides, rules

 3. RegistryManager.install("okr-tracker", "1.0.0")
    a. Download package files to temp dir
    b. Validate:
       - package.yaml schema check
       - checksum verification
       - dependency check (required modules exist in brain/)
       - no file path collisions with existing skills/
       - skill file format valid (YAML frontmatter + Markdown)
    c. Copy to brain/registry/installed/okr-tracker/
    d. Append to manifest.jsonl (state: "installed")
    e. Regenerate brain/registry/routes.yaml from all installed package rules
    f. Return InstallResult { ok: true, path, warnings }

 4. Skill is now available via routing table
    → next time user says "log an OKR", it resolves
```

### 7.1 Validation rules

| Check | Blocks install? | Rationale |
|-------|----------------|-----------|
| Valid `package.yaml` schema | Yes | Prevents corrupt packages |
| Checksum mismatch | Yes | Integrity |
| Missing required brain modules | Yes | Skill would fail at runtime |
| Name collision with `skills/` | No (warn) | Local always takes precedence |
| `core-compat` version mismatch | No (warn) | May still work |
| Skill references non-existent files | No (warn) | User may create them later |

---

## 8. Security model

The registry handles untrusted content (community packages). Security is layered:

### 8.1 Package integrity

- Every package has a `checksum` (SHA-256 of the package directory contents).
- Remote registries serve checksums alongside metadata; the installer verifies after download.

### 8.2 Sandboxed content

Skills and templates are **passive Markdown files**. They contain instructions for the agent, not executable code. This is a fundamental security advantage — a malicious skill can only attempt prompt injection, not execute arbitrary code.

Mitigations for prompt injection:

- Installed skills are clearly tagged in context as `[registry: package-name]` so the agent (and user) can distinguish them from trusted local skills.
- Skills cannot modify `AGENT.md`, `CLAUDE.md`, or core brain module instruction files.
- Skills cannot write to `brain/memory/` directly — they can only instruct the agent to do so, and the agent follows the existing append-only rules.

### 8.3 Permission model

| Action | Requires |
|--------|----------|
| Install from local/workspace | No confirmation |
| Install from remote | User confirmation (display package metadata first) |
| Install a package with `module-extension` type | Explicit user approval + display of what it modifies |
| Auto-load via rule trigger | Allowed for `installed` packages only |
| `block` action in rules | Only from local `skills/` or explicitly approved packages |

### 8.4 Trust levels

```yaml
trust:
  local: full           # skills/ directory — user-authored
  installed: standard   # brain/registry/installed/ — validated
  available: none       # not yet installed — display-only
```

---

## 9. Publishing flow

A user publishes a skill by creating a package directory and pushing it to a registry source.

### 9.1 Local authoring

```
# 1. Author the skill in skills/ as usual
skills/my-new-skill.md

# 2. Package it
brain/registry/staging/my-new-skill/
├── package.yaml          # Fill in metadata
└── my-new-skill.md       # Copy or symlink

# 3. Validate locally
dash registry validate brain/registry/staging/my-new-skill/

# 4. Publish to a Git registry
dash registry publish my-new-skill --to dash-community
```

### 9.2 Package validation (pre-publish)

- `package.yaml` has all required fields.
- All `provides[].path` files exist.
- All `requires.files` are valid brain paths (not absolute or escaping `brain/`).
- No files outside the package directory are referenced by relative path.
- Skill files have valid YAML frontmatter.

---

## 10. CLI and chat commands

| Command | Effect |
|---------|--------|
| `dash registry search <query>` | Search all configured sources |
| `dash registry install <name>` | Install a package |
| `dash registry uninstall <name>` | Archive and remove |
| `dash registry update <name>` | Update to latest compatible version |
| `dash registry list` | List installed packages |
| `dash registry validate <path>` | Validate a package directory |
| `dash registry publish <name> --to <source>` | Publish to a registry source |

These can also be invoked via natural language in chat:

- "install the okr-tracker skill" → `registry install okr-tracker`
- "what skills are available?" → `registry search *`
- "update all my skills" → `registry update --all`

---

## 11. AGENT.md decision table addition

Once the registry is implemented, add this row to AGENT.md:

| User says / intent | Step 1 | Step 2 | Step 3 |
|-------------------|--------|--------|--------|
| Install / find a skill | Load `brain/registry/manifest.jsonl` | Search configured sources | Install + confirm + regenerate routes |

---

## 12. Migration path

### Phase 1 — Local registry (no network)

- Create `brain/registry/` directory structure.
- Implement `LocalRegistryProvider` and `RegistryManager`.
- Package the three existing skills (`voice-guide`, `write-blog`, `log-decision`) as registry packages in `brain/registry/installed/`.
- Keep `skills/` as the primary location; registry is additive.
- Add `/api/registry/list` and `/api/registry/installed` routes.

### Phase 2 — Git-based sharing

- Implement `GitRegistryProvider`.
- Add `sources.yaml` configuration.
- Implement `install`, `uninstall`, and `search` commands.
- Add `brain/registry/routes.yaml` generation.
- Manifest JSONL tracking.

### Phase 3 — Rules engine extraction

- Factor out rule evaluation from `src/registry/rules.ts` into `src/rules/engine.ts`.
- Wire the goal loop, sync system, and memory extractor to use the shared rule engine.
- Support `schedule` and `event` triggers.

### Phase 4 — Remote registry

- Implement `HttpRegistryProvider`.
- Add checksum verification, trust levels.
- Publishing flow and validation.
- Community index (static `index.json` hosted on GitHub Pages or similar).

---

## 13. Design principles

1. **Files are the database.** No SQLite, no Redis. Packages are directories, the manifest is JSONL, configuration is YAML.
2. **Offline first.** Tier 0 (local) always works. Network is optional and additive.
3. **Skills stay passive.** Registry packages are Markdown instructions, not executable code. The security surface is prompt injection, not code execution.
4. **Override by proximity.** `skills/` > `brain/registry/installed/` > remote. The user's local files always win.
5. **Append-only audit trail.** The manifest records every install, update, and removal. History is never lost.
6. **Progressive disclosure.** The agent loads package metadata first, then package files only when a rule triggers or the user invokes the skill.
7. **Same format, no lock-in.** Registry skills use the same YAML frontmatter + Markdown format. "Ejecting" a skill from the registry to `skills/` is a file copy.
