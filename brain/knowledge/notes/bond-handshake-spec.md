# Bond Handshake — Spec

> Status: Draft (2026-03-07)
> Origin: "Two instances bond (Ed25519 exchange) — that's the trust."
> Depends on: inter-instance-tunnels.md, privacy-as-membrane-spec.md, runcore-sh-spec.md, dehydration-cycle-spec.md

## What

The bond handshake is how two brains establish trust. Not a friend request. Not a follow. A cryptographic handshake that creates a permanent, bilateral, revocable bond. Once bonded, two brains can open tunnels, relay envelopes, detect presence, and map collisions. Before the bond, they're strangers — invisible to each other.

## Why

Every other system uses a server to broker relationships. Follow someone on Twitter — Twitter mediates. Add a friend on Facebook — Facebook stores the relationship. Connect on LinkedIn — LinkedIn owns the graph.

Core doesn't have a social graph server. The bond is peer-to-peer. Two brains exchange keys, agree on a relay, and they're bonded. No server approved it. No server can revoke it. The bond lives in both brains, verified by cryptography, not by a platform.

The handshake must be simple enough that a parent can do it with their kid across the dinner table. And secure enough that a stranger can't bond with you without your knowledge.

## Done when

- Two brains can bond using a short code exchanged out-of-band (spoken, texted, shown on screen)
- The bond creates mutual Ed25519 key exchange — both sides hold each other's public key
- A bonded pair can open tunnels, relay envelopes, and detect mutual presence
- Either side can revoke the bond at any time — instant, unilateral, no negotiation
- A revoked bond is cryptographically dead — the revoking brain deletes the peer's key
- The handshake works on LAN (instant) and over relay (async)
- No server is required to establish or maintain a bond
- A parent can bond with their kid in under 60 seconds

## The ceremony

### Step 1: Initiate

Brain A's human says: "Bond with someone." The agent generates a bond code — 6 words from a shared word list.

```
Bond code: amber-castle-seven-river-oak-noon
```

The code is temporary (expires in 10 minutes). It encodes:
- Brain A's fingerprint (derived from Ed25519 public key)
- A one-time challenge nonce
- The relay Brain A prefers (default: runcore.sh)

The code is designed to be spoken aloud, texted, or shown on screen. Six words. No URLs. No QR codes required (though a QR option is fine as sugar).

### Step 2: Accept

Brain B's human enters the bond code. Their agent:
1. Decodes the fingerprint, nonce, and relay preference
2. Generates its own Ed25519 keypair (if first bond) or reuses existing
3. Creates a bond envelope: `{from: fingerprint_b, pubkey: B_public, nonce_response: signed(nonce, B_private)}`
4. Sends the envelope to Brain A via the specified relay

### Step 3: Confirm

Brain A receives the envelope:
1. Verifies the nonce response (proves Brain B has the code, not a replay)
2. Stores Brain B's public key: `brain/bonds/<fingerprint_b>/pubkey.pem`
3. Creates its own bond envelope: `{from: fingerprint_a, pubkey: A_public, confirmed: true}`
4. Sends confirmation back to Brain B via relay
5. Prompts the human: "Bonded with [name]. What should the tunnel carry?"

Brain B receives confirmation:
1. Stores Brain A's public key: `brain/bonds/<fingerprint_a>/pubkey.pem`
2. Bond is live

### Step 4: Tunnel negotiation

Immediately after bonding, both sides exchange tunnel policies (what content types to send/accept). This is the first thing that rides the new bond. See tunnel spec.

```
Total time: under 60 seconds if both humans are present
Total time: minutes to hours if async (code texted, accepted later)
```

## Bond code design

Six words from a 60-word list = ~35 bits of entropy. Not meant to resist brute force — meant to resist accidental collision. The code expires in 10 minutes. Rate limiting on the relay prevents enumeration.

**Why words, not numbers:**
- "amber-castle-seven" is speakable. "7f3a9b2c" is not.
- Parents read it across the table. Kids type it on their phone.
- Words survive autocorrect better than hex strings.

**Why 6 words:**
- 4 is too short (collision risk in busy environments)
- 8 is too long (human patience threshold)
- 6 is the sweet spot — 35 bits, ~34 billion combinations, expires quickly

**Word list requirements:**
- 60 common English words, all distinct first-two-letters (no amber/amble confusion)
- No homophones (no there/their, no to/too/two)
- All single-syllable or two-syllable (speakable fast)
- No offensive words, no words with dual meanings that create awkwardness

## LAN bonding (instant path)

When both brains are on the same network, the bond can skip the relay entirely:

1. Brain A broadcasts bond intent via mDNS: `_core-bond._tcp`
2. Brain B discovers it, shows the human: "Brain A wants to bond. Accept?"
3. Key exchange happens directly over LAN — no relay, no internet required
4. Bond code still required (prevents rogue devices on shared WiFi from bonding)

LAN bonding is instant — both sides confirm in real time. The bond code is still spoken/shown (security), but the relay round-trip is eliminated.

## Relay bonding (async path)

When brains are on different networks:

```
Brain A                    Relay (runcore.sh)           Brain B
  |                              |                         |
  |-- bond envelope (B's fp) --> |                         |
  |                              |-- stored, waiting -->   |
  |                              |                         |
  |                              |     <-- pull envelopes --|
  |                              |-- deliver A's envelope ->|
  |                              |                         |
  |                              |<-- bond response -------|
  |<-- deliver B's envelope -----|                         |
  |                              |                         |
  |-- confirmation envelope ---> |                         |
  |                              |-- deliver confirmation ->|
  |                              |                         |
  Bond live                                          Bond live
```

Three round-trips through the relay. Each envelope is signed and the nonce prevents replay. The relay sees fingerprints and encrypted blobs — it can't read the bond negotiation.

## What the bond stores

Each brain stores bond data locally:

```
brain/bonds/<fingerprint>/
  pubkey.pem          # The peer's Ed25519 public key
  bond.yaml           # Bond metadata
  tunnel.yaml         # Tunnel policy (content types, scope)
  board.jsonl         # Received board items from this peer
  collisions.yaml     # Latest collision map
```

**bond.yaml:**
```yaml
fingerprint: "7f3a9b..."
name: "Dad"                    # Human-assigned label (not the peer's identity)
bonded_at: "2026-03-07T09:00:00Z"
relay: "runcore.sh"
status: active                 # active | muted | revoked
last_seen: "2026-03-07T09:30:00Z"
trust_level: full              # full | limited (future: scoped trust)
```

The `name` field is what the human calls this bond — not what the other brain calls itself. Dad's brain might be named "Cora." You call the bond "Dad." The label is yours.

## Revocation

Either side can revoke a bond instantly. No negotiation. No confirmation from the other side.

**When you revoke:**
1. Peer's public key is deleted from `brain/bonds/<fingerprint>/`
2. Tunnel policy is deleted
3. All pending outbound envelopes to this fingerprint are destroyed
4. Relay is notified: "stop delivering envelopes to me from this fingerprint"
5. Bond status set to `revoked` (the record stays — the key doesn't)
6. Inbound envelopes from this fingerprint are silently dropped

**What the other side sees:**
- Their envelopes stop being pulled (they sit at the relay until TTL expires)
- Presence detection shows you as "gone" (same as dehydration — intentionally ambiguous)
- No notification. No "X has unfriended you." You just go quiet.

**Why no notification:** Revocation might be a safety decision. An abusive partner. A stalker. The system doesn't announce that you've cut someone off. You just disappear from their view, same as if you dehydrated. They can't distinguish revocation from silence.

**Re-bonding after revocation:** Possible, but requires a fresh handshake. The old keys are gone. Start from Step 1. This is intentional — revocation is a clean break, not a pause.

## Mutual presence

Bonded brains can detect each other's presence without revealing location, IP, or activity:

- Each brain periodically sends a heartbeat to the relay: `{fingerprint, alive: true, ts}`
- Bonded brains can query the relay: "Is fingerprint X alive?"
- The relay returns: yes/no and last heartbeat timestamp
- No location. No IP. No "currently active." Just alive or not.

Presence feeds into:
- Board item surfacing (show mutual items when both are present)
- Tunnel traffic (hold envelopes vs deliver immediately)
- Collision detection (run collision analysis when both sides are active)
- Dehydration detection (bonded brain goes quiet — is it dehydrating?)

## Bond types (future)

v1 has one bond type: full bilateral. Both sides hold each other's keys. Both can send and receive. Symmetric.

Future bond types to consider:

| Type | Use case |
|------|----------|
| **Bilateral** (v1) | Two humans, mutual trust. Family, friends, collaborators. |
| **Custodial** | Parent-child. One side has elevated tunnel scope. Child can't revoke until age threshold. |
| **Guest** | Temporary bond. Auto-expires after N days or N interactions. No key storage — session-only. |
| **Service** | Brain-to-service bond. One side is a provider (field feed, hosted relay). Asymmetric trust. |
| **Community** | N-party bond. Shared relay, shared board, group collision detection. Same keys, more envelopes. |

v1 ships with bilateral only. The others are architectural slots, not commitments.

## Security properties

**What the bond guarantees:**
- Authenticity: every envelope is signed. You know it's from who it claims.
- Confidentiality: every payload is encrypted with the peer's public key. Only they can read it.
- Integrity: signatures catch any tampering in transit.
- Forward secrecy: if a key is compromised, only future messages are at risk. Past envelopes (already deleted from relay) are unrecoverable.

**What the bond does NOT guarantee:**
- Availability: the relay can go down. Envelopes wait or expire.
- Ordering: envelopes may arrive out of order. Each is independent.
- Delivery confirmation: you know it was sent and signed. You don't know it was read.

**Attack surface:**
- Bond code interception: attacker who overhears the 6 words can race to bond first. Mitigation: 10-minute expiry, human confirms the name after bonding ("Is this Dad?"), rate limiting on relay.
- Relay compromise: attacker controls the relay. Can delay/drop envelopes but can't read them. Can't forge signatures. Mitigation: switch relays, self-host.
- Key compromise: attacker gets a brain's private key. Can impersonate that brain. Mitigation: keys are local-only, never transit the relay, safe word protects the brain at rest.

## The principle

A bond is a handshake, not a contract. Two brains reach out, exchange keys, and agree to communicate. Either can walk away at any time. No platform mediates. No algorithm curates. No server owns the graph.

The bond is the smallest unit of trust in the system. Everything else — tunnels, relay, field participation, collision detection — builds on top of it. Get the handshake right and everything above it inherits the trust.

## Open questions

1. **Group bonding** — Can 3+ brains bond simultaneously, or is it always pairwise? Family dinner: Mom, Dad, two kids. Four pairwise bonds, or one group bond?
2. **Bond migration** — If a brain moves to a new device (new keys), how does it re-establish existing bonds? Recovery key? Custodian transfer?
3. **Bond visibility** — Should bonded brains see each other's agent names? Or just the human-assigned label? "Dad's brain has 3 agents" — is that visible?
4. **Bond health** — Should the bond itself have a health signal? "This bond is active/cooling/dormant" based on traffic patterns?
5. **Cross-platform bonds** — Can a Core brain bond with a non-Core system? What's the minimum interface? Just Ed25519 + envelope format?
6. **Bond ceremony UX** — Should bonding feel special? A moment? Or is it utilitarian like pairing Bluetooth? The answer affects adoption.
