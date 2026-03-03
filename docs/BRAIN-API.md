# Dash Brain API — shared brain, key-scoped access

**Goal:** One central brain in the cloud. Cursor (project A), Claude (project B), and other tools call the same API. Each project has a **key**; the API only returns and accepts brain data that’s **scoped to that key**. No shared filesystem, no copying the full brain into every repo — and projects don’t see each other’s data.

Think of it like a router for brains: one brain backend, many clients, each client gets a filtered slice.

---

## Why

- **Different roots:** Cursor might be in `~/work/project-alpha`, Claude in another folder or machine. They can’t share `brain/` on disk.
- **No mixing:** Project Alpha shouldn’t get Project Beta’s memory, goals, or identity. One API, many **namespaces** (one per key).
- **Same brain, many entry points:** Identity and high-level rules can be shared (optional); memory, goals, and project-specific data are always key-scoped.

---

## Model

- **Brain service** (one deployment, e.g. Railway or Fly.io):
  - Stores the full brain: memory (JSONL), identity, skills, operations, knowledge.
  - Each **project** or **client** is identified by a **project key** (e.g. API key or `project_id` + secret). Keys are created by you (or an admin) and given to the project.
  - All read/write is **scoped by key**: `getContext`, `learn`, and any other endpoints only see/write data for that key’s namespace.

- **Namespace (per key):**
  - **Private to key:** Memory (experiences, decisions, failures, semantic, procedural), project-specific goals/todos, project-specific knowledge. Stored per namespace; no cross-key access.
  - **Optional shared:** Identity (voice, brand) and skills can be global or per-namespace. Simplest: per-namespace so each project can override; later add “global identity, per-namespace memory.”

- **Clients (Cursor, Claude, other):**
  - Store only the **project key** (e.g. in env or a small config). No copy of the brain.
  - Call the Brain API: “get context for this turn” (key in header or body) → get back messages + working memory for that namespace. “Learn this” (key in header) → append to that namespace’s memory only.

---

## API shape (minimal)

- **Auth:** Every request sends a **project key** (e.g. `Authorization: Bearer <project_key>` or `X-Project-Key: <key>`). Server validates the key and uses it as the namespace for the request.

- **Endpoints (all scoped by key):**
  - `POST /context` — Body: `{ userInput, conversationHistory?, retrievalQuery?, maxRetrieved? }`. Returns: `{ messages, sections, workingMemory }` (same as `getContextForTurn`). Only memory/goals/etc. for this key’s namespace are included.
  - `POST /learn` — Body: `{ type: "semantic"|"episodic"|"procedural", content, meta? }`. Appends to this namespace’s memory only.
  - Optional: `GET /memory`, `POST /memory/decisions`, etc., all key-scoped.

- **Filtering:**  
  - On read: retrieval and context assembly only consider data tagged with or stored under the key’s namespace.  
  - On write: `learn` and any log endpoints write only into that namespace. No way for one key to read or overwrite another’s data.

---

## Security

- **Key generation and storage:** You (or an admin flow) create keys per project; keys are long-lived secrets. Clients store them securely (env vars, secret manager), never in repo.
- **HTTPS only;** no key in URLs or logs. Rate limit and optional audit log per key if needed.
- **No cross-namespace access:** Server enforces that storage and retrieval use only the namespace derived from the key. No “admin override” unless you explicitly add a separate admin auth.

---

## Deployment

- **Brain service:** Node/TS app that wraps the existing `Brain` + a store that’s **namespace-aware** (e.g. `brain/memory/<namespace_id>/*.jsonl` or a DB with `namespace_id` on every row). Deploy to Railway or Fly.io with a persistent volume (or DB) for that storage.
- **Per key:** Map key → `namespace_id` (e.g. key is a secret that decodes to or looks up a namespace). One namespace per project/customer.

---

## Summary

| Concept | Implementation |
|--------|----------------|
| One brain, many clients | Single Brain API deployment; Cursor and Claude both call it. |
| Different roots / no shared FS | No need for shared filesystem; clients only need the API and a key. |
| No mixing between projects | Every request is scoped by project key → namespace; read/write filtered to that namespace. |
| “Operouter for brains” | One entry point (API), routing by key to the right slice of the brain. |

This doc is the design. Implementation is: add a small HTTP server (e.g. Hono or Express), middleware that resolves key → namespace and injects a namespace-scoped store into `Brain`, and the two endpoints above. The existing `Brain` and `FileSystemLongTermMemory` can stay; add a **NamespaceScopedMemory** store that prefixes paths or uses a DB table keyed by namespace.

---

## Dual scope: project + general (all-purpose memory)

**Goal:** Keep project-scoped memory so projects stay isolated, but add a **general** scope for memories that are not project-specific (preferences, identity, cross-project learnings, “how I work”). Context can merge both; over time you can train the brain (or a classifier) to decide whether a new memory is project or general.

### Why two scopes

- **Project-scoped:** “In FindAJob we filter by salary.” “This codebase uses Hono for the API.” Stays in that project’s namespace.
- **General:** “I prefer bullet points over long paragraphs.” “I use Pacific time.” “When debugging, I always check logs first.” Available to every project so the brain doesn’t have to relearn you in each space.

**You don’t have to remember to scope.** Writes default to project (or to a classifier suggestion when one exists). When you find a memory in the wrong place—e.g. something in project that should be general, or in general that should be project—you correct it (move, re-scope, or delete). Those corrections are the training signal: the brain learns over time when scope was wrong and improves its default.

### Learning from corrections

- **Default:** Every `POST /learn` without a scope (or with no classifier yet) writes to **project**. No extra step for you.
- **Corrections:** When you notice a memory is in the wrong scope, you move it (e.g. “this should be general” or “this was general but it’s project-specific”). The API supports a **re-scope** or **move** action: memory id + new scope. Optionally you delete from one scope and re-learn in the other.
- **Training signal:** Each correction (memory X was in scope A, user moved to scope B) is stored. Over time, a classifier or rules can use these to suggest scope for new learns, or auto-set scope so you rarely have to fix it. The brain learns from your corrections; you don’t have to scope up front.

### Model

- **Project key** (unchanged): Maps to a **project namespace**. All project-specific memory, goals, and knowledge live here.
- **General key** (or general namespace per user): Maps to a **general namespace**. One per user/person; can be:
  - **Option A:** A separate key (e.g. `X-General-Key` or a second key in the same request). Client sends project key + general key; server reads/writes project namespace with project key, general namespace with general key.
  - **Option B:** Same “user” behind both keys. When you create a project key, you optionally link it to a user; that user has one general namespace. So one request with the project key can read both project + general for that user, and write with an explicit `scope`.

- **Per-memory scope:** Every memory record stores `scope: "project" | "general"` (and namespace id). That gives you a clean signal for training: “when we stored this as general, it was later retrieved in N projects.”

### API changes

- **Auth:** Request still sends the **project key**. If you use Option B (user-linked general), the server derives “user” from the project key and has access to both that project’s namespace and that user’s general namespace. If you use Option A, request can send an optional **general key** (e.g. `X-General-Key` or in body) for general read/write.

- **POST /context:** Same as today, but **retrieval merges project + general**. Server fetches from project namespace and (when available) general namespace, then assembles one context. You can order or weight (e.g. project first, then general) so project-specific context wins when relevant. Response can optionally tag which section came from which scope for debugging or training.

- **POST /learn:** Body gains an optional **`scope`** (used when the client or a classifier sets it; you don’t have to):
  - `scope: "project"` (default) — write to project namespace. If omitted, server uses default (project) or classifier suggestion when available.
  - `scope: "general"` — write to general namespace.
  - Omit → server writes to project (or runs classifier and uses its suggestion). No need for the user to remember to pass scope.

- **Corrections:** Support **re-scope** so the brain can learn from mistakes. For example: `PATCH /memory/:id` or `POST /memory/:id/move` with `{ scope: "general" }` to move a memory from project to general (or the reverse). Each correction is logged as training data for the scope classifier.

### Storage

- **Project namespace:** As today (e.g. `brain/memory/<project_namespace_id>/*.jsonl` or DB with `namespace_id` + `scope = 'project'`).
- **General namespace:** Same store, different namespace id (e.g. `brain/memory/<general_namespace_id>/*.jsonl` or DB with `namespace_id` for user’s general + `scope = 'general'`). No cross-user access; general is per user, not global.

### Summary (dual scope)

| Concept | Implementation |
|--------|----------------|
| Project-only memory | Project key → project namespace; default for writes when scope omitted or unknown. |
| General memory | General key or user-linked general namespace; one per user. |
| Context = project + general | `/context` retrieves from both namespaces and merges (e.g. project first, then general). |
| Write scope | `POST /learn` accepts optional `scope`; omit → default to project (or classifier suggestion). You don’t have to pass scope. |
| Learning from mistakes | When you find a memory in the wrong scope, re-scope or move it; corrections train the classifier so it improves over time. |

