# Tick Cycle — Spec

> Status: Draft (2026-03-07)
> Origin: "Sense → Work → Joy. Strict order. Every tick."
> Depends on: core-os-spec.md, stream-spec.md, joy-signal-spec.md, the-fields-spec.md, dehydration-cycle-spec.md

## What

The tick cycle is the fundamental rhythm of every brain. Sense, then Work, then Joy. In that order. Every time. No skipping. No reordering. This is not a loop — it's a heartbeat. The brain doesn't decide when to tick. Events trigger ticks. The tick processes one cycle and waits for the next event.

## Why

Every other agent architecture runs on polling loops, task queues, or event-driven chaos. There's no rhythm. No structure. The agent does whatever's next in the queue. It never stops to sense the world before acting. It never checks how things went after acting.

Humans have this rhythm naturally: perceive, act, feel. We look around, we do something, we check how it went. The tick cycle gives the brain the same structure. No action without sensing first. No sensing without reflecting on the last action.

The three dots on the pulse strip are this cycle made visible. Sense dot. Work dot. Joy dot. The tick is the heartbeat. The dots are the pulse.

## Done when

- Every brain runs sense → work → joy in strict order
- Ticks are event-driven, not timer-driven
- Each phase reads from and writes to specific brain locations
- The stream shows each tick phase as it happens
- The pulse dots reflect the current phase and its health
- Skipping a phase is architecturally impossible (not just discouraged — enforced)
- The tick cycle degrades gracefully during dehydration (dims, doesn't break)

## The three phases

### Sense

The brain opens its eyes. What's changed since last tick?

**Reads:**
- Ledger (relationship distance — who's close, who's drifting)
- Inbound tunnel envelopes (what arrived from bonds)
- Nerve connections (who's plugged in right now)
- Field signal (presence, pulse, weather, compost)
- Joy history (how did the human feel last time)
- Dehydration state (what ring are we in)
- File watchers (did a spec land, did a notification arrive)

**Writes:**
- Working memory: sense snapshot (what the world looks like right now)
- Sense signal to pulse dot

**Does NOT:**
- Take any action
- Modify any brain file
- Send any message
- Spawn any agent

Sense is read-only. The brain perceives. That's it. The snapshot becomes the input to Work.

### Work

The brain acts. Based on what Sense found, do what needs doing.

**Reads:**
- Sense snapshot (what just happened)
- Goals (what are we trying to achieve)
- Specs (what's been designed and needs building)
- Access manifest (what are we allowed to do)
- Agent state (who's running, who's idle, who's stuck)

**Writes:**
- Brain files (memory entries, board items, activity log)
- Agent spawns (planner reads specs, creates tasks, spawns agents)
- Tunnel sends (outbound envelopes to bonded instances)
- Nerve responses (sync snapshots, API responses)
- Work signal to pulse dot

**Governed by:**
- Voucher system (authorized actions only)
- Access manifests (scoped by role)
- Membrane (all outbound goes through redaction)
- Audit log (every action recorded)

Work is where things happen. Agents spawn. Messages send. Memory stores. But Work only acts on what Sense perceived. No freelancing. No acting on stale state.

### Joy

The brain reflects. What happened? How did it go? What's the delta?

**Reads:**
- Work output (what was accomplished this tick)
- Human joy signal (if one was given — the 1-4 tap)
- Error state (did anything fail)
- Goal progress (did we move closer or further)
- Previous joy reading (what's the trend)

**Writes:**
- Joy signal to pulse dot
- Joy metric to `brain/memory/joy.jsonl`
- Adaptation signals (if trend is falling, emit "lighten load" for next Sense)
- Field contribution: anonymous joy number to field aggregate

**Measures:**
- Delta: did things get better or worse since last tick?
- Friction: how many errors, manual interventions, retries happened?
- Creation: was something new made, or just maintenance?
- Progress: closer to goals or treading water?
- Human signal: what did the human say (if anything)?

Joy is not celebration. It's measurement. The brain checks: was that tick good? The answer feeds the next Sense phase — the cycle continues with knowledge of how the last cycle went.

## Tick trigger — events, not timers

The tick doesn't run on a clock. Events trigger ticks.

| Event | Triggers tick because |
|---|---|
| Human sends a message | The world changed — sense it, act on it, measure it |
| Spec file changes | New work arrived — sense it, plan it, measure it |
| Notification arrives | Cross-agent signal — sense it, process it, measure it |
| Agent completes a task | Work finished — sense the result, continue or stop, measure it |
| Nerve connects | Someone plugged in — sense who, serve them, measure impact |
| Tunnel envelope arrives | Bond signal — sense it, process it, measure it |
| Joy signal received | Human spoke — sense the feeling, adapt, log it |
| Dehydration threshold crossed | State changed — sense new ring, adjust behavior, measure |

**No event = no tick.** A brain with nothing happening doesn't tick. It rests. This is not a bug — it's the architecture. An idle brain consumes zero cycles. A busy brain ticks as fast as events arrive.

**Multiple events between ticks:** Events queue. The next Sense phase reads all queued events at once. One tick can process multiple events. This prevents tick storms — 10 events don't cause 10 ticks. They cause 1 tick that senses 10 things.

## Tick speed

The tick is as fast as its slowest phase.

| Phase | Typical duration | What determines speed |
|---|---|---|
| Sense | Milliseconds | File reads, field reads, snapshot assembly |
| Work | Seconds to minutes | LLM calls, agent spawns, file writes |
| Joy | Milliseconds | Metric calculation, dot update |

Most ticks complete in seconds. Heavy work ticks (LLM planner call, agent spawn) take longer. Joy is always fast — it's just measurement.

The stream shows tick boundaries. You can see: "Sense started... Work started... agents spawning... Joy: delta positive." The tick is the unit of visibility in the stream.

## Strict order — why it matters

Sense → Work → Joy. Never Work → Sense. Never Joy → Work. Never Sense → Joy → Work.

**Why Sense must come first:**
Without sensing, Work acts on stale state. The agent doesn't know what changed. It's flying blind. Every bad AI behavior — hallucination, repetition, irrelevance — comes from acting without perceiving first.

**Why Work must come second:**
Work needs the sense snapshot. It can't act on what it hasn't perceived. And it can't measure its own output — that's Joy's job. Work acts. It doesn't judge.

**Why Joy must come last:**
Joy measures the delta. It needs both the sense snapshot (what was the world before) and the work output (what changed). Without both, it can't calculate: did we improve? Joy without Work is navel-gazing. Joy without Sense is delusion.

**Enforcement:**
The tick runner is a state machine with three states. Each state must complete before the next begins. No concurrent phases. No phase skipping. If Work fails mid-phase, the tick aborts and Joy records the failure. If Sense finds nothing, Work is a no-op and Joy records "quiet tick."

```typescript
type TickPhase = "sense" | "work" | "joy";

async function tick(events: Event[]): Promise<void> {
  const snapshot = await sense(events);   // Phase 1: perceive
  const output = await work(snapshot);     // Phase 2: act
  await joy(snapshot, output);             // Phase 3: reflect
}
```

Three lines. That's the entire tick. Everything else is implementation inside each phase.

## Tick and the stream

The stream (stream-spec.md) is the tick made visible.

```
09:14:01 ▶ sense    3 events queued: spec change, notification, nerve connect
09:14:01 ▶ sense    field pulse: 0.72/0.61/0.44
09:14:01 ▶ sense    joy trend: rising (3, 3, 4)
09:14:01 ▶ sense    snapshot ready

09:14:02 ▶ work     planner: 2 specs ready to build
09:14:15 ▶ work     spawning: "Implement stream" (PID 68788)
09:14:15 ▶ work     spawning: "Plan board retirement" (PID 70992)
09:14:15 ▶ work     tunnel: sent availability to bond_7f3a

09:14:16 ▶ joy      delta: +0.3 (2 agents spawned, 0 errors, creation detected)
09:14:16 ▶ joy      dot: green (holding)
09:14:16 ▶ joy      field contribution: 3.2 (anonymous)
```

The stream's three action categories (sense, work, joy) are literally the three tick phases. Monitor the stream and you're watching the heartbeat.

## Tick and the dots

The three pulse dots map directly to the three phases:

| Dot | Phase | What it reflects |
|---|---|---|
| Sense dot (first) | Sense | How much is happening in the world. Calm blue = quiet field. Active blue = lots of inbound. Amber = something demands attention. |
| Work dot (second) | Work | How much is being done. Green = agents working, progress happening. Blue = idle, nothing to do. Amber = errors, stuck agents. |
| Joy dot (third) | Joy | How it's going. Green = positive trend, creation happening, human happy. Blue = neutral, maintaining. Amber = friction, falling trend. |

The dots don't update on a timer. They update at the end of each tick phase. Sense finishes → sense dot updates. Work finishes → work dot updates. Joy finishes → joy dot updates. The dots pulse with the heartbeat.

## Tick and dehydration

As a brain dehydrates, the tick cycle dims.

| Stage | Tick behavior |
|---|---|
| Active | Full tick on every event |
| Quiet | Full tick but agents less proactive in Work phase |
| Stage 1 | Sense reads only local (no field). Work is no-op. Joy still measures. |
| Stage 2 | Sense reads only nerve + ledger. Work handles only inbound. Joy still measures. |
| Stage 3 | Sense reads only nerve (waiting for human). Work is off. Joy records silence. |
| Stage 4 | Minimal sense (checking for rehydration signal only). Work = notifications. Joy = last reading. |
| Composted | No ticks. Brain sealed. |

The tick doesn't stop during dehydration — it narrows. Sense gets quieter. Work gets smaller. Joy gets simpler. The heartbeat slows but never stops until composting.

## Tick and multiple agents

One brain, one tick cycle. Agents are spawned during Work phase but run independently between ticks. The tick is the brain's rhythm. Agents are its hands.

```
Tick 1:
  Sense: spec arrived
  Work:  planner spawns Agent A and Agent B
  Joy:   delta positive, work initiated

[Between ticks: Agent A and Agent B run independently]

Tick 2 (triggered by Agent A completing):
  Sense: Agent A completed, Agent B still running, new notification
  Work:  process Agent A output, handle notification
  Joy:   delta positive, progress on spec

Tick 3 (triggered by Agent B completing):
  Sense: Agent B completed, all agents idle
  Work:  commit results, update spec status
  Joy:   delta positive, spec criteria met
```

Agents don't tick. The brain ticks. Agents are concurrent processes that the brain spawns in Work and senses in Sense. The tick is the brain's breathing. Agents are the brain's doing.

## Architecture

```
Events → Queue → Tick Runner
                    │
                    ├── sense(events)
                    │     ├── read ledger
                    │     ├── read tunnels
                    │     ├── read nerves
                    │     ├── read field
                    │     ├── read joy history
                    │     └── → Snapshot
                    │
                    ├── work(snapshot)
                    │     ├── evaluate goals
                    │     ├── read specs
                    │     ├── run planner
                    │     ├── spawn agents
                    │     ├── process inbound
                    │     ├── send outbound
                    │     └── → Output
                    │
                    └── joy(snapshot, output)
                          ├── calculate delta
                          ├── check human signal
                          ├── update dots
                          ├── log to joy.jsonl
                          ├── emit field contribution
                          └── emit adaptation signal
```

## The principle

The tick cycle is not a feature. It's the brain's metabolism. Sense is eating. Work is doing. Joy is sleeping. Every living thing runs this cycle. The rate varies. The order never does.

A brain that acts without sensing is reckless. A brain that senses without acting is paralyzed. A brain that never measures joy is a machine. The tick cycle makes Core a living system, not a software product.

## Open questions

1. **Tick concurrency** — Can the next tick's Sense begin while the current tick's Work is still running long agents? Or strictly serial?
2. **Tick priority** — When multiple events queue, does Sense prioritize? (Human message > agent completion > field signal?)
3. **Tick budget** — Should Work have a token/time budget per tick? Prevent one tick from consuming all resources.
4. **Nested ticks** — Agents run between ticks. Should agents have their own mini tick cycle? Or is the brain-level tick sufficient?
5. **Tick visualization** — In the stream, should tick boundaries be visible? "── Tick 47 ──" separator lines? Or just phase labels?
