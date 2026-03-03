# Core

**A file-based personal operating system for your AI agent.** Clone the repo, configure your instance name, and the agent has everything: voice, goals, memory, skills. No database, no API keys for the brain itself. Just files in markdown, YAML, and JSONL that both humans and language models read natively.

Inspired by **[Muratcan Koylan's "Personal Brain OS"](https://x.com/koylanai/status/2025286163641118915)** (file system as memory, progressive disclosure, agent instruction hierarchy, skill system), plus [Context Engineering](https://www.agent32.org/agent-architecture-overview-from-prompt-to-context/) and the [COALA](https://arxiv.org/pdf/2309.02427) framework.

---

## Getting Started

```bash
# 1. Clone
git clone https://github.com/yourusername/core.git
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

## Principle: context engineering, not prompt engineering

> "Prompt engineering asks 'how do I phrase this question better?' Context engineering asks 'what information does this AI need to make the right decision, and how do I structure that information so the model actually uses it?'"
> — Muratcan Koylan, [Personal Brain OS](https://x.com/koylanai/status/2025286163641118915)

The bottleneck isn't a better prompt. It's **attention budget** and **information architecture**. This repo is designed so the right information loads at the right time — routing first, then module instructions, then data — with no giant system prompt dump.

---

## Layout

```
Core/
├── CLAUDE.md          ← Repo map for AI. Read first.
├── AGENT.md           ← Core rules and decision table.
├── SKILL.md           ← Routing: which module for which task.
│
├── brain/             ← File-based brain (modules + data)
│   ├── memory/        ← Episodic: experiences.jsonl, decisions.jsonl, failures.jsonl, semantic.jsonl, procedural.jsonl
│   ├── identity/      ← Voice, brand (tone-of-voice.md, brand.md)
│   ├── content/       ← CONTENT.md, templates (blog, thread, research)
│   ├── operations/    ← OPERATIONS.md, goals.yaml, todos.md
│   └── knowledge/     ← Research, bookmarks, notes
│
├── skills/            ← Agent skills (YAML frontmatter + instructions). Auto-load or slash-invoke.
│
├── docs/              ← Design docs
│
└── src/               ← TypeScript runtime: Brain class, context assembly, file-backed memory, HTTP server
```

---

## For AI assistants (Cursor, Claude Code, etc.)

1. **Read [CLAUDE.md](CLAUDE.md)** for the project map.
2. **Read [AGENT.md](AGENT.md)** for core rules and the decision table.
3. **Read [SKILL.md](SKILL.md)** to route: content → content module, memory → memory module, etc.
4. **Load only what you need.** Level 1 = SKILL + AGENT. Level 2 = module instruction file. Level 3 = data (JSONL lines, YAML, specific markdown). Do not load all files.
5. **Memory is append-only.** When writing to `brain/memory/*.jsonl`, append one line. Never overwrite the file.

---

## Optional runtime (TypeScript)

If you want programmatic context assembly and file-backed memory from Node:

```bash
npm install
npm run build
```

```ts
import { Brain, FileSystemLongTermMemory } from "core-brain";
import { join } from "node:path";

const brain = new Brain(
  {
    systemPrompt: "You are a personal AI agent. Use the context and memory below when relevant.",
    defaultInstructions: "Be concise. Use retrieved memory when relevant.",
  },
  new FileSystemLongTermMemory(join(process.cwd(), "brain", "memory"))
);

// Assemble context for this turn (reads from brain/memory/*.jsonl)
const { messages, workingMemory } = await brain.getContextForTurn({
  userInput: "What did we decide about the project?",
  conversationHistory: [],
});

// Persist to brain/memory/semantic.jsonl (append-only)
await brain.learn({
  type: "semantic",
  content: "User prefers weekly summaries on Mondays.",
});
```

---

## Concepts

| Concept | Implementation |
|--------|----------------|
| **Progressive disclosure** | Level 1: SKILL.md + AGENT.md. Level 2: module instruction file (e.g. CONTENT.md). Level 3: data files only when needed. |
| **Agent instruction hierarchy** | Repo: CLAUDE.md. Brain: AGENT.md. Module: CONTENT.md, OPERATIONS.md, etc. Scoped rules, no conflicts. |
| **File system as memory** | JSONL for logs (append-only). YAML for config. Markdown for narrative. No DB; Git versions everything. |
| **Episodic memory** | experiences.jsonl, decisions.jsonl, failures.jsonl — judgment and facts. Append-only. |
| **Skills** | Reference skills (auto-load when task type matches). Task skills (user invokes with /command). See [skills/README.md](skills/README.md). |

---

## References

- **[The File System Is the New Database: How I Built a Personal OS for AI Agents](https://x.com/koylanai/status/2025286163641118915)** — Muratcan Koylan. Personal Brain OS, progressive disclosure, format–function mapping, skill system.
- [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering) — Skill format and patterns.
- [Agent Architecture: From Prompt to Context](https://www.agent32.org/agent-architecture-overview-from-prompt-to-context/) — Context engineering as the core discipline.
- [Beyond the Prompt (COALA)](https://medium.com/google-cloud/beyond-the-prompt-why-your-next-ai-agent-needs-a-brain-and-how-coala-research-paper-provides-an-ba187a906ea0) — Modular memory, internal/external actions.
