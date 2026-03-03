# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Core is a file-based personal operating system for an AI agent. The repo is its **brain**: context, memory, and skills stored in markdown, YAML, and JSONL. No database, no API keys. Design follows **context engineering** — progressive disclosure of the right information at the right time. The instance name is configurable via `brain/settings.json` → `instanceName`.

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

## File-based brain (brain/)

The brain has five modules, each with an instruction file and data files:

| Module | Instruction file | Data files |
|--------|-----------------|------------|
| **memory** | `brain/memory/README.md` | `*.jsonl` (experiences, decisions, failures, semantic, procedural) |
| **identity** | — | `tone-of-voice.md`, `brand.md` |
| **content** | `brain/content/CONTENT.md` | `templates/blog.md`, drafts |
| **operations** | `brain/operations/OPERATIONS.md` | `goals.yaml`, `todos.md` |
| **knowledge** | `brain/knowledge/README.md` | `research/`, `bookmarks/`, `notes/` |

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
