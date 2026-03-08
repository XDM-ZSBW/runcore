# Memory module

Episodic memory: experiences, decisions, failures. Stores **judgment** as well as facts — what mattered, what you’d do differently, how you think about tradeoffs.

## Files (append-only)

- **experiences.jsonl** — Key moments. Suggested fields: `date`, `summary`, `emotional_weight` (1–10), `tags`, `status` (active | archived).
- **decisions.jsonl** — Key decisions. Suggested fields: `date`, `context`, `options`, `reasoning`, `outcome`, `status`.
- **failures.jsonl** — What went wrong. Suggested fields: `date`, `summary`, `root_cause`, `prevention`, `status`.
- **semantic.jsonl** — Facts and beliefs (used by optional TS runtime `Brain.learn({ type: "semantic" })`).
- **procedural.jsonl** — How-to knowledge (used by optional TS runtime `Brain.learn({ type: "procedural" })`).

## Rules

- **Append only.** Add one new line per entry. Never overwrite or rewrite the file.
- To “delete,” set `"status": "archived"` on a new line that amends the record (or document archiving in your process). Preserve history for pattern analysis.
- When the agent encounters a decision similar to a past one, it may reference `decisions.jsonl` for your reasoning and priority order instead of giving generic advice.
