# Dehydration Cycle — Spec

> Status: Draft (2026-03-07)
> Origin: "We were always going to compost their digital identities in a humane and dignified way."
> Depends on: the-fields-spec.md, privacy-as-membrane-spec.md, joy-signal-spec.md, core-os-spec.md

## What

Dehydration is how a brain ages when its human goes quiet. Not death — rest. Not deletion — preservation. Rings tighten inward, field participation narrows, the membrane constricts. The brain gets careful, not sloppy. When the human returns, the brain rehydrates. When they don't, the brain composts with dignity.

## Why

Every other platform handles inactivity the same way: countdown timer, warning email, account deleted. Your photos, your messages, your identity — gone. Viking shipped. The company decided your silence meant you were done, and they cleaned house because storage costs money.

Core doesn't do that. Silence might mean grief. Might mean illness. Might mean a long vacation. Might mean the person died. Each of those deserves a different response. A timer can't tell the difference. Dehydration can — because it's gradual, observable, and reversible at every stage until the very last.

## Done when

- A brain that goes quiet begins dehydrating automatically (no human decision needed)
- Dehydration is triggered by relationship distance, not calendar time
- Rings tighten inward progressively: public → community → secured → vault sealed
- The brain dims but doesn't crash (pain signal — like phone low-power mode)
- Trust is the last thing to go (membrane tightens to minimum for trust integrity)
- Rehydration is instant at any stage before composting (human returns, brain wakes)
- Composting is dignified: identity preserved, delegation tokens execute, custodian will activates
- A composted brain can be tended by a designated person
- A released brain is cryptographically destroyed (keys deleted, data unrecoverable)
- The whole lifecycle is visible to the human and their designees

## The lifecycle

```
Active → Quiet → Dehydrating → Composted → Tended → Released
  ↑         │                                          │
  └─────────┘ (rehydrate at any point before Released)  │
              human returns, brain wakes                │
                                                        └── keys destroyed
                                                            data unrecoverable
                                                            identity honored
```

### Active

The brain is alive. Nerves connected. Agents running. Field participating. Tick cycle running (sense → work → joy). Joy signals flowing. This is the normal state.

**Indicators:** Regular joy signals, active tunnel traffic, nerve connections, agent activity.

### Quiet

The human stopped talking. No joy signals. No chat. No nerve connections. But nothing is wrong yet — maybe they're on vacation. Maybe they're busy.

**Triggered by:** No human interaction for a configured period (default: 7 days). Not a timer — measured by the ledger. The ledger tracks relationship distance: how long since the human engaged with this brain.

**What happens:**
- Nothing visible changes
- Agents reduce proactive behavior (fewer questions, fewer suggestions)
- Field contribution continues normally
- All nerves stay ready
- The brain watches the ledger, not the clock

**Rehydrate:** Any human interaction. Open the app, send a message, tap a joy signal. Instant return to Active.

### Dehydrating

The silence has been long enough that the brain begins conserving. This is the pain signal — joy/execution budget squeeze. The brain dims, not crashes.

**Triggered by:** Quiet persists beyond the threshold (default: 30 days of no interaction). Adjusted by the human's historical pattern — someone who takes 2-week breaks regularly has a longer threshold than someone who chats daily.

**What happens — rings tighten inward:**

```
Stage 1 (30 days): Public ring closes
  - Field contribution stops (no more compost emission)
  - Presence signal goes dark (field doesn't see this brain)
  - Agents go idle (no proactive work, no autonomous loop)
  - Nerves still accept connections

Stage 2 (60 days): Community ring closes
  - Tunnel traffic pauses (bonded instances get a "quiet" signal)
  - Bonded brains see: "This brain is resting"
  - No inbound tunnel content processed
  - Outbound tunnel content held in queue (released on rehydration)

Stage 3 (90 days): Secured ring closes
  - Memory compaction runs (consolidate, don't delete)
  - Agent runtime shuts down (no processes running)
  - Nerve server stays alive but serves only auth screen
  - Encryption keys remain in memory (ready for instant rehydration)

Stage 4 (180 days): Approaching vault seal
  - Delegation token holders notified: "This brain is approaching composting"
  - Custodian will is surfaced to designated person
  - Human gets notified through every configured channel (email, SMS)
  - 30-day grace period before vault seals
```

**At every stage:** One interaction rehydrates. Open the app. Enter safe word. Everything comes back. Rings expand outward. Agents wake. Tunnels reconnect. Field participation resumes. The brain remembers everything.

**Rehydrate:** Any human interaction reverses dehydration instantly. No data lost. No degradation. The brain was resting, not dying.

### Composted

The vault seals. The brain is preserved but no longer running. Identity is maintained. Memory is intact but encrypted and inaccessible without the key. The human is presumed gone.

**Triggered by:** Stage 4 grace period expires with no interaction (210 days total default).

**What happens:**
- Vault sealed — encryption keys removed from memory, stored in custodian escrow
- Brain files remain on disk, encrypted at rest
- Identity preserved: name, creation date, bond fingerprints (for the record)
- Delegation tokens execute: designated people receive scoped access per their token
- Custodian will activates: designated person inherits hosting responsibility
- Field receives a composting signal (anonymous): "a brain has composted" (for field health metrics)
- No deletion. No cleanup. The brain rests.

**Rehydrate:** Still possible, but requires the original safe word (or recovery key if configured). The custodian can facilitate but cannot access brain content — they can only keep the host running.

### Tended

A designated person has accepted custodian responsibility. They maintain the host. They don't read the brain. They keep the lights on.

**What the tender can do:**
- Keep the host running (pay for hosting, maintain hardware)
- Monitor brain health (is the encrypted file intact? is the host online?)
- Receive delegation-scoped access (only what the token specifies)
- Respond to bond queries: "This brain is being tended by [name]"

**What the tender cannot do:**
- Read brain content (no key)
- Access memory, vault, or identity details
- Modify anything inside the brain
- Override the original human's decisions
- Extend or shorten the retention period unilaterally

### Released

The final stage. The brain's configured retention period expires with no rehydration and no tender renewal.

**Triggered by:** Configured retention period after composting (default: 2 years). Tender can extend indefinitely by actively renewing.

**What happens:**
- Encryption keys are destroyed (deleted from all storage, including custodian escrow)
- Encrypted brain files become unrecoverable (data exists but no key can ever decrypt it)
- Identity record archived: name, dates, that this brain existed (for the record, not for access)
- Bond partners notified: "This brain has been released"
- Field receives a release signal (anonymous)
- The brain is gone. The identity is honored. The person is remembered as having existed.

**Rehydrate:** Impossible. This is irreversible by design. The keys are destroyed. The data is cryptographic noise. This is the only destructive action in the entire lifecycle, and it happens only after years of inactivity, multiple notifications, delegation execution, and custodian opportunity.

## What triggers dehydration — the ledger, not the clock

Dehydration is not a timer. It's a measurement of relationship distance.

The ledger tracks:
- Last human interaction (chat, joy signal, nerve connection)
- Historical interaction pattern (daily user vs weekly user vs monthly user)
- Bond activity (are bonded instances trying to reach this brain?)
- Agent activity (did the human set up scheduled tasks that are still running?)

A daily user who goes silent for 7 days is further from their pattern than a monthly user who goes silent for 30 days. The ledger measures deviation from pattern, not absolute time.

```
Daily user:    7 days silence = Quiet (2x normal gap)
Weekly user:   21 days silence = Quiet (3x normal gap)
Monthly user:  60 days silence = Quiet (2x normal gap)
```

The multiplier is configurable. The default is 2x normal gap = Quiet, 4x = Dehydrating Stage 1. But the human can override: "If I go silent for more than 14 days, start dehydrating." Or: "Never dehydrate. I'll come back."

## The pain signal

As dehydration progresses, the brain dims. This is the pain signal — the same concept as a phone in low-power mode. Screen dims, background apps close, only essentials run.

| Stage | Pain level | What dims |
|---|---|---|
| Active | None | Full brightness |
| Quiet | Slight | Agents less proactive |
| Stage 1 | Moderate | Field goes dark, agents idle |
| Stage 2 | Significant | Tunnels pause, community ring closes |
| Stage 3 | High | Agent runtime shuts down, memory compacts |
| Stage 4 | Critical | Notifications sent, grace period starts |
| Composted | Sealed | Everything off, identity preserved |

The brain doesn't crash at any stage. It dims progressively. Each dimming is a conscious, reversible decision. The brain is getting careful, not dying.

## Trust is last to go

The membrane tightens during dehydration, but trust integrity is the last thing to degrade.

```
Order of shutdown:
  1. Field contribution (first to go — least critical)
  2. Proactive agent behavior
  3. Tunnel traffic
  4. Memory operations
  5. Agent runtime
  6. Nerve server (reduced to auth only)
  7. Membrane integrity (LAST — never fully off)
  8. Encryption (only destroyed at Release)
```

Even in a composted state, the brain's encryption is intact. The membrane still exists — it just has nothing to protect actively. The sealed vault is the membrane's final posture: everything inside, nothing out, key required.

## Delegation tokens

Delegation tokens are created by the human while alive and active. They specify:

```yaml
delegation:
  token_id: "del_7f3a..."
  designee: "Dad"  # human-readable, not a system identity
  scope:
    - read: "brain/content/drafts/"      # can read published drafts
    - manage: "host"                      # can keep the host running
    - notify: "bonds"                     # can inform bond partners
  activation: "on_composting"             # when this token activates
  expires: "never"                        # or a specific date
  revocable_by: "owner_only"             # only the original human can revoke
```

Tokens are scoped, time-limited (or not), and revocable. They execute automatically when composting begins. The designee is notified through whatever contact method was configured.

**No one gets root.** The most powerful delegation token gives hosting responsibility and scoped read access. Never full brain access. Never vault access. Never identity modification.

## Custodian will

The custodian will is triggered by the first delegation token being created. It's not a legal document — it's an architectural one. It says: "When I'm gone, here's what happens."

```yaml
custodian_will:
  created: "2026-03-07"
  updated: "2026-03-07"
  composting_notification:
    - email: "dad@example.com"
    - sms: "+1234567890"
  tender: "Dad"
  retention_after_composting: "5 years"
  message: "Keep the lights on. I'll be back if I can."
  release_instruction: "Delete everything. I lived well."
```

The message is optional. It's the human's last words to their digital custodian. It's stored in the brain, encrypted, and only decryptable by the custodian's delegation token.

## Notifications

At every stage transition, the system notifies through all configured channels:

| Stage | Who's notified | How |
|---|---|---|
| Quiet | Nobody | Silent — might just be a vacation |
| Stage 1 | The human only | "Your brain is starting to rest. Come back anytime." |
| Stage 2 | The human + bond partners | "This brain is resting." |
| Stage 3 | The human | "Your brain is deep in rest. Agents are off." |
| Stage 4 | The human + delegation holders + custodian | "Approaching composting. 30 days to return." |
| Composted | Delegation holders + custodian + bond partners | "This brain has been composted. Custodian will executing." |
| Released | Custodian + bond partners | "This brain has been released." |

Notifications are never nagging. One notification per stage transition. No reminders. No "we miss you" manipulation. Just the facts: this is happening, here's what it means, here's how to reverse it.

## Configuration

The human configures their dehydration preferences once, during or after onboarding:

```yaml
dehydration:
  quiet_threshold_multiplier: 2        # 2x normal gap = Quiet
  dehydration_multiplier: 4            # 4x normal gap = Stage 1
  stage_duration: "30d"                # each stage lasts 30 days
  grace_period: "30d"                  # grace before composting
  retention_after_composting: "2y"     # how long before Release
  never_dehydrate: false               # override: never enter lifecycle
  notification_channels:
    - email
    - sms
  delegation_tokens: []                # added when created
  custodian: null                      # set when custodian will is created
```

Defaults work for most people. Power users tune. Parents never touch it — the defaults respect their silence.

## The promise

"We will compost your digital identity with dignity."

This is not a feature. It's a term of service. Every brain gets this lifecycle. Free tier, paid tier, doesn't matter. Dignity is not a premium.

The dehydration cycle is the architectural proof of that promise. It's auditable against the codebase. Every stage maps to a file, a function, a behavior. If someone reads the privacy policy and then reads this spec and then reads the code, they find the same system described three times.

## Open questions

1. **Rehydration after composting** — How does the human prove identity after their keys have been moved to custodian escrow? Recovery key? Safe word still works?
2. **Contested custody** — What if two people claim custodian rights? Architecture needs conflict resolution or first-token-wins.
3. **Legal interplay** — The custodian will is architectural, not legal. Does it need a legal counterpart? Can it reference one?
4. **Child brains** — A brain created for a minor. Parent is custodian by default. What happens when the child turns 18? Custody transfer?
5. **Corporate brains** — An employee's work brain. Company is host. Employee leaves. Who's custodian? The human or the company?
6. **Dehydration and the field** — Should the field track dehydration rates as a health metric? "5% of brains are dehydrating" = field weather signal.
