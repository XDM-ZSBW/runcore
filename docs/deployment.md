# Deployment & Operations Runbook

This guide covers deploying, configuring, monitoring, and maintaining the Dash platform.

---

## Prerequisites

- **Node.js** 18+ (ES2022 support required)
- **npm** 8+
- **Git** (for version control and brain file management)
- **TypeScript** 5.7+ (installed as devDependency)

Optional (for sidecars):
- **Python** 3.10+ (for search, avatar sidecars)
- **Piper** (for TTS sidecar)
- **Whisper** (for STT sidecar)
- **Ollama** (for local LLM inference)

---

## Quick Start

```bash
# Clone the repository
git clone <repo-url> dash
cd dash

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
node dist/server.js
# Server starts on port 3577
```

---

## Build & Development

### Build Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript → `dist/` (ES2022, NodeNext) |
| `npm run dev` | Watch mode (`tsc --watch`) |
| `npm run example` | Run `example/dash.ts` with tsx |

### TypeScript Configuration

The project uses strict TypeScript with ES2022 target and NodeNext module resolution:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

Output is ESM (`"type": "module"` in package.json).

---

## Configuration

### Settings File

Settings are stored in `brain/settings.json`:

```json
{
  "airplaneMode": false,
  "models": {
    "chat": "anthropic/claude-sonnet-4",
    "utility": "meta-llama/llama-3.1-8b-instruct"
  },
  "tts": {
    "enabled": true,
    "port": 3579,
    "voice": "en_US-lessac-medium",
    "autoPlay": false
  },
  "stt": {
    "enabled": true,
    "port": 3580,
    "model": "ggml-base.en.bin"
  },
  "avatar": {
    "enabled": false,
    "port": 3581,
    "musetalkPath": "",
    "photoPath": ""
  }
}
```

Settings can also be updated at runtime via `PUT /api/settings`.

### Airplane Mode

When `airplaneMode: true`:
- LLM provider switches to Ollama (local)
- External API calls (OpenRouter, Perplexity, Linear) are skipped
- Search falls back to local sidecar only
- Linear sync is paused

On first startup, the server probes Ollama at `localhost:11434`. If available, airplane mode defaults to `true`.

### Environment Variables

These are managed through the encrypted vault, not environment files:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | For cloud LLM | OpenRouter API key |
| `LINEAR_API_KEY` | For Linear sync | Linear personal API key |
| `PERPLEXITY_API_KEY` | For web search | Perplexity Sonar API key |
| `TWILIO_ACCOUNT_SID` | For phone calls | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | For phone calls | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | For phone calls | Twilio caller number |
| `HUMAN_PHONE_NUMBER` | For phone calls | User's phone number |

Keys are set via `PUT /api/vault/:name` and encrypted at rest.

---

## Deployment Options

### Local Development

```bash
npm run dev    # TypeScript watch mode in one terminal
node dist/server.js  # Server in another terminal (after initial build)
```

### Production (Single Server)

```bash
npm run build
NODE_ENV=production node dist/server.js
```

The server listens on port 3577 by default.

### Docker

Example Dockerfile:

```dockerfile
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY brain/ ./brain/
COPY public/ ./public/

EXPOSE 3577
CMD ["node", "dist/server.js"]
```

Build and run:
```bash
npm run build
docker build -t dash .
docker run -p 3577:3577 -v $(pwd)/brain:/app/brain dash
```

**Important:** Mount `brain/` as a volume to persist memory, settings, and vault data between container restarts.

### Cloud Deployment (Railway / Fly.io)

For persistent file storage, use a volume mount for the `brain/` directory:

**Railway:**
1. Create a new project from your repo
2. Add a persistent volume mounted at `/app/brain`
3. Set build command: `npm run build`
4. Set start command: `node dist/server.js`

**Fly.io:**
```toml
# fly.toml
[build]
  builder = "heroku/buildpacks:20"

[env]
  NODE_ENV = "production"

[[services]]
  internal_port = 3577
  protocol = "tcp"

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[mounts]
  source = "brain_data"
  destination = "/app/brain"
```

---

## Operations

### First-Time Setup

1. **Start the server** — `node dist/server.js`
2. **Open the UI** — Navigate to `http://localhost:3577`
3. **Complete pairing** — Enter the displayed 6-word code, your name, a safe word, and a recovery question
4. **Add API keys** — Use the vault UI or API to store `OPENROUTER_API_KEY` and any other keys
5. **Verify capabilities** — Check `GET /api/status` to see which features are active

### Server Startup Sequence

On boot, the server:

1. Loads settings from `brain/settings.json`
2. Probes Ollama availability (sets airplane mode default)
3. Attempts to restore session key from disk cache
4. If session key found:
   - Loads and decrypts the vault (hydrates `process.env`)
   - Initializes board providers (Linear if API key available, Queue always)
   - Starts Linear sync timer (if enabled)
   - Starts goal check timer
   - Initializes agent system (recovers interrupted tasks)
   - Starts sidecars (TTS, STT, Avatar, Search) if enabled
5. Starts HTTP server on port 3577

### Monitoring

#### Activity Log

Poll `GET /api/activity?since=<lastId>` for real-time operational events:

```bash
# Check recent activity
curl "http://localhost:3577/api/activity?sessionId=<id>&since=0"
```

Activity sources indicate what's happening:
| Source | Meaning |
|--------|---------|
| `system` | Server lifecycle events |
| `goal-loop` | Background goal checks |
| `learn` | Memory extraction/learning |
| `search` | Web searches performed |
| `browse` | URLs fetched |
| `ingest` | File ingestion |
| `agent` | Agent task events |
| `avatar` | Avatar video generation |
| `board` | Task board operations |

#### Health Checks

```bash
# Server status
curl http://localhost:3577/api/status

# Voice capability
curl http://localhost:3577/api/voice-status

# Avatar capability
curl http://localhost:3577/api/avatar/status

# Board status
curl http://localhost:3577/api/board/status

# Runtime status (agent system)
curl http://localhost:3577/api/runtime/status
```

### Background Processes

| Process | Interval | Purpose | Control |
|---------|----------|---------|---------|
| Goal check timer | 30 min (default) | Proactively check goals and take actions | Auto-starts if paired |
| Linear sync timer | 5 min (default) | Bidirectional task sync | Auto-starts if Linear API key set |
| Agent monitor | 15 sec | Poll for dead agent PIDs | Auto-starts with agent system |

### Backup

Since Dash is file-based, backup is straightforward:

```bash
# Full backup (brain + settings + vault)
tar -czf dash-backup-$(date +%Y%m%d).tar.gz brain/

# Memory only
tar -czf dash-memory-$(date +%Y%m%d).tar.gz brain/memory/

# Automated daily backup (cron)
# 0 2 * * * cd /path/to/dash && tar -czf /backups/dash-$(date +\%Y\%m\%d).tar.gz brain/
```

Git also provides version history:
```bash
cd brain/
git add -A && git commit -m "Brain snapshot $(date)"
```

### Recovery

**Session key lost (server restart without cached key):**
- User re-authenticates with safe word
- Session key re-derived and cached
- Vault re-decrypted

**Safe word forgotten:**
- Use recovery question: `GET /api/recover` → `POST /api/recover`
- Requires correct answer to the recovery question set during pairing

**Corrupted JSONL file:**
- JSONL is append-only; corruption typically affects only the last line
- Fix: remove the last (partial) line
- Entries with `status: "archived"` are safely ignored

**Agent task stuck as "running":**
- On restart, the agent monitor checks PIDs
- Dead PIDs → tasks marked as failed
- Pending tasks → re-spawned automatically

---

## Sidecar Management

### TTS (Piper)

```bash
# Start sidecar
# (Automatically started by server if tts.enabled = true)

# Manual health check
curl http://localhost:3579/health

# Test synthesis
curl "http://localhost:3577/api/tts?text=Hello+world" -o test.wav
```

First run downloads the voice model (~100MB).

### STT (Whisper)

```bash
# Verify binary exists
ls sidecar/stt/

# Manual health check
curl http://localhost:3580/health

# Test transcription
curl -X POST http://localhost:3577/api/stt \
  -F "audio=@recording.wav"
```

### Search Sidecar (DuckDuckGo)

```bash
# Verify Python sidecar
python sidecar/search/server.py  # Manual start

# Health check
curl http://localhost:<search-port>/health
```

### Avatar (MuseTalk)

```bash
# Requires musetalkPath configured in settings
# Verify installation
ls <musetalkPath>/

# Prepare reference photo
curl -X POST http://localhost:3577/api/avatar/photo \
  -F "photo=@reference.jpg"
```

---

## Scaling Considerations

### Single-User (Default)

Dash is designed as a personal OS. One instance serves one user. This is the primary deployment model.

### Multi-User (Brain API)

For serving multiple users, see [BRAIN-API.md](BRAIN-API.md):
- One deployment, many clients
- Project keys for namespace isolation
- Per-namespace memory, goals, and knowledge
- Shared or per-namespace identity

### Performance

- **Memory retrieval** — Substring search over JSONL. Fast for thousands of entries. For 100k+ entries, consider adding an index or switching to a database backend.
- **Context assembly** — Token estimation is `chars / 4`. Context budget prevents memory overflow.
- **Agent tasks** — Limited by `maxConcurrentAgents` in runtime config (default: 10).
- **File ingestion** — Budget-limited to ~3K tokens per ingestion to prevent context overflow.

---

## Maintenance Tasks

### Periodic

| Task | Frequency | Action |
|------|-----------|--------|
| Review archived memories | Monthly | Check `brain/memory/*.jsonl` for stale archived entries |
| Update goals | Weekly | Edit `brain/operations/goals.yaml` |
| Review agent task logs | As needed | Check `brain/agents/logs/` for failed tasks |
| Rotate API keys | Quarterly | Update keys via `PUT /api/vault/:name` |

### Cleanup

```bash
# View JSONL file sizes
wc -l brain/memory/*.jsonl

# Count active vs archived entries
grep -c '"status":"archived"' brain/memory/experiences.jsonl
grep -c '"status":"active"' brain/memory/experiences.jsonl

# Clean agent logs (older than 30 days)
find brain/agents/logs/ -mtime +30 -delete
```
