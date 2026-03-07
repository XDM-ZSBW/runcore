# Nerve Vocabulary — Spec

> Status: Draft (2026-03-07)
> Origin: "Nerves are interfaces, not devices. Five types."
> Depends on: core-os-spec.md, nerve-spawn-spec.md, stream-spec.md, agent-archetypes-spec.md, access-manifest-spec.md

## What

Five nerve types define how a brain reaches a human. Not device types — interface types. A phone has three nerves. A PC has four. A watch has one. The brain addresses nerves, not devices. The UI is derived from which nerves are active.

## Why

Every other system designs per device. Mobile app. Desktop app. Watch app. Tablet app. Four codebases. Four UIs. Four maintenance burdens. And when a new form factor arrives (glasses, car, fridge), you start from scratch.

Core doesn't have apps. Core has nerves. A device is a bundle of nerves. The brain knows: "This human has glance + voice + touch active right now." It doesn't know or care whether that's a phone, a tablet, or a watch. The UI assembles from the nerve bundle, not from a device profile.

## Done when

- Five nerve types are defined with clear boundaries
- Every device maps to a nerve bundle (not a custom UI)
- The brain addresses nerves, not devices
- UI is derived from active nerve bundle + access manifest + posture
- Adding a new device means mapping its nerve bundle, not building a new app
- A human can connect multiple devices simultaneously — each contributes its nerves
- Nerves activate and deactivate as devices connect and disconnect

## The five nerves

### 1. Glance

**What you get:** A look. A pulse. A vibe check. No interaction required.

**Capabilities:**
- Pulse strip (three dots — sense/work/joy)
- Single-number indicators (unread count, joy reading, agent count)
- Color signal (ambient state — calm blue, active green, attention amber)
- Nudge (a tap, a vibration, a flash — "something happened")

**Input:** None. Glance is output-only. You look, you know, you move on.

**Devices that have glance:**
- Watch (primary nerve — glance IS the watch experience)
- Phone (lock screen widget, notification badge)
- PC (system tray icon, menu bar indicator)
- Any screen (ambient display, smart mirror, dashboard TV)

**Design constraint:** Must communicate in under 2 seconds. If it takes longer to understand than a glance, it's not glance — it's touch.

### 2. Touch

**What you get:** Tap, swipe, scroll. The primary interaction nerve for screens.

**Capabilities:**
- Chat interface (send/receive messages)
- Stream view (monitor agent activity)
- Board interaction (pin, unpin, rearrange)
- Joy signal input (tap 1/2/3/4)
- Navigation (switch views, drill into details)
- Quick capture (journal entry, thought, photo)

**Input:** Finger taps, swipes, scrolls, long-press. No typing — that's keyboard.

**Devices that have touch:**
- Phone (primary interaction nerve)
- Tablet (primary interaction nerve)
- PC touchscreen (secondary — keyboard is primary on PC)
- Watch (limited — single-tap only, swipe to dismiss)

**Design constraint:** Every touch target is at least 44px. Every action is completable in under 3 taps. Swipe gestures are discoverable but not required.

### 3. Keyboard

**What you get:** Full text input. The power nerve. Where detailed conversation and precise control happen.

**Capabilities:**
- Full chat composition (long messages, formatted text)
- Stream control (shape sliders, twist intercepts, breakpoint rules)
- Search (across memory, brain files, bonds)
- Command input (slash commands, direct agent instructions)
- Code/spec editing (when agent surfaces drafts for review)

**Input:** Physical or virtual keyboard. Full character set.

**Devices that have keyboard:**
- PC (primary input nerve)
- Tablet with keyboard (when attached)
- Phone (virtual keyboard — available but not primary)

**Design constraint:** Keyboard-first doesn't mean keyboard-only. Every keyboard action has a touch equivalent. But keyboard users get shortcuts, autocomplete, and multi-line editing that touch users don't.

### 4. Voice

**What you get:** Speak and listen. Hands-free. Eyes-free.

**Capabilities:**
- Speech-to-text chat (talk to your agent)
- Text-to-speech responses (agent talks back)
- Voice commands ("pause the stream," "bond with Dad," "how's my joy?")
- Ambient listening (opt-in — agent hears context, not just commands)
- Audio nudges (spoken alerts, tone signals)

**Input:** Microphone. Natural language. No wake word required when in active session.

**Devices that have voice:**
- Phone (when microphone is available)
- PC (when microphone is available)
- Smart speaker (voice-only device — voice IS the entire experience)
- Car (hands-free — voice is the only safe nerve while driving)
- AirPods/earbuds (voice in, audio out)

**Design constraint:** Every voice interaction must work without seeing a screen. If you need to look to understand the response, it's not voice — it's touch with audio.

### 5. Haptic

**What you get:** Physical sensation. Vibration patterns. Pressure. Temperature (future).

**Capabilities:**
- Notification patterns (distinct vibration for different signal types)
- Joy confirmation (tap 3, feel a confirmation pulse)
- Urgency encoding (gentle pulse = routine, sharp buzz = attention needed)
- Heartbeat sync (subtle vibration matching the tick cycle — you feel the brain breathing)
- Proximity signal (stronger haptic as relationship distance decreases — future)

**Input:** Haptic is output-only in v1. Future: pressure-sensitive input, squeeze gestures.

**Devices that have haptic:**
- Watch (primary haptic device — wrist is the most haptic-sensitive location)
- Phone (vibration motor)
- Game controller (rumble — future integration)
- Wearables (rings, bands — future)

**Design constraint:** Haptic patterns must be distinguishable without training. Max 5 distinct patterns (human haptic vocabulary is limited). More than 5 and people stop distinguishing.

## Device-to-nerve mapping

| Device | Glance | Touch | Keyboard | Voice | Haptic |
|--------|--------|-------|----------|-------|--------|
| Watch | Y | limited | - | - | Y |
| Phone | Y | Y | virtual | Y | Y |
| Tablet | Y | Y | optional | Y | - |
| PC | Y | optional | Y | Y | - |
| Smart speaker | - | - | - | Y | - |
| Car | - | - | - | Y | - |
| AirPods | - | - | - | Y | - |
| Smart display | Y | Y | - | Y | - |

A device IS its nerve bundle. No custom UIs. The brain sends signal to the nerves that are active. The device renders whatever its nerve bundle supports.

## Nerve vocabulary per archetype

Not every archetype uses every nerve the same way. The access manifest defines which nerves an archetype can address:

| Archetype | Glance | Touch | Keyboard | Voice | Haptic |
|-----------|--------|-------|----------|-------|--------|
| Founder (Dash) | Y | Y | Y | Y | Y |
| Template (Cora) | Y | Y | Y | Y | - |
| Operator (Wendy) | Y | Y | - | Y | - |
| Observer (Marvin) | Y | - | - | - | Y |
| Creator (Core) | - | - | Y | - | - |

The Founder gets all five because it's your primary agent. The Observer gets glance + haptic because it watches and nudges — it doesn't converse. The Creator gets keyboard only because it writes specs, not experiences.

These are defaults. The access manifest can override per-instance.

## Nerve assembly → UI

The UI is not designed. It's assembled. Active nerves determine what appears:

```
Active nerves: [glance, touch, keyboard]
  → Full two-pane UI (chat + stream), pulse strip, keyboard shortcuts

Active nerves: [glance, touch, voice]
  → Chat UI with voice input, pulse strip, no keyboard shortcuts

Active nerves: [glance, haptic]
  → Pulse strip only, haptic nudges, no interaction surface

Active nerves: [voice]
  → Audio-only experience, spoken responses, no visual UI
```

The brain doesn't render a UI — it emits signal to active nerves. Each nerve has a renderer. The renderers compose into whatever the device supports. A phone with touch + voice + glance renders chat + pulse + voice input. A watch with glance + haptic renders dots + vibration.

## Nerve lifecycle

Nerves spawn when a device connects and die when it disconnects:

```
1. Device opens URL (browser) or connects (native)
2. Safe word authenticates → session created
3. Device reports its nerve bundle: {touch: true, voice: true, glance: true}
4. Brain registers the nerve bundle for this session
5. Signal flows to active nerves
6. Device disconnects → nerves deactivate
7. Device reconnects → nerves reactivate (same session if safe word matches)
```

Multiple devices can be active simultaneously. A human at their PC (keyboard + touch + glance) wearing a watch (glance + haptic) has 4 active nerves from 2 devices. The brain doesn't duplicate — it routes. Chat goes to keyboard nerve. Nudges go to haptic nerve. Pulse goes to both glance nerves.

## Nerve priority

When multiple devices have the same nerve type, the brain picks one to be primary:

- **Most recently active** device gets priority for interactive nerves (touch, keyboard)
- **Most persistent** device gets priority for ambient nerves (glance, haptic)
- **All devices** receive broadcast nerves (nudges go to every haptic nerve)

Priority is automatic. No settings. No "set primary device." The brain routes to where the human is — which is wherever they last interacted.

## The principle

A nerve is not an app. It's a sensory channel. The brain doesn't care about screen sizes, operating systems, or app store policies. It cares about: can you see (glance), can you touch (touch), can you type (keyboard), can you speak (voice), can you feel (haptic). Five questions. The answers determine the experience.

New device? Answer the five questions. Map the bundle. Done. No new app. No new UI. No new codebase. The nerve vocabulary is the abstraction that makes Core device-agnostic without being device-ignorant.

## Open questions

1. **Nerve detection** — Should devices self-report their nerve bundle, or should the brain detect capabilities? (Camera API, microphone API, vibration API, keyboard events)
2. **Nerve quality** — A phone's virtual keyboard is not a PC's keyboard. Should the brain adjust behavior based on nerve quality, not just nerve presence?
3. **Nerve conflict** — Two touch nerves active (phone and tablet). Both show chat. Human types on tablet. Does phone's chat update live? Or lag behind?
4. **Custom nerves** — Can developers define new nerve types? (Camera nerve for visual input? Gesture nerve for spatial computing? Biometric nerve for health data?)
5. **Nerve permissions** — Can a human disable specific nerves per device? "No voice on my work PC." "No haptic on my phone."
6. **Nerve and offline** — When a nerve is offline (phone in airplane mode), does the brain queue signal for it? Or does it redistribute to other active nerves?
