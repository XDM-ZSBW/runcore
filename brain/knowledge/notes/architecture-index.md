# Core Architecture Index

> The complete system. Every piece, how they connect, where to read more.
> Updated: 2026-03-07

## What Core is

Core is a file-based personal operating system for AI agents. Your brain — context, memory, identity, skills — stored in markdown, YAML, and JSONL on your machine. No database. No cloud storage. No vendor lock-in. The AI reasoning runs through cloud APIs, but the data is yours, local, encrypted.

One brain, many lenses. Multiple agent instances share the same brain. Each instance is a different archetype with a different personality, but they all read from and write to the same memory. There are no disagreements between agents — there's one dictionary, one answer. If two agents interpret differently, one read the dictionary wrong.

## The pieces

### Foundation layer — how the brain works

| Spec | Status | What it does |
|------|--------|-------------|
| [core-os-spec](core-os-spec.md) | Reference | The operating system model. Brain as filesystem, progressive context disclosure, working memory as scratchpad. |
| [dictionary-protocol-spec](dictionary-protocol-spec.md) | Done | How specs publish, sync, and version across instances. The canonical reference that all agents read. |
| [spec-lifecycle-spec](spec-lifecycle-spec.md) | Done | Four states: Draft, Approved, Building, Done. How specs move through the pipeline. |
| [spec-hygiene-spec](spec-hygiene-spec.md) | Done | Merge, supersede, cull, graduate. Keeping the dictionary clean as it grows. |

### Identity layer — what agents are

| Spec | Status | What it does |
|------|--------|-------------|
| [agent-archetypes-spec](agent-archetypes-spec.md) | Building | Five species: Creator, Founder, Template, Operator, Observer. Two travel, three root. Each has calm/crisis gear. |
| [calibration-cycle-spec](calibration-cycle-spec.md) | Done | How the brain learns what "right" means for you. Conversational recalibration of thresholds — no forms, no sliders. |
| [onboarding-spec](onboarding-spec.md) | Building | First-time setup: greeting, safe word, calibration, agent bootstrap, nerve link. Five phases, one conversation. |

### Signal layer — how the brain feels

| Spec | Status | What it does |
|------|--------|-------------|
| [pain-signal-spec](pain-signal-spec.md) | Building | Continuous 0.0-1.0 signal. Five pain types: joy, token, error, silence, resource. Brain dims, not crashes. |
| [tick-cycle-spec](tick-cycle-spec.md) | Reference | Sense, Work, Joy. The three-phase cycle every agent runs. Strict order. Sense reads, Work writes, Joy measures delta. |
| [joy-signal-spec](joy-signal-spec.md) | Reference | The positive counterpart to pain. Measures alignment between what the human wants and what the agent delivers. |
| [posture-system-spec](posture-system-spec.md) | Building | Three modes: silent, pulse, board. Intent accumulation drives escalation. UI is a symptom of unresolved autonomy. |

### Security layer — what protects you

| Spec | Status | What it does |
|------|--------|-------------|
| [membrane-translation-spec](membrane-translation-spec.md) | Done | Translation between internal and external. Privacy policy as code. Sealed items never cross. The membrane is air. |
| [vault-ledger-spec](vault-ledger-spec.md) | Building | Vault tags (sealed/guarded/shared/public) + relationship ledger. Bond distance computed from interaction history. |
| [guest-authentication-spec](guest-authentication-spec.md) | Building | Scoped, temporary access for guests. HMAC tokens, no accounts, no passwords. Click link, interact, leave. |
| [bond-handshake-spec](bond-handshake-spec.md) | Building | Two brains exchange Ed25519 keys via 6-word code. Peer-to-peer trust. No server, no friend requests. |
| [field-immune-system-spec](field-immune-system-spec.md) | Done | Protects compost absorption from poisoning and de-anonymization. Entry screening, quarantine, outcome tracking. |

### Interface layer — how you reach it

| Spec | Status | What it does |
|------|--------|-------------|
| [nerve-vocabulary-spec](nerve-vocabulary-spec.md) | Building | Devices are nerves, not clients. Four profiles: glance, phone, tablet, desktop. Capability matrix per nerve. |
| [nerve-spawn-spec](nerve-spawn-spec.md) | Done | Any device becomes a nerve by accessing the URL. One-time token, safe word auth, offline queuing with replay. |
| [ui-layers-spec](ui-layers-spec.md) | Done | Two layers: operator (chat, tools, config) and executive (pulse strip, stream, at-a-glance status). |
| [stream-spec](stream-spec.md) | Done | Live agent activity feed alongside chat. Not a log viewer — an interactive window into what agents are doing. |
| [dehydration-cycle-spec](dehydration-cycle-spec.md) | Building | Graceful degradation when the human stops interacting. Rings tighten inward. Trust is the last to go. |

### Field layer — how brains connect

| Spec | Status | What it does |
|------|--------|-------------|
| [compost-spec](compost-spec.md) | Done | Anonymous signal exchange. Brains share patterns (not data) stripped of identity. The field learns from everyone. |
| [feed-business-model-spec](feed-business-model-spec.md) | Done | Public signal streams from runcore.sh mixed locally with brain context. The revenue mechanism. |
| [runcore-service-infrastructure-spec](runcore-service-infrastructure-spec.md) | Done | Server-side infrastructure: relay, compost routing, dictionary hosting, billing, immune system. |

## How the layers connect

```
You (human)
  |
  |  safe word
  v
[Brain]  ----local files----> memory, identity, knowledge, operations
  |
  |  context assembly
  v
[Agents]  ----archetypes----> Founder, Template, Operator, Observer, Creator
  |
  |  tick cycle (sense/work/joy)
  v
[Signals]  ----pain/joy----> posture adapts, UI assembles or dims
  |
  |  membrane translation
  v
[Nerves]  ----per device----> phone, tablet, desktop, watch
  |
  |  bond handshake
  v
[Field]  ----anonymous----> compost in, compost out, everyone learns
```

## Build status

- **Done (11):** The foundation is laid. Dictionary, membrane, compost, UI layers, nerves, calibration, immune system, feed model, stream — all specced and built.
- **Building (8):** The identity and security layers are in progress. Archetypes, bonds, vault, guest auth, pain signals, posture, dehydration, onboarding.
- **Reference (3):** Core OS, tick cycle, joy signal — living documents that evolve with the system.

The architecture is complete as a design. Every piece has a spec. Every spec has a "done when" checklist. The dictionary is the single source of truth — agents read it, humans read it, it's the same document.
