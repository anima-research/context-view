import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const HARNESS = resolve(import.meta.dirname);
const FIXTURES = join(HARNESS, 'lib', 'reach', 'testing', 'fixtures') + sep;
const NOCHECK = /^\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/\s*)*\/\/\/?\s*@ts-nocheck\b/im;
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(mjs|cjs|js|ts|mts|cts)$/.test(entry.name) ? [path] : [];
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

test('no .mjs or .cjs file outside lib/reach/testing/fixtures/: the harness\'s own files are .ts and .cts, and the test glob runs only .ts', () => {
  const js = sources(HARNESS).filter((f) => !f.startsWith(FIXTURES) && /\.(mjs|cjs)$/.test(f)).map((f) => relative(HARNESS, f));
  assert.deepEqual(js, []);
});

test('no file outside lib/reach/testing/fixtures/ imports or requires a relative .mjs or .cjs path in quotes', () => {
  const found = [];
  for (const file of sources(HARNESS)) {
    if (file.startsWith(FIXTURES)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (/^\.\.?\//.test(spec) && /\.(mjs|cjs)$/.test(spec)) found.push(`${relative(HARNESS, file)}: ${spec}`);
    }
  }
  assert.deepEqual(found, []);
});

test('no file outside lib/reach/testing/fixtures/ holds a // @ts-nocheck line, alone or after block comments on its line, anywhere in it', () => {
  const unchecked = sources(HARNESS).filter((f) => !f.startsWith(FIXTURES) && NOCHECK.test(readFileSync(f, 'utf8'))).map((f) => relative(HARNESS, f));
  assert.deepEqual(unchecked, []);
});

test('the walk these guards read reaches the whole harness: its entry, the library\'s code, its tests and the fixtures', () => {
  const walked = new Set(sources(HARNESS).map((f) => relative(HARNESS, f)));
  for (const f of ['run.ts', 'imports.test.ts', 'lib/main.ts', 'lib/strategies/driver.ts', 'lib/reach/reach.test.ts', 'lib/reach/testing/fixtures/host.mjs']) assert.ok(walked.has(f), f);
});

test('no *.unit.ts anywhere: a test is a *.test.ts beside what it tests, which is what the test command runs', () => {
  assert.deepEqual(sources(HARNESS).filter((f) => f.endsWith('.unit.ts')).map((f) => relative(HARNESS, f)), []);
});
