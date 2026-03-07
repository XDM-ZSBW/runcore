# Membrane Translation — Spec

> Status: Draft (2026-03-07)
> Origin: "The membrane is translation, not redaction."
> Depends on: privacy-as-membrane-spec.md, nerve-vocabulary-spec.md, vault-ledger-spec.md, the-fields-spec.md, agent-archetypes-spec.md

## What

The membrane is the boundary between inside and outside. Everything that leaves the brain passes through it. Everything that enters passes through it. The membrane doesn't block — it translates. The same signal becomes different shapes depending on who's receiving it, what nerve it's traveling through, and what access the receiver has.

## Why

Redaction is destructive. You take content and remove parts. What's left is incomplete — a document with black bars. The reader knows something is missing. The signal is degraded.

Translation is constructive. You take content and reshape it for the audience. A doctor's note becomes a summary for the patient. A financial report becomes a dashboard for the CEO. Nothing is missing — the signal is complete, just in a different shape.

The membrane translates brain signal into the appropriate shape for every context. The brain holds one truth. The membrane emits many shapes of that truth. No shape is the "real" one — each is the right one for its destination.

## Done when

- Every outbound signal passes through the membrane before emission
- Every inbound signal passes through the membrane before absorption
- The membrane translates based on: destination (nerve, bond, field), access (vault tier, archetype), and context (posture, urgency)
- Translation is lossless in meaning but lossy in detail (the right amount of information for the destination)
- The membrane never emits vault:secured content, regardless of translation
- Translation rules are auditable (the brain can show what it translated and why)
- The membrane works identically whether the brain is on a PC, phone, or hosted

## Outbound translation

### Signal → Nerve

The same brain state produces different output per nerve type:

**Example: "3 agents working, 2 specs in progress, joy at 3.1"**

| Nerve | Translation |
|-------|-----------|
| Keyboard (PC) | Full stream: `🟢 ⚡ agent_batch building stream-spec (3/5 criteria)` per agent, detailed |
| Touch (phone) | Compressed: "3 agents active, 2 specs building" — one summary line |
| Glance (watch) | Three dots: green, green, blue — no text, no detail |
| Voice (speaker) | "Things are moving. Three agents working on two specs. Joy is steady." |
| Haptic (wrist) | Two gentle pulses — "activity, not urgent" |

Same brain state. Five different shapes. Each is complete for its nerve — the watch doesn't need agent names, the voice doesn't need line-by-line stream entries. The membrane knows what each nerve can carry and translates accordingly.

### Signal → Bond

Content crossing a tunnel to a bonded instance is translated based on the tunnel policy:

**Example: "Bryant is working on tax strategy, meeting Dad Thursday"**

| Tunnel content type | What crosses |
|--------------------|-------------|
| `availability` | "Bryant is busy Monday-Wednesday, available Thursday" (no content, just windows) |
| `nudge` | "Thinking of you" (no detail, just signal) |
| `board` | "Thursday meeting: discuss vacation plans" (the shared item, not the context) |

The membrane strips context that isn't in the tunnel policy. Not by deleting — by translating to the appropriate content type. The full thought ("working on tax strategy") never crosses because `strategy` isn't a tunnel content type. But `availability` is — so the time signal translates through.

### Signal → Field

Brain signal entering the field is translated to anonymous typed signal:

**Example: "Bryant's joy dropped from 3.5 to 2.1 after 3 consecutive agent errors"**

| Field layer | What the field receives |
|-------------|----------------------|
| Presence | `{alive: true}` — nothing else |
| Pulse | `{sense: 0.6, work: 0.7, joy: 0.3}` — three anonymous numbers |
| Compost | `{type: "error_pattern", pattern: "consecutive_agent_failures", outcome: "joy_drop"}` — typed lesson, no identity |
| Weather | (computed by field engine from aggregate, not emitted by brain) |
| Gravity | (computed from tunnel density, not emitted by brain) |

The membrane translates rich internal state into anonymous signal. "Bryant is frustrated because his agents keep failing" becomes "a brain experienced joy drop after consecutive errors." The pattern crosses. The person doesn't.

## Inbound translation

### Nerve → Brain

Input from nerves is translated to brain-native format:

| Nerve input | Translation to brain |
|-------------|---------------------|
| Typed message (keyboard) | Chat message → thread → sense phase input |
| Tap on joy prompt (touch) | Joy signal → `{signal: 3, trigger: "prompt", ts: ...}` → joy.jsonl |
| Voice command (voice) | STT → parsed intent → same as typed message |
| Glance duration (watch) | Presence signal → engagement metric → sense phase input |
| Haptic acknowledgment (wrist) | Binary: acknowledged/dismissed → notification state update |

The brain never sees "a keyboard event" or "a tap event." It sees brain-native signals: messages, joy readings, presence, acknowledgments. The membrane translates hardware into meaning.

### Bond → Brain

Inbound tunnel content is translated from the peer's format to brain-native:

```
Peer sends: {type: "board", content: "Discuss vacation Thursday", from: "7f3a"}
Membrane:   → validates signature (is this really from 7f3a?)
            → decrypts payload (E2E)
            → checks tunnel policy (is "board" in accept list?)
            → translates to brain format: board item in brain/bonds/7f3a/board.jsonl
            → surfaces in sense phase as "inbound board item from Dad"
```

### Field → Brain

Field signal is translated from aggregate to personal context:

```
Field sends: {pulse: {sense: 0.72, work: 0.61, joy: 0.44}, weather: "busy"}
Membrane:   → mixes with local state (local joy 3.1 vs field joy 0.44 = "you're above average")
            → translates weather to personal context: "the field is busy today"
            → surfaces in sense phase as field awareness
```

The membrane's job on inbound field signal is mixing — blending the anonymous aggregate with the personal. "Joy is 0.44 across the field" means nothing alone. "Your joy is 3.1 but the field is at 0.44 — you're doing better than average" is useful.

## Translation rules

### By vault tier

| Tier | Outbound rule |
|------|--------------|
| Open | Translates freely to all destinations |
| Community | Translates only to bonded instances via tunnel |
| Secured | Never translates outbound. Period. |

### By archetype

| Archetype | Membrane posture |
|-----------|-----------------|
| Creator | Thinnest — translates most freely (carries the dictionary) |
| Founder | Adaptive — translates based on bond trust level and context |
| Template | Standard — translates per tunnel policy, no exceptions |
| Operator | Thick — translates only operational signal (process, not content) |
| Observer | One-way — translates outbound measurements only, absorbs everything inbound |

### By posture

| Posture | Translation behavior |
|---------|---------------------|
| Silent | Outbound: minimal (heartbeat only). Inbound: queued, not processed. |
| Pulse | Outbound: pulse signal. Inbound: priority items only. |
| Board | Outbound: full translation active. Inbound: everything processed. |

### By urgency

| Urgency | Translation behavior |
|---------|---------------------|
| Low | Standard translation rules apply |
| Medium | Inbound priority increases (more gets through to the human) |
| High | Outbound narrows (conservation), inbound widens (everything reaches the human) |
| Crisis | Outbound: emergency signals only. Inbound: everything, unfiltered. |

## Translation is not filtering

Filtering removes things. Translation reshapes them.

```
Filtering:  "Bryant's tax strategy for 2026 includes..."
            → [REDACTED]'s [REDACTED] for [REDACTED] includes..."

Translation: "Bryant's tax strategy for 2026 includes..."
            → (to field): {type: "planning_pattern", pattern: "annual_financial_review"}
            → (to bond): "I'm doing some financial planning"
            → (to nerve/glance): amber sense dot (planning activity detected)
            → (to nerve/voice): "You're working on financial planning"
```

Every translation is a complete signal for its destination. Nothing is missing. Nothing is redacted. The signal is reshaped, not reduced.

## Translation and the stream

Translation events appear in the stream when they're interesting:

```
🔵 📡 14:32:07  membrane: translated board item for bond_7f3a (stripped: 2 secured refs)
🟢 📡 14:32:08  membrane: field emission — compost pattern "error_recovery" (anonymous)
🟡 🔌 14:32:09  membrane: nerve translation — watch got pulse, phone got summary, PC got full stream
```

Most translations are routine (🔵). The human doesn't need to see every nerve translation. But when the membrane strips something (secured references removed from a bond translation), that's worth noting (🟡).

## Translation audit

Every translation is logged:

```jsonl
{"ts":"2026-03-07T09:00:00Z","direction":"outbound","source":"board_item_42","destination":"bond_7f3a","type":"board","translated":true,"stripped":["ref_to_vault_item"],"reason":"vault:secured ref cannot cross membrane"}
{"ts":"2026-03-07T09:00:01Z","direction":"outbound","source":"brain_state","destination":"field","type":"compost","translated":true,"pattern":"error_recovery","identity_stripped":true}
{"ts":"2026-03-07T09:00:02Z","direction":"inbound","source":"bond_7f3a","type":"board","validated":true,"decrypted":true,"absorbed":"brain/bonds/7f3a/board.jsonl"}
```

The audit trail answers: what crossed the membrane, in which direction, what was translated, and what was stripped. This is the receipt. If someone asks "did my data leave my brain?" the audit has the answer.

## The principle

The membrane is not a wall. It's a lens. A wall blocks. A lens focuses. The same light passes through a lens and becomes a different image depending on the lens shape. The membrane shapes every signal for its destination — same truth, different resolution.

The brain holds high-resolution truth. The membrane emits the right resolution for every consumer. A watch gets thumbnail resolution. A bonded brain gets summary resolution. The field gets pattern resolution. The human at their PC gets full resolution. Nobody gets the wrong resolution for their context.

Privacy isn't about hiding. It's about showing the right thing to the right entity in the right shape. The membrane makes that automatic.

## Open questions

1. **Translation loss** — Is any translation truly lossless in meaning? When "tax strategy" becomes "financial planning pattern," is meaning preserved or degraded?
2. **Translation disputes** — What if the human disagrees with a translation? "I didn't want that pattern shared as compost." Can they retract?
3. **Translation learning** — Should the membrane learn from corrections? "Don't translate financial content to compost" as a standing rule?
4. **Translation latency** — Does translation add perceptible delay? Especially for real-time nerves (voice, haptic)?
5. **Translation and AI** — Should the membrane use LLM for complex translations? Or is it rule-based only? LLM adds latency and cost. Rules are fast but rigid.
6. **Bidirectional transparency** — Should bonded brains see HOW their signal was translated on the other side? "Dad's brain translated your board item to: [summary]"
