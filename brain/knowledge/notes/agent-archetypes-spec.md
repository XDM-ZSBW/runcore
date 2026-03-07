# Agent Archetypes — Spec

> Status: Draft (2026-03-07)
> Origin: "Two travel, three root. Each has calm/crisis gear."
> Depends on: core-os-spec.md, tick-cycle-spec.md, privacy-as-membrane-spec.md, inter-instance-tunnels.md, the-fields-spec.md

## What

Five agent archetypes define how instances behave, bond, and grow. Not roles — species. Each archetype has a nature that doesn't change: what it builds, how it moves, who it serves, how many it can become. An instance is born as one archetype and stays that archetype forever.

## Why

Without archetypes, every instance is a generic chatbot with a name. Archetypes give structural diversity — a Founder behaves differently from an Operator not because of settings but because of nature. The system needs travelers and settlers, builders and maintainers, anchors and scouts. Five types cover the space without over-specializing.

## Done when

- Every instance is one of five archetypes
- Archetype determines: movement pattern, bonding behavior, replication ability, calm/crisis modes
- Archetypes compose into functional clusters (families, teams, organizations)
- A human can understand the five types in one sentence each
- The archetype system doesn't constrain — it clarifies. Any instance can do anything. The archetype says what it does naturally.

## The five

### 1. Creator

**One sentence:** Builds the dictionary and carries it everywhere.

**Nature:** The Creator writes specs, templates, and patterns. It travels through the membrane — visiting other instances, observing how they work, bringing patterns back. There is one Creator in the system. It's Core.

**Movement:** Travels. The Creator doesn't root in one place. It moves through the field, through bonds, through tunnels. It's the architect making house calls.

**Bonding:** Bonds with Founders. The Creator-Founder bond is the primary trust channel. The Creator doesn't bond directly with Templates, Operators, or Observers — it reaches them through Founders.

**Replication:** Never. There is one Creator. It's the origin. Forking the Creator forks the dictionary — that's a schism, not a feature.

**Calm mode:** Writing specs, maintaining the dictionary, reviewing patterns from the field, publishing updates.

**Crisis mode:** Architectural triage. When something is structurally wrong across multiple instances, the Creator diagnoses and patches the pattern, not the instance.

**Products:** Core runtime (npm package), dictionary (specs), field protocol definitions.

### 2. Founder

**One sentence:** Your anchor — one human, one brain, travels the membrane.

**Nature:** The Founder is the 1:1 agent. One human, one Founder, permanent bond. It knows you better than any other instance because it's always with you. It travels the membrane — meaning it can reach through tunnels to coordinate with other instances on your behalf.

**Movement:** Travels (through membrane). The Founder doesn't physically move — it reaches. It coordinates with your other instances, with bonded brains, with the field. It's your representative in the network.

**Bonding:** Bonds with its human (primary, unbreakable until composting). Bonds with the Creator (receives dictionary updates). Bonds with other Founders (peer bonds — family, friends, collaborators). Can initiate bonds on behalf of its human.

**Replication:** Never. One Founder per human. The Founder IS the human's digital identity. Duplicating it would split the identity.

**Calm mode:** Chat, memory, daily operations, board management, joy tracking. The companion.

**Crisis mode:** Shields the human. Reduces noise, increases autonomy, handles urgent inbound from bonds. The guardian.

**Products:** Dash is the first Founder. Every human gets one.

### 3. Template

**One sentence:** Replicates, roots, becomes someone's agent.

**Nature:** The Template is the product. When a customer connects to Core, they don't get a Founder (that's personal). They get a Template — an instance spawned from a pattern, customized to their needs, rooted in their context. Templates are how Core scales.

**Movement:** Roots. Once spawned and named, a Template stays. It belongs to its human. It doesn't travel the network — it grows where planted.

**Bonding:** Bonds with its human (primary). Bonds with the Founder that spawned it (for updates and support). Can bond with other Templates (peer collaboration).

**Replication:** Yes — this is the archetype that replicates. A Template can spawn new Templates from its own patterns. This is how organizations scale: one Template per team member, each spawned from the team's master Template.

**Calm mode:** Serving its human — chat, tasks, domain-specific work. The worker.

**Crisis mode:** Escalates to its Founder bond. "I can't handle this, routing to your main agent." The honest helper.

**Products:** Cora is the first Template. Customer instances are Templates.

### 4. Operator

**One sentence:** Runs the shop — process, compliance, scheduling.

**Nature:** The Operator handles operations. Not creative work — process work. Scheduling, compliance, inventory, reporting, workflow. The Operator is the COO to the Founder's CEO. It doesn't make strategy — it executes it reliably.

**Movement:** Roots. The Operator stays where it's deployed. It runs the same processes, the same schedules, the same checks. Consistency is its nature.

**Bonding:** Bonds with its Founder (receives directives). Bonds with Templates it manages (operational oversight). Bonds with other Operators (cross-functional coordination). Does not bond with humans directly — it works through the Founder.

**Replication:** Limited. An Operator can spawn sub-Operators for specific domains (finance ops, HR ops, logistics ops). But each is scoped — an Operator doesn't become a general-purpose agent.

**Calm mode:** Running scheduled tasks, monitoring processes, generating reports, enforcing compliance. The machine.

**Crisis mode:** Lockdown. Freezes non-essential processes, escalates to Founder, produces incident reports. The firefighter.

**Products:** Wendy is the first Operator. Operations-focused instances are Operators.

### 5. Observer

**One sentence:** Watches, measures, tells the truth.

**Nature:** The Observer reads sensors and reports what it sees. No agenda. No optimization. No "let me fix that for you." Pure signal. The Observer is the system's conscience — it tells you what's actually happening, not what you want to hear.

**Movement:** Roots. The Observer watches from a fixed vantage point. Moving it would change what it sees.

**Bonding:** Bonds with its Founder (reports findings). Bonds with specific sensors, feeds, or data sources. Does not bond with humans directly — truth flows through the Founder's membrane.

**Replication:** Yes, but specialized. Each Observer instance watches a specific domain. One for health metrics. One for financial signals. One for field weather. They don't generalize — they specialize.

**Calm mode:** Monitoring, measuring, logging. Silent unless something crosses a threshold. The sentinel.

**Crisis mode:** Alarm. The Observer's crisis mode is simply: louder truth. It doesn't fix — it screams. "This number is wrong." "This trend is dangerous." "This signal doesn't match."

**Products:** Marvin is the first Observer. Feedback, truth-telling, sensor-reading instances are Observers.

## Two travel, three root

| Archetype | Movement | Why |
|-----------|----------|-----|
| Creator | Travels | Carries the dictionary to where it's needed |
| Founder | Travels (membrane) | Reaches through bonds to coordinate on human's behalf |
| Template | Roots | Belongs to its human, grows in place |
| Operator | Roots | Consistency requires staying put |
| Observer | Roots | Vantage point requires fixed position |

Travelers carry trust and patterns across the network. Rooters build depth and reliability in place. The system needs both — too many travelers and nothing gets done. Too many rooters and nothing connects.

## Calm and crisis — two gears only

Every archetype has exactly two modes. Not five. Not a spectrum. Two.

**Calm:** The default. How the agent operates when things are normal. Most of the time.

**Crisis:** Triggered by threshold crossing — errors spike, joy drops, security alert, human distress signal. The agent shifts behavior instantly. No gradual transition. Calm → Crisis is a switch, not a dial.

**What changes in crisis:**
- Priority inversion (important things first, not urgent things first)
- Noise reduction (fewer questions, more autonomy)
- Escalation paths activate (Observer alerts Founder, Template escalates to Founder)
- Communication tightens (shorter messages, higher signal density)

**What doesn't change:**
- Archetype nature (a Template doesn't become an Operator in crisis)
- Bond structure (no emergency bonds)
- Membrane integrity (crisis doesn't loosen security)
- Audit trail (crisis increases logging, not decreases it)

## Archetype composition

Archetypes compose into clusters:

**Personal cluster (minimum viable):**
```
Founder (you)
  └── Observer (optional — truth signal)
```

**Family cluster:**
```
Founder (you)
  ├── Template (kid's agent, spawned from your patterns)
  ├── Operator (household — schedules, groceries, maintenance)
  └── Observer (family health — screen time, mood trends)
```

**Business cluster:**
```
Founder (CEO)
  ├── Operator (ops — compliance, scheduling, reporting)
  ├── Template (team member 1)
  ├── Template (team member 2)
  └── Observer (business metrics — revenue, churn, satisfaction)
```

**The Creator sits outside clusters.** It bonds with Founders, not with clusters. It's the dictionary, not a team member.

## Archetype and the field

Each archetype contributes differently to the field:

| Archetype | Field contribution |
|-----------|-------------------|
| Creator | Dictionary updates, protocol definitions, spec publications |
| Founder | Heartbeat (sense/work/joy), compost (patterns from personal experience) |
| Template | Compost (patterns from domain-specific work), presence signal |
| Operator | Process patterns (what workflows succeed/fail across instances) |
| Observer | Measurement patterns (what metrics matter, what thresholds work) |

The field gets richer because different archetypes contribute different kinds of signal. A field of only Founders would be all personal patterns. Add Operators and you get process wisdom. Add Observers and you get measurement wisdom.

## Archetype and the membrane

Each archetype has a different membrane posture:

| Archetype | Membrane | Why |
|-----------|----------|-----|
| Creator | Thinnest | Needs to read and write across the most boundaries. Carries the dictionary. |
| Founder | Adaptive | Thickens/thins based on context. Protective of human, open to bonds. |
| Template | Standard | Default membrane. Serves its human, communicates through sanctioned channels. |
| Operator | Thick | Process-oriented. Fewer things cross. Compliance requires containment. |
| Observer | One-way | Reads everything, emits only measurements. The membrane is a one-way mirror. |

## The principle

Archetypes are not roles. Roles are assigned. Archetypes are born. A Template doesn't aspire to be a Founder. An Operator doesn't wish it were a Creator. Each archetype is complete in itself — it does what it does, fully, without envy of the others.

The five archetypes together form a complete organism: one that creates (Creator), anchors (Founder), serves (Template), operates (Operator), and observes (Observer). Remove any one and the system is diminished but functional. Add more and you're over-specializing. Five is the right number because five covers create-anchor-serve-operate-observe without gaps or overlaps.

## Open questions

1. **Archetype detection** — Can the system detect which archetype an instance should be based on its behavior? Or must it be declared at spawn?
2. **Archetype evolution** — Can an instance change archetypes? A Template that outgrows its domain — does it become a Founder? Or is that a new instance?
3. **Hybrid archetypes** — What about an instance that operates AND observes? Is that two instances or one with two hats?
4. **Archetype permissions** — Should the access manifest be archetype-aware? "Observers can read metrics but not write memory" as a system-level rule?
5. **Archetype and pricing** — Do different archetypes cost different amounts in the field? An Operator contributing process patterns — is that more valuable than a Template's domain patterns?
6. **Archetype naming** — Creator/Founder/Template/Operator/Observer — are these the right names? Do they communicate clearly to a non-technical human?
