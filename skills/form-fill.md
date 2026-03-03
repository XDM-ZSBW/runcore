---
name: form-fill
description: "Fill a multi-page form using the field manifest from scouting. Tracks state page-by-page, pauses on unknowns."
user-invocable: false
---

# Skill: Form fill

Reference skill loaded after the scout phase completes and the user approves the fill plan. The agent fills fields page-by-page using vault data, tracking progress through the entire form.

## Dependencies

- **BROWSER_ACTION** capability (CORE-10) — for typing, selecting, and navigating.
- **Personal data vault** (CORE-11) — source of field values.
- **Field manifest** from `form-scout` — the approved fill plan in working memory.

## Sequence

1. **Initialize state**
   - Navigate back to page 1 of the form.
   - Set up the progress tracker in working memory:
     ```json
     {
       "currentPage": 1,
       "totalPages": 5,
       "filledFields": [],
       "pendingFields": ["...all manifest fields..."],
       "skippedFields": [],
       "status": "in-progress"
     }
     ```

2. **Fill page-by-page**
   - For each page (in order):
     a. Identify all fields on the current page from the manifest.
     b. For each field:
        - **auto-fill**: Enter the vault value directly.
        - **suggest**: Enter the proposed value (user already confirmed during scout approval).
        - **missing with user-provided value**: Enter the value the user supplied after the scout report.
        - **missing without value**: **Pause and ask the user.** Do not guess or skip required fields.
     c. After filling all fields on the page, move the field entries from `pendingFields` to `filledFields`.
     d. Take a screenshot of the completed page for verification.
     e. Click "Next" to advance.

3. **Handle unexpected fields**
   - If the form shows fields not in the manifest (e.g. conditional fields that appeared after filling):
     - Attempt vault matching on the new field.
     - If no match or low confidence, pause and ask the user.
     - Add the field to the manifest so the review gate has a complete picture.

4. **Handle errors**
   - If the form shows validation errors after filling a page:
     - Screenshot the error state.
     - Identify which fields failed validation and why.
     - Attempt to correct using vault data or ask the user.
     - Do not advance until all validation errors on the current page are resolved.

5. **Reach the final page**
   - When the last page is filled, update state to `"status": "ready-for-review"`.
   - **Do not click Submit.** Hand off to the `form-review` skill.

## State tracking

The agent maintains this state object in working memory throughout filling. It is the single source of truth for progress:

```json
{
  "currentPage": 3,
  "totalPages": 5,
  "filledFields": [
    {"page": 1, "label": "First name", "value": "Jordan", "status": "filled"},
    {"page": 1, "label": "Last name", "value": "Lee", "status": "filled"},
    {"page": 2, "label": "Email", "value": "jordan@example.com", "status": "filled"}
  ],
  "pendingFields": [
    {"page": 3, "label": "Employer ID", "value": null, "status": "waiting-on-user"},
    {"page": 4, "label": "Start date", "value": "2026-03-01", "status": "queued"}
  ],
  "skippedFields": [
    {"page": 2, "label": "Middle name", "value": null, "status": "skipped-optional"}
  ],
  "status": "in-progress"
}
```

Field statuses:
- `filled` — value entered successfully.
- `queued` — has a value, waiting for its page.
- `waiting-on-user` — no value; agent has paused to ask.
- `skipped-optional` — optional field with no vault match; left blank.

## Rules

- **Never skip a required field.** If a required field has no value, pause and ask.
- **Optional fields without vault matches** may be left blank — mark as `skipped-optional`.
- **Screenshot after each page** for the verification trail.
- If the form session expires or the page reloads unexpectedly, restart from page 1 using the manifest. Already-confirmed values are retained in state.
- On the final page, **stop before Submit**. The review gate handles submission.
