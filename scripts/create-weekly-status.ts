/**
 * One-off script: Create a "Weekly Status Report" calendar event
 * for 2026-02-28 at 4:30 PM Pacific (30 minutes).
 *
 * Usage: npx tsx scripts/create-weekly-status.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVault } from "../src/vault/store.js";
import { createEvent, getTodaySchedule } from "../src/google/calendar.js";

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
  const start = "2026-02-28T16:30:00-08:00"; // 4:30 PM PST
  const end = "2026-02-28T17:00:00-08:00";   // 5:00 PM PST (30 min)

  const title = "Weekly Status Report";
  const description = [
    "Review Dash progress and current tasks.",
    "",
    "Agenda:",
    "- Review Dash brain module updates and memory entries",
    "- Check progress on active operations and goals",
    "- Review Linear board tasks and blockers",
    "- Assess calendar, email, and integration health",
    "- Plan priorities for the upcoming week",
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

  // Verify by fetching today's schedule
  console.log("\nVerifying — fetching today's schedule...");
  const schedule = await getTodaySchedule();
  if (schedule.ok && schedule.events) {
    const found = schedule.events.find((e) => e.summary === title);
    if (found) {
      console.log(`Verified: "${found.summary}" found on today's schedule at ${found.start}`);
    } else {
      console.log("Warning: event not found in today's schedule (may be a timezone offset issue).");
      console.log("Events today:", schedule.events.map((e) => e.summary).join(", ") || "(none)");
    }
  }
}

main();
