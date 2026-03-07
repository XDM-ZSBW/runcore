# Onboarding — Spec

> Status: Draft (2026-03-07)
> Origin: "A parent can do it without thinking."
> Depends on: core-os-spec.md, nerve-spawn-spec.md, calibration-cycle-spec.md, bond-handshake-spec.md, vault-ledger-spec.md, posture-system-spec.md

## What

The first five minutes. From nothing to a working brain with a name, a safe word, a calibrated agent, and a pulse. No account creation. No email verification. No tutorials. No terms-of-service checkbox before you can breathe. Install, open, talk, done.

## Why

Every product loses people in onboarding. The signup form. The verification email. The "tell us about yourself" questionnaire. The feature tour. The empty state. Each step is a gate where someone decides "not today" and never comes back.

Core's onboarding has one gate: the safe word. Everything else is a conversation. The agent introduces itself, asks a few questions, calibrates, and starts working. The human never sees a form. They never wait for an email. They never click "skip tutorial." There is no tutorial — the agent IS the tutorial.

## Done when

- Install to first useful interaction: under 5 minutes
- Zero forms, zero verification emails, zero questionnaires
- The safe word is the only thing the human must create
- Calibration happens through conversation, not settings
- The agent is useful from the first response (not after setup completes)
- A parent can complete onboarding without help from their kid
- The pulse dots are breathing by the end of onboarding
- Onboarding works on any nerve (PC, phone, tablet, voice-only)

## The sequence

### 1. Install (30 seconds)

**On PC/Mac/Linux:**
```
npm install -g @runcore-sh/runcore
runcore
```

Two commands. The second one starts the brain and opens a browser tab. The terminal shows:

```
Core is running.
Open: http://localhost:3577?token=a7f3b9c2
```

The token is a one-time auto-login — zero friction for the first visit. After the safe word is set, the token expires.

**On Android (host app):**
Install from store. Open. That's it. The host starts the brain internally.

**On phone (nerve, not host):**
Someone else's brain is already running. Open the URL they gave you. Enter safe word. You're in. (This isn't onboarding — it's nerve spawning. See nerve-spawn-spec.)

### 2. First screen (5 seconds)

No splash screen. No logo animation. No "Welcome to Core!" banner. The screen opens to a chat interface with one message:

```
Dash: Hey. I'm Dash. I work for you — you don't work for me.

      Before we start, I need two things from you:
      your name and a safe word.

      What should I call you?
```

The chat input is focused. The cursor is blinking. The human types their name.

**Why chat, not a form:** A form says "fill this out." A conversation says "let's talk." The human is already in the product's primary interaction pattern — chat. No mode switch later.

### 3. Name (10 seconds)

```
You:  Bryant

Dash: Bryant. Got it.

      Now pick a safe word. This is how I know it's you.
      It can be anything — a word, a phrase, a sentence.
      I'll never see it. I only store a fingerprint of it.

      If you forget it, we have a recovery question.
      But pick something you'll remember.

      [Safe word input field appears inline]
```

The safe word input appears inside the chat — not a separate screen, not a modal. It's a password field embedded in the conversation. The human types their safe word and hits enter.

**Why inline:** Switching to a form breaks the conversational flow. The input is part of the chat. The human never leaves the conversation.

### 4. Safe word (15 seconds)

```
      [Safe word: ••••••••]  [Set]

Dash: Locked. That's between you and the system — I can't see it.

      One more thing: if you ever forget your safe word,
      what question should I ask to verify it's you?
```

The human types a recovery question and answer. Both are optional — if they skip, that's fine. They can set it later.

```
You:  What's my dog's name?

Dash: And the answer?

You:  Biscuit

Dash: Got it. If you ever forget your safe word, I'll ask about your dog.
```

**What just happened technically:**
- Safe word hashed (SHA-256, never stored in plain text)
- PBKDF2 salt generated for session encryption
- Ed25519 keypair generated (brain identity)
- `brain/identity/human.json` written
- Session created, encryption key derived
- Pairing code consumed (if it existed)
- The brain is now paired. This is irreversible without recovery.

### 5. Calibration conversation (2-3 minutes)

Immediately flows into calibration. No "setup complete!" interstitial. The conversation continues:

```
Dash: We're paired. Now let me learn how you like to work.
      This takes about 2 minutes.

      When I'm working on something, do you want to see
      what I'm doing? Or just hear about it when I'm done?
```

The full calibration conversation runs (see calibration-cycle-spec.md). By the end, the agent has:
- Autonomy level
- Verbosity preference
- Proactivity level
- Joy prompt frequency
- Pulse dot thresholds

### 6. First useful moment (immediate)

Calibration ends and the agent is immediately useful:

```
Dash: We're set. Here's what I can see:

      Your brain is empty — which means we're starting fresh.
      The three dots above are your pulse. They'll start
      breathing as we work together.

         ● ● ●

      What would you like to do first?

      Some ideas:
      - "Tell me about yourself" (I'll explain what I am)
      - "What can you do?" (I'll show you)
      - Or just start talking. I'll figure it out.
```

The pulse dots are now visible and breathing (low blue — resting state). The human is in the product. Onboarding is over. There was no "onboarding complete" moment — the conversation just became the product.

## What onboarding is NOT

**Not a feature tour.** No "click here to see the stream." No "this is the pulse strip." No arrows pointing at UI elements. The human discovers features by using them. The agent introduces things when they're relevant, not all at once.

**Not a data collection step.** No "what industry are you in?" No "how did you hear about us?" No "what are your goals?" The agent learns goals through conversation over days, not through a questionnaire on day one.

**Not a prerequisite.** The agent is useful from its first response. You don't need to "complete setup" before you can use it. The calibration conversation IS using it. If the human interrupts calibration with a real question, the agent answers it and returns to calibration later.

**Not a one-time event.** Onboarding flows into calibration. Calibration recurs. The "onboarding" is just the first calibration with a name and safe word prepended.

## Onboarding on different nerves

| Nerve | Experience |
|-------|-----------|
| **PC (keyboard)** | Full chat. Type name, safe word, calibration answers. Best experience. |
| **Phone (touch)** | Same chat, optimized for thumb typing. Safe word input is large-target. |
| **Tablet (touch)** | Same as phone but more room. Split-screen if landscape. |
| **Voice** | "Hey, I'm Dash. What's your name?" / "Bryant." / "Pick a safe word — say it now, I'll only hear the shape of it." Voice-only onboarding works but safe word is trickier (need to confirm spelling or use a phrase). |
| **Watch (glance)** | Not an onboarding device. Watch connects after onboarding is complete on another nerve. Shows pulse dots immediately. |

## Empty state

After onboarding, the brain is empty. No pre-loaded content. No sample data. No "here's what a board looks like with items." Empty is honest.

But empty doesn't mean dead:
- Pulse dots breathe (blue, resting — alive but quiet)
- The agent responds to any input (it doesn't need brain content to be useful)
- First interactions create the first memories (the brain starts learning immediately)
- The stream shows sense activity even with nothing happening ("reading ledger... empty. reading field... not connected yet.")

The empty state IS the first impression. It should feel like a clean room, not a broken product. Quiet, ready, breathing.

## Progressive disclosure after onboarding

The agent introduces capabilities as they become relevant, not during onboarding:

| Trigger | What the agent introduces |
|---------|--------------------------|
| Human asks a complex question | "I can research that — want me to dig deeper?" (introduces depth) |
| Human mentions someone | "Want to bond with them? I can set that up." (introduces bonding) |
| Agent completes first task | "That's done. You can see what I did in the stream." (introduces stream) |
| Human returns next day | "Welcome back. How's it going?" [1-4] (introduces joy signal) |
| Agent encounters an error | "Something didn't work. I've logged it." (introduces transparency) |
| Human's second week | "Quick check-in on how we're working..." (introduces recalibration) |
| Human installs on second device | Pulse dots appear. "Same brain, different nerve." (introduces multi-device) |

No feature is introduced before it's needed. The agent drip-feeds capability through natural use. A parent using Core for 6 months might never learn about the stream — and that's fine. They don't need it. The agent handles it.

## Onboarding and registration (runcore.sh)

Registration with runcore.sh is NOT part of onboarding. It happens later, silently, when the human first needs field connectivity:

```
Dash: I'd like to connect to the field — it's a shared signal
      from other brains that helps me serve you better. Anonymous.
      Nothing personal leaves your brain. Want me to connect?

You:  Sure.

Dash: Done. I registered with runcore.sh. Your brain has a
      fingerprint now. Nobody knows it's you — just that a brain exists.
```

Registration requires an email (for billing, later). That's the only form in the entire lifecycle, and it happens weeks or months after onboarding, only if the human wants field access.

## Failure modes

| Failure | What happens |
|---------|-------------|
| Human closes browser during onboarding | Brain remembers what was completed. Next open resumes from where they left off. |
| Human forgets safe word immediately | Recovery question. If they skipped it, they need to re-pair (delete human.json, start over). |
| Human gets confused by calibration | Agent detects non-answers ("I don't know", "whatever") and uses defaults. "No worries — I'll use sensible defaults and we can adjust later." |
| Human is interrupted mid-onboarding | No timeout. Come back in an hour, a day, a week. The conversation is still there. |
| Install fails | Standard package manager errors. No Core-specific failure mode. |
| Port conflict | Auto-increment port finding. If 3577 is taken, try 3578, etc. |

## Metrics (internal, not collected)

The brain tracks its own onboarding for self-improvement:

```jsonl
{"event":"onboarding_start","ts":"2026-03-07T09:00:00Z"}
{"event":"name_set","ts":"2026-03-07T09:00:15Z","elapsed_sec":15}
{"event":"safe_word_set","ts":"2026-03-07T09:00:40Z","elapsed_sec":40}
{"event":"calibration_start","ts":"2026-03-07T09:00:45Z","elapsed_sec":45}
{"event":"calibration_complete","ts":"2026-03-07T09:03:00Z","elapsed_sec":180}
{"event":"first_useful_interaction","ts":"2026-03-07T09:03:30Z","elapsed_sec":210}
```

These metrics stay in the brain. Never sent to runcore.sh. Never aggregated. They exist so the brain can optimize its own onboarding for future instances it spawns (Templates learn from the Founder's onboarding data).

## The principle

Onboarding is not setup. It's the first conversation. The product doesn't start after onboarding — onboarding IS the product. Every second of it is real, useful, and in the same interface the human will use forever.

The safe word is the only ceremony. Everything else is a conversation that happens to produce configuration. If the human never realized they were being "onboarded," the onboarding worked.

## Open questions

1. **Onboarding for kids** — A child's brain spawned by a parent. Does the child go through onboarding? Or does the parent configure it and hand it over? At what age does the child set their own safe word?
2. **Onboarding for teams** — A company deploys 50 instances. Is each one individually onboarded? Or is there a bulk provisioning path?
3. **Re-onboarding** — If the human wants to start over (new safe word, new calibration, fresh brain), is that a factory reset? Or a new instance?
4. **Onboarding analytics** — Should the field aggregate (anonymous) onboarding success rates? "Average onboarding time across all brains is 3.2 minutes" as a product health metric?
5. **Onboarding and accessibility** — Screen reader support? High-contrast mode? The chat interface is naturally accessible, but the safe word input and calibration need testing.
6. **Safe word UX** — Should the agent give guidance on safe word strength? Or trust the human? "Your safe word is 3 characters — that's fine if it's just you, risky if you share a device."
