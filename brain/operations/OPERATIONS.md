# OPERATIONS.md — Operations module instructions

Load this when the task is goals, todos, priorities, or “what should I do next?”

## File inventory

- `brain/operations/goals.yaml` — Key results, progress, targets.
- `brain/operations/todos.md` — Current tasks. Priority and status.
- `brain/operations/changelog.md` — What's new. Dated entries, newest first.

## Priority levels

- **P0** — Do today.
- **P1** — This week.
- **P2** — This month.
- **P3** — Backlog.

Triage all suggestions and tasks using these levels. The agent should follow the same priority system as the user.

## Instructions for the agent

<instructions>

- When the user asks “what are my goals?” or “what should I do?”, load goals and todos. Summarize by priority.
- When suggesting next actions, reference P0/P1 first. Do not overload with backlog items.
- When updating todos or goals, append or edit in place as appropriate; do not rewrite entire files unless the user explicitly asks. Prefer minimal, clear edits.

</instructions>
