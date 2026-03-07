# Privacy Policy as Membrane Spec

> Status: Approved (2026-03-07)
> Principle: The privacy policy describes what the membrane does. The membrane enforces what the privacy policy says. They are the same document in two languages. If they diverge, the architecture is wrong.

## What

The privacy policy is not a legal shield. It is the membrane specification written in plain language. Every claim in the policy must be architecturally enforced — not by process, not by promise, but by code. If the membrane can't enforce it, the policy can't claim it.

## Why

Every other platform writes privacy policies that describe aspirations, not architecture. "We take your privacy seriously" means nothing when the infrastructure allows engineers to query your data. Core's model is different: the membrane makes privacy violations structurally impossible, and the policy simply describes that structure.

## Done when

- Every claim in the privacy policy maps to a specific membrane behavior
- Every membrane behavior is described in the privacy policy
- A technical reader can audit the membrane against the policy and find zero gaps
- A non-technical reader can understand what the system does and doesn't do with their data
- The composting lifecycle is described in both documents identically

## The two documents

| Privacy Policy (for humans) | Membrane Spec (for machines) |
|---|---|
| "We cannot see your data" | E2E encryption, relay sees only sealed envelopes |
| "Your data stays on your device" | Brain is local, host has no read access |
| "You control what is shared" | Tunnel policy: explicit send/accept lists per bond |
| "We will never sell your data" | No data exfiltration path exists in architecture |
| "You can leave at any time" | Brain is local files, no server dependency |
| "Your identity will be treated with dignity" | Composting cycle, dehydration, custodian will |
| "Designated people inherit access" | Delegation tokens, scoped and time-limited |
| "We hold data for X period after inactivity" | Dehydration timer, ring tightening schedule |

## What the policy must cover

### Collection
- What runcore.sh knows: email, registration timestamp, bond fingerprints (opaque)
- What the relay sees: sealed envelopes (encrypted, unreadable), delivery timestamps
- What the host sees: its own brain only. Node brains are on node devices.
- What agents see: scoped by access manifest. Never full brain access unless role = personal.

### Boundaries
- Brain content never leaves the device unless explicitly pushed through a tunnel
- Tunnel content is E2E encrypted — relay cannot decrypt
- Host infrastructure cannot read node brains
- Running a relay grants zero access to instance content
- Cloud LLM calls go through the membrane — sensitive data replaced with typed placeholders before network egress

### Lifecycle
- Active: full service, all nerves connected
- Quiet: dehydration begins after configured silence period
- Dehydrating: rings tighten inward (public → community → secured → vault sealed)
- Composted: identity preserved, brain sealed, delegation token holders notified
- Tended: designated person inherits hosting responsibility, brain remains intact
- Released: after configured retention period with no tender, brain is cryptographically destroyed (keys deleted, encrypted data becomes unrecoverable)

### Departure
- Voluntary: take your brain (it's already on your device), revoke bonds, done
- Involuntary (deregistration by host): node disconnects, brain stays on device, node can register independently
- Death/incapacity: custodian will activates, delegation tokens execute, composting cycle begins

### What we will never do
- Read your brain content (architecturally impossible without your key)
- Sell, share, or monetize your data (no exfiltration path exists)
- Hold your data hostage (brain is local files you already possess)
- Delete your identity without the composting process (dignity is a term of service)
- Viking ship you (deplatform, archive, sunset, or degrade service based on inactivity or profitability)

## Enforcement

The privacy policy is auditable against the codebase. Every claim maps to a file:

| Claim | Enforced by |
|---|---|
| Data stays on device | `brain/` is local filesystem, never synced to host |
| E2E encryption | `src/auth/crypto.ts`, `src/lib/encryption.ts` |
| Tunnel scoping | `brain/bonds/<fingerprint>/tunnel.yaml` |
| Membrane redaction | `src/llm/membrane.ts`, `src/llm/sensitive-registry.ts` |
| Relay is blind | Relay stores `{to, from, payload, sig}` — payload is encrypted |
| Composting cycle | Dehydration model in nerve/state, delegation in voucher system |
| Lineage enforcement | Registration → email → host → agents/nodes chain |

## The test

If someone reads the privacy policy and then reads the codebase, they should find the same system described twice. If they find a gap — a policy claim without architectural enforcement, or a capability without policy disclosure — that's a bug. Not a legal risk. A bug.

## Front and center

This is not buried in legal. The composting commitment, the dignity guarantee, the "we will never viking ship you" promise — these go on the homepage. Above the fold. Before features. Before pricing.

"We will compost your digital identity with dignity. Here's exactly how."

Then link to the policy. Which links to the code. Which enforces the policy. Full circle.
