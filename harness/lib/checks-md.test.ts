// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, WORKLOADS } from './workloads/workloads.ts';
import { configurations } from './strategies/script.ts';

const HARNESS = join(import.meta.dirname, '..');
const DOC = readFileSync(join(HARNESS, '..', 'CHECKS.md'), 'utf8');

function section(title) {
  const start = DOC.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `CHECKS.md has no "## ${title}" section`);
  const rest = DOC.slice(start + `\n## ${title}\n`.length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function sameNames(named, known, what) {
  const twice = named.filter((n, i) => named.indexOf(n) !== i);
  const missing = [...known].filter((n) => !named.includes(n));
  const unknown = named.filter((n) => !known.has(n));
  assert.deepEqual({ twice, missing, unknown }, { twice: [], missing: [], unknown: [] }, `CHECKS.md's ${what}`);
}

const rows = (text) => [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

function assignedChecks(dir) {
  const found = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'testing') for (const n of assignedChecks(path)) found.add(n); }
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) for (const m of readFileSync(path, 'utf8').matchAll(/\bcheck: (\d+)\b/g)) found.add(Number(m[1]));
  }
  return found;
}

test('CHECKS.md names every run, setup, workload, variant and numbered check, and nothing else', () => {
  sameNames(rows(section('The runs')), new Set(RUNS), 'runs');
  sameNames(rows(section('The setups')), new Set(Object.keys(configurations())), 'setups');
  const workloads = section('The workloads, and what each checks');
  const ran = new Set(RUNS.map((id) => id.split('/')[1]));
  sameNames([...workloads.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]), ran, 'workloads');
  for (const name of ran) {
    const own = workloads.slice(workloads.indexOf(`### \`${name}\``)).split(/^### /m)[1];
    sameNames([...own.matchAll(/^- \*\*`([^`]+)`:\*\*/gm)].map((m) => m[1]), new Set(WORKLOADS[name].variants ?? []), `${name} variants`);
  }
  const checks = [...section('The checks every run is judged by').matchAll(/^### Check (\d+): /gm)].map((m) => m[1]);
  sameNames(checks, new Set([...assignedChecks(join(HARNESS, 'lib'))].map(String)), 'numbered checks');
});
