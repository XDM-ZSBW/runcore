/**
 * Create a recurring "Weekly Status Report" task every Friday at 4 PM.
 * Uses the existing Google Tasks integration (DASH-49/67).
 *
 * Usage: npx tsx scripts/create-friday-status-task.ts
 *
 * Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

import { createRecurringWeeklyTasks, isTasksAvailable } from "../src/google/tasks.js";

async function main() {
  if (!isTasksAvailable()) {
    console.error("Google Tasks not available. Ensure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are set.");
    process.exit(1);
  }

  console.log("Creating recurring Weekly Status Report tasks (Friday 4 PM, 4 weeks ahead)...\n");

  const result = await createRecurringWeeklyTasks({
    title: "Weekly Status Report",
    notes: "Prepare and submit weekly status report. Review accomplishments, blockers, and next-week priorities.",
    dayOfWeek: 5, // Friday
    hour: 16,     // 4:00 PM
    minute: 0,
    weeksAhead: 4,
  });

  if (!result.ok) {
    console.error("Failed:", result.message);
    process.exit(1);
  }

  console.log(result.message);
  console.log("\nCreated tasks:");
  for (const task of result.data ?? []) {
    console.log(`  - ${task.title} (due: ${task.due})`);
  }
}

main();
