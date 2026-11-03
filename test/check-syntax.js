'use strict';
const { readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = join(__dirname, '..');
const ignored = new Set(['.git', 'node_modules']);
function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}
const files = scripts(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${relative(root, file)}`);
    console.error(result.stderr || result.error);
    process.exit(1);
  }
}
console.log(`Syntax checks passed for ${files.length} JavaScript files.`);
