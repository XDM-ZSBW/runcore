// Quick script to find local-tier files that import gated modules
const fs = require('fs');
const path = require('path');
const tiers = JSON.parse(fs.readFileSync('module-tiers.json', 'utf-8'));

const gated = new Set();
for (const [key, val] of Object.entries(tiers)) {
  if (key === 'local' || key === '$schema') continue;
  if (val.paths) val.paths.forEach(p => gated.add(p));
}

const localPaths = tiers.local.paths;
for (const lp of localPaths) {
  const rel = lp.replace(/^src\//, '');
  const fullPath = path.join('src', rel);
  try {
    const s = fs.statSync(fullPath);
    const files = s.isDirectory()
      ? fs.readdirSync(fullPath, { recursive: true })
          .filter(f => f.endsWith('.ts'))
          .map(f => path.join(fullPath, f))
      : [fullPath];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('import type')) continue;
        const m = line.match(/from ["'](\.\/.+?)["']/);
        if (!m) continue;
        // Resolve relative import to src/ path
        const dir = path.dirname(file).replace(/\\/g, '/');
        const resolved = path.posix.normalize(dir + '/' + m[1]).replace('.js', '.ts');
        for (const gp of gated) {
          const gpNorm = gp.replace(/\/$/, '');
          if (resolved.startsWith(gpNorm)) {
            console.log(`${file}:${i + 1} -> ${resolved} (gated: ${gp})`);
          }
        }
      }
    }
  } catch {}
}
