# Brain RAG Spec: Semantic Retrieval for Brain Files

**Status:** Spec
**Date:** 2026-03-09
**Problem:** Dash can't find "book 2" content because search is keyword-only. Brain has 1,400+ files and 700MB of data. Keyword grep misses semantic matches ("finances" vs content about financial services). Filename matching misses files organized into subdirectories.

---

## What Exists Today

### VectorIndex (src/memory/vector-index.ts)
- Ollama `nomic-embed-text` embeddings, 768-dim Float32Array
- Stored in `brain/memory/embeddings.jsonl` (append-only)
- In-memory Map for cosine similarity search
- Circuit breaker for Ollama availability
- Batch embedding (10 at a time), background backfill on init
- **Only wired to memory entries** via `FileSystemLongTermMemory`. Not wired to brain files (knowledge, notes, drafts, research, etc.).

### brain-docs.ts (src/search/brain-docs.ts)
- Keyword grep over brain files. Two modes: filename match, content scan.
- Recursive directory walk, reads every file for content scoring.
- Returns single best match, injected as system message before LLM call.
- **700MB full-content scan takes 10-20s.** Unusable.

### files_search (src/mcp-server.ts)
- MCP tool. Same keyword grep approach. Scores filename + content.
- Same performance problem at scale.

### The Gap
VectorIndex exists and works. Brain files exist and are plentiful. They're not connected. Memory entries get embeddings; files don't.

---

## Design

### Principle
The vector index is a **derived cache**, not a source of truth. Delete `brain/memory/file-embeddings.jsonl`, re-index from files. Brain files remain plain files. Append-only JSONL remains append-only.

### Architecture

```
src/search/
  brain-rag.ts        — public API: index(), query(), reindex()
  chunker.ts          — markdown-aware chunking
  file-watcher.ts     — fs.watch on brain dirs, triggers re-embed on change

src/memory/
  vector-index.ts     — (exists) add file chunk support alongside memory entries
```

### 1. Chunking (chunker.ts)

Split markdown files into chunks suitable for embedding.

**Strategy:** Markdown-header-aware splitting with fixed-size fallback.

```
Input:  a .md file (path + content)
Output: Chunk[] where Chunk = { id, filePath, heading, text, index }
```

**Rules:**
- Split on `## ` headers first (preserve section boundaries)
- If a section exceeds 512 tokens (~2,048 chars), split further at paragraph boundaries (`\n\n`)
- If a paragraph exceeds 512 tokens, split at sentence boundaries
- Overlap: 50 tokens (~200 chars) between consecutive chunks within a section
- Chunk ID: `sha256(filePath + ":" + index)` truncated to 16 hex chars
- Each chunk carries metadata: `filePath`, `heading` (nearest parent heading), `index` (chunk position in file)
- Front matter (YAML between `---`) becomes its own chunk if present

**Why not semantic chunking:** 2025 benchmarks show fixed-size recursive splitting (512 tokens) at 69% accuracy vs semantic chunking at 54%. Simpler, faster, better.

**File types:** `.md`, `.yaml`, `.yml`, `.txt`. Skip `.jsonl` (handled by memory vector index). Skip files > 500KB.

### 2. File Embedding Index (brain-rag.ts)

Separate from memory embeddings. Stored at `brain/memory/file-embeddings.jsonl`.

**Schema per line:**
```jsonc
{
  "id": "a1b2c3d4e5f6g7h8",     // chunk ID (hash)
  "filePath": "knowledge/notes/book2-drafts/ch1.md",  // relative to brain root
  "heading": "The Control Paradox",  // nearest heading
  "index": 2,                      // chunk position
  "mtime": 1741571754000,          // file mtime at embed time
  "v": [0.012, -0.034, ...]        // embedding vector
}
```

**Public API:**

```ts
class BrainRAG {
  constructor(brainDir: string, vectorIndex: VectorIndex)

  /** Full index: scan all brain files, chunk, embed missing chunks. Background-safe. */
  async indexAll(): Promise<{ indexed: number; skipped: number; errors: number }>

  /** Index a single file (on write/change). */
  async indexFile(filePath: string): Promise<void>

  /** Remove chunks for a deleted file. Appends tombstones (status: "archived"). */
  async removeFile(filePath: string): Promise<void>

  /** Semantic search: embed query, return top-k file chunks with scores. */
  async query(text: string, topK?: number): Promise<RAGResult[]>

  /** Force re-index everything. Clears in-memory map, rebuilds from files. */
  async reindex(): Promise<void>
}

interface RAGResult {
  filePath: string      // relative to brain root
  heading: string       // section heading
  chunk: string         // the text chunk
  score: number         // cosine similarity
  fullPath: string      // absolute path for file reading
}
```

**Staleness detection:** On `indexAll()`, compare file `mtime` against stored `mtime` per chunk. If file is newer, re-chunk and re-embed that file. If file is gone, append tombstones. No full re-embed on every startup — only changed files.

**Deduplication:** Chunk IDs are content-addressed (hash of path + index). Re-embedding the same chunk at the same position produces the same ID. New embedding line supersedes old one (last-write-wins in the in-memory Map).

### 3. File Watcher (file-watcher.ts)

Watch brain directories for changes. Trigger `indexFile()` on create/modify, `removeFile()` on delete.

```ts
function watchBrain(brainDir: string, rag: BrainRAG): FSWatcher

// Watches: FILES_DIR, and legacy dirs (knowledge/, content/, identity/, etc.)
// Debounce: 2s after last change to batch rapid saves
// Skip: .git, node_modules, log/, memory/*.jsonl (those have their own index)
```

**Startup sequence:**
1. Load existing file embeddings from `file-embeddings.jsonl` into memory
2. Run `indexAll()` in background (catch up on changes while offline)
3. Start file watcher for live updates
4. Search is available immediately using whatever embeddings were loaded in step 1

### 4. Wiring Into Search

**brain-docs.ts — replace content scan with RAG:**

```
findBrainDocument(message):
  1. Extract keywords (existing logic)
  2. If DOC_REF_PATTERN or KNOWLEDGE_QUESTION_PATTERN matches:
     a. Call brainRAG.query(message, topK=5)
     b. If results exist with score > 0.3:
        - Group by filePath
        - For the best-scoring file: read full content, return as DocMatch
        - Log which chunks matched and their scores
     c. If no RAG results: fall back to keyword filename match (existing Mode 1)
  3. Keyword content scan (Mode 2) is removed entirely — RAG replaces it
```

**files_search MCP tool — add semantic mode:**

```
files_search(query, max, mode?):
  mode = "keyword" (default, existing behavior) | "semantic"
  If mode === "semantic" or keyword search returns 0 results:
    Use brainRAG.query(query, topK=max)
    Return file paths + snippets from chunk text
```

**Server injection (server.ts ~line 5915):**

No change to injection shape. `findBrainDocument` still returns a single `DocMatch` with full file content. The change is internal — how the best file is found.

**Future:** Return multiple files when query matches a collection (e.g., "book 2" → all chapters). Requires changing `DocMatch` to `DocMatch[]` and the injection to concatenate. Not in this spec — single best file is sufficient for now.

### 5. VectorIndex Changes

Extend `VectorIndex` to support two namespaces:
- **memory** — existing, keyed by memory entry ID
- **files** — new, keyed by chunk ID

Implementation: separate `embeddings.jsonl` (memory) and `file-embeddings.jsonl` (files). Two separate in-memory Maps. `VectorIndex` stays focused on memory; `BrainRAG` owns the file map and uses `VectorIndex.embed()` / `VectorIndex.embedBatch()` for the embedding calls only.

Alternatively: extract the Ollama embed functions into a shared `embedder.ts` utility that both `VectorIndex` and `BrainRAG` use. Cleaner separation. **This is the preferred approach.**

```ts
// src/search/embedder.ts
export async function embed(text: string): Promise<Float32Array>
export async function embedBatch(texts: string[]): Promise<Float32Array[]>
export async function isOllamaAvailable(): Promise<boolean>
```

Move Ollama URL, model name, circuit breaker logic here. `VectorIndex` and `BrainRAG` both import from `embedder.ts`.

---

## What Does NOT Change

- Brain files are still plain files. No schema migration.
- `embeddings.jsonl` (memory) is untouched. Existing memory search works as-is.
- Append-only JSONL contract. `file-embeddings.jsonl` is append-only. Tombstones for deletions.
- No external database. No SQLite. No LanceDB. Pure JSONL + in-memory Map. At 1,400 files with ~5 chunks each = ~7,000 vectors. In-memory cosine similarity over 7K vectors takes <10ms. No need for ANN or a vector DB until brain reaches 100K+ chunks.
- No cloud dependency. Ollama runs locally. If Ollama is down, keyword fallback still works (existing circuit breaker pattern).
- Chunking and embedding are background operations. Never block the chat response path.

---

## Build Order

1. **embedder.ts** — extract Ollama embed functions from VectorIndex. Update VectorIndex to import from it.
2. **chunker.ts** — markdown-aware chunking. Pure function, no I/O. Easy to test.
3. **brain-rag.ts** — BrainRAG class. indexAll, indexFile, removeFile, query.
4. **file-watcher.ts** — fs.watch wrapper with debounce.
5. **Wire brain-docs.ts** — replace content scan (Mode 2) with RAG query.
6. **Wire files_search** — add semantic fallback in MCP tool.
7. **Wire server startup** — init BrainRAG, start watcher, background indexAll.

Steps 1-3 are the core. Steps 4-7 are wiring. Each step is independently testable.

---

## Estimated Sizing

| Metric | Value |
|--------|-------|
| Files in brain | ~1,400 |
| Searchable files (md, yaml, txt) | ~800 |
| Average chunks per file | ~5 |
| Total chunks | ~4,000 |
| Embedding dimensions | 768 |
| Bytes per embedding | 768 × 4 = 3,072 |
| file-embeddings.jsonl size | ~12MB (4K chunks × 3KB each) |
| In-memory footprint | ~12MB (Float32Arrays) |
| Initial index time (Ollama, local) | ~60s (4K chunks at ~70 chunks/s) |
| Incremental index (1 file change) | <1s |
| Query latency (embed + cosine over 4K) | ~200ms (embed) + <5ms (search) |

---

## Decisions (resolved 2026-03-09)

1. **Chunk size:** 512 tokens. Accepted. Header-first splitting handles most cases naturally; 512 is the fallback for long sections. Tune only if retrieval quality disappoints.
2. **Multi-file injection:** Option B — best file + sibling listing. Return the top-scoring file plus a listing of other files in the same directory. Dash can decide to load more. Full collection injection (option C) deferred.
3. **Embedding model:** `nomic-embed-text`. Already used by VectorIndex. Swap to `mxbai-embed-large` only if retrieval quality disappoints. Model is a single constant — re-index is ~60s.
4. **JSONL growth:** Let it grow. No compaction. 12MB base, append-only. Add compaction only if file becomes unwieldy (100MB+).
