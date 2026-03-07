# Posture System — Spec

> Status: Draft (2026-03-07)
> Origin: "UI is a symptom of unresolved autonomy."
> Depends on: stream-spec.md, nerve-vocabulary-spec.md, tick-cycle-spec.md, joy-signal-spec.md

## What

Three postures define how much UI the brain assembles for you. Silent — you don't see it, it's working. Pulse — you see the dots, you know the vibe. Board — you're hands-on, full surface. The brain escalates and decays between postures based on what's happening, not what you clicked.

## Why

Most apps have one mode: fully on. Open the app, everything's there. Close the app, it's gone. That's a light switch, not a relationship.

A good assistant reads the room. When you're busy, they're quiet. When something needs attention, they tap your shoulder. When you sit down to work together, they spread out the papers. Three modes. Not a settings page — a posture that adapts.

The posture system means the brain is always running but the UI footprint matches the moment. Silent when you're sleeping. Pulse when you're glancing. Board when you're working. The transition is automatic, but the human can pin it.

## Done when

- Three postures exist: silent, pulse, board
- Posture escalates automatically based on intent accumulation
- Posture decays automatically based on silence duration
- The human can pin a posture (lock it, override auto-transitions)
- Each posture assembles a different UI surface from the active nerve bundle
- Posture is per-session (two devices can be in different postures)
- A parent never thinks about posture — it just feels right

## The three postures

### Silent

**What you see:** Nothing. Maybe a system tray dot. Maybe a lock screen badge. The brain is running — ticking, sensing, working — but the UI is absent.

**When:** No recent interaction. No urgent signals. The brain is calm and the human is elsewhere.

**What's happening underneath:**
- Tick cycle runs normally (sense → work → joy)
- Agents execute autonomous tasks
- Memory consolidates
- Bonds stay active, envelopes process
- Joy still measures (ambient signal, not prompted)

**Nerves active:** Glance (minimal — badge/tray icon only). Haptic (for urgent nudges only).

**The principle:** Silent doesn't mean off. It means the brain respects your attention. Most AI products scream for engagement. Silent is the opposite — the brain earns the right to escalate by being useful when you do look.

### Pulse

**What you see:** The three dots. The pulse strip. A breathing indicator that tells you the vibe without requiring interaction. Sense, Work, Joy — three colors, one glance.

**When:** You glanced at the brain (opened the app, looked at your watch, checked the widget). Or the brain nudged you (something crossed an attention threshold). You're aware but not engaged.

**What you get:**
- Pulse strip (three dots with current state)
- Nudge queue (things that crossed thresholds since last look)
- One-tap actions (acknowledge nudge, tap joy signal, dismiss)
- No chat. No stream. No detailed views.

**Nerves active:** Glance (full — dots, colors, counts). Touch (limited — tap to acknowledge). Haptic (nudge patterns).

**The principle:** Pulse is the "check your watch" moment. Two seconds. You know the state of your world. You either move on (back to silent) or lean in (escalate to board).

### Board

**What you see:** Everything. Chat + stream. Full interaction surface. You're working with your agent.

**When:** You started typing. You opened the full app. You asked a question. You've been interacting for more than a few moments. The brain knows you're here and present.

**What you get:**
- Chat (left pane — full conversation)
- Stream (right pane — live agent activity with emoji + nudge)
- All navigation (threads, history, settings)
- Shape/twist/pause controls on the stream
- Joy prompts at natural pauses
- Full nerve vocabulary for the active device

**Nerves active:** All available nerves for the connected device.

**The principle:** Board is the "sit down and work" posture. The brain spreads out everything you might need. You're the CEO at the desk, not the CEO in the hallway.

## Transitions

### Escalation (silent → pulse → board)

Escalation is driven by intent accumulation, not by a single action.

**Intent signals:**

| Signal | Weight | Example |
|--------|--------|---------|
| Open app / connect device | +2 | Looked at Dash |
| Tap a dot or nudge | +1 | Acknowledged something |
| Start typing | +3 | Composing a message (instant board) |
| Voice activation | +3 | "Hey Dash" (instant board) |
| Multiple taps in sequence | +1 each | Browsing, exploring |
| Joy signal tap | +1 | Responded to prompt |

**Thresholds:**
- Silent → Pulse: 1 signal (any interaction = show the dots)
- Pulse → Board: 5 accumulated weight within the session, OR any keyboard/voice input (instant escalation)

Typing or speaking always escalates to board immediately. You don't pulse before a conversation — you sit down.

### Decay (board → pulse → silent)

Decay is driven by silence duration.

| Transition | Default duration | What triggers |
|------------|-----------------|---------------|
| Board → Pulse | 5 minutes of no interaction | You stopped typing, tapping, speaking |
| Pulse → Silent | 30 minutes of no interaction | You stopped looking |

Decay is gentle. Board doesn't snap to silent — it steps through pulse first. The dots linger. You get a moment to re-engage before the brain goes quiet.

**Decay is paused by:**
- Active agent work (agent is building something, stream is flowing — board stays)
- Pending human decision (agent asked a question, waiting for answer — board stays)
- Crisis mode (any archetype in crisis — board stays until resolved)

### Pinning

The human can pin a posture. "Stay in pulse." "Stay in board." "Go silent."

Pinning overrides auto-transitions in both directions:
- Pin to pulse: won't decay to silent, won't escalate to board (unless you type)
- Pin to board: won't decay at all (stays full surface)
- Pin to silent: won't escalate (only urgent nudges with haptic can break through)

Unpin resumes auto-transitions from current state.

Pinning is per-device. Pin your PC to board (working session) while your phone stays in pulse (ambient awareness).

## Posture and the stream

The stream only exists in board posture. In pulse, you see the dots — which ARE the stream compressed to three signals. In silent, you see nothing — but the stream is still recording to activity.jsonl.

| Posture | Stream visibility |
|---------|------------------|
| Silent | Recording only. No visual. |
| Pulse | Compressed to three dots (sense/work/joy aggregate) |
| Board | Full stream with emoji, nudge colors, expand/collapse |

The stream doesn't turn on and off — it's always there. The posture determines how much of it you see.

## Posture and nerves

Posture determines which nerves are active, but nerves also influence posture:

```
Watch (glance + haptic only):
  → Can reach pulse but never board
  → Board requires touch or keyboard, which watch doesn't have

Phone (glance + touch + voice + haptic):
  → Can reach board through touch or voice
  → Pulse is the natural resting state (phone in pocket = pulse)

PC (glance + touch + keyboard + voice):
  → Board is the natural working state
  → Typing = instant board, always
```

A device with only glance + haptic can never reach board posture. The nerve bundle constrains the posture ceiling. This isn't a limitation — it's correct. A watch shouldn't try to be a workstation.

## Posture is orthogonal

Posture is independent of four other axes:

| Axis | What it controls | Not posture |
|------|-----------------|-------------|
| Tier | Capabilities (free vs paid features) | Posture works the same at every tier |
| Bonding | Trust relationships | Posture doesn't change based on who you're bonded with |
| Nerve vocabulary | Which interfaces are available | Nerves constrain posture ceiling, but posture is separate |
| Dehydration | Brain activity level | A dehydrating brain can still be in board posture if the human returns |

All four axes are independent. A free-tier user in board posture with one bond and a phone nerve bundle is a valid state. Every combination works.

## Posture and routes

Server routes are gated by posture. A route that serves board-level content returns 404 in pulse posture — not forbidden, just not assembled yet.

```
GET /api/stream     → 404 in silent/pulse, 200 in board
GET /api/pulse      → 404 in silent, 200 in pulse/board
GET /api/status     → 200 always (posture-independent)
```

The 404 means "this surface doesn't exist right now." Not "you can't access this." The surface isn't built yet because the posture hasn't assembled it. Escalate and it appears.

## The principle

Posture is the brain's way of respecting attention. Most software demands presence — open me, use me, engage with me. Posture does the opposite: the brain withdraws when you're not looking, shows just enough when you glance, and opens fully when you sit down.

The best UI is mostly see, rarely interact. Pulse is the see. Board is the interact. Silent is the trust — the brain working without demanding your eyeballs.

## Open questions

1. **Posture and notifications** — Should posture affect notification delivery? Silent = only critical. Pulse = important. Board = everything?
2. **Posture history** — Should the brain track posture patterns? "You're usually in board from 9-11am." Use this for predictive assembly.
3. **Shared posture** — When two bonded brains are mutual-present, should their postures sync? Both escalate to board for a conversation?
4. **Posture and joy** — Does sustained low joy affect posture decay? "You seem tired, going to pulse" — or is that paternalistic?
5. **Posture transitions and the stream** — Should posture transitions themselves appear in the stream? "🔧 posture: pulse → board (keyboard detected)"
