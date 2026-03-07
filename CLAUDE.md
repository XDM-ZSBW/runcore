# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Core is the runtime for a file-based personal operating system. **Packages are code only, no data ever.** The brain (context, memory, skills in markdown, YAML, and JSONL) lives in a separate repo/directory, configured via the `CORE_BRAIN_DIR` environment variable. Default: `process.cwd() + "brain"` for backward compatibility.

All brain path references flow through `src/lib/paths.ts` → `BRAIN_DIR`. No file defines its own brain path.

## Build commands

```bash
npm install          # Install dependencies (typescript, tsx, @types/node)
npm run build        # Compile TypeScript → dist/ (ES2022, NodeNext)
npm run dev          # Watch mode (tsc --watch)
npm run example      # Run example/dash.ts with tsx
```

No test runner or linter is configured.

## TypeScript runtime architecture (src/)

The runtime is **optional** — Core works purely as files read by an AI. The TS runtime adds programmatic context assembly and file-backed memory.

**Brain class** (`src/brain.ts`) — Main orchestrator. Composes LTM retrieval + context assembly + working memory.
- `getContextForTurn(options)` — Retrieves from LTM, builds context sections, returns LLM-ready messages
- `learn(input)` — Appends to LTM (episodic/semantic/procedural)
- Uses working memory as a per-turn scratchpad (active goal, retrieved items, scratch)

**Memory** (`src/memory/`) — Two LTM implementations behind `LongTermMemoryStore` interface:
- `InMemoryLongTermMemory` — Map-based, for testing
- `FileSystemLongTermMemory` — Reads/writes `brain/memory/*.jsonl`. Maps types to files: episodic→`experiences.jsonl`, semantic→`semantic.jsonl`, procedural→`procedural.jsonl`. Append-only (delete is a no-op).

**Context assembler** (`src/context/assembler.ts`) — Builds `ContextSections` (supportingContent, instructions, examples, cues, primaryContent) from working memory, then converts to LLM message array. Token estimation: `chars / 4`.

Package name is `core-brain` (v0.1.0, ESM, MIT).

## File-based brain (separate repo)

The brain lives outside this package (default: `E:/brain`, configured via `CORE_BRAIN_DIR`). It has five modules:

| Module | Instruction file | Data files |
|--------|-----------------|------------|
| **memory** | `memory/README.md` | `*.jsonl` (experiences, decisions, failures, semantic, procedural) |
| **identity** | — | `tone-of-voice.md`, `brand.md`, `principles.md` |
| **content** | `content/CONTENT.md` | `templates/blog.md` |
| **operations** | `operations/OPERATIONS.md` | `goals.yaml`, `todos.md` |
| **knowledge** | `knowledge/README.md` | `research/`, `bookmarks/`, `notes/` |

Content drafts (human-facing writing) live in the publication repo (herrmangroup), not in the brain.

## Principles

Read `identity/principles.md` (in the brain repo) for product, architecture, and business principles. These inform decision-making across all Core-based brains. Load at Level 2 (alongside module instructions) when a task involves design choices, architecture decisions, or content that represents the brand.

## Critical rules

1. **Route first.** Read `SKILL.md` to determine which module(s) a task needs. Load only those — never load everything.
2. **Progressive disclosure.** Level 1: SKILL.md + AGENT.md (always). Level 2: module instruction file. Level 3: specific data files only when needed.
3. **Three passes for build/design.** When the user is describing a feature or design, use three passes: intent only (plain language) → spec and build → technical review. Do not interleave intent and implementation. See [docs/THREE-PASSES.md](docs/THREE-PASSES.md).
4. **JSONL is append-only.** Files in `brain/memory/*.jsonl` must only be appended to. Use `"status": "archived"` to deprecate entries — never delete or rewrite.
5. **Read AGENT.md** for the decision table mapping user intents to module sequences (e.g., "write a post" → load content + voice + template → draft → voice check).

## Skills system (skills/)

Two types:
- **Reference skills** (e.g., `voice-guide.md`): Auto-load when task type matches. `voice-guide.md` loads for all writing tasks.
- **Task skills** (e.g., `write-blog.md`, `log-decision.md`): User-invoked with slash commands or natural language. Load the skill's instructions and its referenced files.

Skills reference brain module files — they don't duplicate content.

## Memory JSONL schemas

Each JSONL file starts with a `_schema` header line. Entry schemas:
- **experiences**: `date`, `summary`, `emotional_weight` (1–10), `tags`, `status`
- **decisions**: `date`, `context`, `options[]`, `reasoning`, `outcome`, `status`
- **failures**: `date`, `summary`, `root_cause`, `prevention`, `status`
- **semantic/procedural**: `id`, `type`, `content`, `meta`, `createdAt` (runtime format)
