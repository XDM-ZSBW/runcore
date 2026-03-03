# SKILL.md — Routing for Dash

This file is **Level 1**: always loaded. It tells the agent which module is relevant for the current task. Load only the modules that match; do not load everything.

---

## Task type → Module mapping

| Task type | Load module | Key files |
|-----------|-------------|-----------|
| **Content** — blog, post, thread, draft, edit | content | `brain/content/CONTENT.md`, `brain/identity/tone-of-voice.md`, template per type |
| **Research** — topic research, landscape, evidence | content + knowledge | `brain/content/CONTENT.md` (research workflow), `brain/knowledge/` |
| **Memory** — log experience, decision, failure; recall past judgment | memory | `brain/memory/` (relevant JSONL only) |
| **Operations** — goals, todos, priorities, what to do next | operations | `brain/operations/OPERATIONS.md`, `goals.yaml`, `todos.md` |
| **Network** — contact, meeting prep, who is X, interactions | network | `brain/network/contacts.jsonl`, `interactions.jsonl`, `circles.yaml` (if present) |
| **Identity / voice** — sound like me, brand, tone | identity | `brain/identity/tone-of-voice.md`, `brain/identity/brand.md` |
| **Training** — my training, proficiency, skill progress, nudges | training | `brain/training/progress.json`, `/api/training/progress` |
| **Generic / chat** | — | AGENT.md + optional identity for voice if generating text |

---

## Progressive disclosure

- **Level 1 (always):** This file (SKILL.md) + AGENT.md.
- **Level 2 (on demand):** The module instruction file for the task (e.g. CONTENT.md, OPERATIONS.md).
- **Level 3 (when needed):** Data files — specific JSONL lines, YAML, or markdown. Read only what the task requires (e.g. last 20 interactions for a contact, not the full file).

---

## Skills directory

- **Reference skills** (`skills/*.md` with `user-invocable: false` in frontmatter): Load automatically when the task type matches (e.g. all content tasks load voice guide).
- **Task skills** (`/write-blog`, `/topic-research`, etc.): User invokes explicitly. Load that skill’s instructions and its referenced files only.

See `skills/` for the actual skill definitions.
