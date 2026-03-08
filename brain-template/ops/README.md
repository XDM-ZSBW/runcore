# Ops module

Activity log — what happened, when, and why.

## Files (append-only)

- **activity.jsonl** — One JSON object per line. Fields: `timestamp`, `source`, `summary`, `detail`, `tags`.

## Rules

- Append only. Never rewrite or truncate.
- Every significant system action (agent spawn, pulse fire, loop transition, user interaction) logs an entry.
- Use the Operations page (`/ops`) to view the activity stream.
