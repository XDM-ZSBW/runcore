# Three-Repo Architecture: Client, Membrane, Host

> Status: Note (graduated from thought streams, 2026-03-05)
> Next: Research — pressure test against real deployment scenarios, quantum threat models, competitive DLP landscape
> Origin: Convergence of membrane implementation session + enterprise transformation framing + "the membrane is real" principle

---

## Thought Streams That Joined

1. **PrivacyMembrane implementation** — Building reversible typed-placeholder redaction surfaced the insight that the membrane is not a feature. It is an architectural boundary where structure replaces identity.

2. **Membrane whitepaper** — Comparing the membrane to traditional DLP (network, NER, synthetic, cloud proxy) revealed that every other approach relies on either one-way destruction or encryption. The membrane does neither. It substitutes identity with typed placeholders that preserve full relational context.

3. **Enterprise transformation framing** — The Remodel/Gut Rehab/New Construction framework for AI transformation surfaced the question: what does the trust boundary look like between a cloud host and local clients? The membrane is the answer.

4. **"The membrane is real" principle** — Already in `brain/identity/principles.md`: "Data leaving your machine is a conscious, architectural choice — never a default. The cloud never sees the full picture because the architecture makes it physically impossible, not because policy says so."

5. **Anonymity and protection paradox** — How do you claim to protect data you don't see? You don't claim it. The architecture proves it. The membrane is the zone where maximum context meets minimum identity. Legacy systems can't process this state. AI can.

---

## The Architecture

Three repositories. Three trust properties. Two open, one closed.

### core-client (open source)

The brain. The local machine. The user's data, identity, memories, knowledge.

- Runs locally. Works offline. No cloud dependency for storage.
- Contains the user-facing interface — same generic UI regardless of whether connected to a host.
- Holds one side of the membrane — the bidirectional map that connects placeholders to real values.
- The map never leaves the client. This is the critical invariant.

**Trust property: Sovereignty.** Your brain, your machine, your data. Open so anyone can verify.

### core-membrane (open source)

The trust layer between client and host. An independent, auditable contract.

- Typed-placeholder substitution: `<<CATEGORY_N>>` format preserves relational structure without identity.
- Bidirectional: `apply()` outbound (client → host), `rehydrate()` inbound (host → client).
- Same value = same placeholder across turns. The host sees consistent tokens it can reason over without knowing what they refer to.
- Streaming-aware: token buffer handles split placeholders across SSE chunks.
- Audit log: categories and counts only. Never values.
- Sensitive registry: YAML-configured terms + built-in pattern rules. "Secure by teaching" — add a term, the membrane filters it.

**Trust property: Verification.** Provably no real data crosses the boundary. Open so anyone can audit the contract.

### core-host (closed source)

Fleet orchestration. LLM routing. System board. The service layer.

- Manages N clients. Routes LLM requests. Hosts the system board.
- Processes only placeholders. Never receives real values.
- Can be a black box because the membrane is a glass box.
- This is the business. The product. The thing that scales.

**Trust property: Service.** Orchestration, routing, scale. Closed because it doesn't matter — the two open repos prove the host can't see your data.

---

## Why Three Repos, Not Two

If the membrane lives inside the client, the host has to trust the client's implementation. If it lives inside the host, the client has to trust the host's implementation. As a third, independent repo:

- The client is open — you can see what it does with your brain.
- The membrane is open — you can see what crosses the boundary and verify nothing real leaves.
- The host is closed — and it doesn't matter, because the membrane proves the host only receives structure, not identity.

The membrane is the treaty between open and closed. It must be independently auditable to serve that role.

---

## Quantum Resistance

Every other trust model between client and cloud relies on encryption. Encryption is a bet that math stays hard.

- **Encryption says:** "I'll send you the real data, but scrambled so you can't read it."
- **Membrane says:** "I'll never send you the real data."

One of those survives quantum computing. The other doesn't.

The bidirectional map lives on the client. It never crosses the wire. A quantum computer that can break every encryption algorithm ever written still can't reverse a placeholder that was never transmitted alongside its original value. There is nothing to break.

This is not encryption-based security. It is substitution-based security. The host processes `<<ORG_0>>` and `<<PROJECT_1>>` — structure without identity. The computational hardness assumption is not "this math is hard to reverse." It is "this data does not exist on the server."

---

## Topology

```
core-host (cloud, closed)
├── system board
├── LLM routing (proxies to providers)
├── fleet management
├── receives only placeholders
│
├── [membrane boundary — open, auditable]
│
├── core-client A (local, open)
│   ├── brain (its own)
│   ├── bidirectional map (never leaves)
│   └── generic interface → its own brain
│
├── core-client B (local, open)
│   ├── brain (its own)
│   ├── bidirectional map (never leaves)
│   └── generic interface → its own brain
│
└── core-client ∞
```

Every client interacts with its own brain through the same generic interface (Virtual Brain Layer, U-006). The host interacts with all clients through the same membrane contract. What's behind the interface differs:

| Layer | Host sees | Client sees |
|-------|-----------|-------------|
| User data | `<<ORG_0>>`, `<<PERSON_1>>` | "Acme Corp", "Alice Johnson" |
| Relationships | `<<ORG_0>> partnered with <<ORG_1>>` | "Acme Corp partnered with Globex" |
| Patterns | Statistical structure over placeholders | Real meaning |
| Audit trail | Categories + counts | Full context |

The host can provide intelligent orchestration, routing, and fleet management by reasoning over structure. It never needs identity to do this.

---

## Business Model Implication

This resolves the open question from U-005 (backlog):

- **core-client** — Free. Open source. Anyone can run it.
- **core-membrane** — Free. Open source. Anyone can audit it.
- **core-host** — The product. Paid service. Orchestration, routing, scale, managed updates, fleet management.

Two open, one closed. The two open repos are what make the closed one trustworthy. You don't pay for privacy — privacy is the architecture. You pay for the infrastructure that operates on the privacy-preserving structure.

---

## What Scales Infinitely

- Infinite hosts (each managing its own fleet)
- Infinite clients per host (each with its own brain)
- The membrane is the constant — same contract at every boundary

---

## Open Questions (for research phase)

1. Does the membrane repo contain just the substitution logic, or also the registry format spec and the streaming buffer protocol?
2. Should the membrane be a formal protocol (RFC-style) that third parties can implement, or a reference implementation?
3. How does the membrane handle multi-hop scenarios — client → host → external LLM provider? Two membrane applications? Or does the host's outbound call to the LLM provider carry the same placeholders?
4. Key rotation equivalent: if a client wants to re-map all placeholders (new session, paranoia, policy), what's the renegotiation protocol?
5. Compliance framing: can "the host never sees real data" be certified? SOC 2 Type II for a system that provably processes only placeholders?
6. What's the membrane's relationship to homomorphic encryption research? Similar goal (compute on data you can't see), different mechanism (substitution vs. math). Is there a formal equivalence or category distinction?
7. Does the membrane pattern have a name in existing cryptographic literature? Tokenization comes closest but tokenization typically implies a centralized token vault. The membrane's vault is distributed (each client holds its own map).

---

## Relationship to Existing Work

| Backlog item | Connection |
|---|---|
| U-005: Distribution model | Resolved: client open, host closed, membrane is the trust bridge |
| U-006: Virtual Brain Layer | The generic interface that both host and client use to interact with brains |
| U-007: Brain access partitioning | The membrane IS the partition — public layer = placeholders, private layer = real values on client |
| P2: Hub-spoke mesh | Host is the hub. Clients are spokes. Membrane is the spoke protocol. |
| KR2: No PII leaves machine | Architecturally guaranteed by the membrane, not just pattern-matched |
