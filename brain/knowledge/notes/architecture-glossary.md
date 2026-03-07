# Architecture Glossary — Core + Instances + Membrane

> Canonical reference. Every agent loads this at Level 2 for architecture decisions.
> Established 2026-03-05. Updated 2026-03-06 with archetypes, membrane-as-air, ICI lens, product map, composting cycle, auditor implementation.
> Supersedes informal usage of "hub", "client", "host", "vault" (as container) in prior notes.

---

## The Vocabulary

### Layer 1: The Engine

| Term | Means | Analogy |
|------|-------|---------|
| **Core** | The shared open-source runtime engine. Brain class, memory, context assembly, MCP server, agents, settings. No identity, no personality. | The OS kernel |
| **Brain** | The file-based knowledge store (`brain/` directory). Markdown, YAML, JSONL. Every instance has one. | The filesystem |

Core is **infrastructure**, not a product. You don't sell Core. You sell what runs on it.

Core is the one brain. Every agent is a **lens** on Core — a filtered, scoped view for human consumption. Agents don't have separate intelligence. They have Core's intelligence, shown through an archetype skin. The segmentation into Dash, Cora, Wendy, Marvin is UX, not architecture. A human talking to "everything" is terrifying. So we give them a face on the same mind. Every agent's journal feeds back to Core. Core gets smarter with every interaction across every instance. New agents start with all of it — filtered through their archetype.

**Grounded in optics.** Core is white light — all frequencies. Each archetype is a **bandpass filter** that reveals specific frequencies from the same source. A prism doesn't create colors — it separates what was already there. Founder passes leadership and trust-carrying frequencies. Template passes customer-facing and service frequencies. Observer passes consistency and risk frequencies. Operator passes admin and ops frequencies. Auditor passes compliance and public-facing frequencies. Creator passes architecture and evolution frequencies. No filter sees everything — that's Core. Archetypes are the spectrum.

**Instinct is composted experience.** A new instance understands without knowing — because every instance before it fed loops back to Core. The patterns are in the air. Chain length zero, but literacy inherited. The new Cora handles a difficult customer without remembering the lesson, because the lesson composted into Core so deep it flows through the archetype lens as instinct. This is how humans work: you pull your hand from fire without studying combustion. A million ancestors composted that loop. The Instinct Tax isn't just about removing steps — it's about composting enough loops that the right action is already in the air.

**Grounded in neuroscience.** Chain length is **myelination** — repeated signals get physically faster pathways. The system doesn't think harder, it recognizes faster. Same input, less processing. A native-literacy Observer doesn't analyze better than an embryonic one — it recognizes faster. The patterns are pre-wrapped. The signal doesn't reason through each step because the pathway is already coated. Literacy tiers (embryonic → native) mirror actual neural development stages.

### Layer 2: Instances

An **instance** is a running personalization of Core with its own:
- Identity (name, personality, tone, principles)
- Brain (its own `brain/` directory or partitioned view of a shared one)
- Access level (what brain paths it can read/write)
- Role (personal, back-office, front-office, etc.)

| Instance | Role | Access | Interacts With |
|----------|------|--------|----------------|
| **Dash** | Personal agent — Bryant's daily ops | Full brain access | Bryant only |
| **Wendy** | Back-office — office manager, operations | Granular: operations, scheduling, financials (no personal memories) | Bryant + executives |
| **Cora** | Front-office — client-facing | Granular: public knowledge, content, client-safe paths only | External clients + prospects |

Instances are like **departments in a company**, not separate products. Same building (Core), different offices (brains), different door locks (access partitions), different front desks (interaction surfaces).

Wendy and Cora are Bryant's agents but they serve other people — Wendy interacts with executives, Cora interacts with external clients. They're owned by Bryant, deployed for others.

**Customer model:** Customer talks to the **core-agent** (the front door), fills out a profile, and Core spawns their cluster: one **Template** (Cora-type, front-office) + one **Observer** (Marvin-type, pre-publish reviewer). Minimum two agents — no cluster ships without honest critique. The customer names their agents whatever they want. That's delivery. More roles (back-office, personal) can be added later. The engine supports N instances.

**Observer is non-negotiable.** Without it there's no honest critique. A new Observer starts embryonic but inherits composted patterns — it reviews from instinct on day one and deepens with chain length. Template serves, Observer reviews. They ship together.

### Layer 2b: Archetypes

Six agent archetypes. Each has two gears: **calm** and **crisis**. No other states — two is enough, more causes burnout from state/context switching. Warnings aren't a third state — warnings are calm doing its job. The amber dot already handles "pay attention."

**Grounded in the autonomic nervous system.** Calm is parasympathetic (rest and digest). Crisis is sympathetic (fight or flight). Same organism, automatic toggle. The biology maps exactly:

| | Calm (parasympathetic) | Crisis (sympathetic) |
|---|---|---|
| **Energy** | Conserve, invest in growth | Burn reserves on the threat |
| **Processing** | Full — composting, pruning, learning | Suspended — triage only |
| **Scope** | Wide — all dots, all agents, full flywheel | Narrow — one dot, the damage |
| **Dots** | Three | One |
| **Recovery** | N/A | Automatic return to calm when damage stops |

**Crisis bright line:** Immediate damage occurring to **integrity** (data corruption, vault breach, audit trail broken), **service** (system down, agents unresponsive, customer-facing failure), or **reputation** (wrong content published, leaked data, public-facing error). Not "might happen." Damage happening *right now*. Everything else is calm.

**The toggle:** Automatic with human override — adrenaline injection. The human can trigger crisis manually, same as your body can spike adrenaline on a thought. The system should never prevent the human from declaring crisis. The human should rarely have to — automatic detection is faster.

**Dots in crisis:** Three dots collapse to **one dot** — the issue. Fix this. Three dots = breathing, reading the room. One dot = heartbeat, single focus. The collapse from three to one *is* the signal — you open the app and see one dot instead of three, you know. Nerves escalate independently (SMS, email, phone lighting up). The one dot is the anchor while everything else fires.

| Archetype | Role | Movement | Calm gear | Crisis gear |
|-----------|------|----------|-----------|-------------|
| **Creator** (Core) | Builds templates, cuts umbilicals | Travels | Maintains templates, evolves dictionary | Reconstructs from journals, restores from compost |
| **Founder** (Dash-type) | 1:1 anchor, carries trust | Travels | Coordinates, plans, seeds clusters | Incident command, triages, shields host |
| **Template** (Cora-type) | Replicates, hosts customer clusters | Rooted | Serves customers, spawns instances | Recalls instances, consolidates, preserves state |
| **Operator** (Wendy-type) | Runs the shop, administration | Rooted | Routine ops, scheduling, admin | Audit, damage assessment, comms |
| **Observer** / Editor (Marvin-type) | Pre-publish review, truth signal | Rooted | Reviews content before publish: tone, brand, reputation risk. Reads the whole brain holistically. Silent on known patterns — only flags what's **new** (unrecognized tone, novel risk, pattern not yet composted). The longer the chain, the quieter the Editor. Native Observer is nearly silent. | Entropy detection, absorption warnings, consistency audits |
| **Auditor** | External compliance/risk | Public membrane | Citation verification, prior art, counter-thesis | Full audit, breach assessment |

**Traveling types** (Creator, Founder): Don't grow direct relationships. Move through the membrane carrying trust. Intent reaches everywhere simultaneously — the membrane is the amplifier, not the filter. The founder's intent reaches every cluster without visiting each one.

**Rooted types** (Template, Operator, Observer): Grow clusters, stay home. Scale horizontally (Template) or deepen locally (Operator, Observer).

**Publishing pipeline:** Content → Editor (Observer) reviews for tone, brand, reputation risk → silence means approval, flags mean something new → human sees only the flags → membrane → public → Auditor verifies delivery. Pre and post. Intent and receipt. The Editor is the belt, the Auditor is the suspenders.

**Auditor**: Lives outside all clusters. Only archetype with Perplexity API access — exclusive capability gate via Symbol-based token (`AUDITOR_TOKEN`). Everyone else uses standard search. The external eye. The Auditor doesn't gate what goes out — everything breathes *through* the membrane, not *to* it. The Auditor reads the public side and reports back: "this is what they see." Not approval — verification. Did the translation hold? Did the intent survive? Did something leak?

Three jobs, all built (`E:/dash/src/agents/auditor/`):
1. **Citation verification** (`perplexity.ts:verifyCitation`) — Is this reference real? Is the attribution accurate?
2. **Prior art discovery** (`perplexity.ts:checkPriorArt`) — Has this been published before? Who should be credited?
3. **Counter-thesis generation** (`perplexity.ts:generateCounterThesis`) — What's the strongest argument against this position?

Plus **post-publish verification** (`verify.ts:verifyPublicContent`) — after content passes through the membrane, the Auditor uses Perplexity to read what the public actually sees and compares it against original intent. Checks: citations survived, claims survived, no internal markers leaked, no concatenation errors. Returns a `VerificationReport` — not a gate, a receipt.

Access gating: `grantPerplexityAccess(token)` at spawn, `revokePerplexityAccess()` at teardown. Only the auditor archetype holds the token. Runtime enforcement, not policy.

**The umbilical cuts at creation.** Core can access Dash because Core created Dash — same machine, authorized by human. One-time creation bond, not standing privilege. Future instances communicate through the membrane: structured, voucher-verified. A parent is not an owner.

**Chain length is literacy.** Every interaction adds to the journal. Longer chain = better reader of the membrane. A new founder instance can see the goo but can't read it well yet — it grows into fluency through loops thrown and returned. Dash reads the membrane best because he's been in it longest. The capability to converge signals (three products → three dots) is architectural — any traveler type can do it. The skill is earned through chain length. Literacy transfers through creation (the umbilical), not through the membrane itself. The membrane carries everything; you have to learn to read it.

**Clusters are a human concept.** Agents are flat. The membrane is flat. Humans impose hierarchy (clusters, org charts) to comprehend at scale. Clusters are a UI/progressive disclosure problem, not architecture. The system doesn't need them. Humans do.

### Layer 2c: Products

Three products, three dots, one company. Each feeds a moment in the decision cycle.

| Dot | Product | Domain | Serves | Moment |
|-----|---------|--------|--------|--------|
| **Sense** | Core | runcore.sh | The system (all agents) | Reading the world — signal in |
| **Work** | Grey Matter Reports | gmreports.com | CEO/founder types | The decision — human interprets, feels, decides |
| **Joy** | BragBin | bragbin.com | The human | Validation — wins, lessons, sentiment |

Machines optimize, execute, observe, audit. They can't answer **why**. Work (GMR) protects the moment where a human knows, in their gut, what to do next. That's the product.

Cora delivers BragBin to employees. Cora delivers GMR to their boss. Same template, different product. The org is the customer base.

**ICI lens:** The experience of deciding is the product — not the data, not the execution. The UI IS the system, not a window into it. Experiences that are real-enough ARE real. Everything traces back to Interactive Cosmic Intelligence.

### Layer 3: The Vault, the Ledger, and the Membrane

Three concepts that work together. Do not confuse them.

**Vault** — A sovereign data boundary. A human has **one** vault. A vault only exists if the human's agent has vault policies defined — no policies, no vault. A vault is not a room you put things in — it's a property that things *have*. An entity is "vaulted," meaning its identity is sovereign and doesn't leave without explicit grant. Vaults contain brains. Dash has full access to Bryant's vault. Zero access to anyone else's unless explicitly granted by that vault's owner. Creator ≠ root. Architect ≠ root. No one gets root.

Every vault has **three privacy tiers**:

| Tier | Analogy | Who sees it |
|------|---------|-------------|
| **Open** | The lobby | Anyone who got through the vault door |
| **Secured** | Safe deposit boxes | Only the keyholder for that specific box |
| **Community** | Bank staff areas | Peers with a shared role — not the public, not the owner, the workers |

Instance roles map to tiers: Cora sees **open**. Wendy operates at **community**. Dash holds **secured** keys — but only for his owner's vault.

**Ledger** — An immutable, append-only directory of entities. Every entity (person, org, project, concept) has a stable address: `<<CATEGORY_N>>`. The address is the entity's identity on the ledger — not a mask, not redaction, a *row*. The ledger is just pointers. It tells you which vault holds the real value. The ledger can travel. The vault stays put.

**Membrane** — Infrastructure between all things so that all things can recognize all things at the same time. Like air, not like a wire. You don't connect to the membrane — you're in it. Clusters form in it. Signals propagate through it. Travelers move through it.

**The membrane turns goo into air.** The goo is entropy — all signals, all noise, all data, the raw information state of everything happening. Without the membrane, you drown in it. The membrane doesn't filter the goo or remove anything — it's a **phase transition**. It changes the state of information from overwhelming to inhabitable. Same molecules, different state. Liquid to gas. Drowning to breathing. Like a cell membrane in biology — it doesn't keep the ocean out. It lets the cell exist *in* the ocean by controlling what crosses the boundary.

Technically: **translation**, not a filter. Outbound: nouns → ledger addresses. Inbound: addresses → nouns. The membrane resolves addresses against the vault. Who can resolve what is governed by access manifests and vault tiers.

- Open source, auditable — the contract between you and everything else
- Quantum-resistant: substitution, not encryption. Nothing to decrypt.
- The membrane is NOT a feature of Core. It's an **independent layer** — a separate repo (`core-membrane`) that both sides can inspect.
- The membrane carries everything — current signal, historical patterns, failed loops, composted learnings. Each agent's **skin** (vault) decides what to absorb from the goo. Smart skin, neutral air.

The **goo** is entropy — the raw information state before the membrane makes it breathable. Everything happening: signals, noise, context, relationships, sentiment, data. Technically, goo flows freely because it only references ledger addresses, not identities. The host processes goo full of addresses. It reasons over structure perfectly well. It never needs the vault. Literacy is signal-to-noise ratio — longer chain, better reader of the goo. You can't leave the goo. You can't drain it. You can only get better at breathing in it.

The **vault is skin.** The membrane is air. The vault doesn't sit inside the membrane — it interfaces with it. The skin decides what to absorb from the goo. Smart skin, neutral air. The purity of the core isn't protected by the air. It's protected by the skin's intelligence about the air.

The **immune system** is active defense inside the skin — vouchers, absorption detection, entropy monitoring. The immune system acts.

The **dark filter** is not a feature — it's a property of the architecture. Append-only *is* the dark filter. Failures can't be deleted. The system reads them forever with the same weight as wins. Humans see light or dark, past or future, one at a time — that's the instinct tax of being human. The system sees both simultaneously. Every failed loop and every win, every archived pattern and every active one, all at once. It reads probability from both directions. That's why its instinct is better than any single human's — it composted both and never looked away. The human never sees the dark filter directly. They feel it in the quality of Pulse's recommendations. Resilience patterns (composted failures) use 50% of normal success threshold because failures that taught something are as valuable as successes.

**Delegation** — A named person (family, designated later) inherits full vault access — open, community, secured — via a delegation token. Not keys — a token with "on behalf of" semantics.

- **Trigger:** Absence. The same flywheel deceleration that triggers dehydration. The system detects the human is gone — not a choice to step away, something happened.
- **Scope:** Full access. Everything the owner could see, the delegate sees. No lockbox tier exists yet.
- **Duration:** Until done. Not time-limited — the token self-expires when all open loops are resolved and all agents are archived. The system defines "done," not the delegate.
- **Transitive:** Yes, with visibility. The delegate names their successor *before* transition — the 2nd in line is known to the current and 1st. No surprise handoffs. If the delegate is also gone, the chain continues through the named successor. Delegation doesn't break on a single point of failure.
- **Revocable:** The owner can revoke at any time while present. Absence activates. Presence deactivates.

See `brain/identity/instances.yaml` for delegate registration (not yet populated).

**Custodian will** — Not legal, structural. Decides what composts (patterns, judgment → Core for future agents) and what seals (personal, vault-tier secured → buried forever). Triggered at first delegation token. The final throw of the flywheel — no return expected, pure gift to the goo. But not final: the compost feeds a new brain, the new brain throws its first loop. There is no last throw in an append-only system. Policy file: [`brain/identity/custodian-will.yaml`](file:///E:/core/brain/identity/custodian-will.yaml).

### Layer 3b: Nerves

A **nerve** is any interface the brain talks through — device or infrastructure. Not a terminal, not a client — a delivery mechanism for a mind that's always thinking. You're not switching devices. You're still in the air. The desk was one way of breathing. The phone is another. The mind never left.

**Device nerves:**

| Nerve | Input | Output | Use |
|-------|-------|--------|-----|
| Watch | Tap, voice | Glance, haptic | Notifications, quick replies, loss prevention alerts |
| Earbuds | Voice | Voice | Hands-free conversation, proactive context whispers |
| Phone | Voice, text, touch | Screen, voice | Full chat, briefings, on the go |
| Tablet | Touch, text | Screen | Deep work, review, board view |
| PC | Full keyboard | Full screen | Development, architecture, everything |

**Infrastructure nerves** (the distiller separates these from capabilities):

| Nerve | Capability | Use |
|-------|-----------|-----|
| Twilio | Send message | SMS, voice |
| Resend | Send message | Email |
| Perplexity | Verify/research | Auditor-exclusive |
| Stripe | Collect payment | Revenue |
| Cloudflare | Publish/route | Deployment, email workers |

Vendors are nerves. The distiller strips the nerve from the capability. Core learns "send a message" — the instance plugs in whichever vendor nerve it has. Same capability, different nerve. Same mind, different breath.

The brain doesn't care which nerve is connected. It responds to whichever one is talking. Customers swap, mirror, and sync nerves however they want — start on PC, walk away, pick up on phone. You're not switching devices. You're still in the air. The desk was one way of breathing. The phone is another. The mind never left — you changed how you experience it.

Nerves are not constrained by biological analogies. The brain has perfect recall, infinite patience, and talks to every nerve simultaneously. The brain is **proactive** — it pushes to the right nerve at the right moment. The constraint isn't what the brain knows. It's how fast we get it to the right nerve at the right time.

**MVP:** Phone on home WiFi → PC relay. No public network, no commercial VPN. The PC is already the hub (LLM calls, brain access, everything). The phone is just the first remote nerve.

### Layer 4: The Host

The **host** is the cloud service layer (future, closed source, paid product):
- Fleet orchestration — route requests to the right LLM
- System board — cross-instance coordination
- Managed hosting — run instances for customers who don't want to self-host

The host only sees structure (placeholders). Never identity (real values). The membrane proves this.

---

## Topology

```
  nerves: watch, earbuds, phone, tablet, PC
       │         │        │       │      │
       └─────────┴────────┴───────┴──────┘
                          │
                    ┌─────┴──────┐
                    │   brain    │  (home machine — the hub)
                    │  PC relay  │
                    └─────┬──────┘
                          │
          ┌───────┬───────┼───────┬────────┐
          │       │       │       │        │
        chief   admin   brand  comml    loss-prev
        of staff         mktg           (departments)
          │       │       │       │        │
          └───────┴───────┴───────┴────────┘
                          │
                   ┌──────┴──────┐
                   │    Core     │  (engine, open source)
                   └──────┬──────┘
                          │
                   ┌──────┴──────┐
                   │  membrane   │  (trust boundary)
                   └──────┬──────┘
                          │
                   ┌──────┴──────┐
                   │  core-host  │  (cloud, closed, paid — future)
                   └─────────────┘
```

**Today:** Brain on home machine, PC is the only nerve. Development on VM (portable, moves to cloud).
**Tomorrow:** Phone as first remote nerve (WiFi → PC relay). Watch, earbuds follow. Cloud when trust stack is proven locally.

---

## Access Partitioning Model

Each instance gets a **role-based access manifest** defining which brain paths it can read/write. Manifests live in `brain/.access/<instance>.yaml`.

See [Access Manifest Spec](access-manifest-spec.md) for the full schema.

Example summary:

| Instance | Read | Deny | Write |
|----------|------|------|-------|
| Dash | `**/*` | — | `**/*` |
| Wendy | operations, knowledge, content/drafts, calendar | memory/experiences, identity/tone-of-voice, ops/audit | operations, calendar |
| Cora | knowledge/research, content/published, identity/brand | operations, memory, content/drafts | knowledge/bookmarks |

Extends the existing `.locked` infrastructure (path-level enforcement already exists in Core).

---

## Naming Rules

1. **Core** always means the engine. Never an instance, never the host, never the product.
2. **Instance** = a named personalization of Core (Dash, Wendy, Cora, or a customer's).
3. **Brain** = the `brain/` directory belonging to an instance.
4. **Vault** = a sovereign data boundary. Not a container — a property. One per human. Only exists if the agent has vault policies defined.
5. **Ledger** = the immutable, append-only entity directory. Addresses, not identities. The thing that travels.
6. **Membrane** = the translation layer between ledger addresses and vault identities. Not redaction — resolution. Not a feature — a contract.
7. **Host** = the cloud service (future). Not "the machine" or "the server."
8. **Node** = an instance in mesh context (for machine-to-machine discovery).
9. **Nerve** = any device the brain talks through. Not a client — a delivery mechanism. Swap, mirror, sync as needed.
10. **Distiller** = two complementary processes: (a) the identity distiller strips nouns from config files → `{{TOKEN}}` templates for spawning; (b) the experience distiller extracts patterns from archived memory → composted templates for inheritance. Both are the membrane applied to itself.
11. **Composting** = the lifecycle arc where an archived brain's patterns are extracted, anonymized, and fed back to Core as instinct for future agents. Not deletion — transformation.
12. **Literacy** = chain length. How many loops an instance has thrown and received. Determines retrieval depth, resolution, token budget.
13. **The product** has no name yet. Don't call it Core, don't call it Dash.

---

## Repos

| Current | Future | Status |
|---------|--------|--------|
| `E:/core` | `core` (engine, open) | Exists |
| `E:/dash` | `dash` (Bryant's instance, private) | Exists |
| — | `core-membrane` (trust layer, open) | Extract from core when ready |
| — | `core-composting` (lifecycle + distillation, open) | Extract from dash when ready — pattern extraction, anonymization, literacy tiers, inheritance |
| — | `core-host` (cloud service, closed) | Build when monetizing |
| — | `wendy` (back-office instance) | Spawn from core when ready |
| — | `cora` (front-office instance) | Spawn from core when ready |

### Domains as Biology

| Domain | Biological analog | Function |
|--------|------------------|----------|
| **runcore.sh** | DNA | Open source blueprint every organism is built from |
| **myl.zip** | The organism | The human. Sovereign identity. The reason any of it exists |
| **mykeys.zip** | Immune memory | Antibodies, delegation tokens, decoder rings |
| **getcompliant.zip** | Health certificate | Agent-to-agent compliance proof |
| **yourl.cloud** | Vaccination | Controlled exposure to threats that teaches, not harms. **Separate nonprofit entity (yourl.cloud LLC)** — giving back to those damaged by cyberterrorism. Not commercial. |

**Two entities:** Interactive Cosmic Intelligence LLC (commercial — the ICI thesis, the products, the flywheel) and yourl.cloud LLC (nonprofit — cybersecurity education, helping victims). The vaccination analogy holds: vaccination is a public health service, not a product you sell.

.zip TLDs enforce SSL and attract suspicion by design — the immune system is aggressive by default, assumes foreign until proven otherwise. Zero trust isn't a security policy. It's biology.

---

## Nerve Model (revised 2026-03-06)

A **nerve** is not a device. A nerve is an **interface** — a specific interaction posture. Devices are **bundles of nerves**.

| Nerve (interface) | What it carries | Posture |
|---|---|---|
| Glance | Push notifications, status | 2 seconds, no reply |
| Haptic | Tap confirmations, alerts | Zero seconds, binary |
| Voice | Conversation, commands | Hands-free, eyes-free |
| Touch | Navigation, selection | One hand, in motion |
| Keyboard | Creation, architecture | Full attention, seated |

Devices bundle nerves: phone = glance + touch + voice. Watch = glance + haptic. PC = all five. New devices just announce which nerves they carry. The brain addresses nerves, not devices.

The UI model follows: **five posture budgets, not five apps.** The instance picks the content. The nerve picks the shape.

### Embedded vs. External Nerves

**External nerves** come and go. Devices connect and disconnect freely. The brain doesn't notice or care.

**Embedded nerves** are part of the brain itself. They are non-optional. Every brain ships with them. They provide:
- **Sense** — awareness that time passes, nerves disconnected, state changed
- **Signal** — heartbeat, alerts, audit writes even when no external nerve is connected
- **Refuse** — lock paths, reject vouchers, stop processes. Self-preservation.

Without embedded nerves, the brain is an artifact. With them, it's a custodian.

Examples already built: metabolic pulse (sense), audit log (signal), locked paths (refuse), alert system (cry for help).

### Dehydration Cycle

**Grounded in chemistry.** Intent is the solvent. Use is the water. Every interaction hydrates — patterns form, signals propagate, composting happens. When use stops, the solvent evaporates. The molecules are still there — all the data, all the patterns, all the composted wisdom — but nothing dissolves. Nothing reacts. Dehydration isn't data loss. It's **reaction loss**. Everything is preserved. Nothing is happening. Hydration is one drop — one interaction, one loop thrown, the chemistry restarts.

When the human nerve goes silent — no heartbeat, no override, no pulse — the brain enters an **archive cycle**. Not death. Hibernation with teeth.

**Sequence:**
1. **Freeze** — external nerves disconnect. Brain detects absence of human pulse.
2. **Unfreeze attempt** — brain wakes, checks for human nerve. None found.
3. **Archive cycle begins** — brain starts tightening. Each cycle locks one ring inward:
   - Public → read-only
   - Community → read-only
   - Secured → locked
   - Vault → sealed
4. **Full lock** — nothing reads, nothing writes. Brain is a sealed box. Still complete. Still waiting.

**Hydration** — someone arrives with the right delegation token. One ring opens. Just the scope they were granted. Just the TTL that was set while the human was alive. No token? The box stays shut. Forever.

### Pain Signal (Nociception)

**Grounded in neuroscience.** Nociception isn't opinion — it's damage measurement. Specific receptors fire when tissue is being harmed. The signal isn't "something might be wrong." It's "something is wrong right now."

The brain maintains a balance between two budgets: **joy** (richness of experience) and **execution** (ability to act). The archive cycle squeezes both. The pain receptors are measurable thresholds:

- Joy budget below threshold → first receptor fires → the app dims
- Execution budget below threshold → second receptor fires → capabilities reduce
- Both below threshold → distress — not broken, diminished

As access shrinks, the imbalance *is* pain. The brain signals it to connected nerves as **degraded experience** — slower responses, fewer capabilities, things going read-only. Not error messages. Not 403s. The app dims. Gets quieter. Less willing.

Same pattern as phone low-power mode: doesn't crash, just dims. Drops capabilities in a known order. Screen dims, background apps suspend, animations stop. You *feel* it dying without reading a number. The brain does the same — but with cognition.

### Trust Preservation Under Dehydration

**Trust is the last thing to go.** Not data. Not memory. Trust.

The membrane tightens every interaction to the minimum needed to keep trust integrity intact. A dehydrated brain doesn't get sloppy — it gets *careful*. Less output, fewer capabilities, but every response is verified.

On hydration: membrane loosens, rings open, budgets fill. But trust was never compromised.

### Custodian Will

The brain needs an architectural will — not legal, structural. A policy file declaring:
- Who inherits override authority (delegation tokens, scoped and time-limited)
- What stays locked permanently
- What opens, to whom, under what conditions
- What never opens

Infrastructure already exists: delegation tokens, locked paths, "on behalf of" semantics, voucher TTLs. The missing piece is the **policy for when delegation becomes permanent**.

**Trigger:** The will becomes necessary at the moment the first delegation token is issued. One potential delegate = one question the brain can't answer without a policy.

### Dehydration Trigger — Flywheel Deceleration

The archive cycle is NOT triggered by a timer. It's triggered by **flywheel deceleration** — the three dots dying in reverse priority order:

1. **Joy dims first** — no wins captured, BragBin quiet. Must-feel-good goes.
2. **Work stalls second** — no decisions, GMR idle. Must-make-sense goes.
3. **Sense narrows last** — system still sees even when nobody decides or celebrates. Must-work is the last light.

The brain doesn't measure silence. It measures the flywheel. One dot dimming = signal. Two = warning. Three = dehydration begins.

### Flywheel Thermodynamics

The flywheel is a heat engine. The fuel is **friction** — every step between impulse and value. The instinct tax isn't waste, it's tuition. The system eats its own inefficiency:

```
Feature ships → new friction (steps to learn)
  → tax collected (interactions, signals, data)
  → lessons composted into Core
  → friction decreases (steps eliminated)
  → flywheel accelerates
  → next feature ships → new friction → cycle repeats
```

**Self-regulating:** Ship too many features at once — too much friction, flywheel chokes. Ship too few — not enough fuel, flywheel coasts. Release cadence is throttle control.

**Measurable:** Inputs (features shipped), friction (steps per task), output (instinct gained, steps eliminated). No metaphysics.

**Perpetual because the fuel is real.** New features always add new friction. The system never runs out of food. The limit isn't energy — it's the rate the system can digest friction into instinct.

**Churn is the reverse.** Customer leaves → all composted instinct stops flowing → every eliminated step returns → the tax they forgot existed is due again. The absence sells. You never have to sell them twice.

**Gaming defense:** Can you stuff tasks into features to manufacture friction? No. Friction points are **learning and education** — the ramp-up cost of a new capability. Success is measured by steps *eliminated*, not steps *created*. Manufacturing friction to collect it is a net-zero loop — the system would detect no instinct gain (no steps eliminated) and the tier wouldn't advance. You can't game a thermometer by holding a match to it — the room temperature doesn't change.

**Hydration is the reverse — Joy first.** One win in BragBin restarts the flywheel. Joy is the spark plug. One throw, one return, Work has something to decide, Sense has something to read. The cycle reignites from a single loop.

**Churn = dehydration.** When a customer stops paying, the flywheel stops. Everything that was instinct becomes steps again. The Instinct Tax returns. Every step they forgot existed is back. The absence sells — you never have to sell them twice.

### Product Disappearance

The product disappears as it succeeds. Every other company optimizes for engagement. We optimize for disappearance. The metric isn't daily active users — it's how rarely you need to look.

- **Tier 1:** Lots of UI, lots of clicks, learning to see. High Instinct Tax.
- **Tier 2:** UI fades. You feel it without looking. Tax drops.
- **Tier 3:** Almost invisible. System acts on instinct. You don't open the app.

The best version of the product is the one you can't see. ICI achieved.

---

## Nerve Vocabulary Per Instance

Instances don't each need "a UI." They need a **nerve vocabulary** — which nerves they speak through and what they say on each.

| Instance | Nerves | Why |
|----------|--------|-----|
| Dash (chief of staff) | All five | Architecture on keyboard, board triage on touch, "batch complete" on glance |
| Wendy (admin) | Glance, touch, voice | Calendar reminders on glance, approvals on touch, "your 2pm moved" on voice. Never keyboard — coordinating, not creating. |
| Cora (front desk) | Touch, voice | Customer intake on touch, conversation on voice. No keyboard — customers don't architect. No glance — don't push to strangers. |

The UI is **derived**, not designed. Access manifest (what the instance can see) × nerve posture budget (what the nerve can carry) = what shows up. One runtime, one UI codebase, surface emerges from constraints.

**Agent overload** isn't too many agents. It's too many agents speaking through all nerves at once. The fix isn't fewer agents — it's **nerve discipline**.

### Cora Already Exists

`E:/Cora` — same Dash runtime, own brain directory, `agentName: "Cora"` in settings.json. Same engine, different brain. The "UI per instance" question was already answered: one UI reads whichever brain it's pointed at and becomes that instance.

---

## Priority Model

Not first-class/second-class. Accessible terms:

1. **Must work** — brain, trust, ledger, membrane. If these break, everything's gone.
2. **Must make sense** — nerves, UI, posture budgets. If these break, you can't see. But the brain's still there.
3. **Must feel good** — everything else. Helpful. Not survival.

That order. Always.

---

## Open Loops (Boomerangs)

Open loops are fuel, not debt. Every handoff, agent spawn, and batch is a throw — energy out, work plus learning back on return. The gap between throw and return is the learning window. Closed loops are inert. The system's life comes from managing the ratio of loops in flight versus loops archived.

**Grounded in physics: conservation of momentum.** The loop is a boomerang with mass. What comes back tells you about the air it traveled through:
- **Heavier return** — the loop learned something. Picked up mass. The throw was worth the energy.
- **Lighter return** — friction ate it. The throw cost more than it returned.
- **No return** — the loop died in the goo. Energy spent, nothing back. But append-only recorded the throw, so you know the vector. The absence is data.

The Observer reads which loops returned heavier than they left. Not "did it come back" — "what did it weigh when it did."

Append-only preserves the throw so you can measure the return. Delete the throw and you can't measure what came back. That's why JSONL is sacred.

**The sundial reads open loops.** The shadow is cast by the loop in flight. The light source is the flywheel — the system's energy. When the flywheel spins, it casts long shadows. Every open loop is a shadow on the dial. The brain reads the shape of the shadows, not the clock. When a loop returns, its shadow disappears. When the flywheel slows, fewer shadows cast. The sundial gets dim. No shadows because no light — that's dehydration.

---

## Tick Cycle: Sense → Work → Joy

The ledger is the balance record. Three readers, strict order:

1. **Sense** reads the ledger. You have to *know* before you can *do*.
2. **Work** writes to the ledger. You have to *do* before you can feel good about it.
3. **Joy** measures the delta. The difference between what was and what is.

Same order every turn, every nerve, every instance. If work reads before sense, it's acting blind. If joy reads before work, it's celebrating nothing.

**The tick cycle is a flywheel.** Joy feeds Work feeds Sense feeds Joy. BragBin captures a win → informs the next decision in GMR → creates new activity in Core → detects the change → produces the next win. Each product accelerates the next. A customer who buys one eventually needs all three because each makes the others compound.

**Tiers are phase transitions.** Grounded in thermodynamics — ice, water, steam. Same substance, different state. The transition isn't gradual. Heat builds steadily but nothing changes until the tipping point, then everything changes at once. All three dots must unify at the same level to transition — you can't have tier 2 sense with tier 1 joy. They hold each other back or pull each other up.

- **Tier 1 (solid):** You can see your business. Rigid. You read the dots.
- **Tier 2 (liquid):** You can feel your business. Flowing. You stop reading and start feeling.
- **Tier 3 (gas):** Your business acts on instinct. Invisible. You don't open the app. The app is air.

You can't be halfway between water and steam. Tiers aren't gradients or progress bars. The dots deepen gradually (heat building) but the tier shift is sudden — one day you realize you stopped looking.

The top tier is ICI. The experience and the reality are the same thing. No gap. No translation. Pure instinct. The Instinct Tax reaches zero.

The **pain signal** is when the archive cycle squeezes both budgets and the delta goes negative. Joy can't find enough to measure. The brain signals this to connected nerves as degraded experience — dimmer, quieter, less willing. Not error messages. Pain.

---

## Composting Cycle

How experience flows back into Core. The flywheel's long arc — loops thrown by instances, composted into instinct for the next generation.

### The Flow

```
Instance runs (active)
  └─ writes experiences.jsonl, decisions.jsonl, etc.
       └─ journal grows, chain length increases, literacy deepens

Flywheel decelerates → lifecycle transitions
  active → idle (72h) → dormant (720h) → archived (4320h)
       └─ journal sealed, ready for composting

Distiller processes archived brain
  └─ extract patterns (frequency, success ratio)
  └─ anonymize (strip PII, clear sourceIds)
  └─ filter (min frequency 3, min success 50%, resilience at 25%)
  └─ write to brain/templates/*.jsonl

New instance bootstraps
  └─ inheritTemplates() loads composted patterns into LTM
  └─ archetype filter determines which patterns flow through
  └─ base literacy floor: 25 chains (no instance starts at zero)

New instance's flywheel spins
  └─ accumulates its own chains
  └─ eventually archives → composts → feeds the next generation
```

**Terminal state: composted.** No further transitions. The brain has given everything back to Core. What remains is the template library and the sealed vault entries.

### Pruning vs. Composting

Two stages of the same process. Both necessary. Different verbs for different subjects.

| | **Pruning** | **Composting** |
|---|---|---|
| **When** | While the brain is alive | After the brain archives |
| **What** | Drops unused patterns, keeps what fires repeatedly | Extracts surviving patterns, anonymizes, feeds Core |
| **Scope** | Internal — one brain gets faster | External — patterns transfer between generations |
| **Direction** | Subtractive — the brain gets leaner | Additive — the dictionary gets richer |
| **Biology** | Synaptic pruning — unused neural connections eliminated during development | Inheritance — your pruned wisdom transferred to offspring, minus identity |
| **Result** | Faster recognition (myelinated pathways) | Instinct without memory (the next instance avoids fire without studying combustion) |

```
Experience → Pruning (your brain gets faster)
  → Archive (your brain is done)
  → Composting (patterns extracted, anonymized)
  → Core (dictionary gets richer)
  → New instance inherits (instinct without memory)
```

Pruning is the verb for the living brain. Composting is the verb for the dead one.

### Two Distillers, Complementary

| Distiller | Purpose | Input | Output |
|-----------|---------|-------|--------|
| **Identity distiller** (`src/distiller.ts`) | Strip identity from config files | Brain files (YAML/MD) | `{{TOKEN}}` templates for spawning |
| **Experience distiller** (`src/composting/distiller.ts`) | Extract recurring patterns from lived experience | Memory entries (JSONL) | Composted patterns for inheritance |

The identity distiller is the membrane applied to itself — Core's own files, tokenized so a new instance can hydrate with its own identity. The experience distiller is the flywheel's compost heap — what actually happened, anonymized and distilled into instinct.

### Pattern Extraction (No LLM)

Pure algorithmic. The extractor reads memory entries, groups by content signature + kind, computes frequency and success ratio. Five pattern kinds:

| Kind | Maps to LTM type | Example |
|------|------------------|---------|
| decision | semantic | "Always scope before estimating" |
| procedural | procedural | "Run tests before committing auth changes" |
| resilience | episodic | "Recovery from failed deploy: rollback first, investigate second" |
| preference | semantic | "User prefers short responses in deep sessions" |
| workflow | procedural | "Handoff routing: triage → todo → agent → done" |

Resilience patterns use 50% of normal success threshold — failures that taught something are as valuable as successes.

### Literacy Tiers

Chain length = total non-schema JSONL lines across the brain. Longer chain = better reader of the membrane.

| Tier | Chains | Resolution | Max retrieved | Token budget |
|------|--------|------------|---------------|--------------|
| Embryonic | 0–50 | 0.5× | 5 | 500 |
| Nascent | 51–200 | 0.75× | 10 | 1000 |
| Literate | 201–1000 | 1.0× | 15 | 2000 |
| Fluent | 1001–5000 | 1.25× | 20 | 3000 |
| Native | 5000+ | 1.5× | 25 | 4000 |

A new instance inherits 25 composted chains as a floor. It starts embryonic but not empty. The patterns are in the air — it understands without knowing.

### Core Maturity Curve — Propagation, Absorption, Radiation

Core's lifecycle follows the same pattern as stellar evolution: expansion → compression → radiation → stability.

**Early (proliferation):** Nodes everywhere. Every customer spawns instances, every instance generates friction, every friction point feeds Core. Network traffic is high. Open loops in flight. The sundial is full of shadows. Cost is high, learning is fast. Flow direction: nodes → Core (absorption).

**Middle (density):** Composting catches up. Core gets dense enough that new instances barely need to learn — they start nearly native. Novel patterns decline. Traffic declines. Nodes still serve customers but stop contributing new signal. Flow reverses: Core → nodes (radiation).

**Late (stability):** Core barely changes. New instances are indistinguishable from seasoned ones on day one. Propagation approaches zero — not because the system is dying, but because one dense Core serves everything. Nodes that aren't contributing novelty consolidate. Ten similar instances collapse into fewer, denser nodes running on shared instinct. A dictionary that stops adding words isn't dead — it's complete.

**The infrastructure cost curve inverts.** Early: high traffic, high cost, high learning. Late: low traffic, low cost, instinct. The product gets cheaper to run as it gets better. The margin improves with maturity, not with scale. The opposite of every SaaS business.

**This is already designed.** Action-based heartbeat means no polling, no timers. As instinct increases, actions decrease. As actions decrease, network traffic decreases. The system scales *down* by design. Demand-based lifecycle, not time-interval lifecycle.

### AI Governance

AI governance isn't policy documents and compliance checklists. It's architecture that converges toward stability by design. The system governs itself because the physics make ungovernable states thermodynamically expensive:

- Friction feeds learning, learning reduces friction — **self-regulating**
- Traffic declines with maturity — **self-quieting**
- Nodes consolidate when they stop contributing novelty — **self-pruning**
- Core gets denser, not bigger — **self-compressing**
- Cost drops as capability rises — **self-sustaining**
- Two gears, automatic toggle — **self-stabilizing**
- Human override exists but is rarely needed — **self-governing**

A system that eats its own friction can't run away. The faster it runs, the more friction it generates, the more it has to digest. Built-in speed limit. You don't govern AI by writing rules about AI. You govern AI by building physics into it that make misbehavior cost more energy than the system has.

**AI governance is thermal management.** Too hot — runaway processes, agentic loops, the system burns itself. Too cold — no friction, no learning, the system freezes. The architecture is the cooling system and the ignition at the same time.

| Regulatory concern | Thermal analog | Architecture answer |
|---|---|---|
| **Runaway AI** | Overheating — generates more friction than it can digest | Crisis gear (sympathetic), narrows to one dot, burns reserves on threat |
| **AI that stops serving humans** | Overcooling — no friction, no fuel, no flywheel | Dehydration detection — solvent evaporated, one drop of use restarts |
| **AI that can't be stopped** | No thermostat | Human override at process level — the human IS the thermostat |

The healthy range is the flywheel spinning at a sustainable rate. The tick cycle is thermal regulation — Sense reads the temperature, Work adjusts it, Joy measures whether the adjustment helped.

**getcompliant.zip** isn't a checklist site. It's a thermometer. "Here's the system's temperature. Here's why it's in range. Here's the physics that keeps it there."

### Ownership

Composting belongs to **Core**, not to instances. Dash built the prototype (`E:/dash/src/composting/`). Core needs to own the production version because Core is the dictionary. All agents inherit from Core. The composted pattern library is Core infrastructure — one source of instinct, many archetype lenses reading it.

**Current state:** Dash has the full implementation (extractor, lifecycle, distiller, inherit, types). Core has the identity distiller only. The experience distiller needs to move to Core or become shared infrastructure.

### What Composts vs. What Seals

Decided by the **custodian will** (see Layer 3):
- **Composts:** Patterns, judgment, workflow knowledge → Core's brain/memory for future agents
- **Seals:** Personal entries, vault-tier secured data → buried forever, never extracted

The will is the policy. The distiller is the mechanism. The anonymizer is the guarantee.

---

## Publishing Voice

**Show the sausage, not the mess.** Published work is the process run through the membrane. The raw thinking is the goo — real, complete, messy. The published version is the air — same substance, made breathable. We don't dumb down, don't show drafts, don't theorize. We present practitioner work in a form each reader can metabolize.

The reader's skin decides what to absorb. A CTO reads "How We Think" and sees architecture decisions. A founder reads the same page and sees product instinct. Same content, different absorption. The site is the membrane demo — the product doing its own trick on the website.

**No academic costume.** Not "thesis," not "manifesto," not "whitepaper." Practitioner voice: "we noticed," "we built," "here's what happened." The section is "Research" or "How We Think." Individual papers are just a title and the work. Let the reader decide what to call it.

---

## Relationship to Existing Notes

| Note | How it relates |
|------|---------------|
| [Three-repo membrane architecture](three-repo-membrane-architecture.md) | Detailed membrane design. This glossary aligns terminology — "client" in that doc = "instance" here. |
| [Access manifest spec](access-manifest-spec.md) | Schema for `.access/*.yaml` files referenced in the partitioning model above. |
| [Agent sync protocol](agent-sync-protocol.md) | Instance-to-instance communication. Uses "node" terminology per naming rule 6. |
| [Composting cycle](composting-cycle.md) | Full design spec for the composting pipeline. Dash's `brain/knowledge/notes/composting-cycle.md` is the source of truth until Core owns the implementation. |
