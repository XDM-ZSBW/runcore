# API Reference

Dash exposes an HTTP API via Hono on **port 3577**. All routes are prefixed with `/api/` unless otherwise noted.

---

## Authentication

Most endpoints require a valid session. After pairing, include the session ID:
- Query parameter: `?sessionId=<id>`
- The session ID is returned by `POST /api/pair` and `POST /api/auth`

---

## Status & Configuration

### GET /api/status

Returns pairing status, provider info, and available capabilities.

**Response:**
```json
{
  "paired": true,
  "name": "Alex",
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4",
  "capabilities": {
    "tts": true,
    "stt": true,
    "avatar": false,
    "search": true,
    "board": true
  }
}
```

### GET /api/settings

Returns current settings and resolved provider/models.

**Response:**
```json
{
  "settings": {
    "airplaneMode": false,
    "models": {
      "chat": "anthropic/claude-sonnet-4",
      "utility": "meta-llama/llama-3.1-8b-instruct"
    },
    "tts": { "enabled": true, "port": 3579, "voice": "en_US-lessac-medium", "autoPlay": false },
    "stt": { "enabled": true, "port": 3580, "model": "ggml-base.en.bin" },
    "avatar": { "enabled": false, "port": 3581, "musetalkPath": "", "photoPath": "" }
  },
  "resolved": {
    "provider": "openrouter",
    "chatModel": "anthropic/claude-sonnet-4",
    "utilityModel": "meta-llama/llama-3.1-8b-instruct"
  }
}
```

### PUT /api/settings

Update settings. Partial updates supported — only include fields to change.

**Request:**
```json
{
  "airplaneMode": true,
  "models": { "chat": "llama3.1:8b" }
}
```

**Response:** Updated settings object (same shape as GET).

---

## Authentication & Pairing

### POST /api/pair

First-time pairing ceremony. Establishes identity and encryption keys.

**Request:**
```json
{
  "code": "alpha bravo charlie delta echo foxtrot",
  "name": "Alex",
  "safeWord": "my-secret-phrase",
  "recoveryQuestion": "What city were you born in?",
  "recoveryAnswer": "Portland"
}
```

**Response:**
```json
{
  "ok": true,
  "session": {
    "id": "a1b2c3d4...",
    "name": "Alex",
    "createdAt": 1709000000000
  }
}
```

### POST /api/auth

Return-visit authentication with safe word.

**Request:**
```json
{
  "safeWord": "my-secret-phrase"
}
```

**Response:**
```json
{
  "ok": true,
  "session": {
    "id": "a1b2c3d4...",
    "name": "Alex",
    "createdAt": 1709000000000
  },
  "name": "Alex"
}
```

### GET /api/recover

Get the recovery question for password reset.

**Response:**
```json
{
  "question": "What city were you born in?"
}
```

### POST /api/recover

Reset safe word using recovery answer.

**Request:**
```json
{
  "answer": "Portland",
  "newSafeWord": "my-new-phrase"
}
```

**Response:** Same shape as `POST /api/auth`.

---

## Vault (API Key Management)

### GET /api/vault

List stored keys (names and labels only, no values).

**Response:**
```json
{
  "keys": [
    { "name": "OPENROUTER_API_KEY", "label": "OpenRouter" },
    { "name": "LINEAR_API_KEY", "label": "Linear" },
    { "name": "PERPLEXITY_API_KEY", "label": "Perplexity" }
  ]
}
```

### PUT /api/vault/:name

Store or update an API key.

**Request:**
```json
{
  "value": "sk-or-v1-abc123...",
  "label": "OpenRouter"
}
```

**Response:**
```json
{ "ok": true }
```

### DELETE /api/vault/:name

Remove an API key.

**Response:**
```json
{ "ok": true }
```

---

## Chat

### POST /api/chat

Streaming chat endpoint using Server-Sent Events (SSE).

**Request:**
```json
{
  "message": "What are my current goals?",
  "sessionId": "a1b2c3d4..."
}
```

**Response:** SSE stream with the following event types:

```
data: {"type":"token","content":"Your"}
data: {"type":"token","content":" current"}
data: {"type":"token","content":" goals"}
data: {"type":"token","content":"..."}
data: {"type":"search","query":"...","results":"..."}
data: {"type":"browse","url":"...","text":"..."}
data: {"type":"notification","message":"Goal reminder: ..."}
data: {"type":"done"}
```

Event types:
| Type | Description |
|------|-------------|
| `token` | Incremental text from the LLM |
| `search` | Web search was triggered (includes query and results) |
| `browse` | URL was fetched (includes extracted text) |
| `notification` | Goal loop notification injected |
| `done` | Stream complete |

### GET /api/history

Retrieve conversation history for a session.

**Query parameters:**
- `sessionId` (required) — Session identifier

**Response:**
```json
{
  "history": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi! How can I help?" }
  ],
  "summary": "Previous conversation about project goals..."
}
```

---

## Activity Log

### GET /api/activity

Poll for recent activity entries.

**Query parameters:**
- `sessionId` (required)
- `since` (optional) — Activity ID to fetch entries after

**Response:**
```json
{
  "activities": [
    {
      "id": 42,
      "timestamp": "2026-02-27T10:00:00.000Z",
      "source": "goal-loop",
      "summary": "Goal check: reminded about weekly review",
      "detail": "..."
    }
  ]
}
```

Activity sources: `goal-loop`, `ingest`, `learn`, `search`, `browse`, `system`, `agent`, `avatar`, `board`.

---

## Personality

### GET /api/prompt

Read the current personality prompt (`brain/identity/personality.md`).

**Response:**
```json
{
  "prompt": "You are Dash, a personal AI assistant..."
}
```

### PUT /api/prompt

Update the personality prompt.

**Request:**
```json
{
  "prompt": "You are Dash, a focused productivity assistant..."
}
```

---

## Voice I/O

### GET /api/voice-status

Check TTS and STT availability.

**Response:**
```json
{
  "tts": { "available": true, "port": 3579 },
  "stt": { "available": true, "port": 3580 }
}
```

### GET /api/tts

Synthesize speech from text.

**Query parameters:**
- `text` (required) — Text to synthesize

**Response:** `audio/wav` binary data.

### POST /api/stt

Transcribe audio to text.

**Request:** Multipart form data with audio file (WAV format).

**Response:**
```json
{
  "text": "What are my goals for this week?"
}
```

---

## Avatar

### GET /api/avatar/status

Check avatar sidecar availability.

**Response:**
```json
{
  "available": false,
  "reason": "Sidecar not started"
}
```

### POST /api/avatar/photo

Upload and prepare a reference photo for lip-sync.

**Request:** Multipart form data with image file.

**Response:**
```json
{ "ok": true }
```

### GET /api/avatar/latest

Poll for new generated avatar videos.

**Query parameters:**
- `after` (required) — ISO timestamp; returns videos generated after this time

**Response:**
```json
{
  "video": { "hash": "abc123", "timestamp": "2026-02-27T10:00:00.000Z" }
}
```

### GET /api/avatar/video/:hash

Serve a cached avatar video.

**Response:** `video/mp4` binary data.

---

## File Operations

### POST /api/extract

Extract text from uploaded files (PDF, DOCX, images, text).

**Request:** Multipart form data with file.

**Response:**
```json
{
  "text": "Extracted content from the uploaded file...",
  "filename": "document.pdf",
  "type": "pdf"
}
```

Supported formats:
- PDF (via `pdf-parse` + `unpdf`)
- DOCX (via `mammoth`)
- Images — PNG, JPG, TIFF, BMP, WebP (via `tesseract.js` OCR)
- Plain text, Markdown, JSON, YAML

---

## Agent Tasks

### POST /api/agents/tasks

Create and spawn a new agent task.

**Request:**
```json
{
  "label": "Research competitor pricing",
  "prompt": "Research and summarize competitor pricing models for AI assistants",
  "cwd": "/path/to/working/dir",
  "origin": "user",
  "timeoutMs": 300000
}
```

**Response:**
```json
{
  "task": {
    "id": "task_abc123",
    "label": "Research competitor pricing",
    "prompt": "Research and summarize...",
    "cwd": "/path/to/working/dir",
    "status": "running",
    "pid": 12345,
    "createdAt": "2026-02-27T10:00:00.000Z",
    "startedAt": "2026-02-27T10:00:01.000Z",
    "origin": "user"
  }
}
```

### GET /api/agents/tasks

List all agent tasks (newest first).

**Response:**
```json
{
  "tasks": [
    {
      "id": "task_abc123",
      "label": "Research competitor pricing",
      "status": "completed",
      "exitCode": 0,
      "resultSummary": "Found 5 competitors..."
    }
  ]
}
```

### GET /api/agents/tasks/:id

Get a specific task by ID.

### GET /api/agents/tasks/:id/output

Get stdout/stderr from a task.

**Response:**
```json
{
  "output": "Agent output text..."
}
```

### POST /api/agents/tasks/:id/cancel

Cancel a running task.

**Response:**
```json
{ "ok": true }
```

---

## Agent Runtime (Advanced)

### GET /api/runtime/status

Resource usage and state counts for the advanced runtime.

**Response:**
```json
{
  "resources": {
    "activeAgents": 2,
    "maxAgents": 10,
    "totalMemoryMB": 512,
    "maxMemoryMB": 2048,
    "queuedRequests": 0
  },
  "stateCounts": {
    "running": 2,
    "paused": 0,
    "completed": 5,
    "failed": 1
  }
}
```

### GET /api/runtime/instances

List all agent instances.

**Query parameters:**
- `states` (optional) — Comma-separated filter (e.g., `running,paused`)

### GET /api/runtime/instances/:id

Get a specific agent instance.

### POST /api/runtime/spawn

Spawn a new agent instance with full lifecycle management.

**Request:**
```json
{
  "taskId": "task_abc123",
  "label": "Background research",
  "prompt": "Research topic X thoroughly",
  "origin": "ai",
  "config": {
    "timeoutMs": 600000,
    "maxRetries": 3,
    "isolation": "sandboxed"
  },
  "resources": {
    "memoryLimitMB": 256,
    "cpuWeight": 50
  }
}
```

### POST /api/runtime/instances/:id/pause

Pause a running agent (saves checkpoint data).

### POST /api/runtime/instances/:id/resume

Resume a paused agent.

### POST /api/runtime/instances/:id/terminate

Terminate an agent.

### POST /api/runtime/instances/:id/message

Send an inter-agent message.

**Request:**
```json
{
  "from": "agent_1",
  "type": "data_request",
  "payload": { "query": "latest results" }
}
```

---

## Board (Task Management)

### GET /api/board/status

Board provider status and authenticated user.

**Response:**
```json
{
  "provider": "Dash Queue",
  "available": true,
  "user": { "id": "dash", "name": "Dash", "email": "", "displayName": "Dash" }
}
```

### GET /api/board/teams

List teams in the board provider.

**Query parameters:**
- `sessionId` (required)

### GET /api/board/issues

List issues/tasks.

**Query parameters:**
- `sessionId` (required)
- `team` (optional) — Team ID filter
- `state` (optional) — State type filter (e.g., `started`, `completed`)
- `limit` (optional) — Max results

**Response:**
```json
{
  "issues": [
    {
      "id": "q_abc123",
      "identifier": "DASH-1",
      "title": "Implement voice commands",
      "state": "In Progress",
      "priority": 2,
      "assignee": "Dash",
      "url": ""
    }
  ]
}
```

### POST /api/board/issues

Create a new issue.

**Request:**
```json
{
  "title": "Add dark mode support",
  "description": "Implement dark mode toggle in settings",
  "priority": 3,
  "stateId": "todo"
}
```

### PATCH /api/board/issues/:id

Update an existing issue.

**Request:**
```json
{
  "stateId": "done",
  "priority": 1
}
```

---

## Queue Task States

The local queue uses these states, which map to board states:

| State | Display Name | Board Type |
|-------|-------------|------------|
| `triage` | Triage | triage |
| `backlog` | Backlog | backlog |
| `todo` | Todo | unstarted |
| `in_progress` | In Progress | started |
| `done` | Done | completed |
| `cancelled` | Cancelled | cancelled |

---

## Error Handling

All endpoints return errors in a consistent format:

```json
{
  "error": "Description of what went wrong",
  "code": "OPTIONAL_ERROR_CODE"
}
```

Common HTTP status codes:
| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing/invalid parameters) |
| 401 | Not authenticated (invalid or missing session) |
| 404 | Resource not found |
| 500 | Internal server error |

---

## Rate Limits & Timeouts

| Operation | Timeout | Notes |
|-----------|---------|-------|
| Chat streaming | None (SSE) | Connection held open |
| LLM completion | 60s | Background tasks |
| URL browsing | 15s | Page fetch |
| Web search | 15s | Perplexity/sidecar |
| Agent tasks | Configurable | Default varies by origin |
| Avatar video | 120s | Proportional to audio length |
