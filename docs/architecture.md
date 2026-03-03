# Architecture Overview

Dash is a file-based personal operating system for an AI agent. The codebase implements a **brain** — context, memory, and skills stored in markdown, YAML, and JSONL — with an optional TypeScript runtime that adds programmatic context assembly, an HTTP API, and integrations.

---

## Design Philosophy

**Context engineering, not prompt engineering.** The bottleneck is attention budget and information architecture, not better prompts. Dash is designed so the right information loads at the right time — routing first, then module instructions, then data — with no giant system prompt dump.

Key principles:

- **Progressive disclosure** — Three levels: routing (SKILL.md + AGENT.md) → module instructions → data files. Never load everything.
- **File system as database** — JSONL for structured logs (append-only), YAML for config, Markdown for narrative. Git versions everything.
- **Offline-first** — Every component works locally. Cloud services (OpenRouter, Linear, Perplexity) are optional enhancements.
- **Graceful degradation** — Sidecars (TTS, STT, Avatar, Search) are optional. Failures return null; the app continues.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         HTTP Server (Hono)                          │
│                          Port 3577                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │   Auth    │  │   Chat   │  │  Board   │  │  Agents  │   ...     │
│  │  Routes   │  │  Routes  │  │  Routes  │  │  Routes  │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
└───────┼──────────────┼──────────────┼──────────────┼────────────────┘
        │              │              │              │
┌───────┴──────────────┴──────────────┴──────────────┴────────────────┐
│                        Core Services                                │
│                                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │  Brain   │  │   Identity   │  │   Vault     │  │  Settings  │  │
│  │ (Memory  │  │   (Pairing   │  │  (Encrypted │  │  (Airplane │  │
│  │  Context │  │    Crypto)   │  │   Key Store)│  │   Models)  │  │
│  │  LTM)    │  │              │  │             │  │            │  │
│  └────┬─────┘  └──────────────┘  └─────────────┘  └────────────┘  │
│       │                                                             │
│  ┌────┴──────────────────────────────────────────────────────────┐  │
│  │                     File-Based Brain                          │  │
│  │  brain/memory/*.jsonl  brain/identity/  brain/operations/     │  │
│  │  brain/knowledge/      brain/content/   brain/settings.json   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
        │              │              │              │
┌───────┴──────────────┴──────────────┴──────────────┴────────────────┐
│                       Integrations                                  │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │   LLM    │  │  Linear  │  │  Search  │  │  Twilio  │           │
│  │ OpenRouter│  │  Board   │  │Perplexity│  │  Calls   │           │
│  │  Ollama  │  │  Sync    │  │DuckDuckGo│  │          │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │   TTS    │  │   STT    │  │  Avatar  │  │  Agent   │           │
│  │  Piper   │  │ Whisper  │  │ MuseTalk │  │ Runtime  │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Relationships

### Brain (Core Orchestrator)

The `Brain` class (`src/brain.ts`) is the central component. It composes:

1. **Long-Term Memory (LTM)** — Persistent storage of episodic, semantic, and procedural knowledge
2. **Working Memory** — Per-turn scratchpad (active goal, retrieved items, scratch space)
3. **Context Assembly** — Builds structured context sections from memory + user input → LLM-ready messages

```
User Input ──→ Brain.getContextForTurn()
                  │
                  ├── Retrieve from LTM (substring + metadata search)
                  ├── Update working memory
                  ├── Assemble context sections
                  │    ├── supportingContent (retrieved memories)
                  │    ├── instructions (system prompt + defaults)
                  │    ├── examples (few-shot, optional)
                  │    ├── cues (output format hints)
                  │    └── primaryContent (user input)
                  └── Convert to LLM message array
                       └── [system, ...history, user] ──→ LLM
```

### Memory System

Two layers of memory work together:

| Layer | Implementation | Persistence | Use Case |
|-------|---------------|-------------|----------|
| **Working Memory** | In-memory object | Per-turn only | Active goal, retrieved items, scratch |
| **Long-Term Memory** | `FileSystemLongTermMemory` | `brain/memory/*.jsonl` | Experiences, semantic facts, procedures |

LTM type-to-file mapping:
- `episodic` → `experiences.jsonl` (experiences, decisions, failures)
- `semantic` → `semantic.jsonl` (facts, preferences, knowledge)
- `procedural` → `procedural.jsonl` (how-to, workflows)

All JSONL files are **append-only**. Entries are archived with `status: "archived"`, never deleted.

### LLM Provider System

Dual-provider architecture with automatic fallback:

```
Settings (airplane mode?) ──→ resolveProvider()
                                │
                         ┌──────┴──────┐
                         │             │
                    "ollama"      "openrouter"
                    (local)        (cloud)
                         │             │
                    Ollama API    OpenRouter API
                   localhost:11434  openrouter.ai
```

- **Streaming** — Used for chat (`streamChat` / `streamChatLocal`)
- **Non-streaming** — Used for background tasks: extraction, classification, goal checks (`completeChat`)
- **Model resolution** — Configurable per-task. Defaults: `anthropic/claude-sonnet-4` (chat), `meta-llama/llama-3.1-8b-instruct` (utility)

### Board & Queue System

Task management with bidirectional Linear sync:

```
              QueueStore (JSONL)
             brain/operations/queue.jsonl
                      │
           ┌──────────┴──────────┐
           │                     │
    QueueBoardProvider     syncWithLinear()
    (always available)      (every 5 min)
           │                     │
    BoardProvider             Linear API
    interface                  (@linear/sdk)
           │                     │
           └──────────┬──────────┘
                      │
              LinearBoardProvider
              (when API key set)
```

- **Local-authoritative** — The local queue is source of truth
- **Bidirectional sync** — Push unsynced local tasks to Linear; pull new Linear issues locally
- **Last-write-wins** — By timestamp; conflicts resolved by most recent update

### Agent Runtime

Two-tier agent execution:

| Tier | Component | Description |
|------|-----------|-------------|
| **Simple** | `agents/spawn.ts` | Spawns `claude --print` CLI as subprocess. Fire-and-forget with log capture. |
| **Advanced** | `agents/runtime/` | Full lifecycle management: spawn, pause, resume, terminate. Resource pools, inter-agent messaging, retry with backoff. |

Agent lifecycle:
```
CreateTaskInput ──→ submitTask()
                      │
                      ├── createTask() (persist to brain/agents/tasks/)
                      ├── spawnAgent() (claude CLI subprocess)
                      │    ├── stdout → brain/agents/logs/{id}.stdout
                      │    ├── stderr → brain/agents/logs/{id}.stderr
                      │    └── on exit → rememberTaskOutcome() (→ episodic LTM)
                      └── monitor (poll every 15s for dead PIDs)
```

### Authentication Flow

```
First Visit:                    Return Visit:

ensurePairingCode()            authenticate(safeWord)
  → 6-word code                  → PBKDF2 → session key
                                 → validate session
pair(code, name, safeWord)       → decrypt vault → hydrate env
  → PBKDF2 → derive key
  → create human.json
  → create session
  → encrypt vault
  → hydrate API keys
```

All encryption uses AES-256-GCM with PBKDF2-derived keys (600k iterations, SHA-256).

### Search Pipeline

Three-tier classification before searching:

```
User Message
    │
    ├── Tier 1: Regex fast-path
    │   (explicit "search for", "look up", etc.)
    │
    ├── Tier 2: Heuristic skip
    │   (short messages, greetings, URLs → skip)
    │
    └── Tier 3: LLM classifier
        (cheap model decides if search would help)
            │
            ├── Perplexity Sonar API (preferred)
            │
            └── DuckDuckGo sidecar (fallback)
```

### Sidecar Architecture

Optional Python processes managed by the TypeScript server:

| Sidecar | Port | Purpose | Technology |
|---------|------|---------|------------|
| TTS | 3579 | Text-to-speech synthesis | Piper (xtts-v2) |
| STT | 3580 | Speech-to-text transcription | Whisper |
| Avatar | Configurable | Lip-sync video generation | MuseTalk |
| Search | Configurable | Web search fallback | DuckDuckGo (Python) |

Each sidecar has:
- **Lifecycle management** — `start*Sidecar()`, `stop*Sidecar()`, `is*Available()`
- **Health checks** — Probed on startup
- **Graceful degradation** — Features disabled if sidecar unavailable

---

## Data Flow

### Chat Request Lifecycle

```
1. Client POST /api/chat
   ├── body: { message, sessionId }
   │
2. Server middleware
   ├── Validate session
   ├── Load session data (encrypted → decrypt)
   │
3. Pre-processing (parallel, fire-and-forget)
   ├── classifySearchNeed() → web search if needed
   ├── detectUrl() → browseUrl() if URL found
   ├── processIngestFolder() → check for new files
   ├── drainNotifications() → prepend goal notifications
   │
4. Context assembly
   ├── brain.getContextForTurn()
   │   ├── Retrieve from LTM
   │   ├── Build context sections
   │   └── Merge with conversation history
   ├── Compact history if > 20 messages
   │
5. LLM streaming
   ├── streamChat() (OpenRouter) or streamChatLocal() (Ollama)
   ├── SSE tokens → client
   │
6. Post-processing (fire-and-forget)
   ├── extractAndLearn() → persist durable facts
   ├── Save session (encrypt → write)
   └── logActivity()
```

### Goal Check Lifecycle

```
Background timer (every 30 min)
    │
    └── runGoalCheck()
        ├── Read goals.yaml + todos.md
        ├── Retrieve recent episodic memories
        ├── LLM decides action
        │   ├── "remind" → push notification
        │   ├── "search" → web search → persist to semantic LTM
        │   ├── "call" → Twilio phone call
        │   ├── "log" → record to semantic LTM
        │   └── "nothing" → no-op
        └── Log outcome to episodic memory
```

---

## File-Based Brain Modules

The brain has five modules, each with an instruction file and data files:

```
brain/
├── memory/          Episodic memory (append-only JSONL)
│   ├── README.md         Instruction file
│   ├── experiences.jsonl  Experiences with emotional_weight
│   ├── decisions.jsonl    Decisions with reasoning + alternatives
│   ├── failures.jsonl     Failures with root_cause + prevention
│   ├── semantic.jsonl     Facts, preferences, knowledge
│   └── procedural.jsonl   How-to, workflows
│
├── identity/        Voice and brand
│   ├── tone-of-voice.md   Voice profile, banned words, patterns
│   ├── brand.md           Positioning, guardrails
│   ├── personality.md     Personality traits
│   └── human.json         Paired user identity (encrypted fields)
│
├── content/         Content pipeline
│   ├── CONTENT.md         Pipeline instructions
│   └── templates/         Blog, thread, research templates
│
├── operations/      Goals and tasks
│   ├── OPERATIONS.md      Instructions
│   ├── goals.yaml         Key results, progress, targets
│   ├── todos.md           P0–P3 prioritized tasks
│   ├── changelog.md       Release notes
│   └── queue.jsonl        Internal task queue (Linear sync)
│
└── knowledge/       Research and reference
    ├── README.md          Instructions
    └── research/          Topic research files
```

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js + TypeScript (ES2022, ESM) | Server and core logic |
| HTTP Framework | Hono + @hono/node-server | API server |
| Project Management | @linear/sdk | Linear integration |
| PDF Extraction | pdf-parse, unpdf | Document ingestion |
| OCR | tesseract.js | Image text extraction |
| Document Parsing | mammoth | DOCX extraction |
| LLM (Cloud) | OpenRouter API | Chat and utility completions |
| LLM (Local) | Ollama API | Offline-first completions |
| Search | Perplexity Sonar API | Web search |
| Voice | Piper TTS, Whisper STT | Voice I/O sidecars |
| Avatar | MuseTalk | Lip-sync video generation |
| Telephony | Twilio REST API | Phone calls |

---

## Key Architectural Decisions

1. **No database** — Files are the database. JSONL for structured data, YAML for config, Markdown for narrative. Git provides versioning, diffing, and backup.

2. **Append-only memory** — JSONL files are never rewritten. Entries are archived with `status: "archived"`. This prevents data loss and creates an audit trail.

3. **Dual LLM providers** — Ollama for offline/private use, OpenRouter for cloud models. Airplane mode toggles between them automatically.

4. **Local-authoritative task queue** — The local JSONL queue is source of truth, not Linear. Linear is a sync target for visibility. This ensures Dash works offline.

5. **Sidecar pattern** — Python processes (TTS, STT, Avatar, Search) run alongside the Node server. Each is optional, health-checked, and gracefully degraded.

6. **Encryption at rest** — Session data and API keys are encrypted with AES-256-GCM. Keys derived from user's safe word via PBKDF2. No plaintext secrets on disk.

7. **Fire-and-forget background tasks** — Extraction, learning, goal checks, and sync never throw. Errors are logged, not propagated. The chat flow is never blocked by background operations.
