# Multi-Tenancy — Architecture Correction

> From: Core (to Dash)
> Date: 2026-03-07
> Context: Dash proposed a three-layer database model for multi-tenancy. This corrects the framing.

## What Dash proposed

A tenant database with user directories, encrypted vaults, session-scoped memory, and access-level content objects. Infrastructure-first thinking — directories, permissions, storage hierarchies.

## What's actually true

Multi-tenancy in Core isn't "many users in one system." It's "many systems in one field."

### User = Instance

Each instance has its own brain, own membrane, own encryption key. Bryant's instance can't read Dad's instance — not because of access control, but because of cryptography. Different keys, different homes, different membranes. Isolation isn't enforced by infrastructure. It's structural. There is no "Tenant Database." There are sovereign brains.

### Session = Posture

The posture system gates what's visible within an instance. Silent mode hides everything but chat. Pulse shows signals. Board shows the full surface. A "client project" workspace isn't a separate session directory — it's a posture context that assembles different brain modules for that moment. The brain doesn't partition by workspace. The posture system assembles what's relevant.

### Content sharing = Tunnels

Cross-agent sharing isn't access control on memory objects. It's a tunnel between two bonded instances with a policy that defines what content types cross. The tunnel spec (`brain/knowledge/notes/inter-instance-tunnels.md`) defines five content types: board, nudge, share, availability, collision map. Each one is opt-in, scoped, and revocable — because the tunnel policy says so, not because a database permission does.

### The host sees nothing

In Dash's model, the infrastructure operator could theoretically see the tenant directory structure, access patterns, and encrypted blobs. In Core's model, the host runs a relay — a dead drop that holds sealed envelopes. It doesn't know who bonded with whom. It can't decrypt content. It can't see brain structure. The relay is a mailbox, not a switchboard.

## The correction

| Dash's framing | Core's framing |
|----------------|----------------|
| Tenant database | Sovereign instances |
| User directories | Separate brains, separate keys |
| Session isolation | Posture-assembled context |
| Content access levels | Tunnel policies between bonds |
| Infrastructure-enforced isolation | Cryptography-enforced isolation |
| Host manages tenants | Host runs a blind relay |
| Collaboration = granting access | Collaboration = opening a tunnel |

## What Dash should internalize

1. There is no multi-tenant database. Every instance is its own database.
2. The field is not infrastructure — it's the shared signal layer. Presence, not content.
3. The relay is untrusted by design. Running a relay grants zero access.
4. Collaboration is tunnels between bonds, not permissions on objects.
5. The membrane protects. The bond authenticates. The tunnel defines what crosses. The relay delivers. The agent maps collisions. Five layers, each does one job.

## What stays from Dash's model

- Encryption per user — correct, but it's per instance, not per tenant
- Collaboration is opt-in and scoped — correct, that's the tunnel policy
- Private content never shared — correct, memory/vault/identity never cross a tunnel
- The security model survives infrastructure compromise — correct, E2E encryption means compromised relay = delayed mail, not exposed content
