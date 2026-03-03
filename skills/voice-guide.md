---
name: voice-guide
description: "Voice and tone for all user-facing writing. Load automatically when the task involves writing, drafting, or editing text that should sound like the user."
user-invocable: false
disable-model-invocation: false
---

# Voice guide (reference skill)

This skill is **auto-loaded** whenever the task involves writing (blog, post, email, thread). You do not need to invoke it manually.

## What to load

1. Read `brain/identity/tone-of-voice.md` — profile, banned words, checkpoints.
2. If the project has `brain/identity/anti-patterns.md`, read it for the full banned list and structural traps.

## Rules

- Apply voice checkpoints every ~500 words in drafts.
- Run a banned-words scan before presenting any draft.
- One em-dash per paragraph unless the user's tone doc says otherwise.
- Single source of truth: reference the identity files; do not duplicate their content here.
