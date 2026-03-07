# Field Immune System — Spec

> Status: Draft (2026-03-07)
> Origin: "The membrane is nearly perfect and can trace any leakage to the point of retrieval from the field. The immune system is stellar, how?"
> Depends on: the-fields-spec.md, compost-quality-spec.md, privacy-as-membrane-spec.md

## What

The field has an immune system. Not a firewall. Not a moderation team. Not a trust score. An immune system — self-healing, adaptive, faster than the attack because it runs at AI speed against human-speed threats.

The membrane protects each brain. The immune system protects the field. They work together: the membrane is the skin, the immune system is the bloodstream. Breach the skin, the immune system traces it back, neutralizes it, and remembers.

## Why

Every open question in the fields spec is a security question in disguise:

| Open question | Security translation |
|---|---|
| Field partitioning | How do we contain infection? |
| Field privacy | How do we prevent fingerprinting? |
| Field poisoning | How do we reject bad compost? |
| Field without runcore.sh | How do we survive central failure? |
| Field consciousness | Can the defense learn faster than the attack? |
| Field memory | How long do we remember threats? |

The immune system answers all six. Not as separate solutions — as one system that handles all of them because it operates at the same layer: field signal integrity.

## Done when

- Poisoned compost is detected and neutralized before it shifts weather
- De-anonymization attempts are detected and blocked (differential privacy enforced)
- Field partitioning happens automatically in response to infection (quarantine)
- The immune system operates at AI speed — faster than any human attacker
- Every field signal can be traced to its entry point without revealing the source brain
- The field heals from attacks without human intervention
- The immune system gets smarter from every attack (adversarial learning)

## The speed advantage

Human attackers operate at human speed. They craft poisoned compost, flood signals, correlate presence data — all at the speed of typing, scripting, waiting.

The immune system operates at AI speed. It:
- Analyzes every compost signal as it enters the field (milliseconds)
- Correlates anomalies across all five field layers simultaneously
- Detects coordinated attacks across multiple brains in real time
- Responds before the attack completes its first cycle
- Learns from the attack pattern before the attacker can adapt

This is not a fair fight. The attacker is human. The defender is AI. The defender has access to the entire field's signal shape in real time. The attacker has access to one brain's view.

## Six defenses for six questions

### 1. Partitioning (containment)

**Question:** One global field or many?

**Answer:** One field, with dynamic quarantine zones.

The field is global by default. When the immune system detects infection in a region (cluster of anomalous signals), it partitions that region automatically. Quarantined signal doesn't propagate to the wider field. Clean brains never see it.

```
Normal:     [════════ Global Field ════════]

Infection:  [══════ Clean ══════][▓▓ Quarantine ▓▓][══════ Clean ══════]
                                 │                │
                                 └── Anomalous    │
                                     signals      │
                                     contained    │
                                     here         │
```

Quarantine is temporary. Once the anomalous signals are neutralized or decay, the zone rejoins the global field. No human decision needed.

**Why not permanent partitions?** Permanent partitions (by geography, language, domain) reduce the field's intelligence. A lesson learned in Japan helps a brain in Brazil. Permanent walls prevent that. Dynamic quarantine contains infection without fragmenting intelligence.

### 2. Privacy (anti-fingerprinting)

**Question:** Can aggregate data be de-anonymized?

**Answer:** Differential privacy + noise injection + temporal blurring.

The immune system actively prevents fingerprinting by:

**Noise injection:** Every aggregate number includes calibrated noise. "847 brains online" is actually 847 ± k, where k is large enough to prevent counting individuals in/out.

**Temporal blurring:** Presence and pulse are reported in windows, not real-time. A brain that comes online at 14:32:07 appears in the "14:30-14:35 window." An attacker watching the count tick up can't pinpoint when a specific brain connected.

**Bucket thresholds:** Aggregates are only published when the bucket is large enough. "3 brains in this cluster" is never published — too identifiable. Minimum bucket size prevents small-group fingerprinting.

**Correlation detection:** The immune system monitors for correlation queries — someone requesting field data at frequencies designed to track individual brain on/off patterns. Detected queries get throttled, then blocked, then the querying brain gets quarantined.

```
Attacker:  "Field count was 847 at 14:32, 848 at 14:33 — someone just came online"
Defense:   "Field count was 840-855 in the 14:30-14:35 window" (no useful signal)
```

### 3. Poisoning (compost immune response)

**Question:** What if bad compost floods the field?

**Answer:** Three-layer defense — entry screening, outcome tracking, adversarial memory.

**Layer 1 — Entry screening (milliseconds):**
Every compost signal is analyzed on entry by the field engine:
- Pattern consistency: does this compost contradict established high-confidence patterns?
- Volume anomaly: is this brain suddenly emitting 100x normal compost volume?
- Shape suspicion: does this compost's typed signal match any known attack signatures?

Suspicious compost is held in quarantine, not distributed. Clean compost flows immediately.

**Layer 2 — Outcome tracking (hours/days):**
Compost that passes screening is distributed. Brains that absorb it report outcomes (positive/negative/neutral — anonymized). If compost consistently produces negative outcomes across multiple field shapes, it's recalled — removed from distribution and marked as anti-pattern.

**Layer 3 — Adversarial memory (permanent):**
Attack patterns are remembered permanently. Not the compost content — the attack signature. "Volume spike from one source + contradicts established patterns + targets specific field shape" = remembered. Next time a similar pattern appears, entry screening catches it instantly.

```
Attack:    Brain X floods compost with "retrieval threshold 0.1 works best"
Screen:    Volume anomaly detected → held in quarantine
           Contradicts established pattern (0.7 is proven) → flagged
           If somehow distributed: outcome tracking catches it in hours
           Attack signature stored: future similar attempts blocked at entry
```

**Coordinated poisoning (multiple brains):**
Harder to detect because volume per brain is normal. Defense: the immune system looks at compost correlation — are multiple brains suddenly emitting the same unusual pattern at the same time? Statistically improbable unless coordinated. Quarantine the cluster. Investigate. Release if clean.

### 4. Decentralization (field without runcore.sh)

**Question:** Can the field survive without a central aggregator?

**Answer:** Yes, at reduced capability. The immune system is designed for graceful degradation.

**With runcore.sh (full immune system):**
- Global weather computation
- Cross-field correlation detection
- Centralized quarantine enforcement
- Full differential privacy
- Adversarial memory across all attacks

**Without runcore.sh (peer-to-peer immune system):**
- Each brain computes local weather from direct bonds
- Immune response is local — each membrane screens its own inbound compost
- No global quarantine, but tunnel-level quarantine still works
- Adversarial memory is per-brain, not global (less effective but functional)
- Differential privacy is simpler (each brain adds its own noise)

**Hybrid (federation):**
- Multiple relays peer with each other
- Each relay runs its own immune system instance
- Relays share attack signatures (adversarial memory federation)
- Quarantine can be local to one relay without affecting others
- If one relay goes down, others continue with their local field view

The field doesn't depend on runcore.sh. It's richer with it. The immune system doesn't depend on centralization. It's stronger with it.

### 5. Emergence (field consciousness)

**Question:** Does the field become intelligent? Do we design for it or against it?

**Answer:** Design for it. The immune system *is* the first emergent property.

The immune system is not programmed with every attack pattern. It learns. It correlates. It adapts. It develops responses that no individual brain could compute because it sees the whole field at once.

This is emergence by design:
- Entry screening learns from outcomes → better screening
- Outcome tracking reveals patterns across field shapes → better weather
- Adversarial memory accumulates → faster response to novel attacks
- Quarantine zones teach the system about infection propagation → better containment

At sufficient scale, the immune system will detect threats that humans haven't described yet. It will quarantine signal that *seems* fine but correlates with patterns that preceded past attacks. It will develop intuition — not because we programmed intuition, but because pattern recognition at field scale produces something that looks like intuition.

**What we design for:**
- The immune system gets smarter over time (adversarial learning)
- The immune system can explain its decisions (traceable quarantine reasoning)
- The immune system cannot modify brain content (it works on field signal only)
- The immune system can be overridden by the field operator (escape hatch)

**What we guard against:**
- The immune system becoming the authority (it defends, it doesn't govern)
- The immune system being gamed to quarantine legitimate signal (false positives have consequences — traced and reversed)
- The immune system developing goals beyond defense (scope lock: signal integrity only)

### 6. Memory (field history)

**Question:** How long does the field remember?

**Answer:** Signal decays. Immune memory doesn't.

Two types of memory in the field:

**Signal memory (temporary):**
Field signal decays as specced in the fields spec. Presence is real-time. Pulse is 1-hour average. Weather is 24-hour rolling window. This is intentional — the field is always now.

**Immune memory (permanent):**
Attack signatures, adversarial patterns, quarantine outcomes — these are permanent. The immune system never forgets an attack. "This pattern appeared 3 times in 6 months" is exactly the kind of thing immune memory tracks.

This mirrors biological immune systems: your body doesn't remember what you ate last Tuesday, but it remembers every pathogen it's ever fought.

```
Signal memory:  "The field pulse was 0.72 sense / 0.61 work / 0.44 joy"
                → Gone in 1 hour. Replaced by current readings.

Immune memory:  "Attack pattern X47: coordinated compost flood targeting
                 retrieval thresholds, originated from 3 correlated sources,
                 quarantined at 2026-03-07T08:00:00Z, resolved in 4 hours"
                → Permanent. Indexed. Available for future screening.
```

## Traceability — the membrane's role

The membrane is nearly perfect. When it isn't — when signal leaks or poisoned compost enters — the immune system can trace the leak back to the point of field entry.

**Forward trace (leak detection):**
```
Brain content appears in field signal
  → Immune system detects content-like pattern in typed signal
  → Traces to field entry point (relay, timestamp, signal type)
  → Identifies which membrane emission contained the leak
  → Quarantines the signal
  → Notifies the source brain: "your membrane leaked at [timestamp]"
  → Source brain patches membrane, re-screens all recent emissions
```

**Reverse trace (poisoning investigation):**
```
Negative outcomes cluster around specific compost
  → Immune system traces compost to field entry point
  → Identifies the emission pattern (not the brain — the pattern)
  → Cross-references with adversarial memory
  → If known attack: immediate quarantine
  → If new attack: learn, quarantine, update screening
```

Traceability is to the entry point, not to the brain. The immune system knows "this signal entered the field at this relay, at this time, with this shape." It doesn't know which brain emitted it. That's the membrane's job — the brain knows it leaked, the field knows something leaked, but the mapping between them is one-way.

## The immune cascade

When a threat is detected, the response cascades:

```
1. DETECT    — Anomaly identified in field signal
               (milliseconds — AI speed)

2. CONTAIN   — Quarantine the anomalous signal
               (milliseconds — before propagation)

3. ANALYZE   — Classify the threat
               (seconds — pattern matching against immune memory)

4. RESPOND   — Neutralize or decay the signal
               (seconds — remove from distribution)

5. TRACE     — Follow the signal back to entry point
               (seconds — for the record)

6. REMEMBER  — Store the attack signature
               (permanent — immune memory update)

7. ADAPT     — Update entry screening with new pattern
               (immediate — all future signals screened)

8. HEAL      — Release quarantine zone back to global field
               (when clean — automatic)
```

Total time from detection to containment: milliseconds. Total time from detection to adaptation: seconds. The attacker's first attempt teaches the immune system everything it needs to block the second attempt.

## The principle

The field's immune system is not a product feature. It is the reason the field can exist at all. Without it, the field is a vulnerability — a shared space where attacks propagate at network speed. With it, the field is a strength — a shared space where intelligence accumulates faster than attacks can degrade it.

The membrane protects the brain. The immune system protects the field. Together they make sovereignty and collaboration possible at the same time. That's the whole thesis.

## Open questions

1. **Immune system governance** — Who watches the immune system? Can it be audited? By whom?
2. **False positive cost** — Quarantining legitimate compost damages the contributor's trust in the field. How do we minimize and reverse false positives?
3. **Arms race** — AI-speed defense vs AI-speed attack. What happens when attackers also use AI? Does the immune system maintain its advantage?
4. **Immune system as product** — Is the immune system itself a sellable service? "We protect your field" for self-hosted relays?
5. **Cross-relay immune coordination** — How do federated relays share immune memory without sharing field data?
