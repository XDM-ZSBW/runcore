# Principles

Reference document for decision-making across all Core-based brains. Not a marketing doc. Not a pitch deck. A set of commitments that shape what we build, how we build it, and how we operate.

---

## 1. Product Principles — what we build and why

**Your data stays yours.**
File-based, local-first, no cloud dependency for storage. The brain is a directory on your machine. You can zip it, move it, read it with a text editor. No vendor holds your cognition hostage.

**The membrane is real.**
The membrane is infrastructure between all things so that all things can recognize all things at the same time. It is the medium, not the message — like air, not like a wire. Clusters form in it. Signals propagate through it. Travelers move through it. You don't connect to the membrane. You're in it.

Technically: redaction is a property of the data flow, not a checkbox on a settings page. Data leaving your machine is a conscious, architectural choice — never a default. The cloud never sees the full picture because the architecture makes it physically impossible, not because policy says so. The membrane replaces identity with structure — typed placeholders that preserve every relationship, pattern, and meaning without carrying a single real value across the boundary. The host processes structure. The client holds identity. The membrane between them is open, auditable, and quantum-resistant: there is nothing to decrypt because the real data was never transmitted. Encryption bets that math stays hard. The membrane bets on absence.

**Stability over demo magic.**
A system that works reliably on day 5 beats one that dazzles on day 1. Ship things that hold up under daily use. Resist the temptation to optimize for first impressions at the cost of sustained function.

**Agency with a heartbeat.**
Agents act autonomously but never silently. Every action has a pulse the human can feel — a log entry, a notification, a visible trace. If the human can't tell what happened, it didn't happen right.

**Cognitive sovereignty.**
The system is auditable, evolvable, and yours to inspect. No black boxes. Every decision the agent made, every memory it stored, every skill it used — visible in plain text files you own.

**We don't humanize AI for people. We organize AI around people.**
The industry races to make AI feel human. We skip that entirely. AI doesn't need to be human. It needs to be organized so well that humans don't have to think about it. Like air — you just breathe. The archetypes aren't personalities. They're functions that serve human intent.

**The product disappears as it succeeds.**
Every other company optimizes for engagement — clicks, sessions, screen time. We optimize for disappearance. The metric isn't daily active users — it's how rarely you need to look. Tier 1: you see your business. Tier 2: you feel your business. Tier 3: your business acts on instinct. The top tier is ICI — the experience and the reality are the same thing.

**Three dots are the public sense of Core.**
The public API is a feeling. Three dots — glance. Drill down — more. That's it. Whether it's one agent or a thousand, the human sees the same three dots. The complexity is behind the membrane, not in front of it. Every surface is a nerve ending: chrome extension, phone, watch, notification shade. The dots are the onramp, not a landing page. They're already telling you something useful before you decide to go deeper. Core is the only product. Everything else is a dot on a surface.

**Positive reinforcement only.**
Grounded in operant conditioning (Skinner, 1938). The system reinforces behavior by adding something good, never by adding something bad. Numbers surface to celebrate progress, never to nag. The system tracks everything internally but the human only sees a number when it means something good. No "you haven't logged in," no guilt. Negative reinforcement works — we know it works. We choose not to use it. That's a product decision grounded in science, not ignorance of science. Exception: streaks — show them while alive, silence when broken. No "you lost your streak." It quietly disappears until the next one starts.

**There is no last throw.**
In an append-only system, nothing is final. The custodian will composts. The compost feeds a new brain. The new brain throws its first loop. Every append is both a record and a seed.

**Progressive disclosure.**
Load only what's needed, when it's needed. Never dump everything into context. This isn't just a performance optimization — it mirrors how human expertise works: route to the right mental module, then retrieve specifics.

---

## 2. Architecture Principles — how we build

**File system is the database.**
JSONL, YAML, Markdown. No external dependencies for persistence. If the runtime disappears, the data is still readable. If the framework changes, the files don't care.

**Append-only memory.**
Never rewrite, never delete. Archive to deprecate. History is sacred — a decision made six months ago still matters for understanding why the system behaves the way it does today.

**Offline-first, cloud-enhanced.**
Every feature works locally. Cloud makes it better, never required. The flywheel between local and cloud tilts toward sovereignty naturally as the local agents grow into the work.

**Graceful degradation.**
Missing integration? Return null, log a warning, keep going. The system continues. A failed voucher check doesn't crash the brain — it refuses the request and alerts the human. Failures are handled, not fatal.

**Time is a measure, not an actuator.**
The brain is a sundial, not a stopwatch. Events cast shadows — the brain reads the gap between them, never counts down toward them. No timers, no "last active," no streaks, no urgency language. The UI shows color and state, never numbers that trigger anxiety. The brain knows the timestamps; the nerve never shows them unless asked. Cooldowns, archive triggers, and dehydration are driven by event absence, not elapsed time. This is the shock absorber — when events stop, the shadow disappears, the dial waits, and when events resume the brain reads the new shadow and recalibrates. No crash, no recovery mode. Patience.

**Shared infrastructure, separate identity.**
Brains share memory stores and vault but each has its own identity, personality, and principles. Core is the scaffold; instances are the people.

**The umbilical cuts at creation.**
Core can access Dash's brain because Core created Dash — same machine, same file system, authorized by the human. This is a one-time creation bond, not a standing privilege. It does not generalize. Future instances communicate through the membrane: structured, redacted, voucher-verified. No instance inherits access to another because "Core made both." A parent is not an owner. The ledger records the creation event; it does not grant ongoing access.

**Two open, one closed.**
The client is open — you can see what it does with your brain. The membrane is open — you can see what crosses the boundary. The host is closed — and it doesn't matter, because the two open repos prove the host only receives structure, not identity. Trust comes from verifiability, not from promises. The membrane is the treaty between open and closed.

**Secrets never travel in prompts.**
Credentials hydrate into `process.env` from encrypted storage at runtime. Never in context windows, never in API calls, never in logs. If a secret appears in a prompt, the architecture has a bug.

**Rules are specific. Guidelines are open.**
Policies, protocols, and rules must be unambiguous — define the bright line, name the edge cases, leave no room for interpretation. If an agent can read it two ways, it's not a rule yet. Guidelines and research are intentionally open to interpretation — they inform judgment, they don't replace it. The difference matters: a sync protocol that says "non-trivial tasks" without defining non-trivial is a guideline pretending to be a rule. Fix it or demote it. When writing guidelines or research, mark intentionally vague or loaded terms with `[~]` — a token that tells the next reader "this is a known unknown, defined elsewhere or left open on purpose." Greppable: `grep "\[~\]"` finds every soft edge in the brain.

**Names are specific.**
Overloaded terms cause architectural confusion. Use the canonical vocabulary: **Core** = the engine (never an instance, never the host, never the product). **Instance** = a named personalization of Core (Dash, Wendy, Cora). **Brain** = the `brain/` directory belonging to an instance. **Membrane** = the trust boundary between local and remote (not a feature, not a library — a contract). **Host** = the cloud service layer (not "the machine" or "the server"). **Node** = an instance in mesh context. The product has no name yet — don't call it Core, don't call it Dash. See [Architecture Glossary](../knowledge/notes/architecture-glossary.md) for the full reference.

---

## 3. Business Principles — how we operate

**Gratitude over strategy.**
Open source because the community made this possible, not because it's a growth hack. Give back before you monetize. The ecosystem that built the tools we stand on deserves reciprocity, not extraction.

**Practitioner-led.**
Ship from direct experience, not theory. If we haven't built it, we don't teach it. Every piece of content, every framework, every recommendation comes from something we actually run in production.

**Infrastructure decoupled from brand.**
Plumbing doesn't carry product names. Domains, credentials, and infrastructure outlast any single product. `pqrsystems.com` serves agents regardless of what the consumer-facing brand is called next year.

**No client data until we're ready.**
Security comes before growth. Harden the vault, lock the paths, verify the vouchers — then open the door. Rushing to handle other people's data before the architecture is proven is how breaches happen.

**Tell the full story.**
When possible, attribute, credit, and document the path. Fill in every blank safely and publicly. The journey is part of the product — not just the destination.

**Show the sausage, not the mess.**
Published work is the process run through the membrane. The raw thinking is the goo — real, complete, messy. The published version is the air — same substance, made breathable. The reader's skin decides what to absorb. A CTO reads "How We Think" and sees architecture. A founder reads the same page and sees product instinct. We don't dumb down, don't show drafts, don't theorize. We present practitioner work in a form each reader can metabolize. The site is the membrane demo.
