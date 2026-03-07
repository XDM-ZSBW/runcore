# Membrane Checkpoint — Spec

> Status: Done (completed 2026-03-07)
> Origin: "The mapping table is ephemeral. The values it protects are durable."

> Scope: LLM privacy membrane (`src/llm/membrane.ts`) — the placeholder redaction layer between brain and inference provider

## The problem

The membrane holds a bidirectional map in memory: `"Project Phoenix" <-> <<PROJECT_0>>`. If the process crashes or restarts mid-conversation, the map is gone. Three things break:

1. **Orphaned placeholders.** The LLM's context window still contains `<<PROJECT_0>>` from prior turns. The membrane can't rehydrate responses that reference it.
2. **Counter collision.** A fresh membrane starts counters at zero. If the conversation continues, a new `<<PROJECT_0>>` might map to a different value than the original. Same token, different meaning. The LLM reasons about a ghost.
3. **Audit discontinuity.** The audit log tracks categories and counts but not values. After a restart, the audit for the session has a gap — you can't prove what was redacted before the crash.

None of these are security failures. The sensitive values are safe — they live in brain files, not in the map. These are *reasoning* failures. The LLM loses referential integrity.

## Design constraint

The sensitive values already exist on disk in brain files. The membrane doesn't create secrets — it protects secrets that are already yours, in transit. A checkpoint strategy should not create a *new* secret store. It should reconstruct the map from what's already there.

## The strategy: deterministic reconstruction

Don't checkpoint the map. Rebuild it.

### How it works

The membrane's placeholder assignment is deterministic: values are processed in a fixed order (registry terms sorted longest-first, then patterns), and each category gets a monotonically increasing counter. Given the same inputs in the same order, the same map is produced.

On restart:

1. Load the sensitive registry (already on disk: `brain/knowledge/sensitive.yaml`)
2. Load the conversation history for the active session (already on disk: thread storage)
3. Replay each message through `membrane.apply()` in chronological order — user messages and brain context, not LLM responses
4. The forward/reverse maps rebuild with identical assignments
5. Resume. The next LLM response referencing `<<PROJECT_0>>` rehydrates correctly.

### Why this works

- **No new file.** No encrypted mapping table on disk. No new attack surface.
- **No new secret.** The registry and conversation history already exist. Reconstruction reads what's already there.
- **Deterministic.** Same registry + same messages + same order = same map. The counters land in the same place because the input sequence is identical.
- **Idempotent.** Replaying the same message twice doesn't corrupt the map — `getOrCreatePlaceholder` returns the existing placeholder if the value is already mapped.

### What it requires

The reconstruction depends on three invariants:

1. **Registry stability.** The sensitive registry must not change between crash and restart. If a term is added or removed, the processing order shifts and counters may land differently. Mitigation: registry changes should trigger a map reset (new session context anyway).

2. **Conversation history on disk.** The raw (pre-membrane) messages must be stored. Currently, the conversation history includes the human's original messages and the brain's context assembly. These are the inputs to `membrane.apply()`. The LLM's responses (post-rehydration) are also stored. Both are needed: outbound messages rebuild the map, inbound responses validate it.

3. **Processing order determinism.** The registry terms must be sorted consistently (currently: longest-first by value). Pattern rules must be applied in consistent order (currently: array order from registry). This is already true in the implementation but should be documented as a contract.

### What it doesn't cover

- **Dynamic values from user input.** If the user types a sensitive value mid-conversation that isn't in the registry (e.g., a phone number caught by pattern matching), the membrane maps it on the fly. Reconstruction catches this — the user's message is in the conversation history, and replaying it through `apply()` hits the same pattern match.

- **Values the membrane has never seen.** If a prior session used `<<PROJECT_0>>` and this is a new session with a new membrane, the placeholder is meaningless. This is correct behavior — sessions are independent contexts. The LLM shouldn't carry placeholders across session boundaries.

## Implementation

### PrivacyMembrane additions

```typescript
/**
 * Rebuild the membrane's mapping table from conversation history.
 * Call on restart before resuming inference.
 */
reconstruct(messages: string[]): void {
  // messages = raw outbound texts in chronological order
  // (pre-membrane user messages + context assembly)
  for (const msg of messages) {
    this.apply(msg);  // side effect: populates forward/reverse/counters
  }
}

/**
 * Snapshot the current map state for validation (not persistence).
 * Returns category counts and placeholder list — never raw values.
 */
snapshot(): { size: number; categories: Record<string, number> } {
  const categories: Record<string, number> = {};
  for (const [, count] of this.counters) {
    // counters key is category name
  }
  for (const [cat, idx] of this.counters) {
    categories[cat] = idx;
  }
  return { size: this.forward.size, categories };
}
```

### Reconstruction flow

```
Process restart detected
  |
  v
Load SensitiveRegistry from brain/knowledge/sensitive.yaml
  |
  v
Create fresh PrivacyMembrane(registry)
  |
  v
Load conversation history for active session
  |
  v
Extract raw outbound messages (pre-membrane texts)
  |
  v
membrane.reconstruct(messages)
  |
  v
Validate: membrane.snapshot() matches expected category counts
  |
  v
Resume inference — membrane is warm
```

### Integration point

In `src/server.ts` (or wherever the membrane is instantiated), after session restore:

```typescript
// After restoreSession() succeeds and conversation history is loaded
if (membrane && conversationHistory.length > 0) {
  const rawOutbound = conversationHistory
    .filter(m => m.role === "user" || m.role === "system")
    .map(m => m.rawContent ?? m.content);
  membrane.reconstruct(rawOutbound);
  log.info("Membrane reconstructed", membrane.snapshot());
}
```

### Prerequisite: store raw content

Currently, messages may be stored post-membrane (with placeholders already applied). For reconstruction, the raw pre-membrane content must be available. Two options:

**Option A: Store both.** Each message stores `content` (post-membrane, what the LLM saw) and `rawContent` (pre-membrane, what the human typed). The raw content is on local disk, encrypted with the session key. No new exposure — the brain files already contain these values.

**Option B: Store raw only.** Don't persist the membrane-applied version. Re-apply on read. Simpler storage, slightly more computation on every history load. Matches the "membrane is a lens, not a store" principle — storage holds truth, membrane translates on the fly.

Option B is cleaner. The membrane is a runtime translation layer. Storage should hold the original signal. Translation happens at emission time, every time.

## Edge cases

### Registry changes between crash and restart

If `sensitive.yaml` is edited while the process is down (term added, removed, or reordered), reconstruction produces a different map. Mitigation: version the registry. Store a registry hash in the session metadata. On reconstruction, compare hashes. If they differ, warn the user that placeholder continuity may be broken and offer to start a fresh context.

### Very long conversations

Replaying 500 messages through the membrane on startup adds latency. The membrane is string operations (split/join, regex), not LLM calls — 500 messages should reconstruct in under 100ms. If profiling shows otherwise, batch the replay or parallelize per-message application.

### Concurrent sessions

Each session has its own membrane instance. Reconstruction is per-session. No cross-session contamination.

### Partial crash (one agent dies, others live)

In a multi-agent setup, each agent's membrane is independent. A crashed agent reconstructs its own membrane without affecting others. The orchestration layer doesn't need to coordinate membrane state.

## What this is not

This is not persistence. The map is never written to disk. The map is reconstructed from data that's already on disk for other reasons (conversation history, sensitive registry). The membrane remains stateless-on-disk by design.

This is not backup. If the conversation history is lost, the map can't be reconstructed. But if the conversation history is lost, you have bigger problems than placeholder mapping.

This is not the translation membrane from the parent spec. That spec covers nerve/bond/field translation — reshaping signal for destinations. This spec covers the LLM redaction membrane — protecting sensitive values in transit to inference providers. Same word, different layer. The translation membrane is about what shape information takes. The checkpoint strategy is about keeping the redaction map consistent across restarts.

## Done when

- [x] `PrivacyMembrane.reconstruct(messages)` replays message history to rebuild the map — `src/privacy/privacy-membrane.ts:105-160`, `src/core-os/membrane.ts:771-819`
- [x] `PrivacyMembrane.snapshot()` returns category counts for validation (no raw values) — `src/privacy/privacy-membrane.ts:79-95`, `src/core-os/membrane.ts:747-760`
- [x] Conversation history stores raw (pre-membrane) content, not post-membrane — `src/sessions/store.ts:21-34`, `src/sessions/membrane-checkpoint.ts:116-130`
- [x] On session restore, membrane is reconstructed before inference resumes — `src/server.ts:675-698` (restore → reconstruct → rehydrate → resume)
- [x] Registry hash is checked on reconstruction — mismatch warns, doesn't crash — `src/core-os/membrane.ts:778-785`, `src/privacy/privacy-membrane.ts:125-133`
- [x] Reconstruction handles empty history (fresh session, no-op) — `src/privacy/privacy-membrane.ts:109-119`
- [x] Orphaned placeholders in LLM context rehydrate correctly after reconstruction — `src/sessions/membrane-checkpoint.ts:189-248` (rehydration) + `357-445` (orphan recovery)
- [x] Audit log notes reconstruction event: `{direction: "reconstruct", categories: {...}}` — `src/core-os/membrane.ts:813-816`, `src/privacy/privacy-membrane.ts:153-157`
