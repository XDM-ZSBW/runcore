# Spec Hygiene — Spec

> Status: Draft (2026-03-07)
> Origin: "Is there a process for collapsing and combining and culling and grooming specs?"
> Depends on: spec-lifecycle-spec.md, dictionary-protocol-spec.md

## What

The process for maintaining the dictionary as it grows. Collapsing overlapping specs, combining related halves, culling dead weight, and grooming the collection so it stays navigable. Hygiene is periodic, not continuous — a grooming pass, not a permanent bureaucracy.

## Why

Specs accumulate. Early specs get written before the vocabulary stabilizes. Two specs cover the same topic from different angles. A spec gets superseded by a later, more detailed one but nobody retires the original. The dictionary bloats. Readers don't know which spec is canonical. Agents parse stale files.

Without hygiene, the dictionary becomes what the board was — a junk drawer where everything lives and nothing is findable.

## Done when

- A grooming pass can be executed in under an hour
- Every spec in the dictionary is either active or clearly marked Retired
- No two active specs cover the same topic
- Dependency references point to active specs, never retired ones
- The process is documented well enough that any agent can execute it

## The four operations

### Merge

Two specs that cover the same topic from different angles become one.

**When to merge:**
- Two specs share >50% of their "Done when" criteria
- One spec says "what" and the other says "how" for the same thing
- Readers need both specs to understand the topic

**How to merge:**
1. Create the combined spec with a new name (or keep the broader name)
2. Add `> Merges: old-spec-a.md + old-spec-b.md (date)` to the header
3. Mark both originals as `> Status: Retired (date) — merged into new-spec.md`
4. Update all dependency references across other specs
5. Deduplicate open questions (combine, don't repeat)

### Supersede

A newer spec replaces an older one that covered the same ground less completely.

**When to supersede:**
- The newer spec contains everything the older one said, plus more
- The older spec's unique content can be added as a section in the newer one
- The older spec is referenced by name but readers always end up in the newer one

**How to supersede:**
1. Add unique content from the old spec as a section in the new one
2. Add `> Supersedes: old-spec.md (date)` to the new spec's header
3. Mark the old spec as `> Status: Retired (date) — superseded by new-spec.md`
4. Update all dependency references

### Cull

A spec that no longer applies — the feature was cut, the approach was abandoned, the concept was folded into something else entirely.

**When to cull:**
- The spec describes something that will never be built
- The concept was renamed and the old name is dead
- The spec was exploratory and the exploration concluded elsewhere

**How to cull:**
1. Mark as `> Status: Retired (date) — culled: [reason]`
2. Do NOT delete — retired specs are documentation of decisions, including the decision not to build
3. Remove from dependency lists in other specs

### Graduate

A file that isn't a spec — it's a note, a correction memo, a glossary, a set of rules. It shouldn't be in the spec pipeline.

**When to graduate:**
- The file doesn't have What/Why/Done-when structure
- It's a reference document, not a unit of buildable work
- It's an architectural correction or decision record

**How to graduate:**
- Leave it in the notes directory (it belongs with the knowledge)
- Ensure it's clearly labeled (e.g., "Note", "Glossary", "Correction", "Rules")
- Don't include it in spec counts or the spec tracker

## The grooming pass

Run a grooming pass when:
- The spec count exceeds 30 active specs
- 5+ new specs have been written since the last pass
- Someone (human or agent) can't find the canonical spec for a topic
- A dependency graph shows circular or dead references

### Pass procedure

1. **Inventory:** List all files in `brain/knowledge/notes/`. Count active specs, retired specs, non-spec files.
2. **Overlap scan:** Read the What/Why of every active spec. Flag pairs with >50% topic overlap.
3. **Dependency audit:** Check every `Depends on:` line. Flag references to retired or missing specs.
4. **Propose actions:** For each flagged item, propose merge/supersede/cull/graduate with rationale.
5. **Execute:** After human approval, perform the operations. Update all cross-references.
6. **Verify:** Grep for any remaining references to retired specs (outside the retired files themselves).

### Watch list

Some spec pairs are too close for comfort but not yet ready to merge. Track them:

| Pair | Why watch | Merge trigger |
|------|-----------|---------------|
| pain-signal + dehydration-cycle | Pain triggers dehydration. Shared dimming lifecycle. | If one grows to cover the other's territory. |
| calibration-cycle + onboarding | Onboarding IS the first calibration. | If calibration spec absorbs the onboarding sequence. |
| nerve-vocabulary + nerve-spawn | Vocabulary = what nerves are. Spawn = how they connect. | If vocabulary stays thin enough to fold in. |

## The principle

The dictionary is language. Language that isn't maintained drifts. Two words for the same thing. One word for two things. Dead words nobody uses. The grooming pass is dictionary editing — not censorship, but clarity. Every active spec should be the one canonical place to learn about its topic. If it isn't, the dictionary needs editing.

## Open questions

1. **Automation** — Can an agent detect overlap automatically? Cosine similarity on spec content? Or is this inherently a judgment call?
2. **Retired spec retention** — How long do retired specs stay in the directory? Forever (historical record)? Or move to an `archive/` subdirectory after N months?
3. **Cross-instance hygiene** — When the dictionary publishes to instances, do retired specs travel? Or only active ones?
4. **Hygiene cadence** — Should grooming be scheduled (every 10 new specs) or triggered (someone complains)?
