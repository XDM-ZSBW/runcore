/**
 * One-off script: Create a "Weekly Status Review" calendar event
 * for 2026-03-01 at 4:30 PM Pacific (30 minutes).
 *
 * Usage: npx tsx scripts/create-status-review.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVault } from "../src/vault/store.js";
import { createEvent, listEvents } from "../src/google/calendar.js";

const SESSION_KEY_PATH = join(process.cwd(), "brain", "identity", ".session-key");

async function main() {
  // Load cached session key
  const hex = (await readFile(SESSION_KEY_PATH, "utf-8")).trim();
  const key = Buffer.from(hex, "hex");

  // Hydrate vault → populates process.env with Google credentials
  await loadVault(key);

  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.error("ERROR: GOOGLE_REFRESH_TOKEN not found after vault load.");
    process.exit(1);
  }

  console.log("Google credentials loaded from vault.");

  const timeZone = "America/Los_Angeles";
  const start = "2026-03-01T16:30:00-08:00"; // 4:30 PM PST
  const end = "2026-03-01T17:00:00-08:00";   // 5:00 PM PST (30 min)

  const title = "Weekly Status Review";
  const description = [
    "Weekly status review session.",
    "",
    "Agenda:",
    "- Review project progress across Dash and active projects",
    "- Check backlog items and prioritize upcoming work",
    "- Assess blockers and dependencies",
    "- Update goals and operational priorities",
  ].join("\n");

  console.log(`\nCreating event: ${title}`);
  console.log(`  Start: ${start}`);
  console.log(`  End:   ${end}`);
  console.log(`  TZ:    ${timeZone}`);

  const result = await createEvent(title, start, end, {
    description,
    timeZone,
  });

  if (!result.ok) {
    console.error("FAILED:", result.message);
    process.exit(1);
  }

  console.log("\nEvent created successfully!");
  console.log("  ID:", result.event?.id);
  console.log("  Summary:", result.event?.summary);
  console.log("  Start:", result.event?.start);
  console.log("  End:", result.event?.end);
  if (result.event?.htmlLink) {
    console.log("  Link:", result.event.htmlLink);
  }

  // Verify by querying for the event
  console.log("\nVerifying — searching for created event...");
  const search = await listEvents({
    timeMin: "2026-03-01T00:00:00-08:00",
    timeMax: "2026-03-02T00:00:00-08:00",
    query: "Weekly Status Review",
  });

  if (search.ok && search.events) {
    const found = search.events.find((e) => e.id === result.event?.id);
    if (found) {
      console.log(`Verified: "${found.summary}" found at ${found.start}`);
    } else {
      console.log("Warning: event not found by ID, but creation succeeded.");
      console.log("Events matching query:", search.events.map((e) => `${e.summary} (${e.start})`).join(", ") || "(none)");
    }
  } else {
    console.log("Could not verify — list query failed:", search.message);
  }
}

main();
