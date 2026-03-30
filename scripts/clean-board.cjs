const fs = require('fs');
const path = 'E:/dash/brain/operations/queue.jsonl';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
const tasks = new Map();
for (const line of lines) {
  try {
    const t = JSON.parse(line);
    if (t._schema) continue;
    if (t.id) tasks.set(t.id, t);
  } catch {}
}

// Cancel non-Runcore items
const cancelIds = new Set([
  'DASH-1088', 'DASH-1089', 'DASH-1090', 'DASH-1091', 'DASH-1092',
  'DASH-1093', 'DASH-1094', 'DASH-1095', 'DASH-1096', 'DASH-1097',
  'DASH-1098', 'DASH-1099',
]);

let cancelled = 0;
for (const [id, task] of tasks) {
  if (cancelIds.has(task.identifier) && task.state !== 'cancelled' && task.state !== 'done') {
    task.state = 'cancelled';
    task.updatedAt = new Date().toISOString();
    cancelled++;
    console.log('Cancelled:', task.identifier, task.title);
  }
}

// Rewrite file
const schema = '{"_schema":"queue","_version":"2.0"}';
const output = [schema, ...[...tasks.values()].map(t => JSON.stringify(t))].join('\n') + '\n';
fs.writeFileSync(path, output, 'utf8');
console.log('\nCancelled', cancelled, 'items');

// Show what remains
const remaining = [...tasks.values()].filter(t => t.state !== 'done' && t.state !== 'cancelled');
console.log('\nRemaining active:');
remaining.forEach(t => console.log(' ', t.state, t.identifier, t.title));
