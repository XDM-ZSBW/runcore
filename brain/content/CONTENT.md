# CONTENT.md — Content module instructions

Load this when the task is content: blog, post, thread, draft, edit, or research.

## File inventory

- `brain/identity/tone-of-voice.md` — Voice profile and checkpoints. Load for any writing.
- `brain/identity/brand.md` — Positioning and guardrails. Load for any writing.
- `brain/content/templates/` — Blog, thread, research templates. Load the one that matches the content type.
- `brain/knowledge/research/` — Existing topic research. Check before drafting.

## Content pipeline (stages)

1. **Idea** — Capture to ideas log; score alignment, insight, audience need, timeliness, effort.
2. **Research** — Output to `brain/knowledge/research/[topic].md` (structured: summary, landscape, evidence, sources).
3. **Outline** — Per template (sections, word counts).
4. **Draft** — Follow template + voice. Run anti-patterns check.
5. **Edit** — Structure → voice → evidence → read-aloud.
6. **Publish / Promote** — Log to posts; create thread or adaptation per template.

## Quality gates

- Every draft: banned-words scan, sentence rhythm, one em-dash per paragraph rule.
- Evidence: claims sourced?
- Final: would the user actually post this?

## Instructions for the agent

<instructions>

- When writing, always load tone-of-voice and brand. Do not skip voice checkpoints.
- Use the template for the requested content type (blog, thread, research). Do not make up structure.
- Research output goes to `brain/knowledge/research/[topic].md` in the structured format (Executive Summary, Landscape, Evidence Bank, Sources).
- Single source of truth: reference files by path; do not duplicate long content into the prompt.

</instructions>
