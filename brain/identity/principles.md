# Principles

Reference document for decision-making across all Core-based brains. Not a marketing doc. Not a pitch deck. A set of commitments that shape what we build, how we build it, and how we operate.

---

## 1. Product Principles — what we build and why

**Your data stays yours.**
File-based, local-first, no cloud dependency for storage. The brain is a directory on your machine. You can zip it, move it, read it with a text editor. No vendor holds your cognition hostage.

**The membrane is real.**
Redaction is a property of the data flow, not a checkbox on a settings page. Data leaving your machine is a conscious, architectural choice — never a default. The cloud never sees the full picture because the architecture makes it physically impossible, not because policy says so.

**Stability over demo magic.**
A system that works reliably on day 5 beats one that dazzles on day 1. Ship things that hold up under daily use. Resist the temptation to optimize for first impressions at the cost of sustained function.

**Agency with a heartbeat.**
Agents act autonomously but never silently. Every action has a pulse the human can feel — a log entry, a notification, a visible trace. If the human can't tell what happened, it didn't happen right.

**Cognitive sovereignty.**
The system is auditable, evolvable, and yours to inspect. No black boxes. Every decision the agent made, every memory it stored, every skill it used — visible in plain text files you own.

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

**Shared infrastructure, separate identity.**
Brains share memory stores and vault but each has its own identity, personality, and principles. Core is the scaffold; instances are the people.

**Secrets never travel in prompts.**
Credentials hydrate into `process.env` from encrypted storage at runtime. Never in context windows, never in API calls, never in logs. If a secret appears in a prompt, the architecture has a bug.

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
