# Compost Quality — Spec

> Status: Retired (2026-03-07) — merged into compost-spec.md
> Origin: "What gives the compost quality stamp of approval? The fields. The venn diagrams."
> Depends on: feed-business-model-spec.md, core-os-spec.md

## What

Compost quality is not rated by a central authority. It's rated by the field it lands in. Your host computes resonance — how well incoming compost matches your field's shape — and surfaces what fits. No editorial board. No star ratings. No upvotes. The field knows what it needs. The compost finds its soil.

## Why

Centralized quality control doesn't work for sovereign brains. A curated feed assumes someone knows what's good for you. Nobody does. Your field is unique — your agents, your goals, your scale, your patterns, your failures. Only your field can judge what makes it richer.

The compost isn't content. It's lessons. Patterns stripped of identity by the membrane, distilled into reusable signal. The quality of a lesson depends entirely on who's learning it.

## Done when

- Compost resonance is computed locally, not at runcore.sh
- High-resonance compost surfaces in the feed. Low-resonance decomposes or passes through.
- A single user with one agent produces compost that makes their next agent smarter
- Two users with overlapping fields cross-pollinate without seeing each other's data
- No human curation, no voting, no editorial process. The field filters itself.
- Quality improves over time as the field learns what resonates

## How compost is born

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

## Field shape — the venn diagram

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

## Resonance — how compost finds its soil

When compost arrives in the feed, your host computes resonance: how close is this compost's origin shape to your field's shape?

```
Incoming compost:
  origin_shape: { scale: 3, domain: "creative", maturity: 60d,
                  agents: ["founder","operator"], autonomy: 0.7 }

Your field:
  shape: { scale: 4, domain: "creative", maturity: 45d,
           agents: ["founder","operator","template"], autonomy: 0.6 }

Resonance: 0.89 (high overlap)
→ Surfaces in your feed with high priority
```

```
Incoming compost:
  origin_shape: { scale: 50, domain: "compliance", maturity: 365d,
                  agents: ["template","template","template"...], autonomy: 0.9 }

Your field:
  shape: { scale: 4, domain: "creative", maturity: 45d,
           agents: ["founder","operator","template"], autonomy: 0.6 }

Resonance: 0.21 (low overlap)
→ Stays in the pile. Maybe useful later as your field grows.
```

**Resonance is not permanent.** Your field changes shape as you grow. Compost that didn't resonate last month might resonate today. The pile doesn't expire — it waits.

## The venn diagram

Two fields overlap where their shapes align. The overlap is the cross-pollination zone.

```
┌──────────────┐         ┌──────────────┐
│  Your field   │         │  Dad's field  │
│              │         │              │
│  Creative    │         │  Simple      │
│  3 agents    │         │  1 agent     │
│  Deep work   │◄──Venn──►│  Light use   │
│              │         │              │
│  High        │         │  Low         │
│  autonomy    │         │  autonomy    │
└──────────────┘         └──────────────┘
        │                        │
        │   Overlap zone:        │
        │   - Basic retrieval    │
        │   - Membrane patterns  │
        │   - Dehydration        │
        │     thresholds         │
        │                        │
        ▼                        ▼
  You absorb his         He absorbs your
  simplicity lessons     retrieval lessons
  (agent efficiency)     (better responses)
```

The overlap is where compost crosses. Outside the overlap, compost doesn't resonate — it's not rejected, just not absorbed yet. Fields grow toward each other over time if bonds exist.

## Quality without authority

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

The quality loop:

```
Agent lives → produces compost → stripped of identity →
enters field → resonance computed locally → absorbed or not →
outcome measured locally → anonymous signal back →
runcore.sh reweights distribution → better compost surfaces →
field gets smarter → agent produces better compost → cycle continues
```

## Compost at scale one

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

Your agents are the first farmers. You're the first field. Everyone after you inherits richer soil.

## What runcore.sh does with compost

| Action | What it sees | What it doesn't |
|---|---|---|
| Receives compost signals | Typed patterns, parameters, outcomes | Content, names, identities, brain data |
| Computes field shapes | Anonymous dimension vectors | Who the vector belongs to |
| Distributes compost | Routes by resonance score | Who absorbs it |
| Tracks outcomes | Positive/negative/neutral per compost ID | What changed in the absorber's field |
| Reweights distribution | Amplifies high-outcome compost | Why it worked (that's local context) |

runcore.sh is a composting facility. Material comes in stripped. Processed material goes out. The facility never knows whose garden it came from or whose garden it feeds.

## Anti-gaming

What stops someone from poisoning the compost?

1. **Resonance filtering** — Poisoned compost only affects fields it resonates with. Low-resonance poison never surfaces.
2. **Outcome tracking** — If absorbed compost makes things worse, the negative signal demotes it across all similar fields.
3. **Volume limits** — One host can't flood the field. Compost production is proportional to agent activity, not submission volume.
4. **Pattern consistency** — Compost that contradicts established high-quality patterns gets flagged for deeper decomposition before distribution.
5. **Field isolation** — Worst case: one field absorbs bad compost. It measures negative outcome. Signals back. Compost gets demoted. Damage is local and reversible.

No moderation team. No trust scores. No reputation systems. The field's immune system is its own measurement of outcomes.

## Open questions

1. **Compost opt-in** — Is compost production opt-in or opt-out? Default: opt-in for paid, opt-out for free? Or everyone contributes to the commons?
2. **Compost granularity** — How specific can a compost signal be before it risks de-anonymization? A retrieval threshold is safe. A unique workflow pattern might fingerprint someone.
3. **Resonance computation cost** — Computing resonance for every incoming compost signal against your field shape. Expensive? Needs local model? Or simple vector distance?
4. **Temporal decay** — Does old compost lose potency? Or does a 2-year-old lesson matter as much as yesterday's?
5. **Adversarial fields** — What if two fields are adversarial (competing businesses)? Should resonance be blocked by bond exclusion?
6. **Compost provenance** — Should a host be able to trace "this lesson helped me" back to a thank-you signal (anonymous) to the originating field?
