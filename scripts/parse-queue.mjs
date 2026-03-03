import { readFileSync } from 'fs';

const data = readFileSync('brain/operations/queue.jsonl', 'utf8');
const entries = data.trim().split('\n').map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);

// Skip schema line
const tasks = entries.filter(e => !e._schema);

// Deduplicate: last occurrence wins per id
const map = new Map();
for (const t of tasks) map.set(t.id, t);

const all = [...map.values()];

// Group by status
const active = all.filter(t => t.status !== 'archived');
const archived = all.filter(t => t.status === 'archived');

console.log('=== SUMMARY ===');
console.log('Total entries in file:', entries.length);
console.log('Unique tasks:', all.length);
console.log('Active:', active.length);
console.log('Archived:', archived.length);

console.log('\n=== ACTIVE TASKS ===');
// Sort by identifier number
active.sort((a,b) => {
  const na = parseInt(a.identifier.replace('DASH-',''));
  const nb = parseInt(b.identifier.replace('DASH-',''));
  return na - nb;
});

for (const t of active) {
  console.log(JSON.stringify({
    identifier: t.identifier,
    title: t.title,
    state: t.state,
    priority: t.priority,
    description: t.description ? t.description.substring(0, 300) : '(empty)',
    assignee: t.assignee,
    linearId: t.linearIdentifier || null,
    exchangeCount: t.exchanges?.length || 0
  }));
}

console.log('\n=== ARCHIVED TASKS ===');
for (const t of archived) {
  console.log(JSON.stringify({
    identifier: t.identifier,
    title: t.title,
    state: t.state,
    priority: t.priority,
  }));
}
