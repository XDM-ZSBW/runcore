/**
 * Example: Dash using the brain for context and memory.
 * Run: npm run example
 */

import { Brain } from "../src/index.js";

const brain = new Brain({
  systemPrompt: "You are Dash, a helpful agent. Use the context and memory below when relevant.",
  defaultInstructions: "Be concise. If you recall a relevant fact from memory, use it.",
  defaultCues: "Respond in plain text. If you store a new fact, say so.",
  maxRetrieved: 5,
});

async function main() {
  // Learn something for later
  await brain.learn({
    type: "semantic",
    content: "User prefers weekly summaries on Mondays.",
  });
  await brain.learn({
    type: "episodic",
    content: "We decided to use TypeScript for the Dash brain project.",
    meta: { topic: "project" },
  });

  // Get context for a turn (retrieval runs automatically)
  const { messages, workingMemory } = await brain.getContextForTurn({
    userInput: "What did we decide about the project?",
    conversationHistory: [],
    maxRetrieved: 5,
  });

  console.log("--- Assembled messages (first 2) ---");
  console.log(messages.slice(0, 2).map((m) => `${m.role}: ${m.content.slice(0, 200)}...`).join("\n\n"));

  console.log("\n--- Working memory (retrieved) ---");
  console.log(workingMemory.retrieved.map((r) => `[${r.type}] ${r.content}`).join("\n"));

  // Simulate storing a new fact after the "conversation"
  await brain.learn({
    type: "semantic",
    content: "User asked about project decisions; we use TypeScript.",
  });

  const count = await brain.getLongTermMemory().list();
  console.log("\n--- Total LTM entries ---", count.length);
}

main().catch(console.error);
