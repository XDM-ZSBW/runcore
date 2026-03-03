# File Management Spec

Dash needs structured file management — uploads, storage, versioning, and integrations — to support agent-generated reports, resume attachments, document templates, and user uploads. Today files are ad-hoc: `ingest/` for one-shot extraction, `public/avatar/cache/` for video, `brain/` for structured data. This spec unifies file handling into a single system that agents, the chat UI, and integrations all share.

## Design principles

- **File-first.** File metadata lives in `brain/files/registry.jsonl`. Actual files live in `storage/`. No database.
- **Append-only audit.** Every file operation (upload, rename, delete, version) is logged to `brain/files/events.jsonl`.
- **Progressive disclosure.** The registry stores lightweight metadata. File contents are read on-demand.
- **Encrypt at rest.** Sensitive files use the same AES-256-GCM vault encryption the rest of Dash uses.
- **Agent-native.** Agents can create, read, and attach files without human intervention.

---

## 1. Storage architecture

### Directory layout

```
storage/
├── uploads/           # User-uploaded files (originals)
│   └── <year>/
│       └── <month>/
│           └── <file-id>_<slug>.<ext>
├── generated/         # Agent-produced reports, exports
│   └── <year>/
│       └── <month>/
│           └── <file-id>_<slug>.<ext>
├── templates/         # Document templates (reusable)
│   └── <template-name>/
│       └── v<n>.<ext>
├── versions/          # Previous versions of updated files
│   └── <file-id>/
│       └── v<n>_<timestamp>.<ext>
├── thumbnails/        # Auto-generated previews
│   └── <file-id>.webp
└── tmp/               # In-progress uploads, processing workspace
    └── <upload-token>/
```

### File ID scheme

Same pattern as agent tasks: `file_<timestamp>_<8-hex>`.

```typescript
function generateFileId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `file_${ts}_${rand}`;
}
```

### Storage quotas

| Category | Default limit | Configurable |
|----------|--------------|--------------|
| Total storage | 10 GB | `settings.files.maxStorageBytes` |
| Single file upload | 50 MB | `settings.files.maxUploadBytes` |
| Template storage | 500 MB | — |
| Temporary files | 1 GB (auto-purged) | — |
| Versions per file | 20 | `settings.files.maxVersions` |
| Thumbnail size | 200 KB max | — |

### Settings integration

Add to `brain/settings.json`:

```jsonc
{
  "files": {
    "enabled": true,
    "maxStorageBytes": 10737418240,      // 10 GB
    "maxUploadBytes": 52428800,          // 50 MB
    "maxVersions": 20,
    "autoCompress": true,
    "autoThumbnail": true,
    "encryptSensitive": true,
    "cleanupDays": 90,                   // temp + orphan cleanup threshold
    "gdrive": {
      "syncEnabled": false,
      "folderId": null,                  // Google Drive target folder
      "syncIntervalMs": 900000           // 15 min
    }
  }
}
```

---

## 2. File registry

### Schema — `brain/files/registry.jsonl`

First line is a `_schema` header, consistent with all Dash JSONL files.

```jsonc
{"_schema":"file","version":1,"fields":["id","name","slug","mimeType","sizeBytes","category","tags","origin","ownerId","taskId","parentId","version","storagePath","checksum","encrypted","status","createdAt","updatedAt"]}
```

Entry:

```typescript
interface FileEntry {
  id: string;                    // "file_1772300000000_a1b2c3d4"
  name: string;                  // Original filename: "Q4-report.pdf"
  slug: string;                  // URL-safe: "q4-report"
  mimeType: string;              // "application/pdf"
  sizeBytes: number;
  category: FileCategory;
  tags: string[];                // User or agent-assigned
  origin: FileOrigin;
  ownerId: string | null;        // Session ID of uploader, or null for system
  taskId: string | null;         // Agent task ID that produced it, or null
  parentId: string | null;       // Previous version's file ID (version chain)
  version: number;               // 1-based, increments on update
  storagePath: string;           // Relative path under storage/
  checksum: string;              // SHA-256 of file contents
  encrypted: boolean;
  status: "active" | "archived" | "processing" | "quarantined";
  createdAt: string;             // ISO 8601
  updatedAt: string;
}

type FileCategory =
  | "upload"          // User-uploaded via chat or API
  | "report"          // Agent-generated report
  | "template"        // Reusable document template
  | "attachment"      // Attached to a board task
  | "export"          // Data export (CSV, JSON)
  | "resume"          // Resume/CV document
  | "media"           // Images, audio, video
  | "ingest"          // Ingested for context extraction
  | "other";

type FileOrigin =
  | "user-upload"     // Uploaded via UI/API
  | "agent"           // Created by an agent task
  | "gdrive-sync"     // Synced from Google Drive
  | "template"        // Created from a template
  | "system";         // Internal (thumbnails, exports)
```

### Event log — `brain/files/events.jsonl`

Every mutation is recorded. Append-only, never rewritten.

```typescript
interface FileEvent {
  id: string;                    // "evt_<timestamp>_<hex>"
  fileId: string;
  action: "created" | "updated" | "versioned" | "archived" | "restored"
        | "downloaded" | "shared" | "quarantined" | "synced" | "attached"
        | "detached" | "compressed" | "encrypted" | "decrypted";
  actor: string;                 // Session ID, agent task ID, or "system"
  detail?: string;               // Human-readable note
  timestamp: string;
}
```

### Store implementation — `src/files/store.ts`

Same pattern as `QueueStore` (`src/queue/store.ts`): append-only JSONL, in-memory Map cache, auto-compaction when line count > 200.

```typescript
class FileStore {
  private cache: Map<string, FileEntry>;
  private registryPath: string;   // brain/files/registry.jsonl
  private eventsPath: string;     // brain/files/events.jsonl

  async list(filter?: FileFilter): Promise<FileEntry[]>;
  async get(id: string): Promise<FileEntry | null>;
  async create(entry: Omit<FileEntry, "id" | "createdAt" | "updatedAt">): Promise<FileEntry>;
  async update(id: string, patch: Partial<FileEntry>): Promise<FileEntry>;
  async archive(id: string, actor: string): Promise<void>;
  async restore(id: string, actor: string): Promise<void>;
  async getVersionHistory(id: string): Promise<FileEntry[]>;
  async compact(): Promise<void>;
  async getStorageUsage(): Promise<{ totalBytes: number; byCategory: Record<FileCategory, number> }>;
}

interface FileFilter {
  category?: FileCategory;
  origin?: FileOrigin;
  status?: FileEntry["status"];
  tags?: string[];
  taskId?: string;
  search?: string;               // Fuzzy match on name/tags
  limit?: number;
  offset?: number;
}
```

---

## 3. File upload mechanisms

### REST endpoint — multipart upload

```
POST /api/files/upload
Content-Type: multipart/form-data
```

Fields:
- `file` (required) — The file binary
- `category` (optional) — FileCategory, defaults to `"upload"`
- `tags` (optional) — Comma-separated tag list
- `taskId` (optional) — Agent task to associate with
- `encrypt` (optional) — `"true"` to encrypt at rest

Flow:

```
Client                     Server
  │                          │
  ├──POST multipart──────────►│
  │                          ├─ Validate session (sessionId header)
  │                          ├─ Check file size ≤ maxUploadBytes
  │                          ├─ Validate MIME type (allowlist)
  │                          ├─ Generate file ID + upload token
  │                          ├─ Stream to storage/tmp/<token>/
  │                          ├─ Compute SHA-256 checksum
  │                          ├─ Security scan (magic bytes, extension match)
  │                          ├─ Move to final storage path
  │                          ├─ Generate thumbnail (if image/PDF)
  │                          ├─ Append to registry.jsonl
  │                          ├─ Append "created" event
  │                          ├─ Auto-compress (if enabled + eligible)
  │◄─ 201 { file: FileEntry }┤
```

### Chunked upload — large files

For files over 10 MB, support chunked upload to avoid timeout:

```
POST /api/files/upload/init     → { uploadToken, chunkSize }
PUT  /api/files/upload/:token/chunk/:n   → { received: n }
POST /api/files/upload/:token/complete   → { file: FileEntry }
DELETE /api/files/upload/:token          → abort
```

Chunks are written to `storage/tmp/<token>/chunk_<n>`. On complete, chunks are concatenated, checksummed, and moved to final path. Incomplete uploads are cleaned up by the temp cleanup job.

### Chat UI integration

The existing `POST /api/extract` endpoint extracts text for LLM context. Extend the chat UI:

1. **Drag-drop zone** — Overlay on the chat input. Drops trigger `/api/files/upload` and then inject a `[file:<id>]` reference into the message.
2. **Paste support** — Images pasted from clipboard upload automatically.
3. **File pill** — Uploaded files render as clickable pills showing name, size, type icon. Clicking opens a preview or download.

The `/api/chat` handler recognizes `[file:<id>]` tokens in messages, resolves them via `FileStore`, and injects the file content (or extraction) into the LLM context — same as the current `ingestedContext` mechanism.

---

## 4. File type validation and security

### Allowed MIME types

```typescript
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  // Documents
  "application/pdf":              [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "text/plain":                   [".txt", ".log", ".csv", ".md"],
  "text/markdown":                [".md"],
  "text/csv":                     [".csv"],
  "application/json":             [".json"],
  "application/x-yaml":           [".yaml", ".yml"],

  // Images
  "image/png":                    [".png"],
  "image/jpeg":                   [".jpg", ".jpeg"],
  "image/webp":                   [".webp"],
  "image/gif":                    [".gif"],
  "image/svg+xml":                [".svg"],

  // Audio (for STT pipeline)
  "audio/wav":                    [".wav"],
  "audio/mpeg":                   [".mp3"],
  "audio/webm":                   [".webm"],
  "audio/ogg":                    [".ogg"],

  // Archives (for batch ingest)
  "application/zip":              [".zip"],
};
```

### Validation pipeline — `src/files/validate.ts`

Every upload passes through these checks in order:

```typescript
interface ValidationResult {
  valid: boolean;
  rejected?: string;           // Reason if invalid
  sanitizedName: string;       // Cleaned filename
  detectedMime: string;        // From magic bytes, not extension
  detectedExt: string;
}

async function validateUpload(
  buffer: Buffer,
  originalName: string,
  declaredMime: string
): Promise<ValidationResult>;
```

1. **Filename sanitization** — Strip path traversal (`..`, `/`, `\`), null bytes, control chars. Truncate to 255 chars. Slugify for storage path.
2. **Extension check** — Must be in the allowlist. Reject double extensions (`.pdf.exe`).
3. **Magic byte verification** — Read first 8+ bytes, detect actual file type. Must match declared MIME/extension. Reject mismatches (e.g., `.pdf` that's actually an EXE).
4. **Size check** — Must be ≤ `maxUploadBytes`.
5. **Content scan** — For text files: reject if contains null bytes (binary masquerading as text). For SVG: strip `<script>` tags and event handlers. For ZIP: reject if contains executables or nested ZIPs deeper than 2 levels.
6. **Filename collision** — If a file with the same name and category exists, auto-suffix: `report (2).pdf`.

### Quarantine

If a file fails validation after partial processing (e.g., magic bytes pass but content scan fails), move it to a `quarantined` status rather than deleting. Log the reason in the event log. Quarantined files are excluded from all queries by default.

---

## 5. Automatic compression and optimization

### Policy — `src/files/compress.ts`

Compression runs post-upload if `settings.files.autoCompress` is true.

| File type | Action | Tool |
|-----------|--------|------|
| PNG | Lossless optimize | `sharp` (already a common Node dep) |
| JPEG | Quality 85, strip EXIF | `sharp` |
| WebP | No-op (already optimized) | — |
| PDF | No-op (risk of corruption) | — |
| Text > 100 KB | gzip alongside original | Node `zlib` |
| DOCX/XLSX | No-op (already ZIP-compressed) | — |

Images are resized if they exceed 4096px on either dimension (preserve aspect ratio). The original is kept in `versions/` as v0 before compression replaces the primary copy.

```typescript
interface CompressionResult {
  originalBytes: number;
  compressedBytes: number;
  saved: number;                 // Percentage
  action: string;                // "optimized-png", "resized-jpeg", etc.
}

async function compressFile(
  fileId: string,
  storagePath: string,
  mimeType: string
): Promise<CompressionResult | null>;
```

### Thumbnail generation

For images and PDFs (first page), generate a 400px-wide WebP thumbnail stored in `storage/thumbnails/<file-id>.webp`. Thumbnails are served via `GET /api/files/:id/thumbnail`.

---

## 6. Versioning system

### Version chain

When a file is updated (new content uploaded for the same logical document), the system:

1. Copies the current file to `storage/versions/<file-id>/v<n>_<timestamp>.<ext>`
2. Overwrites the primary storage path with the new content
3. Increments the `version` field in the registry
4. Appends a `"versioned"` event
5. Sets `parentId` on the new entry to the previous version's snapshot

### Version limits

When a file exceeds `maxVersions`, the oldest version files are deleted (but the event log entries remain for audit).

### Rollback

```
POST /api/files/:id/rollback
Body: { targetVersion: number }
```

Copies the target version back to the primary path, increments version counter (rollback is itself a new version), appends events.

### Diff support (text files only)

```
GET /api/files/:id/diff?from=2&to=3
```

Returns a unified diff between two versions. Only available for text-based MIME types.

---

## 7. Google Drive integration

### Sync architecture

Builds on the existing Google OAuth flow (`/api/google/auth`, `/api/google/callback`) and token storage in the vault.

```
┌────────────────┐        ┌──────────────┐        ┌──────────────┐
│  Dash storage/ │◄──────►│  Sync Engine  │◄──────►│ Google Drive  │
│  (local files) │  read/ │ (src/files/   │  API   │ (folderId)   │
│                │  write │  gdrive.ts)   │        │              │
└────────────────┘        └──────────────┘        └──────────────┘
```

### Sync modes

1. **Backup** (default) — One-way push. Local files with `origin: "user-upload"` or `origin: "agent"` are uploaded to Drive. Deletions are not propagated.
2. **Mirror** — Two-way sync. Changes in Drive are pulled to local storage. Conflicts resolved by last-write-wins with the loser saved as a version.

### Sync timer

Same adaptive pattern as the queue sync timer (`src/queue/timer.ts`):
- Base interval: 15 minutes (configurable via `settings.files.gdrive.syncIntervalMs`)
- Exponential backoff on failures, max 60 min
- Pauses if Google auth is revoked

### Tracked state — `brain/files/gdrive-sync.jsonl`

```typescript
interface GDriveSyncEntry {
  fileId: string;                // Dash file ID
  driveFileId: string;           // Google Drive file ID
  driveVersion: number;          // Drive modifiedTime-based version
  localChecksum: string;         // Last-synced SHA-256
  syncedAt: string;
  direction: "push" | "pull";
}
```

### API endpoints

```
GET  /api/files/gdrive/status       → { connected, folderId, lastSync, fileCount }
POST /api/files/gdrive/sync         → Force immediate sync
PUT  /api/files/gdrive/config       → Update folderId, syncMode
GET  /api/files/gdrive/conflicts    → List unresolved conflicts
POST /api/files/gdrive/conflicts/:id/resolve  → { keep: "local" | "remote" }
```

---

## 8. Specific file type support

### Resume attachments

Resumes get special handling:

- Category: `"resume"`
- On upload: extract text (existing PDF/DOCX extractors), store extracted text as a companion `.txt` alongside the original
- Auto-tag with detected skills, education, companies (via utility LLM call if available)
- Searchable via metadata

### Document templates

Templates live in `storage/templates/<name>/` with versioned files.

```
POST /api/files/templates                → Create template (upload + name)
GET  /api/files/templates                → List templates
GET  /api/files/templates/:name          → Get template metadata + latest version
POST /api/files/templates/:name/generate → Fill template with provided data
```

Template generation: for Markdown templates, supports `{{variable}}` substitution. For DOCX, use the extracted text as a base and let the agent LLM produce the filled content.

### Agent-generated reports

When an agent task produces a file:

1. Agent writes to `storage/generated/<year>/<month>/`
2. Registers with `origin: "agent"` and `taskId` pointing to the agent task
3. Appends a `"created"` event with actor = agent task ID
4. The board task (if any) gets a `[file:<id>]` reference added to its exchanges

Agents access files through a helper module:

```typescript
// src/files/agent-api.ts
async function agentCreateFile(opts: {
  taskId: string;
  name: string;
  content: Buffer;
  mimeType: string;
  category?: FileCategory;
  tags?: string[];
}): Promise<FileEntry>;

async function agentReadFile(fileId: string): Promise<Buffer>;
async function agentListFiles(filter: FileFilter): Promise<FileEntry[]>;
```

---

## 9. File sharing and permissions

### Permission model

Dash is single-user, so "sharing" means controlling visibility and access scope rather than multi-user ACLs.

```typescript
type FileVisibility =
  | "private"         // Only accessible with valid session
  | "agents"          // Agents can read (no session required)
  | "shared";         // Accessible via share link (time-limited)

interface ShareLink {
  id: string;                    // "share_<hex>"
  fileId: string;
  token: string;                 // Cryptographic random, URL-safe
  expiresAt: string;             // ISO 8601
  maxDownloads: number | null;   // null = unlimited
  downloads: number;
  createdAt: string;
}
```

### Share link endpoints

```
POST   /api/files/:id/share     → { token, url, expiresAt }
  Body: { expiresInHours?: number, maxDownloads?: number }
GET    /api/files/shared/:token  → Stream file (no auth required)
DELETE /api/files/:id/share      → Revoke all share links
```

Share links are stored in `brain/files/shares.jsonl`. Default expiry: 24 hours. Max expiry: 7 days.

### Agent access

Agents always have read access to files with visibility `"agents"` or `"shared"`. Agent-created files default to `"agents"` visibility. The agent prompt preamble (in `src/agents/store.ts`) includes available file references when relevant.

---

## 10. Metadata storage and search

### Full-text search

File metadata (name, tags, extracted text snippets) is indexed in the registry. For search:

```
GET /api/files/search?q=quarterly+report&category=report&tags=finance
```

The search implementation uses in-memory scanning of the registry cache (same approach as queue store). For extracted text, the first 500 chars of document text are stored in a `textPreview` field on the registry entry.

```typescript
interface FileSearchResult {
  file: FileEntry;
  relevance: number;             // 0-1 score
  matchContext?: string;          // Snippet with match highlighted
}
```

### Tag system

Tags are freeform strings. Conventions:
- Agent-generated tags prefixed with `auto:` (e.g., `auto:finance`, `auto:resume`)
- User tags are plain strings
- System tags prefixed with `sys:` (e.g., `sys:compressed`, `sys:encrypted`)

### Metadata extraction

On upload, extract and store:
- **Images**: dimensions, format, EXIF date (if present, strip GPS)
- **PDFs**: page count, title, author
- **DOCX**: word count, title, author
- **Audio**: duration, sample rate, format

Stored in a `meta` field on the FileEntry:

```typescript
meta?: Record<string, string | number | boolean>;
```

---

## 11. Cleanup policies

### Temporary file cleanup

`storage/tmp/` contents older than 24 hours are deleted. Runs on a timer:

```typescript
// src/files/cleanup.ts
const CLEANUP_INTERVAL_MS = 3600000;  // Every hour

async function runCleanup(): Promise<CleanupReport>;
```

### Archive and purge

Files with `status: "archived"` older than `settings.files.cleanupDays` (default 90) are candidates for permanent deletion. Before deletion:
1. Check if the file has active share links → skip
2. Check if referenced by any active board task → skip
3. Delete physical file + all versions
4. Append `"purged"` event (the registry entry remains with status `"purged"` for audit)

### Orphan detection

Files on disk with no matching registry entry are logged and moved to `storage/tmp/orphans/` for manual review. Never auto-deleted.

### Storage pressure

When total usage exceeds 90% of `maxStorageBytes`:
1. Log a warning via activity log (`source: "system"`)
2. Auto-archive files in `storage/tmp/` older than 1 hour
3. Compact old versions beyond the last 5 per file
4. If still over 90%, alert via the health/alerting system

---

## 12. Integration with task and agent systems

### Board task attachments

Extend `QueueTask` (from `src/queue/types.ts`) with an optional `attachments` field:

```typescript
interface QueueTask {
  // ... existing fields ...
  attachments?: string[];        // Array of file IDs
}
```

API:

```
POST /api/board/issues/:id/attachments     → Attach file(s) to a task
  Body: { fileIds: string[] }
DELETE /api/board/issues/:id/attachments/:fileId  → Detach
GET  /api/board/issues/:id/attachments     → List attached files
```

When an agent task completes and produces files, the spawner automatically attaches them to the originating board task (if one exists).

### Agent prompt context

When spawning agents, the preamble injected by `src/agents/store.ts` includes:

```
## Available files
You can read files using their ID. Relevant files for this task:
- file_1772300000000_a1b2c3d4: "Q4-report.pdf" (report, 2.3 MB)
- file_1772300100000_e5f6g7h8: "template-weekly.md" (template, 4 KB)
```

Agents reference files with `[file:<id>]` in their output, which the system resolves when recording results.

### Activity log integration

File operations emit to the existing activity log (`src/activity/log.ts`):

```typescript
logActivity({
  source: "system",  // or "agent" if agent-initiated
  summary: `File uploaded: ${entry.name} (${formatBytes(entry.sizeBytes)})`,
  detail: `id=${entry.id} category=${entry.category} origin=${entry.origin}`
});
```

---

## 13. API endpoints — complete reference

### Core CRUD

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/files/upload` | Upload a file (multipart) | Session |
| POST | `/api/files/upload/init` | Start chunked upload | Session |
| PUT | `/api/files/upload/:token/chunk/:n` | Upload chunk | Session |
| POST | `/api/files/upload/:token/complete` | Finalize chunked upload | Session |
| DELETE | `/api/files/upload/:token` | Abort chunked upload | Session |
| GET | `/api/files` | List files (with filter params) | Session |
| GET | `/api/files/search` | Full-text search | Session |
| GET | `/api/files/:id` | Get file metadata | Session |
| GET | `/api/files/:id/download` | Download file content | Session |
| GET | `/api/files/:id/thumbnail` | Get thumbnail | Session |
| PATCH | `/api/files/:id` | Update metadata (name, tags, category) | Session |
| DELETE | `/api/files/:id` | Archive file (soft delete) | Session |
| POST | `/api/files/:id/restore` | Restore archived file | Session |

### Versioning

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/files/:id/versions` | List version history | Session |
| GET | `/api/files/:id/versions/:v` | Download specific version | Session |
| POST | `/api/files/:id/rollback` | Rollback to version | Session |
| GET | `/api/files/:id/diff` | Diff between versions (text only) | Session |

### Sharing

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/files/:id/share` | Create share link | Session |
| DELETE | `/api/files/:id/share` | Revoke share links | Session |
| GET | `/api/files/shared/:token` | Download via share link | None |

### Templates

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/files/templates` | List templates | Session |
| POST | `/api/files/templates` | Create template | Session |
| GET | `/api/files/templates/:name` | Get template | Session |
| POST | `/api/files/templates/:name/generate` | Fill template | Session |

### Google Drive

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/files/gdrive/status` | Sync status | Session |
| POST | `/api/files/gdrive/sync` | Force sync | Session |
| PUT | `/api/files/gdrive/config` | Update Drive config | Session |
| GET | `/api/files/gdrive/conflicts` | List conflicts | Session |
| POST | `/api/files/gdrive/conflicts/:id/resolve` | Resolve conflict | Session |

### Task attachments

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/board/issues/:id/attachments` | Attach files | Session |
| GET | `/api/board/issues/:id/attachments` | List attachments | Session |
| DELETE | `/api/board/issues/:id/attachments/:fileId` | Detach file | Session |

### System

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/files/stats` | Storage usage, counts by category | Session |
| POST | `/api/files/cleanup` | Trigger manual cleanup | Session |

---

## 14. Security considerations

### Upload security

- **No execution path.** Uploaded files are never executed. Storage paths are generated server-side — the original filename is only used for display.
- **Path traversal prevention.** All filenames are slugified. Storage paths use the file ID, not the user-provided name.
- **MIME sniffing.** Magic byte detection (not Content-Type header) determines actual file type. Mismatches are rejected.
- **No inline serving.** Files are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. No inline rendering of user-uploaded HTML/SVG.
- **SVG sanitization.** SVG uploads have `<script>`, `<iframe>`, `on*` attributes, and `javascript:` URIs stripped before storage.

### Encryption

Sensitive files (user-opted or category `"resume"`) are encrypted at rest using the same AES-256-GCM scheme as the vault (`src/auth/crypto.ts`). The session key (derived from the safe word via PBKDF2) is used for encryption. Encrypted files have `encrypted: true` in the registry and are decrypted on-the-fly for download.

### Rate limiting

Apply the existing rate limiter pattern from `server.ts`:

| Endpoint group | Limit |
|---------------|-------|
| `/api/files/upload*` | 30 req / 60 sec |
| `/api/files/shared/*` | 60 req / 60 sec |
| `/api/files/*` (reads) | 120 req / 60 sec |

### Share link security

- Tokens are 32 bytes of `crypto.randomBytes`, base64url-encoded
- Links expire (max 7 days)
- Download count tracking with optional cap
- Revocation is immediate (token removed from shares.jsonl)

### Content Security Policy

Thumbnails and file previews served from `/api/files/` include:
```
Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'none'
X-Content-Type-Options: nosniff
```

---

## 15. Implementation plan

### Phase 1 — Core storage + CRUD

New files:
- `src/files/store.ts` — FileStore (registry + events JSONL)
- `src/files/validate.ts` — Upload validation pipeline
- `src/files/types.ts` — All interfaces and type definitions

Server additions (in `src/server.ts`):
- `POST /api/files/upload` — Multipart upload
- `GET /api/files` — List with filters
- `GET /api/files/:id` — Metadata
- `GET /api/files/:id/download` — File download
- `PATCH /api/files/:id` — Update metadata
- `DELETE /api/files/:id` — Archive

Directories:
- `brain/files/` — registry.jsonl, events.jsonl
- `storage/uploads/`, `storage/tmp/`

### Phase 2 — Versioning + compression

New files:
- `src/files/version.ts` — Version management
- `src/files/compress.ts` — Compression + thumbnail pipeline

Server additions:
- Version endpoints (`/versions`, `/rollback`, `/diff`)
- Thumbnail endpoint

Directories:
- `storage/versions/`, `storage/thumbnails/`

### Phase 3 — Agent integration + templates

New files:
- `src/files/agent-api.ts` — Agent helper functions
- `src/files/templates.ts` — Template management

Modifications:
- `src/agents/store.ts` — Inject file context into agent preamble
- `src/agents/spawn.ts` — Auto-attach agent output files to board tasks
- `src/queue/types.ts` — Add `attachments` field to QueueTask

Server additions:
- Template endpoints
- Board attachment endpoints

### Phase 4 — Google Drive sync

New files:
- `src/files/gdrive.ts` — Drive API integration + sync engine

Uses the existing Google OAuth token from the vault. Builds on `googleapis` (already a transitive dependency via the Google integration).

Server additions:
- Drive sync endpoints

New JSONL:
- `brain/files/gdrive-sync.jsonl`

### Phase 5 — Sharing + search + cleanup

New files:
- `src/files/share.ts` — Share link management
- `src/files/search.ts` — Search implementation
- `src/files/cleanup.ts` — Cleanup timer + policies

Server additions:
- Share endpoints, search endpoint, stats + cleanup endpoints

New JSONL:
- `brain/files/shares.jsonl`

---

## Open questions

These are decisions that can be deferred or made during implementation:

1. **Dependency on `sharp`** — Used for image compression/thumbnails. It's a native module requiring build tools. Alternative: skip auto-compression and use browser-side resizing before upload.
2. **Chunked upload necessity** — For a local-first system, the 50 MB single-upload limit may be sufficient. Chunked upload adds complexity. Could defer to Phase 5 or drop entirely.
3. **Google Drive conflict resolution UI** — The API supports it, but the chat UI needs a way to surface conflicts. Could be a simple notification in the activity log with agent-assisted resolution.
4. **Template format** — Markdown `{{variable}}` is simple but limited. For DOCX templates, a dedicated library like `docxtemplater` would be needed. Could start Markdown-only.
