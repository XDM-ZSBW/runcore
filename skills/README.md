# Skills — Dash

Agent skills define **how** to perform tasks. Two types:

- **Reference skills** — `user-invocable: false`. The agent loads them automatically when the task type matches (e.g. all content tasks load the voice guide).
- **Task skills** — `disable-model-invocation: true`. The user invokes them explicitly (e.g. `/write-blog`, "log this decision"). The agent then follows that skill’s instructions and loads only the files it references.

## Index

| Skill | Type | When |
|-------|------|------|
| voice-guide | Reference | Any writing/drafting task |
| core-architecture | Reference | Architecture, design philosophy, self-identity, Core whitepaper |
| onboard | Task | User says `/onboard` or "set me up" or "get started" |
| write-blog | Task | User says `/write-blog <topic>` |
| log-decision | Task | User says "log this decision" / "remember we decided..." |
| form-scout | Reference | Form-filling task detected — scouts all pages, builds field manifest |
| form-fill | Reference | After scout approval — fills fields page-by-page using vault data |
| form-review | Reference | Final page reached — gates submission behind user approval |

## Format

Each skill is a markdown file with YAML frontmatter:

- `name` — Skill id.
- `description` — When to load (for reference) or what the command is (for task).
- `user-invocable: true/false` — Can the user invoke by name/slash?
- `disable-model-invocation: true` — If true, the agent only runs this when the user explicitly invokes it.

Skills reference module files by path (e.g. `brain/identity/tone-of-voice.md`). Single source of truth: content lives in the brain modules, not duplicated in the skill.

## Reference

Pattern follows [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering) (Muratcan Koylan).
