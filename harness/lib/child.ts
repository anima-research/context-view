// @ts-nocheck
import { writeFileSync } from 'node:fs';
import { SignalDeath, buildCheckpoint, drivenOff, factsOf, installCandidateIn, installRelease, workloadRun } from './drive.ts';
import { HarnessFailure } from './pool.ts';

const KINDS = {
  release: installRelease,
  candidate: installCandidateIn,
  facts: factsOf,
  checkpoint: buildCheckpoint,
  run: (spec) => (spec.recording ? workloadRun(spec) : drivenOff(spec)),
};

const spec = JSON.parse(process.argv[2]);
let result;
try {
  if (!KINDS[spec.kind]) throw new Error(`the harness has no child kind ${JSON.stringify(spec.kind)}`);
  result = { value: await KINDS[spec.kind](spec) };
} catch (e) {
  result = e instanceof SignalDeath
    ? { signalled: { boot: e.boot, signal: e.signal } }
    : e instanceof HarnessFailure ? { failed: e.message }
    : { threw: { message: String(e?.message ?? e), ...(typeof e?.full === 'string' ? { full: e.full } : {}) } };
}
writeFileSync(spec.result, JSON.stringify(result));
process.exit(0);
