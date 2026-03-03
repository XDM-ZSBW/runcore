/**
 * Test script: Create a recurring "Weekly Status Report" task
 * every Friday at 4 PM via Google Tasks API.
 *
 * Google Tasks has no native recurrence, so this creates concrete
 * tasks for the next 4 Fridays.
 *
 * Usage: npx tsx scripts/test-recurring-task.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVault } from "../src/vault/store.js";
import {
  createRecurringWeeklyTasks,
  listTasks,
  isTasksAvailable,
} from "../src/google/tasks.js";

const SESSION_KEY_PATH = join(process.cwd(), "brain", "identity", ".session-key");

async function main() {
  // Load cached session key
  const hex = (await readFile(SESSION_KEY_PATH, "utf-8")).trim();
  const key = Buffer.from(hex, "hex");

  // Hydrate vault → populates process.env with Google credentials
  await loadVault(key);

  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.error("ERROR: GOOGLE_REFRESH_TOKEN not found after vault load.");
    console.error("Ensure Google OAuth has been completed via the Dash UI.");
    process.exit(1);
  }

  console.log("Google credentials loaded from vault.");

  if (!isTasksAvailable()) {
    console.error("ERROR: Google Tasks is not available (auth check failed).");
    process.exit(1);
  }

  console.log("Google Tasks API is available.\n");

  // Create recurring Friday 4 PM tasks
  const config = {
    title: "Weekly Status Report",
    notes: "Prepare and submit weekly status report",
    dayOfWeek: 5, // Friday (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat)
    hour: 16,     // 4 PM
    minute: 0,
    weeksAhead: 4,
  };

  console.log("Creating recurring tasks:");
  console.log(`  Title:     ${config.title}`);
  console.log(`  Notes:     ${config.notes}`);
  console.log(`  Schedule:  Every Friday at ${config.hour}:${String(config.minute).padStart(2, "0")}`);
  console.log(`  Weeks:     ${config.weeksAhead} weeks ahead`);
  console.log();

  const result = await createRecurringWeeklyTasks(config);

  if (!result.ok) {
    console.error("FAILED:", result.message);
    process.exit(1);
  }

  console.log("SUCCESS:", result.message);
  console.log();

  if (result.data) {
    console.log("Created tasks:");
    for (const task of result.data) {
      const dueStr = task.due
        ? new Date(task.due).toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "(no due date)";
      console.log(`  - ${task.title}`);
      console.log(`    Due: ${dueStr}`);
      console.log(`    ID:  ${task.id}`);
    }
  }

  // Verify by listing tasks from the default list
  console.log("\nVerifying — fetching tasks from default list...");
  const listResult = await listTasks("@default", { showCompleted: false });

  if (listResult.ok && listResult.data) {
    const statusTasks = listResult.data.filter((t) =>
      t.title.includes("Weekly Status Report"),
    );
    console.log(
      `Found ${statusTasks.length} "Weekly Status Report" task(s) in default list.`,
    );
    for (const t of statusTasks) {
      console.log(`  - ${t.title} (status: ${t.status})`);
    }
  } else {
    console.log("Warning: Could not list tasks to verify:", listResult.message);
  }

  console.log("\nDone.");
}

main();
