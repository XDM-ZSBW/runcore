# Skills module

Reusable prompt patterns for common tasks. Each skill is a YAML file with a structured prompt template.

## Files

- **schema.yml** — Defines the skill file format (fields, validation rules).
- **debugging.yml** — Systematic debugging workflow.
- **file-editing.yml** — Safe file editing patterns.
- **git-operations.yml** — Git workflow prompts.
- **testing.yml** — Test writing and execution.
- **web-scraping.yml** — Web content extraction.

## How skills work

Skills are loaded by the agent runtime when a task matches the skill's keywords. Each skill provides:
- A structured prompt template with placeholders
- Input/output expectations
- Safety constraints (e.g., "don't delete files without confirmation")

## Adding a new skill

Create a YAML file following `schema.yml`. The file name becomes the skill identifier.
