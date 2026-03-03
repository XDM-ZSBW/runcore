# Scheduling module

Internal time allocation — how Core plans and experiences time. Focus blocks, deadlines, milestones. Google Calendar is external reality; scheduling is Core's intentional structure.

## Files (append-only)

- **blocks.jsonl** — Scheduling blocks. Fields: `id` (blk_ + 8 hex), `type` (focus | deadline | milestone | admin | review | break), `title`, `start`/`end` (ISO 8601 for time-range blocks), `dueAt` (ISO 8601 for deadlines/milestones), `boardItemId` (optional DASH-N link), `status` (planned | active | completed | skipped | cancelled), `outcome` (optional completion note), `tags`.

## Rules

- **Append only.** Add one new line per entry. Never overwrite or rewrite the file.
- To update a block, append a new line with the same `id` and updated fields. Last occurrence wins.
- Blocks whose `start` has arrived auto-transition to `active`.
- Blocks 2+ hours past their `end` time while still `planned` auto-transition to `skipped`.
- Missed blocks create voltage in the pulse system — Core's own planning failed.
- Completed blocks should include an `outcome` note for temporal history.

## How Core experiences time

- **Anticipation**: Timer detects upcoming blocks, pushes notifications.
- **Presence**: Active blocks inform what Core should be working on.
- **Tension**: Missed blocks create voltage — planning failed.
- **Reflection**: Completed blocks with `outcome` create temporal history.
