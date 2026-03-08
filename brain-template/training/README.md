# Training module

Tracks the paired human's proficiency across three skill trees.

## Skill trees

1. **Board Craft** — Writing clear board items (tasks, goals, descriptions).
2. **Observatory Literacy** — Reading and interpreting system output (metrics, activity, pulse).
3. **Tuning Core** — Adjusting system behavior (thresholds, posture, settings).

## Files

- **progress.json** — Current skill tree snapshot. Read by the Observatory.
- **proficiency.jsonl** — Append-only observations of skill use. Each entry records what the human did and which skill it demonstrates.

## Rules

- Proficiency is observed, not tested. The system watches natural interactions and infers skill level.
- Never gate features behind proficiency. Training is informational, not restrictive.
- Progress resets are allowed — the human can ask to start fresh.
