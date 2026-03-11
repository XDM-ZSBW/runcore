// Check for missing import targets in a directory
const fs = require('fs');
const path = require('path');
const distDir = process.argv[2] || path.join(__dirname, '..', 'dist');

function check(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes:true}); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { check(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const content = fs.readFileSync(full, 'utf-8');
    const re = /from ["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const importPath = m[1];
      const resolved = path.resolve(path.dirname(full), importPath);
      const target = resolved.endsWith('.js') ? resolved : resolved + '.js';
      if (!fs.existsSync(target)) {
        const rel = path.relative(distDir, full).split(path.sep).join('/');
        const relTarget = path.relative(distDir, target).split(path.sep).join('/');
        console.log(rel + ' -> MISSING: ' + relTarget);
      }
    }
  }
}
check(distDir);
