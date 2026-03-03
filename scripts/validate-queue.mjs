/**
 * Validate and compact queue.jsonl after grooming.
 * Reports final state summary.
 */

import { readFileSync, writeFileSync } from 'fs';

const QUEUE_FILE = 'brain/operations/queue.jsonl';
const data = readFileSync(QUEUE_FILE, 'utf8');
const lines = data.trim().split('\n');
const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Separate schema from tasks
const schema = entries.find(e => e._schema);
const tasks = entries.filter(e => !e._schema);

// Deduplicate: last occurrence per id wins
const taskMap = new Map();
for (const t of tasks) taskMap.set(t.id, t);
const all = [...taskMap.values()];

console.log(`Lines in file (before compact): ${lines.length}`);
console.log(`Unique tasks: ${all.length}`);

// Check for identifier collisions
const identifierMap = new Map();
for (const t of all) {
  if (identifierMap.has(t.identifier)) {
    console.error(`⚠ IDENTIFIER COLLISION: ${t.identifier} used by both ${identifierMap.get(t.identifier).id} and ${t.id}`);
  }
  identifierMap.set(t.identifier, t);
}

// Group by state
const byState = {};
for (const t of all) {
  byState[t.state] = byState[t.state] || [];
  byState[t.state].push(t);
}

console.log('\n=== Tasks by state ===');
for (const [state, items] of Object.entries(byState)) {
  console.log(`\n${state.toUpperCase()} (${items.length}):`);
  items.sort((a, b) => a.priority - b.priority || parseInt(a.identifier.replace('DASH-','')) - parseInt(b.identifier.replace('DASH-','')));
  for (const t of items) {
    const pri = ['urgent','high','medium','low','low'][t.priority] || 'none';
    const desc = t.description ? '✓' : '✗';
    console.log(`  ${t.identifier.padEnd(9)} P${t.priority}(${pri.padEnd(6)}) ${desc} desc  ${t.title.substring(0,65)}`);
  }
}

// Check for items without descriptions (excluding done/cancelled)
const active = all.filter(t => t.state !== 'done' && t.state !== 'cancelled');
const noDesc = active.filter(t => !t.description);
if (noDesc.length > 0) {
  console.log('\n⚠ Active items still missing descriptions:');
  for (const t of noDesc) {
    console.log(`  ${t.identifier}: ${t.title}`);
  }
} else {
  console.log('\n✓ All active items have descriptions.');
}

// Compact the file
const compactLines = [JSON.stringify(schema), ...all.map(t => JSON.stringify(t))];
writeFileSync(QUEUE_FILE, compactLines.join('\n') + '\n', 'utf8');
console.log(`\nCompacted: ${lines.length} lines → ${compactLines.length} lines`);
