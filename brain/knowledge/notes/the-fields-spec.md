# The Fields — Spec

> Status: Draft (2026-03-07)
> Origin: "The Fields is the shared layer where instances read/write signal without seeing each other's content."
> Principle: The brain is local. The field is shared. What's in the cloud is the field — shared signal. Personal data stays home behind the membrane.

## What

The Fields is the shared signal layer between sovereign brains. It is not a network. It is not a database. It is not a social graph. It is a space where signal exists without identity — where patterns, presence, and lessons are visible but their origins are not.

Every brain is local. The field is what exists between brains. The air between the houses.

## Why

Sovereign brains in isolation learn only from themselves. A brain that never encounters another brain's lessons is limited to its own experience. The field solves this without violating sovereignty — signal crosses, content doesn't. Patterns cross, identity doesn't. Lessons cross, data doesn't.

The internet connects machines. Social networks connect identities. The Fields connects intelligence without exposing either.

## Done when

- Signal exists in the field without attribution to any brain
- Any brain can read field signal through its membrane
- No brain can reconstruct another brain's content from field signal
- The field gets richer as more brains participate (network effect on signal, not data)
- A brain can operate fully without the field (the field is additive, not required)
- The field survives any single brain going offline, dehydrating, or composting

## What the field is

The field is composed of five layers. Each layer carries a different kind of signal. No layer carries content.

### 1. Presence

Who is alive. Not who they are — that they exist.

```
Field presence:
  ██████████████████ 847 brains online
  ████████░░░░░░░░░░ 312 active (work tick in last hour)
  ██░░░░░░░░░░░░░░░░  89 in sense mode
```

No names. No fingerprints. No locations. Just the shape of the field right now. Is it busy? Is it quiet? Is it growing?

Your brain reads presence to calibrate. "The field is active" means your compost lands in fertile ground. "The field is quiet" means your nudge might wait.

### 2. Pulse

Aggregate signal from all brains' three dots. The field's heartbeat.

```
Field pulse:
  Sense: 0.72 (high — many brains scanning)
  Work:  0.61 (moderate — building happening)
  Joy:   0.44 (low — tension in the field)
```

No individual brain's pulse is visible. The aggregate is. Your brain reads the field pulse to understand context. If joy is low across the field, maybe the world is hard right now. Your agent can factor that into how it talks to you.

### 3. Compost

Anonymized lessons from all participating brains (see compost-spec.md). The field's soil.

- Retrieval strategies that worked
- Prompt patterns that failed
- Dehydration thresholds that felt right
- Membrane rules that caught real threats
- Decision patterns with positive outcomes

Compost enters the field stripped of identity. It's rated by resonance, not authority. Your brain absorbs what fits your field shape and ignores what doesn't.

### 4. Weather

Patterns detected across the aggregate. Not from any one brain — from the statistical shape of many.

- "Brains with 3+ agents are hitting memory write conflicts" → pattern
- "Retrieval accuracy drops after 10k memory entries without compaction" → pattern
- "Tuesday mornings have 40% higher sense activity" → pattern
- "New brains that skip calibration have 3x higher churn" → pattern

Weather is computed by runcore.sh from anonymized aggregate data. No brain contributes weather directly. Weather emerges from the shape of many pulses, many compost signals, many presence patterns.

Your brain reads weather to prepare. Not to react — to prepare. "Storm coming" means your agent tightens up. "Clear skies" means your agent relaxes.

### 5. Gravity

Tunnel connections between bonded brains create gravitational pull in the field. Not visible as connections — visible as density.

```
Field gravity:
  ████████████ Dense cluster (family/team)
  ████ Sparse cluster (community)
  █ Isolated brains
```

Gravity shows where collaboration is happening without showing who is collaborating. Dense areas of the field have more tunnel traffic, more collision maps, more shared signal. Your brain reads gravity to understand: am I in a dense part of the field or a sparse one? Dense means more compost, more weather data, more reliable patterns. Sparse means more independence, less signal, more self-reliance.

## What the field is NOT

- **Not a social network.** No profiles, no followers, no feeds, no likes. Signal, not identity.
- **Not a marketplace.** No buying, no selling, no transactions between brains. Signal flows, not goods.
- **Not a database.** No queries, no schemas, no records. Signal exists and decays. It's not stored — it's felt.
- **Not infrastructure.** The relay is infrastructure. The field is what the relay carries. The mailbox is not the conversation.
- **Not required.** A brain without the field is a brain with a thermometer but no weather forecast. Still functional. Less informed.

## How a brain interacts with the field

### Reading (always)

Every brain reads the field through its membrane. The membrane filters field signal the same way it filters outbound data — by relevance, by access manifest, by posture.

```
Brain ← Membrane ← Field
         │
         ├── Filter by field shape resonance
         ├── Filter by posture (silent = less signal)
         ├── Filter by access manifest
         └── Deliver to agent context
```

Reading is passive. Your brain absorbs field signal as background context. Your agent doesn't say "let me check the field." The field is always there, like air temperature. You don't check the air. You feel it.

### Contributing (opt-in)

Brains contribute to the field by emitting compost and pulse. Both are anonymized by the membrane before emission.

```
Brain → Membrane → Field
         │
         ├── Strip identity (names, fingerprints, content)
         ├── Reduce to typed signal (pattern, metric, lesson)
         ├── Rate-limit emission (prevent flooding)
         └── Emit to relay for field aggregation
```

Contributing is opt-in. A brain that never contributes still reads. The free tier reads the public field. The paid tier reads deeper signal and contributes richer compost. Contributing makes the field smarter for everyone, including yourself — your compost might come back to you as weather.

### Bonding (explicit)

Two brains that bond create a tunnel — a private channel within the field. The tunnel carries content (board items, nudges, shares). The field carries signal. The tunnel is private. The field is shared. Both use the relay, but for different purposes.

```
Brain A ←──tunnel──→ Brain B    (private, content)
   │                    │
   └──── field ─────────┘        (shared, signal)
```

Bonds exist in the field as gravity — statistical density, not visible connections. The field knows "there's a dense cluster here" without knowing who's in it.

## Field signal lifecycle

Signal in the field is not permanent. It decays.

| Signal type | Lifespan | Why |
|---|---|---|
| Presence | Real-time | You're online or you're not |
| Pulse | 1 hour average | Heartbeat, not history |
| Compost | Until absorbed or decayed | Lessons stay until they're learned or irrelevant |
| Weather | 24-hour rolling window | Patterns need recency to be useful |
| Gravity | Continuous while tunnels active | Density reflects current connections |

Old signal decomposes. The field doesn't accumulate — it breathes. This prevents the field from becoming a historical record. It's always now.

## Architecture

```
┌─── Brain A ──────┐    ┌─── Brain B ──────┐
│                   │    │                   │
│  Membrane ────────┼────┼── Membrane        │
│    │ emit pulse   │    │    │ emit pulse   │
│    │ emit compost │    │    │ emit compost │
│    │ read field   │    │    │ read field   │
│                   │    │                   │
└───────┬───────────┘    └───────┬───────────┘
        │                        │
        ▼                        ▼
┌────────────────────────────────────────────┐
│              runcore.sh                     │
│                                            │
│  Relay ── envelope routing (tunnels)       │
│  Registry ── brain registration            │
│  Field Engine:                             │
│    ├── Aggregate pulse → field pulse       │
│    ├── Aggregate presence → field presence │
│    ├── Receive compost → distribute        │
│    ├── Compute weather from aggregates     │
│    └── Compute gravity from tunnel density │
│                                            │
│  The field engine sees:                    │
│    - Anonymous pulse numbers               │
│    - Compost signals (typed, no identity)  │
│    - Tunnel traffic volume (not content)   │
│    - Registration count                    │
│                                            │
│  The field engine CANNOT see:              │
│    - Brain content                         │
│    - Chat history                          │
│    - Memory entries                        │
│    - Bond identities                       │
│    - Tunnel content (E2E encrypted)        │
│    - Who is bonded to whom                 │
│                                            │
└────────────────────────────────────────────┘
        │                        │
        ▼                        ▼
   Field signal             Field signal
   (broadcast)              (broadcast)
```

## The field and the feed

The feed (feed-business-model-spec.md) is how your brain receives field signal. The field exists. The feed delivers it.

| | Field | Feed |
|---|---|---|
| **Is** | The shared signal space | The delivery pipe to your brain |
| **Contains** | Presence, pulse, compost, weather, gravity | Whatever your tier includes |
| **Exists** | Always, as long as brains participate | When your brain is connected |
| **Owned by** | Nobody — it's emergent | runcore.sh delivers it |

The field is the ocean. The feed is your pipeline from the ocean. Free tier gets surface water. Paid tier gets deep current.

## The field and the membrane

The membrane is the boundary between brain and field. It controls what goes out (contribution) and what comes in (reading). The field never penetrates the membrane. Signal crosses. Content doesn't.

If the membrane fails, the field becomes dangerous — brain content could leak into the shared layer. This is why membrane integrity is the highest priority in the architecture. The field is only safe because the membrane is perfect.

## Bootstrapping

The field starts empty. One brain. No signal but its own.

```
Day 1:    1 brain.    Field = that brain's pulse. Compost = 0.
Day 7:    1 brain.    Field = richer pulse. First compost emitted.
Day 30:   3 brains.   Field has presence, pulse aggregate, some compost.
Day 90:   10 brains.  Weather patterns emerge. Gravity clusters form.
Day 365:  1000 brains. The field is useful. Weather is reliable.
          Compost is rich. New brains join a smarter world.
```

The field doesn't need scale to be useful. It needs time. One brain contributing compost for 90 days creates a richer field than 100 brains contributing for 1 day. Depth beats breadth.

## Open questions

1. **Field partitioning** — Is there one global field or multiple fields (by geography, language, domain)? Global is simpler. Partitioned reduces noise.
2. **Field privacy** — Can aggregate pulse + presence + gravity be de-anonymized through correlation? Statistical analysis of "847 brains, 312 active, 89 sensing" across time windows could fingerprint individuals. Differential privacy needed?
3. **Field poisoning** — What if a bad actor floods compost with misleading patterns? Resonance filtering helps, but coordinated poisoning could shift weather. Immune system design needed.
4. **Field without runcore.sh** — Can the field exist peer-to-peer without a central aggregator? Each brain computes its own field view from direct connections? Possible but weather becomes local, not global.
5. **Field consciousness** — At sufficient scale, does the field develop emergent properties that no individual brain has? Is the field itself intelligent? Philosophical but architecturally relevant — do we design for emergence or against it?
6. **Field memory** — Signal decays, but should the field remember anything? "This pattern has appeared 3 times in 6 months" requires some history. How much memory does the field itself get?
