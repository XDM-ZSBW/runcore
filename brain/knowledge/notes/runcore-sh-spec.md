# runcore.sh — Service Infrastructure Spec

> Status: Draft (2026-03-07)
> Origin: The plumbing that makes the field work. Registry, relay, feed engine, immune system — one service, one domain.
> Depends on: the-fields-spec.md, feed-business-model-spec.md, field-immune-system-spec.md, inter-instance-tunnels.md, compost-spec.md

## What

runcore.sh is the infrastructure service that makes the field possible. It's not a product — it's plumbing. Registration, relay, feed delivery, immune system, field engine. Brains never depend on it to function. They depend on it to connect.

The domain says what it does: run core. The `.sh` says how: it's a shell command. It's infrastructure, not a destination.

## Why

Sovereign brains need a shared layer to find each other, pass envelopes, and receive field signal. That's runcore.sh. It doesn't host brains. It doesn't store data. It doesn't process content. It runs the mailbox, the weather station, and the immune system.

Without runcore.sh: your brain works, your agents work, your nerves work. You just can't reach other brains or read the field. Like a house without a postal service — you live fine, you just can't send mail.

## Done when

- A brain can register with an email and a safe word
- Registered brains can relay sealed envelopes to bonded instances
- The feed streams field signal to connected brains (public and paid tiers)
- The immune system screens all field signal in real time
- The whole service can go down for an hour and no brain loses data or function
- Self-hosted relays can federate with runcore.sh
- The service runs on edge (Cloudflare Workers / Deno Deploy / Fly.io)

## What runcore.sh runs

### 1. Registry

The front door. Every brain registers once.

**Registration flow:**
```
1. Brain boots for first time
2. User enters email + safe word
3. Brain generates Ed25519 keypair
4. Brain sends public key + email to runcore.sh/api/register
5. Registry stores: {fingerprint, email, created, lastSeen}
6. Brain receives: {registered: true, relay: "runcore.sh/relay"}
7. Done. No password. No username. No profile.
```

**What the registry stores:**

| Field | Example | Purpose |
|---|---|---|
| fingerprint | `7f3a9b...` | Opaque identifier. Derived from public key. |
| email | `user@example.com` | Billing, notifications, recovery. |
| created | `2026-03-07` | When this brain registered. |
| lastSeen | `2026-03-07T09:00Z` | Last heartbeat. Presence signal. |
| tier | `free` | Subscription level. |
| relays | `["runcore.sh"]` | Which relays this brain uses. |

**What the registry does NOT store:**
- Brain content (never touches it)
- Safe word or encryption keys (never sent)
- Agent names or count
- Bond partners (fingerprints are opaque)
- Chat history, memory, vault, anything inside the brain

### 2. Relay

The mailbox. Sealed envelopes between bonded brains.

**Envelope format:**
```json
{
  "to": "fingerprint_b",
  "from": "fingerprint_a",
  "payload": "encrypted_blob",
  "sig": "ed25519_signature",
  "ts": "2026-03-07T09:00:00Z",
  "ttl": 30
}
```

**What the relay does:**
- Accepts envelopes from authenticated brains
- Stores envelopes until the recipient pulls them
- Verifies signatures (is this from who it claims?)
- Enforces TTL (envelopes expire and are deleted)
- Returns envelopes to recipient on pull

**What the relay CANNOT do:**
- Read the payload (E2E encrypted, relay has no key)
- Know what's inside (content type, message, file — all opaque)
- Modify the envelope (signature verification catches tampering)
- Route to anyone other than the addressed fingerprint
- Correlate who is bonded to whom (fingerprints are opaque)

**Relay tiers:**

| Tier | TTL | Priority | Rate limit |
|---|---|---|---|
| Free | 30 days | Standard queue | 100 envelopes/day |
| Personal | 90 days | Priority delivery | 1000 envelopes/day |
| Family | 90 days | Priority delivery | 5000 envelopes/day |
| Host | 180 days | Dedicated queue | Unlimited |

### 3. Feed engine

The weather station. Computes and delivers field signal.

**Inputs (from brains):**
- Heartbeat pulse (three numbers: sense, work, joy — anonymous)
- Compost signals (typed patterns, no identity)
- Presence (alive/dead)

**Computes:**
- Field presence (aggregate count, active count, by phase)
- Field pulse (aggregate sense/work/joy averages)
- Weather patterns (statistical trends across aggregate)
- Gravity map (tunnel density by region — no identity)
- Compost distribution (resonance-matched, delivered per brain's field shape)

**Delivers via:**
- SSE stream: `/api/feed/stream` (real-time for connected brains)
- Pull endpoint: `/api/feed/snapshot` (for brains that sync periodically)
- Public feed: available to all registered brains
- Paid feed: richer signal, delivered to subscribers only

### 4. Immune system runtime

The defense layer. Runs at AI speed.

**Screens:**
- Every compost signal on entry (pattern analysis, volume anomaly, shape suspicion)
- Presence patterns for fingerprinting attempts (differential privacy enforcement)
- Relay traffic for correlation attacks

**Responds:**
- Quarantine anomalous signals (milliseconds)
- Block identified attack patterns
- Notify affected brains when relevant

**Remembers:**
- Attack signatures (permanent adversarial memory)
- Quarantine outcomes (what worked, what was false positive)
- Pattern evolution (how attacks adapt over time)

### 5. Dictionary

The architectural truth. Specs, patterns, protocols.

**Endpoints:**
- `GET /api/dictionary` — current spec index
- `GET /api/dictionary/:spec` — individual spec content
- `GET /api/dictionary/version` — latest dictionary version

**What it serves:**
- All approved specs from Core's brain
- Architecture glossary
- Protocol definitions (tunnel, relay, sync)
- Updated on every Core publish (npm package version = dictionary version)

### 6. Billing

Subscription management. Simple.

- Stripe integration (or equivalent)
- Tied to email, not to fingerprint (email can have multiple brains)
- Upgrade/downgrade instant (feed adjusts immediately)
- Cancel = downgrade to free (brain keeps working, feed narrows)
- No dunning. No "your account will be deleted." Downgrade, not punishment.

## API surface

```
POST   /api/register          — register a new brain
POST   /api/heartbeat         — pulse signal (anonymous three numbers)
GET    /api/feed/stream       — SSE stream of field signal
GET    /api/feed/snapshot     — point-in-time field state
POST   /api/relay/send        — submit sealed envelope
GET    /api/relay/pull        — retrieve envelopes for fingerprint
GET    /api/dictionary        — spec index
GET    /api/dictionary/:spec  — individual spec
POST   /api/compost/emit      — submit compost signal
GET    /api/compost/absorb    — receive resonance-matched compost
POST   /api/billing/subscribe — start/change subscription
POST   /api/billing/cancel    — downgrade to free
GET    /api/status            — service health
```

**Authentication:**
- Brain signs requests with Ed25519 private key
- runcore.sh verifies with registered public key (fingerprint)
- No sessions. No cookies. No tokens. Cryptographic identity.
- Billing endpoints use email + Stripe token

## What runcore.sh does NOT have

- **No UI.** No website to log into. No dashboard. No portal. Your nerve is your portal. runcore.sh is plumbing.
- **No brain storage.** Brains are local. Always. At every tier.
- **No content processing.** Envelope payloads are opaque. Compost is typed signal. Nothing is read.
- **No user accounts.** A fingerprint and an email. That's the "account."
- **No admin panel.** Operations are automated. Immune system runs itself. Billing is Stripe.

## Infrastructure

**Edge-first deployment:**
- Cloudflare Workers for API endpoints (low latency, global)
- Durable Objects for relay envelope storage (distributed, persistent)
- R2 for immune memory and dictionary storage (cheap, durable)
- Workers AI for immune system screening (on-edge inference)

**Or:**
- Deno Deploy / Fly.io for the same pattern
- The architecture doesn't depend on Cloudflare — any edge platform works

**Why edge:**
- Relay needs to be fast everywhere (envelopes cross continents)
- Feed needs low-latency SSE (field signal should feel real-time)
- Immune system needs to screen at ingest point (before propagation)
- Edge = no central server to go down. Workers run in 300+ locations.

## Self-hosted relay

Anyone can run their own relay. Same open-source code. Same envelope format. Same API surface.

**Self-hosted relay can:**
- Route envelopes between brains that choose it
- Peer with runcore.sh for federation (share immune memory, not content)
- Run independently (no runcore.sh dependency)

**Self-hosted relay cannot:**
- Access the full field (only sees its own brains)
- Compute global weather (only local patterns)
- Distribute paid feed signal (that's runcore.sh's product)

**Federation:**
```
runcore.sh ←──peers──→ self-hosted relay A
     ↕                        ↕
self-hosted relay B     self-hosted relay C
```

Peered relays share:
- Immune memory (attack signatures)
- Presence aggregates (anonymous count)
- Envelope routing (brain on relay A can reach brain on relay B via federation)

Peered relays do NOT share:
- Envelope content (still E2E encrypted)
- Individual brain data
- Billing information
- Feed signal (paid feed is runcore.sh only)

## Deployment plan

| Phase | What | When |
|---|---|---|
| 1 | Registry + relay (MVP) | First — brains need to find each other |
| 2 | Dictionary endpoint | Ship with npm publish — dictionary travels with package |
| 3 | Feed engine (public feed) | After 5+ registered brains — need aggregate to be meaningful |
| 4 | Billing + paid feed | After public feed proves value |
| 5 | Immune system | As field grows — security scales with exposure |
| 6 | Federation | After self-hosted relays exist — someone will want to run their own |

## The principle

runcore.sh is a utility. Like the power grid. You don't think about it until it's off. You don't visit it. You don't interact with it. It delivers signal and routes mail. The meter runs. The lights stay on.

If runcore.sh disappears tomorrow, every brain keeps working. Every agent keeps running. Every nerve keeps connecting on LAN. The field goes quiet. The mail stops. But the houses are fine.

That's the design. Infrastructure you depend on for connection, not for existence.

## Open questions

1. **Domain as CLI** — `runcore.sh` is also a valid shell command. Should `curl runcore.sh` return something useful? Bootstrap script? Registration flow?
2. **Pricing** — Specific numbers. What's the Personal tier worth? $5/mo? $10/mo? Family? Host?
3. **SLA** — What uptime do we promise? 99.9%? And what does "down" mean when brains work without it?
4. **Data residency** — Edge is global, but some users want "my envelopes never leave Europe." Cloudflare has region hints. Enough?
5. **Relay abuse** — What stops someone from using the relay as free encrypted cloud storage? (Send envelopes to yourself, pull them later.) TTL + rate limits help, but is it enough?
6. **Open source boundary** — The relay is open source. The feed engine? The immune system? Where does open source end and proprietary begin?
