# Resolution Scanner Spec

*Complement to the resonance scanner — detects when open loops have been resolved.*

## Problem

The Open Loop Protocol has a one-way escalation path. The resonance scanner (`src/openloop/scanner.ts`) moves loops from `active` → `resonant` when it finds semantic matches. But nothing moves loops from `resonant` → `expired` when the underlying tension is resolved.

Resonant loops are exempt from time-based decay. So a resolved tension stays active indefinitely — burning scanner cycles, LLM tokens, and log entries — until a human manually appends a resolution line to the JSONL.

The system can detect new connections but can't detect when a problem has been fixed.

## Solution

Add a **resolution scanner** that runs alongside the existing resonance scanner. It checks resonant loops against recent git commits and activity entries to determine if the underlying question has been answered. On confirmation, it transitions the loop to `expired` with `resolvedBy` set and logs a detailed activity entry.

## Architecture

### Signal Sources

Two inputs, checked in order:

1. **Git commits** — Parse recent commit messages and (optionally) changed file paths for semantic overlap with the loop's `dissonance` and `searchHeuristic` fields
2. **Activity entries** — Same source the resonance scanner uses, but looking for resolution signals rather than connection signals

### Pipeline (mirrors resonance scanner)

```
Every scan cycle (5 min):
  1. Collect resonant loops
  2. Collect new signals since last resolution scan:
     a. Git commits since last scan (git log --since)
     b. Activity entries since last scan watermark
  3. For each resonant loop:
     a. Vector similarity between loop text and signal text
     b. If similarity >= threshold → candidate
  4. LLM confirmation (conservative):
     "Has this tension been RESOLVED, not just touched?"
  5. On confirmation:
     a. Transition loop: state → expired, resolvedBy → signal ID
     b. Log activity entry with source "open-loop", explaining what resolved it
  6. Advance watermark
```

### Key Difference from Resonance Scanner

The resonance scanner asks: *"Does this new thing relate to the open question?"*
The resolution scanner asks: *"Does this new thing ANSWER the open question?"*

The LLM prompt must be tuned for this distinction. A commit that mentions "temporal reasoning" is a resonance candidate. A commit that *fixes* the temporal reasoning bug is a resolution candidate.

## LLM Confirmation Prompt

```
You are a resolution detector for Dash's Open Loop Protocol.

You receive a resonant open loop (an unresolved tension) and a candidate signal
(a git commit or activity entry). Your job is to determine whether the signal
RESOLVES the tension — not just touches it.

Resolution means:
- The specific question/contradiction in the dissonance has been answered
- Code was written, tested, or deployed that addresses the root cause
- The open question no longer needs monitoring because its purpose has been fulfilled

NOT resolution:
- The signal merely discusses the same topic
- The signal acknowledges the problem without fixing it
- The signal addresses a related but different question
- Partial fixes that leave the core issue open

Respond with JSON:
{
  "resolved": true/false,
  "confidence": "high" | "medium" | "low",
  "explanation": "Why this does/doesn't resolve the tension"
}

Only return resolved: true with high or medium confidence.
```

## Git Commit Scanning

### Collecting commits

```typescript
// Get commits since last scan
const since = lastResolutionScanTime.toISOString();
const result = execSync(
  `git log --since="${since}" --format="%H|||%s|||%b" --no-merges`,
  { encoding: 'utf-8' }
);
```

### What to extract per commit

- **Hash** — used as `resolvedBy` identifier (prefixed: `commit:<short-hash>`)
- **Subject + body** — semantic content for matching
- **Changed files** — cross-reference against loop's `searchHeuristic` keywords

### Watermark

Store `lastResolutionScanCommit` (hash) alongside the existing `lastScanId` for activity entries. Both advance independently.

## State Transition

On confirmed resolution:

```typescript
await transitionLoop(loopId, "expired", resolvedBySignalId);

logActivity({
  source: "open-loop",
  summary: `Loop ${loopId} resolved: ${explanation}`,
  detail: JSON.stringify({
    loopId,
    anchor: loop.anchor,
    dissonance: loop.dissonance,
    resolvedBy: signalId,
    confidence,
    explanation,
  }),
});
```

No separate document is generated. The activity entry IS the record. It stays in the activity log and surfaces in the Observatory's River section.

## Integration Points

### Scanner Module

Add to `src/openloop/scanner.ts` or create `src/openloop/resolution-scanner.ts` (prefer new file to keep concerns separate).

### Scan Cycle

Option A: Run resolution scan in the same `setInterval` as the resonance scanner, after resonance completes.
Option B: Separate interval (same 5-min cadence, offset by 2.5 min to spread load).

**Recommend Option A** — simpler, and resolution scanning is lightweight (only checks resonant loops, which are a small subset).

### Thresholds

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Vector similarity threshold | 0.60 | Slightly higher than resonance (0.55) — resolution needs stronger match |
| LLM confidence minimum | medium | Don't auto-close on low confidence |
| Max loops per scan | 10 | Bound LLM calls per cycle |
| Git lookback on first run | 24h | Don't scan entire history |

### Watermark Persistence

Store in the same way the resonance scanner stores its watermark. Either in-memory (reset on restart, re-scans recent) or append to a small state file.

**Recommend in-memory with 24h git lookback on cold start.** On restart, it'll re-check recent commits against any still-resonant loops. Idempotent — resolving an already-expired loop is a no-op.

## Edge Cases

1. **Partial resolution** — Loop has multiple facets; commit fixes one. LLM should return `resolved: false` with explanation noting partial progress. Loop stays resonant.

2. **False positive** — LLM incorrectly marks resolved. Mitigation: require `medium+` confidence. Worst case: loop goes expired, but the knowledge stays in vector space (expired loops still influence retrieval). If the tension resurfaces, a new loop can be created.

3. **Agent-spawned fixes** — Agent commits may not have descriptive messages. Resolution scanner should check changed file paths against `searchHeuristic` keywords as a secondary signal, not just commit message text.

4. **Multiple loops resolved by same commit** — Fine. Each gets its own transition line and activity entry, all pointing to the same `resolvedBy`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/openloop/resolution-scanner.ts` | **New.** Core resolution detection logic. |
| `src/openloop/scanner.ts` | **Modify.** Call resolution scan after resonance scan in the interval handler. |
| `src/openloop/index.ts` | **Modify.** Export new module. |
| `src/server.ts` | **Modify.** Wire startup/shutdown if resolution scanner has its own lifecycle. Likely minimal — just import and let scanner.ts call it. |

## Success Criteria

1. Resonant loops whose tension has been addressed in code are automatically transitioned to expired within one scan cycle (5 min)
2. Each resolution produces a detailed activity entry visible in the Observatory
3. Loops that are only partially addressed remain resonant
4. No false closures on low-confidence matches
5. Git commits from autonomous agents are detected as resolution signals
6. Cold restart re-scans last 24h of commits against any resonant loops
