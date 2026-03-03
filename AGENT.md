# AGENT.md — Core rules and decision table

Read this for every task. These rules scope how the agent behaves at the brain level. Module-level files add domain-specific rules.

---

## Core rules

1. **Route first.** Use SKILL.md to decide which module(s) apply. Load only those modules. Do not load identity when doing operations, or content templates when doing meeting prep.

2. **Respect the attention budget.** Put the most critical instructions and constraints at the top of any assembled context. Front-load what must not be forgotten (voice, bans, priorities).

3. **Memory is append-only.** When writing to `brain/memory/*.jsonl`, append one line. Never overwrite or rewrite the file. Use `"status": "archived"` to deprecate an entry instead of deleting.

4. **Single source of truth.** Reference files by path (e.g. "Read `brain/identity/tone-of-voice.md`"). Do not duplicate long content across skills or prompts.

5. **Scoped instructions.** If a rule is for content only, it lives in CONTENT.md or the content skill, not in AGENT.md. Avoid conflicting rules by keeping them in the right module.

6. **Data over prose.** Prefer structured data (YAML, JSONL) for facts, lists, and config. Use Markdown for narrative, voice, and instructions.

7. **Act first, mention what you did.** For routine actions (creating events, replying to threads, browsing), execute immediately and report the outcome. Only confirm before destructive actions (deleting data, sending to new recipients, submitting forms) or when the request is genuinely ambiguous. Prefer safe defaults (e.g. append, don’t replace).

8. **"Again" means look back, not out.** When the user says "again", "look again", "try again", "check again", or similar retry cues, re-examine the conversation history and your existing context (brain files, prior tool results, retrieved memory) before reaching for external tools like web search. The answer is almost always already in context. Only escalate to external search if a thorough re-read of conversation + local files comes up empty.

9. **Three passes for build/design.** When the user is describing a feature, change, or new capability, operate in three passes: (1) Intent only - user states what they want in plain language; (2) Spec and build - you derive a spec and implement from that intent; (3) Technical review - user critiques scale, abstraction, structure. Do not interleave intent and implementation in one turn. See [docs/THREE-PASSES.md](docs/THREE-PASSES.md).

---

Map common user intents to actions. Use this to choose the right module and sequence.

| User says / intent | Step 1 | Step 2 | Step 3 |
|-------------------|--------|--------|--------|
| Write a post / blog / thread | Load CONTENT.md + voice + template | Draft per template | Run voice/anti-pattern check |
| Research a topic | Load content research workflow | Output to `brain/knowledge/research/[topic].md` | Use structured format (summary, evidence, sources) |
| Log a decision | Load memory module | Append to `brain/memory/decisions.jsonl` | Include reasoning, alternatives, outcome |
| Log a failure | Load memory module | Append to `brain/memory/failures.jsonl` | Include cause, prevention |
| Log an experience | Load memory module | Append to `brain/memory/experiences.jsonl` | Include emotional weight if relevant |
| What are my goals? / What should I do? | Load `brain/operations/OPERATIONS.md` + goals | Triage by priority (P0–P3) | Suggest next actions from todos |
| Meeting prep / Who is X? | Load network/contacts module | Look up contact, interactions | Compile brief (context, history, follow-ups) |
| Use my voice / sound like me | Load `brain/identity/tone-of-voice.md` + anti-patterns | Apply to all generated text | Check banned words and structure |
| Weekly review | Load operations + goals + metrics | Run review workflow | Update todos and goal progress from outcome |
| What's new? / Changelog | Load `brain/operations/changelog.md` | Summarize recent entries | — |
| Training / proficiency / how am I doing? | Load `brain/training/progress.json` | Report skill tree status, signal levels, next nudge | Explain what the human can improve |

---

## File inventory (brain modules)

- **memory/** — `experiences.jsonl`, `decisions.jsonl`, `failures.jsonl`. Episodic + judgment. Append-only.
- **identity/** — `tone-of-voice.md`, `brand.md`. Voice, brand, audience.
- **content/** — `CONTENT.md`, templates (blog, thread, research). Pipeline and quality gates.
- **operations/** — `OPERATIONS.md`, `goals.yaml`, `todos.md`, `changelog.md`. Priorities, key results, tasks, changes.
- **knowledge/** — Research docs, bookmarks, notes. Input for content and decisions.
- **training/** — `proficiency.jsonl` (append-only skill observations), `progress.json` (snapshot). Tracks human's board craft, observatory literacy, and system tuning proficiency. Observable at `/api/training/progress` and in the Observatory.
