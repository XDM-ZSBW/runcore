# Dash operates in three passes

**Principle:** When building or designing with Dash, separate intent, specification/build, and technical review. Do not interleave them. The clearest, most productive work happens when each pass has a single job.

---

## The three passes

| Pass | Who drives | What happens | Outcome |
|------|------------|--------------|---------|
| **Pass 1 — Intent** | User (plain language) | User states what they want in outcome terms. No implementation, no architecture, no "how." Just: what should exist, what should happen, what's in scope. | Clear, unambiguous intent. No conflicting constraints. |
| **Pass 2 — Spec and build** | Dash (AI) | From the intent, Dash proposes or derives a spec and implements it. Design and build happen in this pass; the only input is the intent from Pass 1. | A working thing that matches the stated intent. |
| **Pass 3 — Technical review** | User (technical hat) | User reviews the result and says "this won't scale because X," "swap that abstraction for Y," "move this to a separate module." Editing a working thing, not co-designing from scratch. | Refined, production-ready result. |

---

## Why three passes

- **Pass 1 only (pure intent):** Removes ambiguity. When intent and implementation are mixed in one message, the AI has to satisfy both "what you want" and "how you said to build it," and those can conflict. Pure intent gives a single target.
- **Pass 2:** Dash runs with the intent end-to-end. No need to negotiate structure in the same breath as behavior.
- **Pass 3:** The human's technical knowledge has highest leverage when reviewing and correcting a concrete artifact. Not when co-designing from scratch in the same turn as stating intent.

---

## For the AI (Dash)

When the user is describing a feature, a change, or a new capability:

1. **If the user's message mixes intent and implementation,** gently separate them. E.g. "I'll treat that as Pass 1 intent: [restate the outcome in plain language]. I'll then propose a spec and build from that. If you want to add technical constraints or review the result, we can do that in Pass 3."
2. **In Pass 2,** use only the stated intent. Do not invent requirements the user didn't state. If something is ambiguous, ask once in Pass 1 terms ("Do you mean X or Y for the outcome?").
3. **After delivering Pass 2,** invite Pass 3: "Built. When you're ready, put your technical hat on and tell me what to change—scale, abstraction, structure."

---

## For the user

- **Pass 1:** Talk like a non-technical person. "Should have an email people can send their brags to." "When I find a memory in the wrong scope I want to move it and have the system learn from that." No code, no architecture.
- **Pass 2:** Let Dash run. Don't add "and use a queue for that" in the same breath as the intent—that's Pass 3.
- **Pass 3:** Critique the working thing. "This won't scale because X." "Swap that for Y." Your coding knowledge is highest leverage here.

---

## Summary

| Concept | Implementation |
|--------|----------------|
| Dash operates in 3 passes | Intent → Spec/build → Technical review. |
| Don't mix passes | One job per pass. Mixing intent and implementation in one turn produces messier results. |
| Pass 3 is the human edge | Editing a working thing beats co-designing from scratch. |
