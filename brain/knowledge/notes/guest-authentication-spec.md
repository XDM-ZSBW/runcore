# Guest Authentication — Spec

> Status: Draft (2026-03-07)
> Origin: "How does someone interact with a brain they're not bonded with?"
> Depends on: bond-handshake-spec.md, privacy-as-membrane-spec.md, vault-ledger-spec.md, nerve-spawn-spec.md

## What

Guest authentication is how a non-bonded visitor interacts with a brain. Not a stranger — a known entity with limited, scoped, temporary access. A client checking their project status. A friend previewing a shared note. A customer trying the product. No bond. No keys. No permanent relationship.

## Why

Bonds are for trust relationships. Not every interaction deserves a bond. A plumber doesn't need your house keys — they need to be let in, shown to the bathroom, and let out when they're done. Guest auth is the front door, not the key exchange.

Without guest auth, every interaction requires a full bond handshake. That's like requiring a marriage certificate to have coffee with someone. The system needs a lighter-weight access pattern for temporary, scoped, revocable interactions.

## Done when

- A brain owner can generate a guest link (URL with embedded token)
- The guest clicks the link and gets scoped access — no safe word, no bond, no key exchange
- Guest access is defined by a scope document: what they can see, what they can do, when it expires
- The guest appears in the ledger as type `guest` (not a bond)
- Guest sessions are stateless — nothing persists on the guest's side after the session ends
- The brain owner can revoke a guest link instantly
- A guest cannot escalate to bond-level access from within a guest session
- Guest access works through any nerve (browser = touch nerve, shared link = read-only glance)

## Guest vs Bond

| Property | Guest | Bond |
|----------|-------|------|
| Key exchange | None | Ed25519 mutual |
| Duration | Temporary (expires) | Permanent (until revoked) |
| Access scope | Defined per-link | Defined by tunnel policy |
| Ledger entry | `type: guest` | `type: bond` |
| Data persistence | Nothing stored on guest side | Keys + bond file stored |
| Revocation | Link expires or is revoked | Unilateral key deletion |
| Tunnel | No tunnel | Full tunnel |
| Field participation | None | Heartbeat, compost, presence |
| Membrane treatment | Read-only viewport | Bilateral exchange |

## Guest link anatomy

```
https://[brain-address]/g/[token]

Example:
https://192.168.1.50:3577/g/a7f3b9c2e1d4
```

The token encodes:
- Brain fingerprint (which brain issued this)
- Scope hash (what access this grants)
- Expiry timestamp
- HMAC signature (prevents tampering)

The token is opaque to the guest. They click and get access. They don't know what scope means or what the token contains.

## Scope document

Every guest link has a scope that defines exactly what the guest can see and do:

```yaml
guest_scope:
  id: "gs_a7f3b9"
  created: "2026-03-07T09:00:00Z"
  created_by: "human"            # only the human can create guest scopes
  expires: "2026-03-14T09:00:00Z"  # 7 days
  max_uses: 10                    # or null for unlimited within expiry

  # What the guest can see
  read:
    - "brain/content/drafts/project-update.md"    # specific file
    - "brain/operations/goals.yaml"                # specific file
    # Never: memory, vault, identity, bonds, ledger

  # What the guest can do
  actions:
    - "chat"                    # can send messages (scoped to guest thread)
    - "joy_signal"              # can tap 1-4 (feedback on the experience)
    # Never: spawn agents, modify brain files, access settings

  # What the guest sees in UI
  surface:
    - "chat"                    # chat pane (guest thread only)
    - "shared_files"            # read-only file viewer for scoped files
    # Never: stream, pulse dots, board, operations

  # Identity
  label: "Client preview"       # human-readable name for this scope
  guest_name: null               # guest can optionally identify themselves
```

## Guest types

| Type | Scope | Use case |
|------|-------|----------|
| **Preview** | Read-only, specific files | "Look at this draft" — shared via link |
| **Chat** | Chat + read, no write | "Talk to my agent" — customer trial, support |
| **Collaborate** | Chat + read + limited write (comments, pins) | "Work on this together" — project partner |
| **Observe** | Read-only, stream visible | "Watch what my agent is doing" — demo, showcase |

Each type is a scope template. The human picks a type when generating the link. Custom scopes are possible but not required.

## Guest session lifecycle

```
1. Human generates guest link
     → Scope document created, stored in brain/guests/[scope_id].yaml
     → Token generated, embedded in URL
     → Link ready to share

2. Guest clicks link
     → Token validated (signature, expiry, use count)
     → Guest session created (ephemeral, in-memory)
     → Scope applied: UI assembles only what's permitted
     → Ledger entry created: {type: "guest", scope_id, ts}

3. Guest interacts
     → All actions checked against scope before execution
     → Chat messages go to a guest-specific thread (not the main conversation)
     → Read access returns only scoped files (404 for anything else)
     → No agent spawning, no settings, no stream, no bonds

4. Guest leaves (closes tab, session expires)
     → Session destroyed
     → Nothing persists on guest side (no cookies, no stored keys)
     → Ledger records: {action: "guest_session_ended", duration, ts}

5. Link expires or is revoked
     → Token invalidated
     → Future clicks return: "This link has expired"
     → Scope document archived (not deleted — ledger is append-only)
```

## Guest and the membrane

The membrane treats guests as external entities with a temporary viewport:

```
Full brain
  ├── Vault: secured     → NEVER visible to guests
  ├── Vault: community   → NEVER visible to guests
  ├── Vault: open         → Only if explicitly in scope
  ├── Memory              → NEVER visible to guests
  ├── Identity            → NEVER visible to guests
  ├── Bonds               → NEVER visible to guests
  ├── Ledger              → NEVER visible to guests
  └── Scoped files        → Visible (read-only unless scope says otherwise)
```

The membrane doesn't "open" for guests. It creates a narrow viewport — a slit through which specific files are visible. Everything else is invisible, not forbidden. The guest doesn't see a "you don't have access" message — they see only what exists in their scope. The rest of the brain doesn't exist from their perspective.

## Guest and agents

Guests don't interact with the brain's agents directly. They interact with a **guest handler** — a lightweight responder that:

- Answers chat using the brain's context (scoped to what the guest can see)
- Cannot access memory, vault, or identity beyond what's in scope
- Cannot spawn agents or modify brain state
- Logs all interactions to the guest thread
- Uses the brain's LLM configuration but with reduced token budget

The guest handler is not an archetype. It's a constrained mode of the Founder agent — like the Founder wearing a visitor badge. Same engine, different permissions.

## Guest and the ledger

Every guest interaction creates a ledger entry:

```jsonl
{"fingerprint":"guest_a7f3b9","type":"guest","first_seen":"2026-03-07T09:00:00Z","scope_id":"gs_a7f3b9","label":"Client preview"}
{"fingerprint":"guest_a7f3b9","ts":"2026-03-07T09:05:00Z","action":"chat_message","content_hash":"[hash]"}
{"fingerprint":"guest_a7f3b9","ts":"2026-03-07T09:10:00Z","action":"file_viewed","file":"brain/content/drafts/project-update.md"}
{"fingerprint":"guest_a7f3b9","ts":"2026-03-07T09:15:00Z","action":"guest_session_ended","duration_min":15}
```

Guest fingerprints are derived from the scope ID, not from a key exchange. They're not real cryptographic identities — they're session labels. The ledger records that a guest visited, what they saw, and when they left.

## Guest → Bond upgrade

A guest session can lead to a bond, but it's a separate ceremony:

```
Guest is chatting via guest link
  → Enjoys the experience
  → Human says "want to bond?"
  → Normal bond handshake begins (6-word code)
  → Bond established
  → Guest session ends, bond session begins
  → Ledger records: {action: "guest_upgraded_to_bond"}
```

The upgrade is not automatic. The guest link doesn't become a bond. A fresh handshake is required. This prevents scope creep — a guest can't gradually accumulate access by visiting repeatedly.

## Security

**Guest links are bearer tokens.** Anyone with the link has the access. This is intentional — the link IS the authentication. Sharing a guest link is like giving someone your WiFi password. Simple, understood, revocable.

**Mitigations:**
- Links expire (configurable: hours, days, weeks)
- Links have use limits (optional: max 5 uses)
- Links are revocable instantly (human can kill any link)
- Rate limiting on guest sessions (prevent link scanning)
- Guest sessions are logged in the ledger (full audit trail)
- No escalation from guest to bond without handshake

**What a compromised guest link exposes:**
- Only what's in the scope document (specific files, limited chat)
- Never: memory, vault, identity, bonds, settings, agents, stream
- Never: the ability to modify anything (unless scope explicitly allows)

**What a compromised guest link does NOT expose:**
- Other guest links (each is independent)
- Bond information (bonds are invisible to guests)
- Brain structure (guests see a flat file list, not the brain's organization)

## The principle

A guest is a visitor, not a resident. They come in through the front door, see what you've chosen to show them, and leave. They don't get house keys. They don't see the bedroom. They don't know the floor plan. They experience a curated viewport into your brain — generous enough to be useful, narrow enough to be safe.

Guest auth is the lightest touch in the trust spectrum: strangers → guests → bonds → custodians. Each level up requires more ceremony and grants more access. Guests are one step above strangers — they have a link, not a key.

## Open questions

1. **Guest identity** — Should guests be required to identify themselves (name, email)? Or is anonymous guest access valid?
2. **Guest memory** — If a guest chats with the agent, should that conversation be remembered? Or forgotten when the session ends?
3. **Recurring guests** — A client who visits weekly via guest links. Should the brain recognize them across sessions? Or is every visit fresh?
4. **Guest and the field** — Should guest activity contribute to field signals? (Presence count, interaction patterns?) Probably not — they're not registered brains.
5. **Guest abuse** — What stops someone from generating thousands of guest links and using them as a public API? Rate limits on link generation? Max concurrent guests?
6. **Guest on native host** — On Android/iOS host, does a guest link open in the host app or in a browser? Browser is simpler. Host app could provide richer scoping.
