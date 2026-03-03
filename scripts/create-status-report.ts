/**
 * One-off script: Create a "Weekly Status Review Session" calendar event
 * for 2026-02-28 at 4:30 PM Pacific (30 minutes).
 *
 * Usage: npx tsx scripts/create-status-report.ts
 *
 * Reads the cached session key from brain/identity/.session-key
 * to decrypt the vault and get Google credentials.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVault } from "../src/vault/store.js";
import { createEvent } from "../src/google/calendar.js";

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

  const title = "Weekly Status Review Session";
  const description = [
    "Weekly status review and planning session.",
    "",
    "Agenda:",
    "- Review progress on current sprint goals",
    "- Discuss blockers and dependencies",
    "- Review completed tasks and wins from the week",
    "- Plan priorities for the upcoming week",
    "- Action items and follow-ups",
  ].join("\n");

  console.log(`Creating event: ${title}`);
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
}

main();
