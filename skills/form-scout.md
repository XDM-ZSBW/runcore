---
name: form-scout
description: "Scout a multi-page form before filling. Navigates all pages, extracts field manifest, maps fields to vault data."
user-invocable: false
---

# Skill: Form scout

Reference skill loaded automatically when an agent is given a form-filling task. The scout runs **before anything is typed** — its job is to map the entire form and produce a fill plan for user approval.

## Dependencies

- **BROWSER_ACTION** capability (CORE-10) — for navigation and screenshots.
- **Personal data vault** (CORE-11) — for matching fields to stored data.

## Sequence

1. **Navigate without filling**
   - Starting at the form's first page, click through every page (Next, Continue, etc.) without entering any data.
   - On each page, take a screenshot and extract all visible form fields.
   - If the form requires input to advance (e.g. required fields block "Next"), note the page as gated and record what's needed.

2. **Build the field manifest**
   - For every field found, record one entry:
     ```json
     {
       "page": 1,
       "label": "First name",
       "type": "text",
       "required": true,
       "htmlName": "firstName",
       "options": null
     }
     ```
   - For select/radio/checkbox fields, include the available `options`.
   - For file upload fields, note the accepted formats and size limits if visible.

3. **Map fields to vault data**
   - For each manifest entry, search the vault for a matching value.
   - Assign a confidence score (0.0–1.0) based on label-to-vault-key similarity.
   - Categorize each field into one of:
     - **auto-fill** — vault match with confidence ≥ threshold (see `form-config.yaml`).
     - **suggest** — vault match below threshold; needs user confirmation.
     - **missing** — no vault match; user must provide the value.

4. **Return the scout report**
   - Present to the user:
     - Total pages and total fields found.
     - Count by category: auto-fill / suggest / missing.
     - List of all "missing" fields so the user can provide values.
     - List of all "suggest" fields with the proposed vault value for confirmation.
   - **Do not proceed to filling until the user approves the plan.**

## Output format

The scout produces a **field manifest** stored in agent working memory:

```json
{
  "formUrl": "https://example.com/application",
  "totalPages": 5,
  "fields": [
    {
      "page": 1,
      "label": "First name",
      "type": "text",
      "required": true,
      "htmlName": "firstName",
      "vaultKey": "personal.firstName",
      "confidence": 0.95,
      "category": "auto-fill",
      "value": "Jordan"
    },
    {
      "page": 3,
      "label": "Employer ID",
      "type": "text",
      "required": true,
      "htmlName": "employerId",
      "vaultKey": null,
      "confidence": 0.0,
      "category": "missing",
      "value": null
    }
  ]
}
```

## Rules

- **Never type into a form during scouting.** The scout is read-only reconnaissance.
- If the form cannot be fully scouted (e.g. gated pages), note the gap and report what was discovered. The fill phase will re-scout gated pages after prerequisite fields are filled.
- Screenshot every page for the user's reference.
- If `scoutFirst` is `false` in `brain/browser/form-config.yaml`, skip this skill and go directly to fill. Default is `true`.
