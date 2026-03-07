# The Feed — Business Model Spec

> Status: Draft (2026-03-07)
> Origin: "The subscription unlocks the feed. Public feed free, paid tiers mix with private data locally."
> Depends on: core-os-spec.md, nerve-spawn-spec.md, stream-spec.md

## What

The feed is the product. Not the brain, not the agent, not the runtime. Those are free, local, open source, and yours forever. The feed is a proprietary stream from runcore.sh that your local host mixes with your private data to produce personalized insight neither side could generate alone.

## Why

Every other AI product charges for the brain. Your data on their servers, your conversations in their cloud, your memory behind their paywall. Cancel and you lose everything.

Core inverts this. Your brain is local. Your agents are local. Your nerves are local. Cancel the feed and everything still works — you just lose the weather forecast. Your thermometer still reads the room.

The business model isn't access to your own data. It's access to signal from the wider field that makes your local brain smarter.

## Done when

- Free tier: public feed streams to all registered hosts
- Paid tiers: richer signal, deeper patterns, faster updates
- Mixing happens locally — runcore.sh never sees private data
- Cancellation degrades gracefully — brain, agents, nerves all keep working
- The value of the feed is obvious within one week of use
- A parent can understand what they're paying for in one sentence

## The one sentence

"Your brain is free. The signal that makes it smarter is the subscription."

## What's free forever

| Component | Why it's free |
|-----------|--------------|
| Core OS | Open source. Run it anywhere. It's your computer. |
| Brain storage | Local files on your device. We never touch them. |
| Agents | Run locally. Your LLM keys, your compute, your rules. |
| Nerves | PWA in a browser. URL + safe word. No app store. |
| Chat + Stream | The core experience. Never paywalled. |
| Tunnels (direct) | Bond with someone, open a tunnel, talk. P2P. |
| Local LLM | Your model, your device. We don't meter it. |
| Membrane | Privacy enforcement. Safety is not a premium feature. |
| Encryption | Security is not a tier. |

**Principle:** Safety, privacy, and sovereignty are never behind a paywall. The membrane, encryption, and local brain are free because charging for safety is extortion.

## What the feed provides

### Public feed (free, everyone gets it)

Signal that keeps the ecosystem healthy. The commons.

| Content | Frequency |
|---------|-----------|
| Dictionary updates | As published — new specs, new patterns, architectural changes |
| Security patches | Immediate — membrane rule updates, vulnerability fixes |
| Open source release notes | Per release |
| Community signal (anonymized) | Weekly — aggregate trends, popular patterns |
| Protocol updates | As needed — tunnel spec changes, relay updates |

The public feed keeps your host current and your membrane sharp. This is the tide that lifts all boats. It never goes away.

### Paid feed (subscription tiers)

Signal that makes your local brain smarter. The proprietary stream.

**What flows down from runcore.sh:**

| Signal type | What it is |
|-------------|-----------|
| Pattern intelligence | Anonymized, aggregated patterns from across the field. "Hosts like yours are seeing X." No individual data, no fingerprints — statistical signal only. |
| Curated models | Fine-tuned model weights, prompt templates, retrieval strategies optimized by runcore research. |
| Deep dictionary | Extended architectural specs, implementation guides, advanced patterns beyond the open source base. |
| Priority relay | Faster envelope delivery, higher TTL, priority queue at the relay. |
| Federation signal | Richer presence data from the field — not who, but the shape of activity across the network. |
| Early access | New capabilities before open source release. Time-limited exclusivity, always eventually open. |

**Where the signal comes from:**

The paid feed isn't runcore.sh being smart. It's the field being smart. The best users — the ones running the healthiest hosts, building the strongest patterns, solving the hardest problems — share their compost. Anonymized, aggregated, stripped of identity. What worked, what failed, what patterns emerged. runcore.sh composts it into signal that feeds back to everyone.

The field fertilizes itself. The richer the field, the richer the feed. Paid users get richer compost because they're contributing more back. The subscription isn't paying for runcore.sh's intelligence — it's paying for access to the collective intelligence of the field.

**What the signal is NOT:**

- Not other people's data (anonymized + aggregated, no individual reconstruction possible)
- Not access to your own brain (you already have that)
- Not a requirement for basic functionality (everything works without it)
- Not permanent lock-in (cancel and keep everything you've built)

## The mix — where the magic happens

The feed is raw signal. Your brain is private context. Neither is useful alone. The mix is the product.

```
┌─────────────────────────────────────┐
│          runcore.sh                  │
│                                     │
│  Public feed ──────┐                │
│  Paid feed ────────┤   (outbound    │
│                    │    only,       │
│                    │    one way)    │
└────────────────────┼────────────────┘
                     │
                     ▼
┌────────────────────────────────────┐
│          Your host (local)         │
│                                    │
│  Feed signal ──┐                   │
│                │                   │
│  Your memory ──┤                   │
│                ├──► LOCAL MIX ──► ● ● ●
│  Your goals ───┤     (private)     │
│                │                   │
│  Your context ─┘                   │
│                                    │
│  The mix never leaves this box.    │
│  runcore.sh never sees the mix.    │
│  The insight is yours.             │
└────────────────────────────────────┘
```

**Example mixes:**

| Feed signal | Your brain | Mixed insight |
|-------------|-----------|---------------|
| "Pattern: hosts running 3+ agents see memory write conflicts" | You run 4 agents | "Your agents may be stepping on each other. Here's where." |
| "New retrieval strategy improves recall by 30%" | Your 10k memory entries | Strategy applied locally, your recall improves. runcore.sh doesn't know you have 10k entries. |
| "Federation: 40% of field is quiet this week" | You have 3 active bonds | "Your bonds might be slow to respond — field-wide pattern, not personal." |
| "Security: new sensitive field pattern detected" | Your existing sensitive.yaml | Membrane auto-updates with new patterns. Your data never left to teach this lesson. |

## Tiers

### Free

- Public feed
- Relay (standard priority, 30-day envelope TTL)
- Registration (one host, unlimited nerves)
- Community support

### Personal

- Everything in Free
- Paid feed (full signal stream)
- Priority relay (faster delivery, 90-day TTL)
- Multiple hosts (phone + PC + Pi — same account)
- Curated model updates
- Email support

### Family / Small group

- Everything in Personal
- N hosts under one account (family members, each with own brain)
- Family-level aggregate signal (opt-in — each member chooses what to share up)
- Shared relay namespace
- Priority support

### Host (for those running services)

- Everything in Family
- Self-hosted relay federation (your relay peers with runcore.sh)
- Commercial agent spawning (Cora templates for clients)
- SLA on relay uptime
- API access to feed for custom integration
- Dedicated support

## Pricing principles

1. **Free tier must be complete.** A free user has a fully functional brain, agents, nerves, tunnels, and membrane. They are never degraded to push an upgrade.
2. **Paid tier is additive.** You're buying more signal, not unlocking locked features. Nothing that works today stops working if you cancel.
3. **Safety is never a tier.** Membrane, encryption, security patches, privacy — always free. Charging for safety is extortion.
4. **The feed earns its price.** If the mixed insight isn't obviously valuable within a week, the feed isn't good enough. Fix the feed, don't guilt the user.
5. **Annual discount.** Monthly available, annual cheaper. No multi-year lock-in. No contracts.
6. **Family pricing is real.** Not "5 accounts at full price." One price, everyone in the household. A parent paying for their family's digital sovereignty shouldn't need a spreadsheet.

## What runcore.sh runs

| Service | Purpose | Revenue |
|---------|---------|---------|
| Registry | Host registration, fingerprint directory | Free (cost of doing business) |
| Relay | Envelope routing between hosts | Free tier: standard. Paid: priority. |
| Feed | Public + paid signal streams | The product. This is what people pay for. |
| Dictionary | Architectural specs, patterns | Public: open source. Deep: paid tier. |
| Model hosting | Curated fine-tuned models for download | Paid tier. |
| Federation | Relay peering for self-hosted relays | Host tier. |

## What runcore.sh does NOT run

- **Your brain.** Ever. For anyone. At any tier.
- **Your agents.** They run on your host.
- **Your LLM inference.** Your keys, your compute. (Cloud LLM through membrane is the user's choice, not our infrastructure.)
- **Your mix.** The blended insight stays local. We send signal, you do the math.

## Data flow — what goes where

| Data | Direction | Who sees it |
|------|-----------|-------------|
| Feed signal | runcore.sh → your host | Your host only |
| Registration | your host → runcore.sh | runcore.sh (fingerprint, email, that's it) |
| Heartbeat | your host → runcore.sh | runcore.sh (alive/dead, pulse numbers, no content) |
| Envelopes | host A → relay → host B | Relay sees sealed envelopes. Cannot decrypt. |
| Brain content | nowhere | Never leaves your host. Period. |
| Mixed insight | nowhere | Computed locally. Never transmitted. |
| Anonymized patterns | runcore.sh computes from aggregate heartbeats | No individual host is identifiable |

## The test

A user at every tier should be able to answer these questions:

- **"What am I paying for?"** → The signal that makes your brain smarter.
- **"What happens if I cancel?"** → Your brain, agents, nerves, and tunnels keep working. You lose the forecast, not the thermometer.
- **"Can you see my data?"** → No. We send signal down. Nothing comes up except a heartbeat.
- **"Is the free tier real?"** → Yes. Full brain, full agents, full nerves, full encryption. No tricks.

## Open questions

1. **Heartbeat privacy** — The three pulse numbers (sense/work/joy) go to runcore.sh for aggregate computation. Is that too much? Should it be a single "alive" bit instead?
2. **Feed latency** — How fast does paid feed signal need to arrive? Real-time SSE? Hourly batch? Daily digest?
3. **Pattern computation** — How does runcore.sh compute aggregate patterns without seeing individual data? Differential privacy? Federated learning? Or just heartbeat statistics?
4. **Model distribution** — Curated models could be large. CDN? BitTorrent? Local relay cache?
5. **Family account mechanics** — How does a parent add a family member? Invite code? Bond + upgrade? Auto-detect same household?
6. **Churn signal** — If a paid user cancels, do they keep the curated models they already downloaded? Or do models phone home?
