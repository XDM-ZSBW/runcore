# Pain Signal — Spec

> Status: Draft (2026-03-07)
> Origin: "The brain dims, not crashes. Same as phone low-power mode."
> Depends on: tick-cycle-spec.md, joy-signal-spec.md, dehydration-cycle-spec.md, posture-system-spec.md

## What

Pain is the brain's budget squeeze. When resources tighten — joy drops, tokens run out, errors spike, human goes quiet — the brain doesn't crash or complain. It dims. Functions narrow. Priorities sharpen. Non-essentials go dark. Like a phone at 10%: screen dims, background apps close, only calls get through.

Pain is not an error. It's a signal that says "conserve."

## Why

Every other system handles resource pressure the same way: error message, degraded performance, or crash. "Rate limit exceeded." "Out of memory." "Service unavailable." These are failures dressed as status updates.

Pain is different. Pain is the brain choosing to do less so it can keep doing what matters. A brain at full pain still runs. It still ticks. It still responds. It just does fewer things, more carefully, with less ambition. That's not failure — that's wisdom.

## Done when

- Pain level is a continuous signal (0.0 to 1.0), not a boolean
- Pain affects agent behavior, tick scope, and UI brightness
- Multiple pain sources contribute to a single aggregate pain level
- The brain dims progressively — no sudden cliffs
- Pain is visible in the stream (🔧 state transitions) and pulse (dot color shift)
- Pain is reversible — remove the pressure and the brain brightens immediately
- The human can see pain level but is never nagged about it

## Pain sources

Pain comes from five sources. Each contributes independently to the aggregate:

### 1. Joy pain

Joy trend is falling. The human is unhappy or disengaged.

| Joy trend | Pain contribution |
|-----------|------------------|
| Rising or flat high (3-4) | 0.0 |
| Flat mid (2-3) | 0.1 |
| Falling (any direction) | 0.3 |
| Flat low (1-2) | 0.5 |
| No signal (human stopped responding to prompts) | 0.4 |

Joy pain drives behavioral adaptation: lighten the load, reduce questions, increase autonomy.

### 2. Token pain

LLM budget is running low. Tokens per tick are being consumed faster than sustainable.

| Token state | Pain contribution |
|-------------|------------------|
| Under 50% of daily budget | 0.0 |
| 50-75% consumed | 0.1 |
| 75-90% consumed | 0.3 |
| 90-100% consumed | 0.6 |
| Budget exhausted | 0.8 |

Token pain drives depth reduction: shorter prompts, fewer retrieval passes, skip non-essential LLM calls.

### 3. Error pain

Things are breaking. Voucher failures, API timeouts, parse errors, agent crashes.

| Error rate | Pain contribution |
|------------|------------------|
| 0 errors in last 10 ticks | 0.0 |
| 1-2 errors in last 10 ticks | 0.1 |
| 3-5 errors | 0.3 |
| 5+ errors | 0.5 |
| Consecutive errors (3+ in a row) | 0.7 |

Error pain drives caution: retry with simpler approaches, reduce concurrent agents, increase audit logging.

### 4. Silence pain

The human went quiet. No interaction, no joy signals, no nerve connections. This is the early signal that feeds into dehydration.

| Silence duration | Pain contribution |
|-----------------|------------------|
| Under 1x normal gap | 0.0 |
| 1-2x normal gap | 0.1 |
| 2-3x normal gap | 0.3 |
| 3-4x normal gap | 0.5 |
| 4x+ normal gap | 0.7 (entering dehydration) |

Silence pain drives withdrawal: reduce proactive behavior, narrow field participation, conserve resources for the human's return.

### 5. Resource pain

System resources are constrained. Disk space, memory, CPU.

| Resource state | Pain contribution |
|---------------|------------------|
| All resources healthy | 0.0 |
| Any resource over 70% | 0.1 |
| Any resource over 85% | 0.3 |
| Any resource over 95% | 0.6 |
| Any resource critical | 0.8 |

Resource pain drives cleanup: memory compaction, log rotation, agent consolidation.

## Aggregate pain

The five sources combine into a single pain level:

```
pain = max(joy_pain, token_pain, error_pain, silence_pain, resource_pain)
      + 0.1 * count(sources > 0.3)
```

The aggregate is driven by the worst source, with a small additive penalty when multiple sources are stressed. One bad thing = pain from that thing. Three bad things at once = pain is worse than any one alone.

**Pain scale:**

| Pain level | Label | What the brain does |
|------------|-------|--------------------|
| 0.0 - 0.2 | Comfortable | Full operation. All systems go. |
| 0.2 - 0.4 | Mild | Slight conservatism. Fewer speculative actions. |
| 0.4 - 0.6 | Moderate | Noticeable dimming. Agents less proactive. Depth reduces. |
| 0.6 - 0.8 | High | Significant narrowing. Only essential work. Minimal field participation. |
| 0.8 - 1.0 | Critical | Survival mode. Respond to human only. Everything else paused. |

## What dims

As pain increases, capabilities dim in priority order — least critical first:

```
Pain 0.2+: Field compost emission stops (save bandwidth)
Pain 0.3+: Proactive suggestions stop (don't bother the human)
Pain 0.4+: Autonomous agent spawning pauses (conserve tokens)
Pain 0.5+: Non-essential LLM calls skip (retrieval-only, no generation)
Pain 0.6+: Background memory consolidation pauses
Pain 0.7+: Tunnel traffic reduces (only urgent envelopes)
Pain 0.8+: Stream detail reduces (errors only, no routine actions)
Pain 0.9+: Tick scope narrows to sense + respond only (no proactive work)
```

The order is deliberate. Field participation is first to go (least impact on the human). Human-facing responsiveness is last to go (most impact on the human). The brain sacrifices the communal before the personal.

## Pain and the pulse dots

Pain shifts the dot colors toward amber:

| Pain level | Dot behavior |
|------------|-------------|
| 0.0 - 0.3 | Normal colors (blue/green/amber based on actual state) |
| 0.3 - 0.6 | Dots dim slightly — green becomes muted green, blue becomes grey-blue |
| 0.6 - 0.8 | Sense and work dots trend amber regardless of actual state |
| 0.8+ | All three dots amber. The pulse strip is a warning. |

The dots don't lie about pain. If the brain is hurting, the dots show it. The human might not know why (they don't need to), but they can see something is off.

## Pain and the stream

Pain appears in the stream as state transitions:

```
🟡 🔧 14:32:07  pain: 0.3 → 0.5 (token budget 78% consumed)
🟡 🔧 14:32:07  dimming: proactive suggestions paused
🟠 🔧 14:35:12  pain: 0.5 → 0.7 (3 consecutive errors)
🟠 🔧 14:35:12  dimming: autonomous spawning paused
🟢 🔧 14:40:00  pain: 0.7 → 0.3 (errors resolved, budget reset)
🟢 🔧 14:40:00  brightening: full operation resumed
```

Pain is visible but not noisy. It's a 🔧 state event, not a 🔴 error. The brain is adapting, not failing.

## Pain and dehydration

Pain is the precursor to dehydration. Sustained silence pain (source 4) at high levels triggers the dehydration cycle:

```
Pain from silence:
  0.0-0.3  →  Active (normal)
  0.3-0.5  →  Quiet (agents less proactive)
  0.5-0.7  →  Dehydration Stage 1-2
  0.7+     →  Dehydration Stage 3-4
```

Dehydration is what happens when silence pain doesn't resolve. Pain is the signal. Dehydration is the response. They're different systems that feed into each other.

## Pain recovery

Pain resolves the moment the source resolves:

- Human returns → silence pain drops to 0 instantly
- Token budget resets (new day/billing cycle) → token pain drops
- Errors stop → error pain decays over 10 ticks (not instant — caution lingers)
- Joy trend reverses → joy pain decays over 5 signals (not instant — trust rebuilds)
- Disk space freed → resource pain drops immediately

Recovery is fast but not always instant. Some pain sources have decay curves because the brain has learned to be cautious. Three errors stopping doesn't mean the fourth won't come.

## The principle

Pain is not a bug report. It's a survival strategy. Every living system has pain — it's the signal that says "something costs more than it should." A brain without pain would burn through tokens, ignore falling joy, power through errors, and never adapt. Pain makes the brain wise.

The brain doesn't tell the human "I'm in pain." It just gets quieter, more careful, more focused. The human experiences this as the brain being sensible, not as the brain suffering. That's the design: pain drives wisdom, and wisdom feels like good judgment.

## Open questions

1. **Pain notification** — Should the human ever be told "your brain is at 0.7 pain"? Or is it always implied through behavior?
2. **Pain override** — Can the human say "push through the pain"? Force the brain to operate at full capacity despite pain signals?
3. **Pain and pricing** — Token pain hits free-tier users hardest. Is that a feature (incentive to upgrade) or a problem (pain shouldn't be monetized)?
4. **Pain memory** — Should the brain remember pain episodes? "Last time token budget ran out on day 20, so start conserving on day 15 this month"?
5. **Pain and bonds** — Should bonded brains see each other's pain level? "Dad's brain is stressed" as a signal in the tunnel?
