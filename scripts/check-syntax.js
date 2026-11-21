const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(filename);
    else if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name)) files.push(filename);
  }
}
for (const directory of ['src', 'scripts', 'tests']) collect(path.join(root, directory));
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`Checked ${files.length} JavaScript files.`);
