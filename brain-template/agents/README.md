# Agents module

Spawned agent tasks, execution logs, and runtime state.

## Directories

- **tasks/** — Task definitions and results for spawned agents.
- **runtime/** — Runtime state snapshots during agent execution.
- **logs/** — Execution logs from completed agent runs.

## Files

- **cooldowns.json** — Tracks cooldown timers to prevent rapid re-spawning of the same task.
- **locks.json** — Active locks preventing concurrent access to shared resources.

## Rules

- Agent logs are append-only. Never delete or overwrite execution history.
- Cooldowns are checked before spawning. If a task was attempted recently and failed, the system waits before retrying.
- Locks are released when the owning agent completes or times out.
