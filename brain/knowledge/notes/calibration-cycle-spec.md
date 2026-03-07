# Calibration Cycle — Spec

> Status: Draft (2026-03-07)
> Origin: "Calibration = onboarding = performance review. Same process."
> Depends on: joy-signal-spec.md, tick-cycle-spec.md, posture-system-spec.md, agent-archetypes-spec.md

## What

Calibration is how the brain learns what "right" means for you. Not a setup wizard. Not a preferences page. A living process that runs during onboarding, repeats on a cadence, and produces the thresholds that drive the pulse dots, joy interpretation, posture timing, and agent behavior.

Onboarding IS calibration. Performance review IS calibration. They're the same conversation: "Do these thresholds still fit you?"

## Why

Every AI product has a cold start problem. Day one, the agent knows nothing about you. Most products solve this with a preferences form or a "tell me about yourself" questionnaire. That's a snapshot — accurate for one day, stale by next week.

Calibration is continuous. The first calibration happens during onboarding. Then it recurs — every N interactions, every C cycles, or when the joy signal says something shifted. The brain doesn't assume it knows you. It checks.

## Done when

- First-run onboarding produces working thresholds for all three dots (sense/work/joy)
- Calibration recurs automatically on a cadence (not a calendar — a usage cadence)
- Each calibration is one conversation, under 5 minutes
- Thresholds adapt to the human, not the human to the thresholds
- A parent can complete calibration without understanding what a threshold is
- Performance review and onboarding use the exact same process
- Calibration results are stored and diffable (you can see how your thresholds evolved)

## What gets calibrated

### Pulse dot thresholds

The three dots (sense/work/joy) need to know what "calm" vs "active" vs "attention" means for you.

| Dot | What it measures | Calibration question |
|-----|-----------------|---------------------|
| Sense | How much is happening in your world | "How many inbound signals before you want to know?" |
| Work | How much your agents are doing | "How many active tasks before you want visibility?" |
| Joy | How you're feeling about it all | "What does a good day feel like? A bad day?" |

These aren't literal questions. They're derived from the calibration conversation. The agent asks natural questions and maps answers to thresholds.

### Agent behavior

| Behavior | What it controls | Calibration input |
|----------|-----------------|-------------------|
| Autonomy | How much the agent does without asking | "Do you want to approve everything, or just the big stuff?" |
| Proactivity | How often the agent initiates | "Should I suggest things, or wait for you to ask?" |
| Verbosity | How much the agent explains | "Short answers or detailed explanations?" |
| Pace | How fast the agent works through tasks | "One thing at a time or parallel?" |

### Posture timing

| Parameter | What it controls | Calibration input |
|-----------|-----------------|-------------------|
| Board decay | How long before board → pulse | Derived from session length patterns |
| Pulse decay | How long before pulse → silent | Derived from check-in frequency |
| Joy prompt frequency | How often to ask "How's it going?" | Derived from response rate to prompts |

## The calibration conversation

### First run (onboarding)

The first calibration is the onboarding experience. No forms. No wizards. A conversation.

```
Dash: Hey. I'm Dash. I work for you — not the other way around.
      Before we start, I need to learn how you like to work.
      This takes about 3 minutes. Ready?

You:  Sure.

Dash: When I'm working on something for you, do you want to
      see what I'm doing, or just hear about it when I'm done?

You:  Just tell me when it's done.

Dash: Got it — high autonomy. I'll handle things and report back.
      If something's unclear or risky, I'll ask first.

      When things are going well, how do you want to know?

You:  I don't need to know. Just keep going.

Dash: Okay — minimal pulse for work. I'll only light up the
      work dot when something needs your attention.

      What about when things go wrong?

You:  Tell me immediately.

Dash: Understood — fast escalation on problems. Amber dot, nudge,
      and a message.

      Last one: when I ask "how's it going?" — 1, 2, 3, or 4 —
      how often is too often?

You:  Maybe once or twice a day.

Dash: Perfect. I'll check in at natural pauses, max twice a day.

      We're calibrated. I'll check back in a couple weeks to see
      if these settings still feel right. You can also just tell me
      "recalibrate" anytime.
```

Total time: under 3 minutes. No technical language. No sliders. No checkboxes. A conversation that produces:

```yaml
calibration:
  version: 1
  date: "2026-03-07"
  thresholds:
    autonomy: high          # agent decides most things
    work_visibility: low    # only show work dot on attention-needed
    escalation_speed: fast  # amber + nudge on any problem
    joy_frequency: 2/day    # max 2 prompts per active day
    verbosity: concise      # short answers
    proactivity: low        # wait for asks, don't suggest
  derived:
    sense_calm: 5           # under 5 inbound signals = blue dot
    sense_active: 15        # 5-15 = green dot
    sense_attention: 15+    # over 15 = amber dot
    work_calm: 0            # no active tasks = blue
    work_active: 3          # 1-3 = green (but invisible per preference)
    work_attention: 3+      # over 3 or any error = amber + nudge
    joy_baseline: null      # not enough data yet — calibrates from first 20 signals
```

### Recalibration (performance review)

Same conversation. Shorter. Happens automatically.

**Trigger conditions (any one):**
- N interactions since last calibration (default: 200)
- C tick cycles since last calibration (default: 500)
- Joy trend shift (baseline moved significantly)
- Human says "recalibrate"

```
Dash: It's been a couple weeks. Quick check-in on how we're working.

      You said high autonomy — I've been handling things on my own.
      37 decisions since last calibration, you intervened on 2.
      Still feel right?

You:  Yeah, that's good.

Dash: Your joy readings average 3.1 — steady. Any adjustment?

You:  Actually, ask me more often. I like the check-ins.

Dash: Done — bumping to 3-4 times a day on active days.

      Everything else holding?

You:  Yeah.

Dash: Calibrated. Next check-in in a couple weeks.
```

The recalibration shows you data from the interval — how many decisions, what the joy trend was, how often you intervened. It's a performance review for the agent, driven by the human's experience.

## Calibration storage

```
brain/calibration/
  history.jsonl           # Every calibration, append-only
  current.yaml            # Current active thresholds
```

**history.jsonl:**
```jsonl
{"version":1,"date":"2026-03-07","thresholds":{"autonomy":"high","work_visibility":"low",...},"source":"onboarding"}
{"version":2,"date":"2026-03-21","thresholds":{"autonomy":"high","joy_frequency":"4/day",...},"source":"recalibration","delta":{"joy_frequency":{"from":"2/day","to":"4/day"}}}
```

Every calibration is stored with its delta from the previous one. You can see how your relationship with the agent evolved over time. The history is yours — part of your brain, never shared.

## Calibration and archetypes

Each archetype calibrates differently:

| Archetype | What it calibrates | How |
|-----------|-------------------|-----|
| Founder | Full spectrum — autonomy, pace, verbosity, joy, posture | Conversational (the full calibration experience) |
| Template | Domain-specific thresholds — task handling, escalation | Lighter conversation (fewer questions, domain-focused) |
| Operator | Process parameters — schedule adherence, reporting frequency | Data-driven (show metrics, ask "still right?") |
| Observer | Alert thresholds — what's worth reporting, sensitivity | Threshold review (show what it flagged, ask "too much? too little?") |
| Creator | Not calibrated to a human — calibrated to the dictionary | Self-calibrating (spec consistency, protocol adherence) |

## Calibration and the field

Calibration data never enters the field. Your thresholds are personal. But aggregate calibration patterns (anonymized) can inform defaults:

- "Most humans prefer autonomy: high on day 30" → adjust default for new brains
- "Joy frequency sweet spot is 2-3/day for daily users" → default for that usage pattern
- "Concise verbosity is 3x more common than detailed" → default to concise

The field helps calibrate new brains faster by providing better starting defaults. But each brain's calibration is sovereign.

## The principle

Calibration is not configuration. Configuration is what you set before using the product. Calibration is what emerges from using it. The brain doesn't ask you to fill out a form — it has a conversation, watches how you respond, and adjusts.

The same process runs on day 1 and day 100. On day 1 it's onboarding. On day 100 it's a performance review. The only difference is how much data the brain has to show you. The question is always the same: "Do these thresholds still fit you?"

## Open questions

1. **Silent calibration** — Can the brain calibrate without asking? Just watch behavior and adjust? Or does the human need to confirm every change?
2. **Calibration conflict** — What if joy signal says "things are bad" but the human says "everything's fine" in calibration? Trust the signal or the words?
3. **Calibration across devices** — Same thresholds on all devices? Or per-device calibration? (Phone might want higher autonomy than PC)
4. **Calibration sharing** — Can a human export their calibration to a new brain? "Make this one feel like my other one"?
5. **Calibration and dehydration** — When a brain rehydrates after months, should it recalibrate immediately? The human may have changed.
