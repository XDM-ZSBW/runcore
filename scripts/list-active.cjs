const fs = require('fs');
const lines = fs.readFileSync('E:/dash/brain/operations/queue.jsonl', 'utf8').split('\n').filter(Boolean);
const tasks = new Map();
for (const line of lines) {
  try {
    const t = JSON.parse(line);
    if (t._schema) continue;
    if (t.id) tasks.set(t.id, t);
  } catch {}
}
const all = [...tasks.values()];
const active = all.filter(t => t.state !== 'done' && t.state !== 'cancelled');
active.forEach(t => console.log(t.state, t.identifier, t.title));
console.log('\nTotal active:', active.length);
