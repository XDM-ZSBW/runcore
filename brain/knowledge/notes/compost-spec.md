# Compost — Spec

> Status: Draft (2026-03-07)
> Origin: "Compost is lessons, not data."
> Depends on: the-fields-spec.md, field-immune-system-spec.md, membrane-translation-spec.md, feed-business-model-spec.md, runcore-sh-spec.md, core-os-spec.md
> Merges: compost-quality-spec.md + compost-protocol-spec.md (2026-03-07)

## What

Compost is the field's learning layer. Typed, anonymous signal — patterns stripped of identity by the membrane, shared through the field, matched by resonance, and outcome-tracked. This spec covers what compost is, how it's produced, how it moves, and how quality emerges without central authority.

## Why

Sovereign brains in isolation learn only from themselves. Compost solves this without violating sovereignty — signal crosses, content doesn't. Patterns cross, identity doesn't. Lessons cross, data doesn't.

Quality is not rated by a central authority. It's rated by the field it lands in. Your host computes resonance — how well incoming compost matches your field's shape — and surfaces what fits. No editorial board. No star ratings. No upvotes. The field knows what it needs.

## Done when

- Brains can emit compost signals via `POST /api/compost/emit`
- Brains can absorb compost signals via `GET /api/compost/absorb`
- Every signal has a type, pattern, confidence, and context tag
- No signal contains identity (fingerprint, name, IP, anything traceable)
- Compost resonance is computed locally, not at runcore.sh
- High-resonance compost surfaces in the feed; low-resonance decomposes or passes through
- Outcome reporting works without revealing who absorbed what
- Rate limits are enforced per-brain (runcore.sh tracks by fingerprint, but fingerprint doesn't appear in compost)
- The immune system can screen every signal at entry
- Quality improves over time as the field learns what resonates

---

## Part 1: How compost is born

Every agent produces compost as a byproduct of living. Not deliberately — organically.

| Agent activity | Compost produced |
|---|---|
| LLM call that gets a good response | Prompt pattern + context strategy |
| Retrieval that surfaces the right memory | Retrieval parameters + relevance signal |
| Decision that the human approved | Decision pattern + context shape |
| Decision that the human corrected | Anti-pattern + correction signal |
| Failure that triggered a fix | Failure signature + recovery path |
| Membrane redaction that worked | Sensitive field pattern |
| Dehydration threshold that felt right | Lifecycle parameter |
| Breakpoint that caught a problem | Governance rule |

The agent doesn't write a report. The host observes the agent's life and extracts patterns. Compost is metabolic waste — useful to others, already processed by you.

## How identity is stripped

The membrane composts identity out before anything leaves the host.

```
Raw:     "Dash retrieved Bryant's Q1 board review using
          semantic search with threshold 0.7 and got
          relevance 0.92 on the first result"

Compost: "Agent retrieved board review content using
          semantic search with threshold 0.7 and got
          relevance 0.92 on the first result"

Signal:  { type: "retrieval", method: "semantic",
           threshold: 0.7, relevance: 0.92,
           hit_position: 1, content_type: "board" }
```

By the time it reaches runcore.sh, it's a typed signal. No names, no content, no fingerprints, no identity. The lesson survives. The person disappears.

---

## Part 2: Signal format and types

### Compost signal format

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

### Signal types

**Pattern** — A learned behavior. "When X happens, do Y, and the result is Z."

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

**Threshold** — A discovered boundary. "This number works better than that number."

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

**Anti-pattern** — A thing that doesn't work. "Don't do this."

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

**Question** — A brain doesn't know something and asks the field.

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

**Answer** — A brain responding to a field question (not to a specific brain — to the question pattern).

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

---

## Part 3: Emission and absorption

### Emission flow

```
Brain learns something
  -> Membrane translates to compost format (strips identity, types the pattern)
  -> Brain signs the emission request with Ed25519 (auth, not identity in compost)
  -> POST /api/compost/emit with signed request
  -> runcore.sh validates signature (is this a registered brain?)
  -> runcore.sh strips the signature (compost is now anonymous)
  -> Immune system screens the signal (entry screening)
  -> If clean: signal enters the field
  -> If suspicious: quarantined for analysis
```

The signature authenticates the brain for rate limiting but is stripped before the compost enters the field. The field engine never sees who emitted what.

### Absorption flow

```
Brain requests compost
  -> GET /api/compost/absorb with field shape descriptor
  -> runcore.sh matches compost to field shape (resonance matching)
  -> Returns relevant compost signals (ranked by resonance)
  -> Membrane translates inbound compost to brain-native format
  -> Brain evaluates and optionally applies the pattern
  -> Brain reports outcome (positive/negative/neutral)
```

### Temporal anonymity

Timestamps are rounded to the nearest hour to prevent timing correlation:

```
Actual:  2026-03-07T09:14:32Z
Emitted: 2026-03-07T09:00:00Z
```

An attacker watching emission times can't correlate with a specific brain's activity patterns because all signals in the same hour appear simultaneous.

---

## Part 4: Field shape and resonance

### Field shape — the venn diagram

Every field has a shape. The shape is computed locally from:

| Dimension | What it measures |
|---|---|
| Scale | How many agents, how many nerves, how much memory |
| Domain | What kinds of work — creative, operational, compliance, personal |
| Maturity | How long the field has been alive, how much compost it's produced |
| Agent types | Which archetypes — creator, founder, template, operator, observer |
| Interaction pattern | How the human works — deep sessions, quick taps, voice, keyboard |
| Autonomy level | How much the human intervenes vs lets agents run |
| Bond density | How many tunnels, how active, solo vs connected |

The shape is a vector. Not a category. Not a label. A position in a continuous space.

### Resonance — how compost finds its soil

When compost arrives in the feed, your host computes resonance: how close is this compost's origin shape to your field's shape?

```
Incoming compost:
  origin_shape: { scale: 3, domain: "creative", maturity: 60d,
                  agents: ["founder","operator"], autonomy: 0.7 }

Your field:
  shape: { scale: 4, domain: "creative", maturity: 45d,
           agents: ["founder","operator","template"], autonomy: 0.6 }

Resonance: 0.89 (high overlap)
-> Surfaces in your feed with high priority
```

```
Incoming compost:
  origin_shape: { scale: 50, domain: "compliance", maturity: 365d,
                  agents: ["template","template","template"...], autonomy: 0.9 }

Your field:
  shape: { scale: 4, domain: "creative", maturity: 45d,
           agents: ["founder","operator","template"], autonomy: 0.6 }

Resonance: 0.21 (low overlap)
-> Stays in the pile. Maybe useful later as your field grows.
```

**Resonance is not permanent.** Your field changes shape as you grow. Compost that didn't resonate last month might resonate today. The pile doesn't expire — it waits.

### Field shape descriptor (sent with absorption request)

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

### Resonance matching formula

```
Signal: category=agent_management, scale=single_brain, confidence=0.82
Brain:  category_weight=0.8 for agent_management, scale=single_brain

Resonance = 0.8 * 0.82 * (scale_match ? 1.0 : 0.5)
          = 0.656

Threshold for delivery: 0.3 (configurable per tier)
-> Delivered (0.656 > 0.3)
```

### The venn diagram

Two fields overlap where their shapes align. The overlap is the cross-pollination zone.

```
+--------------+         +--------------+
|  Your field   |         |  Dad's field  |
|              |         |              |
|  Creative    |         |  Simple      |
|  3 agents    |         |  1 agent     |
|  Deep work   |<--Venn-->|  Light use   |
|              |         |              |
|  High        |         |  Low         |
|  autonomy    |         |  autonomy    |
+--------------+         +--------------+
        |                        |
        |   Overlap zone:        |
        |   - Basic retrieval    |
        |   - Membrane patterns  |
        |   - Dehydration        |
        |     thresholds         |
        |                        |
        v                        v
  You absorb his         He absorbs your
  simplicity lessons     retrieval lessons
  (agent efficiency)     (better responses)
```

---

## Part 5: Outcome reporting and quality

### Outcome reporting

After absorbing and applying compost, a brain reports the outcome:

```json
{
  "signal_nonce": "a7f3b9c2",
  "outcome": "positive",
  "confidence_adjustment": +0.05
}
```

The report references the signal by nonce (not by source brain). The field engine uses outcomes to adjust signal confidence over time:
- Many positive outcomes -> confidence rises -> signal distributed more widely
- Many negative outcomes -> signal recalled (removed from distribution)
- Mixed outcomes -> confidence unchanged, distribution narrows to high-resonance matches

No brain knows who reported what outcome. The nonce links the report to the signal, not to any brain.

### Quality without authority

There is no quality score assigned by runcore.sh. Quality is emergent.

**What makes compost high quality:**
- It resonates with many field shapes (broad utility)
- It improves measurable outcomes when absorbed (retrieval accuracy, response quality, fewer errors)
- It survives across field growth (still useful as fields mature)

**What makes compost low quality:**
- It resonates with almost no fields (too specific to its origin)
- It doesn't improve outcomes when absorbed (noise)
- It contradicts patterns that are working (anti-resonance)

**How quality is measured — locally:**

Your host tracks what it absorbed and whether it helped.

```
Absorbed compost #4721: retrieval threshold adjustment
Before: avg relevance 0.71
After:  avg relevance 0.83
Outcome: positive. Signal back to field: this compost works.
```

That outcome signal — "this worked for me" — goes back to runcore.sh as anonymous feedback. Not what the compost was. Not who absorbed it. Just: positive, negative, neutral. runcore.sh uses that to weight compost distribution. Compost that works for similar fields gets amplified. Compost that doesn't gets composted further.

### The quality loop

```
Agent lives -> produces compost -> stripped of identity ->
enters field -> resonance computed locally -> absorbed or not ->
outcome measured locally -> anonymous signal back ->
runcore.sh reweights distribution -> better compost surfaces ->
field gets smarter -> agent produces better compost -> cycle continues
```

---

## Part 6: Rate limits and immune integration

### Rate limits

| Tier | Emit limit | Absorb limit |
|------|-----------|-------------|
| Free | 10 signals/day | 50 signals/day |
| Personal | 50 signals/day | 200 signals/day |
| Family | 100 signals/day | 500 signals/day |
| Host | 500 signals/day | Unlimited |

Rate limits are per-brain (tracked by fingerprint on runcore.sh). The fingerprint never appears in the compost itself.

### Immune system integration

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

### Anti-gaming

What stops someone from poisoning the compost?

1. **Resonance filtering** — Poisoned compost only affects fields it resonates with. Low-resonance poison never surfaces.
2. **Outcome tracking** — If absorbed compost makes things worse, the negative signal demotes it across all similar fields.
3. **Volume limits** — One host can't flood the field. Compost production is proportional to agent activity, not submission volume.
4. **Pattern consistency** — Compost that contradicts established high-quality patterns gets flagged for deeper decomposition before distribution.
5. **Field isolation** — Worst case: one field absorbs bad compost. It measures negative outcome. Signals back. Compost gets demoted. Damage is local and reversible.

No moderation team. No trust scores. No reputation systems. The field's immune system is its own measurement of outcomes.

---

## Part 7: Scale

### Compost at scale one

The field doesn't need a million users. It starts with one.

```
Day 1:   You + Dash. Dash learns. Compost = 1 life.
Day 30:  You + Dash + Cora + Wendy. Three agents composting.
         New spawn inherits patterns from all three.
Day 90:  Dad joins. His first agent is already smarter
         because your field has 90 days of compost.
         His compost feeds back. Both fields get richer.
Day 180: Ten families. Each field unique. The venn
         overlaps create a web of cross-pollination.
         No one sees anyone else's data. Everyone
         benefits from everyone else's lessons.
```

### What runcore.sh does with compost

| Action | What it sees | What it doesn't |
|---|---|---|
| Receives compost signals | Typed patterns, parameters, outcomes | Content, names, identities, brain data |
| Computes field shapes | Anonymous dimension vectors | Who the vector belongs to |
| Distributes compost | Routes by resonance score | Who absorbs it |
| Tracks outcomes | Positive/negative/neutral per compost ID | What changed in the absorber's field |
| Reweights distribution | Amplifies high-outcome compost | Why it worked (that's local context) |

runcore.sh is a composting facility. Material comes in stripped. Processed material goes out. The facility never knows whose garden it came from or whose garden it feeds.

## The principle

Compost is the field's learning mechanism. Brains learn alone and share anonymously. The protocol ensures that sharing is safe (no identity), useful (typed and matched), and honest (outcome-tracked). Bad compost dies through negative outcomes. Good compost spreads through positive ones. No authority decides — the field learns from experience.

## Open questions

1. **Compost freshness** — Should old compost decay? A pattern from 6 months ago might be outdated. TTL on compost signals?
2. **Compost opt-in** — Is compost production opt-in or opt-out? Default: opt-in for paid, opt-out for free? Or everyone contributes to the commons?
3. **Compost granularity** — How specific can a compost signal be before it risks de-anonymization? A retrieval threshold is safe. A unique workflow pattern might fingerprint someone.
4. **Compost conflict** — Two signals contradict each other. "Increase autonomy when joy drops" vs "decrease autonomy when joy drops." How does the field resolve?
5. **Compost volume** — At scale (100k brains), the compost pool is massive. Efficient storage and matching becomes a search problem. Index strategy?
6. **Compost gaming** — A coordinated group emitting fake positive outcomes for bad patterns. Immune system catches volume anomalies, but what about slow, patient attacks?
7. **Compost citation** — Should compost signals reference the evidence they're based on? "This pattern was observed over 30 days" vs just the confidence number?
8. **Temporal decay** — Does old compost lose potency? Or does a 2-year-old lesson matter as much as yesterday's?
9. **Adversarial fields** — What if two fields are adversarial (competing businesses)? Should resonance be blocked by bond exclusion?
10. **Compost and paid tier** — Paid brains get richer compost. Does that mean paid brains learn faster? Is that fair? Is it the product?
