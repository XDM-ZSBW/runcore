# Developer Guide

This guide covers how to build with Dash's TypeScript SDK, extend its integrations, and work with the file-based brain.

---

## SDK Overview

Dash's public API is exported from the `dash-brain` package:

```ts
import {
  Brain,
  FileSystemLongTermMemory,
  InMemoryLongTermMemory,
  createWorkingMemory,
  updateWorkingMemory,
  formatWorkingMemoryForContext,
  assembleSections,
  sectionsToMessages,
  estimateTokens,
} from "dash-brain";

import type {
  BrainConfig,
  GetContextOptions,
  GetContextResult,
  LearnInput,
  ContextMessage,
  ContextSections,
  WorkingMemory,
  MemoryEntry,
  LongTermMemoryType,
  LongTermMemoryStore,
  ContextAssemblerConfig,
} from "dash-brain";
```

---

## Brain Class

The `Brain` is the central orchestrator for memory retrieval and context assembly.

### Creating a Brain

```ts
import { Brain, FileSystemLongTermMemory } from "dash-brain";
import { join } from "node:path";

// File-backed (persistent)
const brain = new Brain(
  {
    systemPrompt: "You are Dash, a personal AI assistant.",
    defaultInstructions: "Be concise. Use retrieved memory when relevant.",
    defaultCues: "Respond in markdown format.",
    maxRetrieved: 5,
    maxSupportingTokens: 2000,
  },
  new FileSystemLongTermMemory(join(process.cwd(), "brain", "memory"))
);

// In-memory only (for testing)
const testBrain = new Brain({
  systemPrompt: "Test brain",
});
```

### Configuration Options

```ts
interface BrainConfig {
  systemPrompt: string;          // Required. The base system prompt.
  defaultInstructions?: string;  // Additional instructions added to every turn.
  defaultCues?: string;          // Output format hints appended to context.
  maxRetrieved?: number;         // Max memory entries to retrieve (default: 5).
  maxSupportingTokens?: number;  // Token budget for supporting content.
}
```

### Retrieving Context for a Turn

```ts
const result = await brain.getContextForTurn({
  userInput: "What did we decide about the database?",
  conversationHistory: [
    { role: "user", content: "Let's discuss the project architecture" },
    { role: "assistant", content: "Sure! What aspects would you like to cover?" },
  ],
  maxTokens: 4000,
  retrievalQuery: "database decision architecture",  // Optional: custom retrieval query
  maxRetrieved: 10,                                    // Optional: override default
});

// result.messages — LLM-ready message array [system, ...history, user]
// result.sections — Raw context sections before message conversion
// result.workingMemory — Current working memory state
```

### Learning (Writing to Memory)

```ts
// Semantic memory (facts, preferences)
await brain.learn({
  type: "semantic",
  content: "User prefers TypeScript over JavaScript for all projects.",
  meta: { category: "preference", confidence: 0.9 },
});

// Episodic memory (experiences)
await brain.learn({
  type: "episodic",
  content: "Shipped v2.0 of the dashboard. Took 3 weeks.",
  meta: { emotional_weight: 7, project: "dashboard" },
});

// Procedural memory (how-to)
await brain.learn({
  type: "procedural",
  content: "To deploy: run npm run build, then push to main branch.",
  meta: { domain: "deployment" },
});
```

### Working Memory

Working memory is a per-turn scratchpad that resets between interactions:

```ts
// Set the current goal
brain.getWorkingMemory();  // Read-only access

// Track reasoning (ReAct pattern)
brain.setLastThought("User is asking about past decisions. I should search episodic memory.");

// Clear between turns
brain.clearWorkingMemory();       // Keep scratch space
brain.clearWorkingMemory(true);   // Clear everything including scratch
```

---

## Memory Implementations

### FileSystemLongTermMemory

Reads and writes `brain/memory/*.jsonl`. This is the primary production implementation.

```ts
import { FileSystemLongTermMemory } from "dash-brain";

const ltm = new FileSystemLongTermMemory("/path/to/brain/memory");

// List all entries of a type
const allSemantic = await ltm.list("semantic");

// Search by content substring
const results = await ltm.search({
  type: "episodic",
  contentSubstring: "database",
});

// Search by metadata
const decisions = await ltm.search({
  type: "episodic",
  meta: { category: "decision" },
});

// Add a new entry (appends to JSONL)
const entry = await ltm.add({
  type: "semantic",
  content: "Dash uses Hono for the HTTP server.",
});

// Get by ID
const specific = await ltm.get("entry_id_here");
```

**File mapping:**
| Memory Type | File |
|------------|------|
| `episodic` | `experiences.jsonl` |
| `semantic` | `semantic.jsonl` |
| `procedural` | `procedural.jsonl` |

**Important:** Files are append-only. The `delete()` method is a no-op. To archive entries, set `status: "archived"` in metadata.

### InMemoryLongTermMemory

Map-based implementation for testing. Same interface, no persistence.

```ts
import { InMemoryLongTermMemory } from "dash-brain";

const ltm = new InMemoryLongTermMemory();
// Same API as FileSystemLongTermMemory
```

### Custom Implementation

Implement the `LongTermMemoryStore` interface for custom backends:

```ts
import type { LongTermMemoryStore, MemoryEntry, LongTermMemoryType } from "dash-brain";

class PostgresMemory implements LongTermMemoryStore {
  async list(type?: LongTermMemoryType): Promise<MemoryEntry[]> { /* ... */ }
  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> { /* ... */ }
  async get(id: string): Promise<MemoryEntry | null> { /* ... */ }
  async delete(id: string): Promise<boolean> { /* ... */ }
  async search(query: {
    type?: LongTermMemoryType;
    contentSubstring?: string;
    meta?: Record<string, unknown>;
  }): Promise<MemoryEntry[]> { /* ... */ }
}

const brain = new Brain(config, new PostgresMemory());
```

---

## Context Assembly

The context assembler converts working memory and options into LLM-ready messages.

### Building Sections

```ts
import { assembleSections, sectionsToMessages, estimateTokens } from "dash-brain";

const sections = assembleSections(
  brain.getWorkingMemory(),
  {
    userInput: "Tell me about our goals",
    conversationHistory: [],
  },
  {
    systemPrompt: "You are Dash.",
    defaultInstructions: "Be helpful.",
    defaultCues: "Use markdown.",
    maxSupportingTokens: 2000,
  }
);

// sections.supportingContent — Retrieved memories formatted as text
// sections.instructions — System prompt + defaults
// sections.examples — Few-shot examples (if any)
// sections.cues — Output format hints
// sections.primaryContent — The user's input

const messages = sectionsToMessages(sections, conversationHistory);
// messages = [
//   { role: "system", content: "..." },
//   ...conversationHistory,
//   { role: "user", content: "..." }
// ]
```

### Token Estimation

```ts
const tokens = estimateTokens("Some text here");
// tokens ≈ text.length / 4
```

### History Compaction

When conversation history exceeds 20 messages, use compaction:

```ts
import { compactHistory } from "dash-brain/context";

const result = await compactHistory(
  history,                    // Full conversation history
  existingSummary,            // Previous summary (or "")
  "openrouter",               // Provider
  "meta-llama/llama-3.1-8b-instruct"  // Model
);

if (result.compacted) {
  // result.summary — Compressed summary of older messages
  // result.trimmedHistory — Last 6 messages kept verbatim
}
```

---

## LLM Integration

### Streaming Chat

```ts
import { streamChat } from "./llm/openrouter.js";
import { streamChatLocal } from "./llm/ollama.js";

// OpenRouter (cloud)
await streamChat({
  messages: [
    { role: "system", content: "You are Dash." },
    { role: "user", content: "Hello!" },
  ],
  model: "anthropic/claude-sonnet-4",
  onToken: (token) => process.stdout.write(token),
  onDone: () => console.log("\n[Done]"),
  onError: (err) => console.error(err),
  signal: abortController.signal,
});

// Ollama (local)
await streamChatLocal({
  messages: [/* same format */],
  model: "llama3.1:8b",
  onToken: (token) => process.stdout.write(token),
  onDone: () => console.log("\n[Done]"),
  onError: (err) => console.error(err),
});
```

### Non-Streaming Completion

```ts
import { completeChat } from "./llm/complete.js";

const response = await completeChat({
  messages: [
    { role: "system", content: "Extract key facts from this text." },
    { role: "user", content: longText },
  ],
  provider: "openrouter",
  model: "meta-llama/llama-3.1-8b-instruct",
});
// response is a string
```

### Checking Ollama

```ts
import { checkOllama } from "./llm/ollama.js";

const status = await checkOllama("llama3.1:8b");
// { available: true, model: "llama3.1:8b" }
// { available: false, error: "Connection refused" }
```

---

## Board Provider Integration

### Using the Generic Board Interface

```ts
import type { BoardProvider } from "./board/types.js";
import { getBoardProvider, setBoardProvider } from "./board/provider.js";

const board = getBoardProvider();
if (board && board.isAvailable()) {
  // List issues
  const issues = await board.listIssues({
    teamId: "team-123",
    stateType: "started",
    limit: 20,
  });

  // Create an issue
  const issue = await board.createIssue("Fix login bug", {
    description: "Users can't log in with email",
    priority: 1,
    stateId: "todo",
  });

  // Update issue state
  await board.updateIssue(issue.id, { stateId: "done" });

  // Add a comment
  await board.addComment(issue.id, "Fixed in commit abc123");
}
```

### Linear Integration

```ts
import { LinearBoardProvider } from "./linear/client.js";

const linear = new LinearBoardProvider();
// Requires LINEAR_API_KEY in process.env (set via vault)

if (linear.isAvailable()) {
  const teams = await linear.getTeams();
  const states = await linear.getTeamStates(teams[0].id);
  const issues = await linear.listIssues({ teamId: teams[0].id });
}
```

### Local Queue

```ts
import { QueueBoardProvider } from "./queue/provider.js";

const queue = new QueueBoardProvider("brain");
// Always available — no external dependencies

const task = await queue.createIssue("Implement dark mode", {
  description: "Add theme toggle to settings",
  priority: 3,
});

// Access the underlying QueueStore for advanced operations
const store = queue.getStore();
await store.addExchange(task.id, {
  author: "dash",
  body: "Started research on theme libraries",
  source: "chat",
});
```

### Bidirectional Linear Sync

```ts
import { syncWithLinear } from "./queue/sync.js";
import { startSyncTimer, stopSyncTimer } from "./queue/timer.js";

// One-time sync
const result = await syncWithLinear(store);
// { pushed: 3, pulled: 2, errors: [] }

// Background sync (every 5 minutes)
startSyncTimer(store, 5 * 60 * 1000);
// ...later
stopSyncTimer();
```

---

## Agent System

### Spawning Tasks (Simple)

```ts
import { initAgents, submitTask, getTask, getTaskOutput, cancelTask, listTasks } from "./agents/index.js";

// Initialize on startup
await initAgents();

// Submit a task
const task = await submitTask({
  label: "Research competitor pricing",
  prompt: "Research and summarize competitor pricing models for AI assistants. Output a markdown table.",
  origin: "user",
  timeoutMs: 300000, // 5 min
});

// Check status
const updated = await getTask(task.id);
console.log(updated.status); // "running" | "completed" | "failed"

// Get output
const output = await getTaskOutput(task.id);

// Cancel if needed
await cancelTask(task.id);
```

### Agent Runtime (Advanced)

```ts
import { createRuntime, getRuntime, shutdownRuntime } from "./agents/runtime/index.js";

// Create runtime with config
const runtime = await createRuntime({
  maxConcurrentAgents: 5,
  defaultTimeoutMs: 300000,
  maxTotalMemoryMB: 2048,
  monitorIntervalMs: 15000,
});

// Spawn an agent instance
const instance = await runtime.spawn({
  taskId: "task_123",
  label: "Deep research",
  prompt: "Comprehensive analysis of...",
  origin: "ai",
  config: {
    timeoutMs: 600000,
    maxRetries: 3,
    backoffMs: 1000,
    isolation: "sandboxed",
  },
  resources: {
    memoryLimitMB: 512,
    cpuWeight: 80,
  },
});

// Pause and resume
await runtime.pause(instance.id, "User requested pause");
await runtime.resume(instance.id);

// Inter-agent messaging
runtime.sendMessage("agent_1", "agent_2", "data_request", { query: "results" });
runtime.onMessage("agent_2", "data_request", (msg) => {
  console.log("Received:", msg.payload);
});

// Monitor resources
const snapshot = runtime.getResourceSnapshot();
console.log(`Active: ${snapshot.activeAgents}/${snapshot.maxAgents}`);

// Shutdown
await shutdownRuntime("Server shutting down");
```

---

## Search Integration

### Search Classification

```ts
import { classifySearchNeed } from "./search/classify.js";

const result = await classifySearchNeed(
  "What's the current price of Bitcoin?",
  "openrouter",
  "meta-llama/llama-3.1-8b-instruct"
);
// { needsSearch: true, query: "Bitcoin current price 2026", trigger: "auto" }
```

### Web Search

```ts
import { search, isSearchAvailable } from "./search/client.js";

if (isSearchAvailable()) {
  const result = await search("TypeScript best practices 2026");
  // { results: "...", query: "TypeScript best practices 2026" }
}
```

### URL Browsing

```ts
import { browseUrl, detectUrl } from "./search/browse.js";

// Detect URL in user message
const url = detectUrl("Check out https://example.com/article");
if (url) {
  const page = await browseUrl(url);
  // { url, title, text (up to 8KB), truncated }
}
```

---

## File Ingestion

### Directory Ingestion

```ts
import { ingestDirectory } from "./files/ingest.js";

const result = await ingestDirectory("/path/to/project", {
  budget: 12000,  // Character budget (~3K tokens)
});
// { content: "...", files: ["file1.md", "file2.ts", ...], truncated: false }
```

Supported file types: `.md`, `.txt`, `.json`, `.yaml`, `.ts`, `.js`, `.pdf`, `.png`, `.jpg`, and more.

Automatically skips: `node_modules`, `.git`, `dist`, `.next`, `__pycache__`.

### Text Extraction

```ts
import { extractPdfText, extractImageText } from "./files/extract.js";
import { readFile } from "node:fs/promises";

const pdfBuffer = await readFile("document.pdf");
const pdfText = await extractPdfText(pdfBuffer);

const imageBuffer = await readFile("screenshot.png");
const ocrText = await extractImageText(imageBuffer);
```

---

## Settings Management

```ts
import {
  loadSettings,
  getSettings,
  updateSettings,
  resolveProvider,
  resolveChatModel,
  resolveUtilityModel,
} from "./settings.js";

// Load from brain/settings.json (call once on startup)
await loadSettings();

// Read current settings
const settings = getSettings();
console.log(settings.airplaneMode); // true | false

// Update settings
await updateSettings({
  airplaneMode: false,
  models: { chat: "anthropic/claude-sonnet-4", utility: "meta-llama/llama-3.1-8b-instruct" },
});

// Resolve provider based on settings
const provider = resolveProvider();  // "ollama" | "openrouter"
const chatModel = resolveChatModel();  // Model string or undefined
```

---

## Extending Dash

### Adding a New Board Provider

Implement the `BoardProvider` interface:

```ts
import type { BoardProvider, BoardIssue, BoardTeam, BoardState, BoardUser } from "./board/types.js";

class JiraBoardProvider implements BoardProvider {
  readonly name = "Jira";

  isAvailable(): boolean {
    return !!process.env.JIRA_API_TOKEN;
  }

  async getMe(): Promise<BoardUser | null> { /* ... */ }
  async getTeams(): Promise<BoardTeam[]> { /* ... */ }
  async getTeamStates(teamId: string): Promise<BoardState[]> { /* ... */ }
  async listIssues(opts?: { teamId?: string; stateType?: string; limit?: number }): Promise<BoardIssue[]> { /* ... */ }
  async createIssue(title: string, opts?: {}): Promise<BoardIssue | null> { /* ... */ }
  async updateIssue(id: string, opts: {}): Promise<BoardIssue | null> { /* ... */ }
  async addComment(issueId: string, body: string): Promise<boolean> { /* ... */ }
  async findByIdentifier(identifier: string): Promise<BoardIssue | null> { /* ... */ }
  async getDoneStateId(teamId: string): Promise<string | null> { /* ... */ }
}
```

Register it:
```ts
import { setBoardProvider } from "./board/provider.js";
setBoardProvider(new JiraBoardProvider());
```

### Adding a New LTM Backend

Implement `LongTermMemoryStore` (see Custom Implementation section above), then pass it to the `Brain` constructor.

### Adding a New Sidecar

Follow the existing pattern:

1. Create `src/your-sidecar/client.ts` — HTTP client for the sidecar API
2. Create `src/your-sidecar/sidecar.ts` — Lifecycle management (start, stop, health check)
3. Add routes in `src/server.ts`
4. Add capability check to `GET /api/status`

Sidecar conventions:
- `start*Sidecar()` → Returns `Promise<boolean>`
- `is*Available()` → Returns `boolean`
- `stop*Sidecar()` → Returns `void`
- Health check with timeout on startup
- Graceful degradation: features disabled if sidecar unavailable

---

## Working with JSONL Files Directly

If you're building tools that read Dash's brain files without the TypeScript runtime:

### Reading JSONL

```python
# Python example
import json

memories = []
with open("brain/memory/experiences.jsonl") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get("type") == "_schema":
            continue  # Skip schema header
        if entry.get("status") == "archived":
            continue  # Skip archived entries
        memories.append(entry)
```

### Writing JSONL (Append-Only)

```python
import json
import uuid
from datetime import datetime

entry = {
    "id": str(uuid.uuid4()),
    "type": "semantic",
    "content": "User prefers dark mode.",
    "meta": {"category": "preference"},
    "createdAt": datetime.utcnow().isoformat() + "Z"
}

with open("brain/memory/semantic.jsonl", "a") as f:
    f.write(json.dumps(entry) + "\n")
```

**Rules:**
- Never rewrite or truncate JSONL files
- Always append new lines
- Use `status: "archived"` for soft-delete
- Each file starts with a `_schema` header line — preserve it

### JSONL Schemas

**experiences.jsonl:**
```json
{"date": "2026-02-27", "summary": "Shipped v2.0", "emotional_weight": 7, "tags": ["milestone"], "status": "active"}
```

**decisions.jsonl:**
```json
{"date": "2026-02-27", "context": "Choosing DB", "options": ["Postgres", "SQLite"], "reasoning": "...", "outcome": "Postgres", "status": "active"}
```

**failures.jsonl:**
```json
{"date": "2026-02-27", "summary": "Deploy broke prod", "root_cause": "Missing migration", "prevention": "Add CI check", "status": "active"}
```

**semantic.jsonl / procedural.jsonl (runtime format):**
```json
{"id": "uuid", "type": "semantic", "content": "Fact text", "meta": {"key": "value"}, "createdAt": "2026-02-27T10:00:00.000Z"}
```
