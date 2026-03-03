---
name: write-blog
description: "Full workflow to write a long-form blog post. User invokes with /write-blog <topic or title>."
user-invocable: true
disable-model-invocation: true
---

# Skill: Write blog

Invoked by the user as **/write-blog** followed by the topic or working title. When invoked, this skill is the agent’s complete instruction set for that task.

## Sequence

1. **Load context**
   - `brain/identity/tone-of-voice.md`
   - `brain/identity/brand.md`
   - `brain/content/templates/blog.md`
   - Check `brain/knowledge/research/` for existing research on the topic; load if present.

2. **Outline**
   - Produce an outline that follows the blog template (Hook, Core concept, Framework, Practical application, Failure modes, Getting started, Closing).
   - Include word-count targets per section.

3. **Draft**
   - Write section by section. After every ~500 words, run voice checkpoints (insight lead? specific? would user post this?).
   - No banned words; respect em-dash limit.

4. **Edit**
   - Structure pass → voice pass → evidence pass → read-aloud test.
   - Present the draft with a short self-check summary.

## Output

- Draft can be written to `brain/content/drafts/[slug].md` or presented in chat, per user preference.
- Every draft must include the attribution footer from the blog template (entity name, URL, date — sourced from `brain/identity/brand.md`).
- If research was used, cite it. If new research is needed, suggest running the topic-research skill first.

## Quality gates (from template)

- Hook grabs; each section earns its place.
- Banned-words scan and rhythm check done.
- Claims sourced where needed.
- Final: would the user actually post this?
