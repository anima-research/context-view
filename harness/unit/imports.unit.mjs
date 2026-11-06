import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const HARNESS = resolve(import.meta.dirname, '..');
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(mjs|cjs|js|ts)$/.test(entry.name) ? [path] : [];
  });
}

test('nothing in harness/ imports from outside it, so all of this repository\'s code that a view\'s jobs run is in harness/', () => {
  const outside = [];
  for (const file of sources(HARNESS)) {
    for (const m of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')) continue;
      const target = spec.startsWith('file:') ? new URL(spec).pathname : resolve(dirname(file), spec);
      if (target !== HARNESS && !target.startsWith(HARNESS + sep)) outside.push(`${relative(HARNESS, file)}: ${spec}`);
    }
  }
  assert.deepEqual(outside, []);
});
