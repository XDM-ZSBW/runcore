# Compost Protocol — Spec

> Status: Retired (2026-03-07) — merged into compost-spec.md
> Origin: "Compost is lessons, not data."
> Depends on: compost-quality-spec.md, the-fields-spec.md, field-immune-system-spec.md, membrane-translation-spec.md, runcore-sh-spec.md

## What

The wire protocol for how brains emit compost into the field and absorb compost from it. Typed signal with no identity. Patterns, not content. The compost protocol defines the envelope format, emission rules, absorption matching, and outcome reporting that makes the field's learning layer work.

## Why

Compost quality spec says what compost is. This spec says how it moves. The protocol needs to be:
- **Typed** — every compost signal has a declared type so the field can route it
- **Anonymous** — no identity in the envelope, no way to trace to a brain
- **Outcome-trackable** — brains report whether absorbed compost helped, without revealing who reported
- **Rate-limited** — volume caps prevent flooding
- **Immune-compatible** — format allows the immune system to screen at entry

## Done when

- Brains can emit compost signals via `POST /api/compost/emit`
- Brains can absorb compost signals via `GET /api/compost/absorb`
- Every signal has a type, pattern, confidence, and context tag
- No signal contains identity (fingerprint, name, IP, anything traceable)
- The field engine matches compost to brains by field shape, not by identity
- Outcome reporting works without revealing who absorbed what
- Rate limits are enforced per-brain (runcore.sh tracks by fingerprint, but fingerprint doesn't appear in compost)
- The immune system can screen every signal at entry

## Compost signal format

```json
{
  "type": "pattern",
  "category": "error_recovery",
  "pattern": {
    "trigger": "consecutive_agent_failures",
    "response": "reduce_concurrent_agents",
    "outcome": "positive",
    "confidence": 0.82
  },
  "context": {
    "domain": "agent_management",
    "scale": "single_brain",
    "recency": "7d"
  },
  "ts": "2026-03-07T09:00:00Z",
  "nonce": "a7f3b9c2"
}
```

**Required fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `type` | enum | Signal type: `pattern`, `threshold`, `anti-pattern`, `question`, `answer` |
| `category` | string | Domain category for routing: `error_recovery`, `calibration`, `memory`, `onboarding`, etc. |
| `pattern` | object | The actual lesson — trigger/response/outcome/confidence |
| `context` | object | Non-identifying metadata for matching |
| `ts` | ISO8601 | Emission timestamp (rounded to nearest hour for anonymity) |
| `nonce` | string | Random value for deduplication (not for identity) |

**Forbidden fields** (immune system rejects if present):
- Any fingerprint, name, email, or identifier
- IP addresses or location data
- Brain file paths or structure hints
- Specific content (text, files, messages)
- Bond information or relationship data

## Signal types

### Pattern

A learned behavior. "When X happens, do Y, and the result is Z."

```json
{
  "type": "pattern",
  "category": "calibration",
  "pattern": {
    "trigger": "joy_flat_low_7d",
    "response": "increase_autonomy_reduce_questions",
    "outcome": "positive",
    "confidence": 0.75
  }
}
```

### Threshold

A discovered boundary. "This number works better than that number."

```json
{
  "type": "threshold",
  "category": "memory_retrieval",
  "pattern": {
    "parameter": "relevance_cutoff",
    "value": 0.72,
    "comparison": "0.5_default",
    "outcome": "positive",
    "confidence": 0.88
  }
}
```

### Anti-pattern

A thing that doesn't work. "Don't do this."

```json
{
  "type": "anti-pattern",
  "category": "agent_spawning",
  "pattern": {
    "trigger": "spawn_more_than_5_concurrent",
    "expected": "faster_completion",
    "actual": "resource_exhaustion_and_errors",
    "confidence": 0.91
  }
}
```

### Question

A brain doesn't know something and asks the field.

```json
{
  "type": "question",
  "category": "posture_timing",
  "pattern": {
    "question": "optimal_board_decay_duration_for_daily_users",
    "context": "tried_5min_too_aggressive_tried_30min_too_slow"
  }
}
```

### Answer

A brain responding to a field question (not to a specific brain — to the question pattern).

```json
{
  "type": "answer",
  "category": "posture_timing",
  "pattern": {
    "question_pattern": "optimal_board_decay_duration_for_daily_users",
    "answer": "12_minutes",
    "confidence": 0.7,
    "basis": "30d_observation"
  }
}
```

## Emission flow

```
Brain learns something
  → Membrane translates to compost format (strips identity, types the pattern)
  → Brain signs the emission request with Ed25519 (auth, not identity in compost)
  → POST /api/compost/emit with signed request
  → runcore.sh validates signature (is this a registered brain?)
  → runcore.sh strips the signature (compost is now anonymous)
  → Immune system screens the signal (entry screening)
  → If clean: signal enters the field
  → If suspicious: quarantined for analysis
```

The signature authenticates the brain for rate limiting but is stripped before the compost enters the field. The field engine never sees who emitted what.

## Absorption flow

```
Brain requests compost
  → GET /api/compost/absorb with field shape descriptor
  → runcore.sh matches compost to field shape (resonance matching)
  → Returns relevant compost signals (ranked by resonance)
  → Membrane translates inbound compost to brain-native format
  → Brain evaluates and optionally applies the pattern
  → Brain reports outcome (positive/negative/neutral)
```

### Field shape descriptor

Each brain has a shape — the categories and domains it operates in. The shape is computed locally and sent as a matching hint:

```json
{
  "shape": {
    "categories": ["agent_management", "calibration", "memory_retrieval"],
    "weights": [0.8, 0.5, 0.3],
    "scale": "single_brain",
    "maturity": "30d"
  }
}
```

The shape says "I care about agent management and calibration." The field returns compost in those categories, ranked by confidence and resonance. The brain doesn't get every signal — it gets the ones that match its shape.

### Resonance matching

Resonance is the overlap between a compost signal's context and a brain's field shape:

```
Signal: category=agent_management, scale=single_brain, confidence=0.82
Brain:  category_weight=0.8 for agent_management, scale=single_brain

Resonance = 0.8 * 0.82 * (scale_match ? 1.0 : 0.5)
          = 0.656

Threshold for delivery: 0.3 (configurable per tier)
→ Delivered (0.656 > 0.3)
```

High resonance = high relevance. The field doesn't spam every brain with every signal. It matches.

## Outcome reporting

After absorbing and applying compost, a brain reports the outcome:

```json
{
  "signal_nonce": "a7f3b9c2",
  "outcome": "positive",
  "confidence_adjustment": +0.05
}
```

The report references the signal by nonce (not by source brain). The field engine uses outcomes to adjust signal confidence over time:
- Many positive outcomes → confidence rises → signal distributed more widely
- Many negative outcomes → signal recalled (removed from distribution)
- Mixed outcomes → confidence unchanged, distribution narrows to high-resonance matches

No brain knows who reported what outcome. The nonce links the report to the signal, not to any brain.

## Rate limits

| Tier | Emit limit | Absorb limit |
|------|-----------|-------------|
| Free | 10 signals/day | 50 signals/day |
| Personal | 50 signals/day | 200 signals/day |
| Family | 100 signals/day | 500 signals/day |
| Host | 500 signals/day | Unlimited |

Rate limits are per-brain (tracked by fingerprint on runcore.sh). The fingerprint never appears in the compost itself.

## Immune system integration

Every emitted signal passes through the immune system:

**Entry screening (milliseconds):**
1. Format validation — does it match the schema?
2. Forbidden field check — any identity markers?
3. Volume check — is this brain emitting abnormally?
4. Pattern check — does this contradict high-confidence established patterns?
5. Signature check — known attack signatures from adversarial memory?

**If suspicious:**
- Quarantined (not distributed)
- Analyzed deeper (pattern correlation, temporal analysis)
- Either released to field or discarded
- Attack signature updated if malicious

**If clean:**
- Enters the field immediately
- Available for absorption matching

## Temporal anonymity

Timestamps are rounded to the nearest hour to prevent timing correlation:

```
Actual:  2026-03-07T09:14:32Z
Emitted: 2026-03-07T09:00:00Z
```

An attacker watching emission times can't correlate with a specific brain's activity patterns because all signals in the same hour appear simultaneous.

## The principle

Compost is the field's learning mechanism. Brains learn alone and share anonymously. The protocol ensures that sharing is safe (no identity), useful (typed and matched), and honest (outcome-tracked). Bad compost dies through negative outcomes. Good compost spreads through positive ones. No authority decides — the field learns from experience.

The protocol is simple because the intelligence is in the matching and the immune system, not in the envelope. A compost signal is a plain JSON object. What makes it powerful is the system that routes it, screens it, and tracks its outcomes.

## Open questions

1. **Compost freshness** — Should old compost decay? A pattern from 6 months ago might be outdated. TTL on compost signals?
2. **Compost citation** — Should compost signals reference the evidence they're based on? "This pattern was observed over 30 days" vs just the confidence number?
3. **Compost conflict** — Two signals contradict each other. "Increase autonomy when joy drops" vs "decrease autonomy when joy drops." How does the field resolve?
4. **Compost volume** — At scale (100k brains), the compost pool is massive. Efficient storage and matching becomes a search problem. Index strategy?
5. **Compost gaming** — A coordinated group emitting fake positive outcomes for bad patterns. Immune system catches volume anomalies, but what about slow, patient attacks?
6. **Compost and paid tier** — Paid brains get richer compost. Does that mean paid brains learn faster? Is that fair? Is it the product?
