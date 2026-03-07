# Vault & Ledger — Spec

> Status: Draft (2026-03-07)
> Origin: "Vault is a property, not a container. Ledger is addresses, not masks."
> Depends on: membrane-translation-spec.md, bond-handshake-spec.md, dehydration-cycle-spec.md, core-os-spec.md

## What

Two primitives that govern what's inside and who's outside.

**Vault** is a property — a flag on any piece of data that says "this is secured." Not a folder. Not a container. A property that any brain file can have. Vault means: encrypted at rest, accessible only with the safe word, last to dehydrate, first to seal.

**Ledger** is the directory — an immutable record of every entity the brain has ever interacted with. Not a contact list. Not a social graph. An append-only log of addresses. Fingerprints, names, bond status, last interaction. The ledger is how the brain knows who exists.

## Why

### Vault

Every other system has a "secure folder." Put sensitive things in it. The problem: you decide at storage time what's sensitive. But sensitivity changes. A draft becomes a contract. A note becomes evidence. A photo becomes private. Moving things in and out of a secure folder is a constant tax on attention.

Vault is a property, not a place. Tag anything as vault-secured at any time. The data stays where it is — in memory, in knowledge, in content. The vault property wraps it in encryption. No reorganization. No moving files. Just: "this is sensitive now."

### Ledger

Every other system has a contact list that you curate. Add people, remove people, organize into groups. The problem: deletion is a lie. You didn't unfriend that person — you hid them. The data still exists somewhere.

The ledger is honest. It's append-only. Once an entity appears, it stays. You can change the status (active → revoked → quiet), but you can't delete the record. The ledger is the truth about who has ever existed in your world. Deletion would be rewriting history.

## Done when

### Vault
- Any brain file or field can be tagged `vault: true`
- Vault-tagged items are encrypted at rest using a key derived from the safe word
- Vault items are only decrypted in memory when the human has authenticated
- Vault is the last thing to seal during dehydration
- Vault items never cross the membrane (not even in compost, not even anonymized)
- A human can vault/unvault anything at any time with a single action

### Ledger
- Every entity interaction creates a ledger entry
- Ledger is append-only — entries are never deleted
- Status changes are new entries, not mutations
- The ledger measures relationship distance (time since last interaction)
- Bond information is derived from the ledger (who's bonded, who's drifted)
- The ledger feeds the sense phase of the tick cycle

## Vault

### Three tiers

Not everything needs the same security. Vault has three tiers that determine access during normal operation:

| Tier | Access | Example | Encryption |
|------|--------|---------|------------|
| **Open** | Available to all agents, visible in stream | Chat history, board items, general notes | At-rest encryption (standard) |
| **Community** | Available to bonded instances via tunnel | Shared projects, availability, nudges | At-rest + tunnel encryption |
| **Secured** | Available only to the human + Founder agent | Credentials, health data, financial records, personal journals | At-rest + safe-word-derived key |

The default tier is **open**. Tagging something `vault: true` sets it to **secured**. Tagging `vault: community` sets it to the middle tier.

### Vault as property

```yaml
# Any brain file can have vault metadata
# brain/memory/semantic.jsonl entry:
{
  "id": "sem_7f3a",
  "type": "semantic",
  "content": "My social security number is...",
  "meta": {
    "vault": "secured",
    "vaulted_at": "2026-03-07T09:00:00Z",
    "vaulted_by": "human"
  }
}

# brain/knowledge/notes/tax-strategy.md frontmatter:
---
vault: community
vaulted_at: 2026-03-07
---
```

The vault property travels with the data. Move the file, copy it, reference it — the vault tag stays. The membrane checks the vault property on every emission. Secured items never cross. Community items cross only to bonded instances. Open items cross freely.

### Vault operations

| Operation | What happens |
|-----------|-------------|
| **vault(item, tier)** | Tag item with vault property. If securing: encrypt with safe-word-derived key. |
| **unvault(item)** | Remove vault property. Decrypt if secured. Item becomes open. |
| **vault-check(item)** | Return current vault tier. Used by membrane before emission. |
| **vault-seal()** | Encrypt all vault items, remove keys from memory. Happens during composting. |
| **vault-unseal(safe_word)** | Derive key from safe word, decrypt vault items into memory. Happens on auth. |

### Vault and dehydration

During dehydration, vault tiers seal in order — open first, secured last:

```
Active:      All tiers accessible
Stage 1:     Open tier still accessible
Stage 2:     Open tier sealed (only community + secured remain)
Stage 3:     Community tier sealed (only secured remains)
Stage 4:     Secured tier sealed (vault fully sealed)
Composted:   All keys removed from memory, stored in custodian escrow
Released:    Keys destroyed. Vault is cryptographic noise.
```

Trust is the last thing to go. Secured data is the last to seal because it represents the deepest trust the human placed in the system.

### Vault and agents

Not every agent can see every vault tier:

| Agent | Open | Community | Secured |
|-------|------|-----------|---------|
| Founder (Dash) | Y | Y | Y (when human is authed) |
| Template (Cora) | Y | Y | N |
| Operator (Wendy) | Y | limited | N |
| Observer (Marvin) | Y | N | N |
| Creator (Core) | N | N | N |

The Founder is the only agent with secured access, and only when the human has authenticated with the safe word. If the human hasn't entered the safe word this session, even the Founder can't read secured items.

## Ledger

### What the ledger records

Every entity that interacts with the brain gets a ledger entry:

```yaml
# brain/ledger/entities.jsonl
{
  "fingerprint": "7f3a9b...",
  "name": "Dad",                    # Human-assigned label
  "type": "bond",                   # bond | guest | service | field
  "first_seen": "2026-03-07T09:00:00Z",
  "events": [
    {"ts": "2026-03-07T09:00:00Z", "action": "bonded", "via": "handshake"},
    {"ts": "2026-03-07T09:30:00Z", "action": "tunnel_opened", "types": ["board", "nudge"]},
    {"ts": "2026-03-08T14:00:00Z", "action": "envelope_received"},
    {"ts": "2026-03-15T10:00:00Z", "action": "presence_detected"}
  ],
  "status": "active",
  "bond_file": "brain/bonds/7f3a9b/bond.yaml"
}
```

### Entity types

| Type | What it is | How it enters the ledger |
|------|-----------|------------------------|
| **bond** | A bonded brain. Mutual key exchange completed. | Bond handshake ceremony |
| **guest** | A temporary visitor. Session-only, no keys stored. | Guest authentication (future) |
| **service** | A service provider (field feed, relay, API). | Service registration |
| **field** | The field itself — an aggregate entity. | First field connection |

### Relationship distance

The ledger's primary job is measuring relationship distance — how far each entity is from "present."

```
Distance = f(time_since_last_interaction, interaction_frequency, interaction_depth)
```

| Component | What it measures |
|-----------|-----------------|
| Time since last | Raw gap since last event for this entity |
| Frequency | Average gap between interactions over the relationship lifetime |
| Depth | What kind of interactions — nudges are shallow, shared projects are deep |

Distance feeds into:
- **Sense phase:** "Dad hasn't been around in 2 weeks" → sense snapshot includes this
- **Dehydration:** silence pain is measured per-relationship, not global
- **Board surfacing:** close relationships surface items first
- **Bond health:** is this bond active, cooling, or dormant?

### Ledger is append-only

Entries are never deleted. Status changes are new events:

```jsonl
{"fingerprint":"7f3a","ts":"2026-03-07","action":"bonded"}
{"fingerprint":"7f3a","ts":"2026-06-15","action":"bond_revoked","reason":"human_initiated"}
```

The revocation event doesn't delete the bonding event. The ledger is a history, not a state machine. Current status is derived from the latest event.

**Why append-only:**
- You can always reconstruct what happened
- Audit trail is complete (when did you bond? when did you revoke?)
- No "I deleted them but the system still remembers" confusion
- The ledger is the receipt. Receipts don't get erased.

### Ledger and the membrane

The ledger is inside the membrane. It never crosses:
- Bond partners don't see your full ledger (they don't know who else you're bonded with)
- The field doesn't see your ledger (fingerprints are opaque in the field)
- Agents can read the ledger but can't emit it (the membrane blocks ledger data in all outbound)

The ledger is yours. It's your memory of relationships. Nobody else gets to see it.

## Vault + Ledger together

The vault protects data. The ledger tracks relationships. Together they answer:
- **What's sensitive?** → Vault property on the data
- **Who can see it?** → Vault tier + agent archetype + membrane rules
- **Who exists?** → Ledger entries
- **Who's close?** → Ledger distance calculation
- **What crosses?** → Membrane checks vault tier before any emission

```
Human creates a note → open by default
Human tags it vault:secured → encrypted with safe word key
Human shares it with Dad → membrane checks: is Dad bonded? (ledger: yes)
  → vault tier is secured → membrane blocks: secured items never cross
Human moves it to vault:community → now it can cross to bonded instances
  → membrane allows: community items cross via tunnel
```

## The principle

The vault doesn't protect things by hiding them — it protects them by encrypting them in place. You don't move sensitive data to a safe room. You make the room safe around the data.

The ledger doesn't manage relationships by curating a list — it records them by keeping an honest log. You don't unfriend people. You stop interacting. The ledger reflects the truth: this person was in your life. The distance says how far they've drifted.

Together, vault and ledger make the brain trustworthy. Not because it follows rules — because the architecture makes certain violations impossible. Secured data physically cannot cross the membrane. Deleted relationships physically cannot be erased from the record.

## Open questions

1. **Vault search** — Can you search inside vault-secured items when authenticated? Or are they opaque blobs until explicitly opened?
2. **Vault inheritance** — If a vault:community note references a vault:secured item, does the reference cross the tunnel? Or is the reference itself secured?
3. **Ledger size** — Append-only means the ledger grows forever. At what scale does this matter? Compaction strategy?
4. **Ledger and GDPR** — "Right to be forgotten" conflicts with append-only. Resolution: the ledger entry stays, but the name/label is scrubbed. The fingerprint remains (it's already opaque).
5. **Vault tiers and guests** — Can a guest entity see community-tier data? Or is community strictly for bonded entities?
6. **Multi-vault** — Can a human have multiple vault keys? "Work vault" and "personal vault" with different safe words?
