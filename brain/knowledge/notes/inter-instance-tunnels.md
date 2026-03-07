# Inter-Instance Tunnels — Spec

> Status: Approved (2026-03-07)
> Decided: Default relay at runcore.sh, self-hosted optional, relay is untrusted by design.

## What

Encrypted communication channels between two bonded Core instances across trust boundaries. Each instance lives inside its own membrane. The tunnel is a negotiated opening in both membranes that allows specific content types to pass.

## Why

Sovereign brains need to collaborate without merging. Different homes, different networks, different communities. The tunnel defines what can cross and what can't.

## Done when

- Two bonded instances can establish a tunnel
- Each side declares what content types it will send and accept
- Content is end-to-end encrypted (relay sees nothing)
- Either side can close the tunnel or narrow its scope at any time
- Works across homes, networks, ISPs — no shared LAN required

## The tunnel is NOT a VPN

A VPN merges networks. A tunnel connects two membranes with a contract.

## Anatomy

```
Your membrane                    Dad's membrane
     |                                |
     |── tunnel policy ──────────────|
     |   send: [board, nudge]        |
     |   accept: [board, nudge]      |
     |   deny: [memory, vault, *]    |
     |                                |
     |── relay (dead drop) ──────────|
     |   runcore.sh/relay            |
     |   envelope: encrypted         |
     |   TTL: 30 days                |
     |                                |
```

## Content types (start small)

- `board` — whiteboard items (questions, ideas, pins)
- `nudge` — "thinking of you," "call me," "check this" — zero-content signals
- `share` — a specific file or note, explicitly pushed, one-time
- `availability` — calendar windows, not calendar content

## What never crosses

- Memory (experiences, decisions, failures)
- Vault (keys, credentials)
- Identity (safe word, manifests)
- Anything not explicitly in the tunnel policy

## Relay — Decided

**Default relay:** `runcore.sh/relay` — we run it, we defend it globally. Everyone gets it with registration.

**Self-hosted relay:** Anyone can run one. Same open-source code. Running a relay gives you the ability to pass envelopes between instances that choose your relay. Nothing else.

**Running a relay does NOT give you:**

- Access to any instance behind it
- Decryption of any envelope passing through
- Knowledge of who is bonded to whom (fingerprints are opaque)
- Field presence data of connected instances
- Any path to host resources, brain content, or related nodes

**The relay is a mailbox, not a switchboard.** It holds sealed letters until picked up. It doesn't know what's inside, who wrote them, or what network they came from. It can't open them. It can't forward them to anyone other than the addressed fingerprint.

### Trust model

- Two instances bond (Ed25519 exchange) — that's the trust
- They agree on a relay — that's the delivery mechanism
- The relay is untrusted by design — envelopes are E2E encrypted before they touch it
- Switching relays doesn't break the bond, just changes the mailbox
- An instance can use multiple relays (one per bond if paranoid)
- Worst case if relay is compromised: envelopes delayed or lost. Never decrypted. Never routed wrong.

## Architecture

- Tunnel policy stored locally: `brain/bonds/<fingerprint>/tunnel.yaml`
- Both sides must agree — your send list must match their accept list
- Bond handshake (existing Ed25519) authenticates both ends
- Envelope format: `{to: fingerprint, from: fingerprint, payload: encrypted, sig: ed25519}`
- Each content type has its own handler:
  - Board items → `brain/bonds/<fingerprint>/board.jsonl`
  - Nudges → nerve signal
  - Shares → `knowledge/shared/`
  - Availability → calendar overlay

## Collaboration tools that ride the tunnel

1. **Board** — async pins, surface on mutual presence
2. **Nudge** — lightweight signal, no content
3. **Share** — push a note/article/photo through the tunnel
4. **Availability** — "I'm free Thursday" without exposing calendar
5. **Collision map** — agent-generated analysis of board tensions (see below)
6. **Future:** shared projects, co-authored content, delegated tasks — each is a new content type added to tunnel policy

## Agent collision detection

> Decided 2026-03-07. Origin: Dash identified the pattern — agents pre-process
> human tension so meeting time is spent on choices, not discovering what the choices are.

### What

Agents on both sides of a tunnel read the board. When both sides have pinned items, each agent scans for collisions — conflicts, dependencies, gaps, timing issues. The analysis is presented to both humans before they meet. Agents map the terrain. Humans make the choices.

### Why

Two people pin items independently. They don't see each other's pins until presence triggers surfacing. By then they're already in conversation, discovering conflicts in real time, burning human time on structural analysis that an agent could have done overnight.

### Collision types

- **Conflict** — your item contradicts their item. "Person A wants to cut budget, Person B wants to expand team." Agent presents the tension and 2-3 sequencing options.
- **Dependency** — this item can't be discussed without that item first. Agent suggests an order.
- **Gap** — this decision requires input from someone not in the conversation. Agent flags: "proceed with partial info or postpone?"
- **Timing** — based on history or complexity, this topic needs more time than the conversation window allows. Agent flags priority.

### How it works

1. Both agents independently read their side's board items addressed to the other's fingerprint
2. Each agent also reads incoming items from the tunnel (what the other side pinned)
3. Agent runs collision analysis locally — no content leaves the membrane for this step
4. Collision map is a new content type (`collision`) that rides the tunnel
5. Both agents exchange collision maps so both humans see the same structural analysis
6. On mutual presence, the board surfaces with collision annotations inline

### What agents do NOT do

- Resolve tensions — they map them
- Choose for humans — they present options
- Negotiate between themselves — each agent analyzes independently, then shares the analysis
- Access anything beyond the board — collision detection reads only pinned items, not memory/vault/identity

### Collision map format

```yaml
collisions:
  - type: conflict
    items: [pin_id_a, pin_id_b]
    summary: "Budget reduction vs team expansion — direct resource conflict"
    options:
      - "Discuss budget first, scope expansion within remaining budget"
      - "Discuss expansion first, then find budget to support it"
      - "Defer both — need Q3 projections before either decision"
  - type: gap
    items: [pin_id_c]
    summary: "This decision requires Sarah's input — she's not in this conversation"
    options:
      - "Postpone until Sarah is available"
      - "Proceed with partial info, flag for Sarah's review"
  - type: timing
    items: [pin_id_d, pin_id_e]
    summary: "These two topics typically need 30 minutes — only 15 available"
    options:
      - "Pick one, defer the other"
      - "Timeblock both at 15 min each, accept shallower discussion"
```

### Architecture fit

- Collision analysis runs locally inside each membrane — no content leaks
- The `collision` content type is added to tunnel policy alongside `board`
- Collision maps are regenerated when board items change — not on a timer
- Agents annotate the board, they don't create a separate artifact. The board IS the meeting prep.

## Open questions

1. Tunnel negotiation — one-time during bonding, or can either side propose new content types later?
2. Community tunnels — same pattern scaled to N people, or different primitive?
3. Envelope TTL — 7 days? 30? Until pulled?
4. Collision depth — should agents suggest resolutions (opinionated) or only map tensions (neutral)?
5. Multi-party collisions — when 3+ instances share a board, does each pair get its own collision map or is there one aggregate?

## Layers

The membrane protects. The bond authenticates. The tunnel defines what crosses. The relay delivers. The agent maps collisions. Each layer does one job. Collaboration is the sum of all five.
