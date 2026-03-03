---
name: form-review
description: "Review gate before form submission. Shows summary of all filled fields, waits for explicit user approval before clicking Submit."
user-invocable: false
---

# Skill: Form review

Reference skill that activates as the final step of form automation. The agent has filled all fields but has **not** clicked Submit. This skill gates submission behind explicit user approval.

## Dependencies

- **BROWSER_ACTION** capability (CORE-10) — for screenshots and final submit click.
- **Fill state** from `form-fill` — the completed progress tracker with all field values.

## Trigger

The review gate activates when **any** of these conditions are met:
- The agent detects a submit/confirm button on the current page. Detection via button text matching: "Submit", "Confirm", "Place Order", "Complete", "Finish", "Send", "Apply".
- The fill state reaches `"status": "ready-for-review"`.
- The `reviewGate` setting in `brain/browser/form-config.yaml` is `always` (default).

If `reviewGate` is set to `never`, the agent submits immediately after filling (skip this skill). If set to `high-value`, the agent uses heuristics (financial forms, legal agreements, applications) to decide whether to gate.

## Sequence

1. **Screenshot the final page**
   - Capture the review/summary page if the form has one.
   - If the form has no dedicated review page, capture the current (last) page.

2. **Build the submission summary**
   - Compile all filled fields from the fill state into a readable summary:
     ```
     Form: https://example.com/application
     Pages: 5 | Fields filled: 23 | Skipped (optional): 2

     Page 1 — Personal Info
       First name: Jordan
       Last name: Lee
       Date of birth: 1990-05-15

     Page 2 — Contact
       Email: jordan@example.com
       Phone: +1 (213) 555-0100

     Page 3 — Employment
       Employer: Acme Corp
       Employer ID: ⚠️ EMP-12345 (user-provided, not from vault)

     ...

     Skipped (optional):
       Middle name — no value available
       Fax number — no value available
     ```
   - Flag any field that was **user-provided** (not from vault) with a ⚠️ marker so the user can double-check those values.
   - Flag any field where vault confidence was below the auto-fill threshold.

3. **Present to user and wait**
   - Show the summary and screenshot.
   - Ask: **"Ready to submit? Reply 'go' to confirm or tell me what to change."**
   - **Do not click Submit until the user explicitly says "go", "yes", "submit", or equivalent.**

4. **Handle user corrections**
   - If the user asks to change a value:
     - Navigate back to the relevant page.
     - Update the field.
     - Re-screenshot the page.
     - Return to the final page and present an updated summary.
   - Repeat until the user approves.

5. **Submit**
   - On explicit approval, click the Submit/Confirm button.
   - Wait for the confirmation page or response.
   - Screenshot the result (success or error).
   - Report the outcome to the user.

6. **Handle submission failure**
   - If submission fails (server error, validation error on submit):
     - Screenshot the error.
     - Report what went wrong.
     - Suggest next steps (retry, fix a field, try later).
   - Do not retry automatically — wait for user direction.

## Summary format

The summary uses this structure for consistency:

```
📋 Form Submission Review
━━━━━━━━━━━━━━━━━━━━━━━━

Form:   [URL]
Pages:  [N] | Fields: [filled] filled, [skipped] skipped

[Page-by-page field listing]

⚠️  User-provided values (not from vault):
    [field] = [value]

Ready to submit? Reply "go" to confirm or tell me what to change.
```

## Rules

- **Never submit without explicit user approval** when the review gate is active.
- The summary must include **every** filled field, not just a subset. The user needs the full picture.
- User-provided and low-confidence values must be visually flagged.
- If the user abandons the form (says "cancel", "stop", "nevermind"), do not submit. Confirm cancellation and report what was filled (in case they want to resume later).
- After successful submission, store a record in agent working memory: form URL, date, field count, outcome. This supports future automation of the same form.
