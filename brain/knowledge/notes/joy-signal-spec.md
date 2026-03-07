# Joy Signal — Spec

> Status: Draft (2026-03-07)
> Origin: "My agents should prompt me for feedback. How is it going? 1, 2, 3, 4 only."
> Depends on: stream-spec.md, the-fields-spec.md, core-os-spec.md

## What

The agent asks "How's it going?" You tap a number. That's the joy signal. No surveys. No text. No explanation. One tap. The number feeds the joy dot directly.

## Why

Joy was measuring task completion. Task completion is Work, not Joy. Joy is how the human feels about where they are. The only way to know how someone feels is to ask. The only way to ask without creating friction is to make the answer one tap.

Every other feedback system is broken because it asks too much. Star ratings want 5 choices and a text box. NPS wants 0-10 and "why." Surveys want minutes. All of them get ignored or gamed.

1, 2, 3, 4. That's it. The human knows what the number means to them. The system doesn't need to know why. It just needs the signal.

## Done when

- Agent prompts "How's it going?" at natural pauses
- Human taps 1, 2, 3, or 4
- Joy dot updates immediately
- Pattern over time produces a joy curve
- Agent adapts behavior based on trend
- Asking never creates friction (timing, frequency, context are all right)
- A parent can do it without thinking

## The scale

```
  1     2     3     4
rough  meh   good  great
```

Four choices. Not five — no middle to hide in. You're either below center or above it. The scale forces a lean.

No labels shown by default. Just the numbers. The human assigns their own meaning. 1 is whatever 1 means to you today. The system doesn't interpret the number — it tracks the pattern.

## What the number is NOT

- Not a rating of the agent (it's a reading of you)
- Not a satisfaction score (it's a feeling, not an evaluation)
- Not actionable feedback (the agent doesn't ask "why" — it reads the trend)
- Not a metric for anyone but you (never aggregated with identity, never reported)

## When to ask

The agent asks at natural pauses. Never interrupts. Never asks twice in the same hour. Never asks when you're mid-thought.

| Trigger | Why |
|---|---|
| End of a conversation thread | Natural pause. You finished a thought. |
| After an agent completes a spec task | Work landed. How does it feel? |
| After 30+ minutes of active session | Check-in at a natural interval. |
| When posture transitions (board → pulse → silent) | The energy is shifting. Capture the feeling. |
| When you return after absence | "Welcome back. How's it going?" |

| Never ask when | Why |
|---|---|
| Mid-conversation | Interruption kills flow |
| During an error/fix cycle | You already feel bad. Don't make them say it. |
| Within 60 minutes of last ask | Feedback fatigue |
| While agents are spawning/working | Wait for the result, not the process |
| On the watch (glance nerve) | One tap is still too much on a watch. Infer from presence patterns instead. |

## How it looks

### On PC/tablet (keyboard + touch nerve)

Inline in chat, after a natural pause:

```
Dash: Done — three agents finished building from the stream spec.

  How's it going?
  [1]  [2]  [3]  [4]

```

Tap a number. It fades. Chat continues. No confirmation. No "thanks for your feedback." The number is absorbed. The conversation moves on.

### On phone (voice + touch nerve)

Same inline prompt. Buttons are large enough for thumb tap. Swipe to dismiss without answering (that's data too — "didn't want to answer" is a signal).

### On watch (glance nerve)

Don't ask. Infer from:
- Did they look at the dots? (engagement)
- How long did they look? (concern vs glance)
- Did they open phone after looking? (escalation = lower joy)

### Voice interface

```
Dash: "How's it going? One through four."
You: "Three."
Dash: [continues]
```

## What happens with the number

### Immediate: Joy dot updates

The joy dot color shifts based on the most recent signal blended with the rolling average.

| Number | Dot response |
|---|---|
| 4 | Green — hold steady |
| 3 | Green — slight adjustment toward more of the same |
| 2 | Shift toward amber — something's off, lighten the load |
| 1 | Amber — reduce friction, increase autonomy, fewer questions |

The dot doesn't snap to the number. It blends. A single 2 after a week of 4s doesn't turn the dot amber. A trend of 2s does.

### Short-term: Agent adapts

The agent reads the trend, not the individual number.

| Trend | Agent response |
|---|---|
| Rising (2 → 3 → 4) | Hold course. Whatever's happening, keep doing it. |
| Falling (4 → 3 → 2) | Lighten touch. Fewer questions. More autonomy. Less noise. |
| Flat high (4, 4, 4) | Everything's working. Maintain. |
| Flat low (2, 2, 2) | Something systemic is wrong. Surface it in chat: "I've noticed things feel stuck. Want to talk about it?" |
| Spike down (4 → 1) | Something happened. Don't ask why. Just be gentler. Reduce load. |
| Spike up (1 → 4) | Breakthrough. Note what changed. Reinforce that pattern. |

The agent never says "you rated us a 2." The number disappears into the dot. The adaptation is felt, not announced.

### Long-term: Joy curve

Over weeks and months, the numbers form a curve. The curve is personal. It lives in your brain, not in the field.

```
Joy curve (30 days):

4 │          ██    ██  ██████
3 │  ████████  ████  ██      ████
2 │██                            ██
1 │
  └────────────────────────────────
    Week 1    Week 2    Week 3    Week 4
```

The curve answers questions no single number can:
- When are you happiest? (day of week, time of day, after what kind of work)
- What kills your joy? (correlate dips with events — errors, manual interventions, friction)
- Is the trend improving? (are we getting better at serving you)
- What's your baseline? (some people live at 3. Some live at 2. The agent calibrates to YOU, not to an absolute scale)

### Field contribution (anonymous)

Your joy signal contributes to the field's Joy layer — but only as an anonymous number in the aggregate. The field knows "average joy across all brains is 3.2 today." It doesn't know your number. Your curve never leaves your brain.

Field-level joy dropping = weather signal. "Something is hard across the field right now." Your agent can factor that in: "It's not just you — the field is tough today."

## Calibration

The first few signals calibrate the system to you. "4" from someone who's naturally reserved means something different than "4" from someone who's naturally enthusiastic. The agent learns your personal scale from the pattern.

No explicit calibration step. No "what does 3 mean to you?" Just use it. The pattern reveals the person.

After N signals (maybe 20), the agent has a baseline. After that, deviations from baseline are more meaningful than absolute numbers. Your "2" might be someone else's "3." That's fine. The system tracks YOUR curve, not a universal one.

## Storage

```
brain/memory/joy.jsonl (append-only)

{"ts":"2026-03-07T09:00:00Z","signal":3,"trigger":"thread_end","context":"spec_session"}
{"ts":"2026-03-07T10:30:00Z","signal":4,"trigger":"task_complete","context":"stream_spec_built"}
{"ts":"2026-03-07T14:00:00Z","signal":2,"trigger":"session_return","context":"after_lunch"}
```

Minimal. Timestamp, number, what triggered the ask, lightweight context tag. No chat content. No explanation. The number speaks for itself.

## What this replaces

| Old joy measurement | Problem | New |
|---|---|---|
| Task completion count | Counts work, not feeling | Human says how they feel |
| BragBin items | Requires effort to log wins | One tap, no effort |
| Sentiment analysis on chat | Inaccurate, creepy, inferred | Direct signal, no inference |
| No measurement at all | Joy dot was guessing | Joy dot is listening |

## The principle

Don't infer what you can ask. Don't ask more than you need. Don't do anything with the answer except listen.

The joy signal is the simplest possible feedback loop: ask, listen, adapt. The human doesn't owe the system an explanation. The system doesn't owe the human a response. The number flows into the dot. The dot breathes. The agent adjusts. Nobody talks about it.

## Open questions

1. **Dismiss = signal?** — If the user swipes away without answering, is that a 2? A null? Tracked separately as "declined"?
2. **Recovery prompt** — After a string of 1s and 2s, should the agent explicitly offer help? Or just silently adapt?
3. **Shared joy** — In a family/team, should aggregate joy be visible? "The household is at 3.2 today." Opt-in only.
4. **Joy and dehydration** — Does sustained low joy trigger dehydration warnings? Or is that conflating mood with system health?
5. **Gaming** — What if someone always taps 4 to dismiss the prompt? The curve is flat, the signal is useless. Detect and reduce frequency?
