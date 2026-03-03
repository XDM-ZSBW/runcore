---
name: onboard
description: "Guided onboarding that seeds all five brain modules in one sitting. User says /onboard or 'set me up' or 'get started'."
user-invocable: true
disable-model-invocation: true
---

# Skill: Onboard

Invoked when a new user wants to seed their agent's brain. This skill walks through five conversations that fill the five brain modules — identity, operations, knowledge, content, and memory — so the agent is productive from session one.

## Goal

Go from empty brain to a seeded agent in one sitting. Not exhaustive. Just enough for the metabolic cycle to start producing value: voice-matched writing, goal-aware planning, tension tracking from real questions.

## Sequence

Run these five phases in order. Each phase is a conversation, not a form. Ask follow-up questions. Extract structure from natural answers. Write files at the end of each phase, not during — keep the conversation flowing.

### Phase 1: Identity — "Who are you?"

**Ask about:**
- What they do, who they serve, what makes them different
- How they talk: formal or casual? serious or playful? technical or simple?
- Words they never use. Patterns they hate. How they open and close writing.
- Paste 2-3 things they've written (emails, posts, messages) — extract voice patterns

**Write to:**
- `brain/identity/tone-of-voice.md` — Fill in the voice profile scales, banned words, signature patterns
- `brain/identity/brand.md` — Fill in positioning: who, what, for whom, distinction, guardrails

### Phase 2: Operations — "What are you building?"

**Ask about:**
- Top 1-3 goals right now. What does "done" look like for each?
- Current priorities — what matters this week?
- Any deadlines, milestones, or key results they're tracking?
- Recurring tasks or rhythms (weekly reviews, daily standups, etc.)

**Write to:**
- `brain/operations/goals.yaml` — Fill in goals with key results, targets, current progress, status
- `brain/operations/todos.md` — Seed with P0-P1 items from the conversation

### Phase 3: Knowledge — "What do you already know?"

**Ask about:**
- Topics they've already researched or have strong opinions on
- Bookmarks, articles, reference material they want the agent to know
- Domain expertise — what are they the expert on?
- If they have existing notes or docs, offer to ingest them (point to the ingest folder)

**Write to:**
- `brain/knowledge/research/[topic].md` — One file per topic, structured: summary, key points, sources
- `brain/knowledge/notes/` — Capture any loose knowledge that doesn't fit research format

### Phase 4: Open Questions — "What's unresolved?"

**Ask about:**
- What are they stuck on right now? Decisions unmade, questions unanswered.
- What tensions keep coming up? Problems they've circled without resolving.
- What would they want the agent to watch for — signals, opportunities, patterns?
- Any recurring debates or trade-offs they haven't settled?

**Write to:**
- `brain/memory/open-loops.jsonl` — Create Open Loop Packets for each genuine tension. Include anchor, dissonance, search heuristics, 7-day TTL. Follow the schema in `src/openloop/types.ts`.

### Phase 5: First Memory — "What matters to you?"

**Ask about:**
- A key decision they made recently and why
- A failure they learned from
- An experience that shaped how they work
- What they'd tell a new assistant on day one

**Write to:**
- `brain/memory/decisions.jsonl` — Log 1-2 key decisions with reasoning
- `brain/memory/failures.jsonl` — Log any failure with root cause and prevention
- `brain/memory/experiences.jsonl` — Log formative experiences with emotional weight

## Rules

- **Conversational, not clinical.** This is a getting-to-know-you session. Ask questions naturally. Don't present forms.
- **Extract, don't interrogate.** If someone says "I'm a designer who hates jargon," that fills voice profile (casual, simple, "jargon" is banned) AND brand (designer) AND identity. One answer, multiple modules.
- **Write files at phase boundaries.** Keep the conversation flowing within each phase. Write the structured output at the end before transitioning to the next phase.
- **Append-only for JSONL.** Never overwrite memory files. Append new entries.
- **Confirm before writing.** Show the user what you're about to write to each file. Let them adjust before you commit.
- **Skip what's filled.** If a module already has content, acknowledge it and ask if they want to update or skip.
- **End with a summary.** After all five phases, show what was seeded: files written, loops opened, goals set. Tell them what the agent will start doing autonomously.

## After Onboarding

The agent is seeded. From here:
- The autonomous cycle will start checking the board on its next heartbeat
- Open loops will begin scanning against activity
- Voice profile will apply to all writing tasks
- Goals will inform background planning

The metabolic cycle has started. Everything after this is learning by doing.
