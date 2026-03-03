# Security & Compliance

This document covers Dash's security architecture, threat model, data protection mechanisms, and operational security practices.

---

## Security Architecture Overview

Dash follows a **zero-trust local** model: even though the system runs on the user's own machine, sensitive data (API keys, session data) is encrypted at rest. The security stack:

```
┌─────────────────────────────────┐
│       Pairing Ceremony          │  Identity establishment
│   (6-word code + safe word)     │
└───────────────┬─────────────────┘
                │
┌───────────────┴─────────────────┐
│        Key Derivation           │  PBKDF2 (600k iterations, SHA-256)
│   safe word → 256-bit key       │
└───────────────┬─────────────────┘
                │
┌───────────────┴─────────────────┐
│     Encryption at Rest          │  AES-256-GCM
│  Sessions, Vault, Identity      │
└───────────────┬─────────────────┘
                │
┌───────────────┴─────────────────┐
│     Session Management          │  Derived session IDs
│  (survives server restarts)     │  Cached session key on disk
└─────────────────────────────────┘
```

---

## Authentication

### Pairing Ceremony

First-time identity establishment:

1. Server generates a **6-word pairing code** from a curated word list
2. User provides: pairing code, name, safe word, recovery question + answer
3. Server derives a 256-bit encryption key from the safe word via PBKDF2
4. Identity stored in `brain/identity/human.json`:
   - `name` — Plaintext
   - `safeWordHash` — SHA-256 hash of the safe word (for verification)
   - `pbkdf2Salt` — Random salt for key derivation
   - `recovery.question` — Plaintext
   - `recovery.answerHash` — SHA-256 hash of recovery answer
   - `pairedAt` — ISO timestamp

The safe word is **never stored** — only its hash and the derived encryption key (cached for the session).

### Session Management

- **Session ID** — Derived deterministically from the safe word hash. Survives server restarts without re-authentication.
- **Session key** — The PBKDF2-derived encryption key. Cached to `brain/identity/.session-key` for server restart recovery.
- **Session validation** — Server checks session ID against known sessions on each request.

### Recovery Flow

If the user forgets their safe word:

1. `GET /api/recover` — Returns the recovery question
2. `POST /api/recover` — User provides the answer + a new safe word
3. Server verifies the answer hash, re-derives keys, re-encrypts all vault data

---

## Encryption

### Key Derivation

```
Safe Word → PBKDF2 → 256-bit Key
              │
              ├── Algorithm: PBKDF2
              ├── Hash: SHA-256
              ├── Iterations: 600,000
              ├── Salt: 32 random bytes (per user)
              └── Output: 256-bit (32 bytes) AES key
```

600,000 iterations follows OWASP recommendations for PBKDF2-SHA256.

### Symmetric Encryption

All at-rest encryption uses **AES-256-GCM**:

```
Plaintext → AES-256-GCM → { ciphertext, iv, authTag }
              │
              ├── Algorithm: AES-256-GCM
              ├── IV: 12 random bytes (per encryption)
              ├── Auth tag: 16 bytes (integrity verification)
              └── Key: PBKDF2-derived 256-bit key
```

The authenticated encryption (GCM mode) provides both confidentiality and integrity — tampering is detected.

### What's Encrypted

| Data | Location | Encrypted |
|------|----------|-----------|
| API keys | `brain/vault/keys.json` | Yes (AES-256-GCM) |
| Session data | `brain/sessions/{id}.json` | Yes (AES-256-GCM) |
| Session key cache | `brain/identity/.session-key` | On disk (cleartext key cache) |
| Safe word hash | `brain/identity/human.json` | Hashed (SHA-256, not reversible) |
| Recovery answer | `brain/identity/human.json` | Hashed (SHA-256, not reversible) |
| Memory (JSONL) | `brain/memory/*.jsonl` | No (plaintext) |
| Goals/Todos | `brain/operations/` | No (plaintext) |
| Identity/Voice | `brain/identity/` | No (plaintext) |

### Vault System

The vault (`brain/vault/keys.json`) stores API keys as encrypted payloads:

```json
{
  "OPENROUTER_API_KEY": {
    "ciphertext": "a1b2c3...",
    "iv": "d4e5f6...",
    "authTag": "789abc...",
    "label": "OpenRouter"
  }
}
```

On authentication:
1. Vault is loaded and decrypted with the session key
2. Decrypted values are injected into `process.env`
3. API keys are available to all server components without touching disk again

---

## Data Protection

### Memory Data

Brain memory files (`brain/memory/*.jsonl`) are stored as **plaintext**. This is by design:

- Memory files are human-readable for inspection and debugging
- Git versioning provides change history and rollback
- The file system's own permissions are the access boundary

**If memory encryption is required** for your threat model, consider:
- Full-disk encryption (BitLocker, LUKS, FileVault)
- Encrypted volumes for the `brain/` directory
- A custom `LongTermMemoryStore` implementation that encrypts entries

### Append-Only Guarantee

All JSONL files are append-only:
- New entries are appended to the end of the file
- Entries are never modified in place
- Archival uses `status: "archived"` — a new append, not a rewrite
- This provides an immutable audit trail of all memory operations

### Data Retention

- **Memory entries** — Retained indefinitely unless archived
- **Session data** — Retained until manually cleared
- **Agent logs** — Retained in `brain/agents/logs/`; no automatic cleanup
- **Activity log** — In-memory only; lost on server restart

---

## Network Security

### External API Connections

| Service | Protocol | Authentication | Data Sent |
|---------|----------|---------------|-----------|
| OpenRouter | HTTPS | Bearer token | Chat messages, system prompts |
| Perplexity | HTTPS | Bearer token | Search queries |
| Linear | HTTPS | API key | Task titles, descriptions, comments |
| Twilio | HTTPS | Account SID + Auth Token | Phone number, TwiML message |
| Ollama | HTTP (localhost) | None | Chat messages (local only) |

### Sidecar Communication

All sidecars communicate over **localhost HTTP** (not exposed externally):

| Sidecar | Port | Data |
|---------|------|------|
| TTS (Piper) | 3579 | Text to synthesize |
| STT (Whisper) | 3580 | Audio buffers |
| Avatar (MuseTalk) | Configurable | Audio + reference photo |
| Search (DuckDuckGo) | Configurable | Search queries |

### Server Exposure

The Hono server binds to `0.0.0.0:3577` by default. For local-only access:
- Use a firewall rule to restrict port 3577 to localhost
- Or deploy behind a reverse proxy (nginx, Caddy) with TLS

**Recommendation:** For production, always run behind a reverse proxy with HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name dash.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3577;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Agent Security

### Process Isolation

Agent tasks spawn as **detached child processes**:
- Each agent runs in its own process (PID)
- Agents use the `claude --print` CLI — output-only, no interactive access
- Environment is cleaned: `CLAUDECODE` env vars are removed to prevent nested session hijacking

### Agent Permissions

- Agents inherit the server process's file system permissions
- No sandboxing beyond process isolation (no containers, no chroot)
- The `isolation: "sandboxed"` config option is defined in the runtime types but enforcement depends on the driver implementation

### Timeout Protection

- Default timeout: configurable per task
- Tasks exceeding timeout are forcefully terminated
- Retry with exponential backoff: configurable `maxRetries`, `backoffMs`, `backoffMultiplier`, `maxBackoffMs`

---

## Threat Model

### Assumed Trust Boundaries

1. **Trusted:** The local machine, the file system, the user
2. **Semi-trusted:** External APIs (OpenRouter, Linear, etc.) — we send data but validate responses
3. **Untrusted:** Network traffic, sidecar responses (checked for prompt injection patterns)

### Addressed Threats

| Threat | Mitigation |
|--------|-----------|
| API key exposure on disk | Encrypted vault (AES-256-GCM) |
| Session hijacking | PBKDF2-derived session IDs, not guessable |
| Safe word brute force | 600k PBKDF2 iterations |
| Memory tampering | Append-only JSONL (git tracks changes) |
| Prompt injection from search | Three-tier classification before injection into context |
| Agent escape | Process isolation, environment cleaning, timeout |

### Not Addressed (User Responsibility)

| Threat | Recommendation |
|--------|---------------|
| Physical machine access | Full-disk encryption |
| Network eavesdropping | Deploy with HTTPS/TLS |
| Memory data exposure | Disk encryption or encrypted LTM implementation |
| Sidecar tampering | Run sidecars on localhost only |
| Supply chain attacks | Audit dependencies, use `npm audit` |

---

## Compliance Considerations

### Data Sovereignty

All data resides in the `brain/` directory on the local file system. No data is stored in external databases or cloud services. External API calls (OpenRouter, Linear, etc.) transmit data over HTTPS but don't persist data on Dash's behalf.

### GDPR / Data Privacy

For personal deployments:
- **Data portability** — All data is in portable formats (JSONL, YAML, Markdown)
- **Right to deletion** — Archive entries with `status: "archived"` or delete files directly
- **Data minimization** — Only data explicitly learned or extracted is stored
- **Transparency** — All memory files are human-readable

For multi-user deployments (Brain API):
- **Namespace isolation** — Each user/project gets its own namespace
- **No cross-namespace access** — Enforced at the API layer
- **Key-scoped filtering** — All queries are scoped to the authenticated namespace

### Audit Trail

- JSONL append-only format provides a chronological record of all memory operations
- Git versioning tracks all file changes with timestamps
- Activity log records all operational events (in-memory; persist to file for compliance)

---

## Security Checklist

### Initial Setup

- [ ] Complete pairing ceremony with a strong safe word
- [ ] Set a recovery question and answer
- [ ] Store API keys via vault (not environment files)
- [ ] Verify vault encryption: `cat brain/vault/keys.json` should show ciphertext, not plaintext

### Network

- [ ] Run behind HTTPS reverse proxy for any non-localhost access
- [ ] Restrict port 3577 to localhost if only accessed locally
- [ ] Verify sidecar ports are not exposed externally

### Ongoing

- [ ] Rotate API keys periodically (via `PUT /api/vault/:name`)
- [ ] Review `brain/memory/*.jsonl` for unintended data
- [ ] Run `npm audit` to check for dependency vulnerabilities
- [ ] Monitor activity log for unexpected operations
- [ ] Back up `brain/` directory regularly

### Production Hardening

- [ ] Enable full-disk encryption on the host
- [ ] Set `NODE_ENV=production`
- [ ] Restrict file permissions: `chmod 600 brain/vault/keys.json brain/identity/human.json`
- [ ] Consider rate limiting on the reverse proxy
- [ ] Set up log aggregation for the activity log
