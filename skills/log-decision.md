---
name: log-decision
description: "Log a key decision to episodic memory. User says 'log this decision' or 'remember this decision' with context."
user-invocable: true
disable-model-invocation: true
---

# Skill: Log decision

Invoked when the user wants to record a decision for future reference (e.g. "log this decision," "remember we decided X").

## What to do

1. Load `brain/memory/README.md` for schema and rules.
2. **Append** one line to `brain/memory/decisions.jsonl`. Do not overwrite the file.
3. Include: `date` (ISO), `context`, `options` (if relevant), `reasoning`, `outcome` (if known), `status: "active"`.

## Example line (JSON, one line)

```json
{"date": "2026-02-23", "context": "Choice of stack for Dash brain", "options": ["TypeScript file-based", "Python only"], "reasoning": "File-based aligns with Personal Brain OS; TS for type safety and Cursor integration", "outcome": "Shipped file-based + optional TS runtime", "status": "active"}
```

## Rules

- Append only. Never rewrite or replace the file.
- To deprecate later, add a new line or use a process that sets `status: "archived"`; do not delete history.
