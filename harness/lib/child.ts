import { writeFileSync } from 'node:fs';
import { SignalDeath, buildCheckpoint, drivenOff, factsOf, installCandidateIn, installRelease, windowOf, workloadRun } from './drive.ts';
import { HarnessFailure } from './pool.ts';
import type { RunSpec } from './drive.ts';

const KINDS = {
  release: installRelease,
  candidate: installCandidateIn,
  facts: factsOf,
  checkpoint: buildCheckpoint,
  window: windowOf,
  run: (spec: RunSpec) => (spec.recording ? workloadRun(spec) : drivenOff(spec)),
};

export type ChildKind = keyof typeof KINDS;
export type ChildAsk<K extends ChildKind = ChildKind> = { [J in K]: { kind: J } & Parameters<(typeof KINDS)[J]>[0] }[K];
export type ChildSpec<K extends ChildKind = ChildKind> = ChildAsk<K> & { result: string };
export type ChildValue<K extends ChildKind> = Awaited<ReturnType<(typeof KINDS)[K]>>;
export type ChildResult<T = unknown> =
  | { value: T; signalled?: undefined; failed?: undefined; threw?: undefined }
  | { signalled: { boot: number; signal: NodeJS.Signals }; value?: undefined; failed?: undefined; threw?: undefined }
  | { failed: string; value?: undefined; signalled?: undefined; threw?: undefined }
  | { threw: { message: string; full?: string }; value?: undefined; signalled?: undefined; failed?: undefined };

const spec = JSON.parse(process.argv[2]) as ChildSpec;
let result: ChildResult;
try {
  if (!Object.hasOwn(KINDS, spec.kind)) throw new Error(`the harness has no child kind ${JSON.stringify(spec.kind)}`);
  result = { value: await (KINDS[spec.kind] as (spec: ChildSpec) => unknown)(spec) };
} catch (e) {
  result = e instanceof SignalDeath
    ? { signalled: { boot: e.boot, signal: e.signal } }
    : e instanceof HarnessFailure ? { failed: e.message }
    : { threw: { message: String((e as { message?: unknown } | null | undefined)?.message ?? e), ...(typeof (e as { full?: unknown } | null | undefined)?.full === 'string' ? { full: (e as { full: string }).full } : {}) } };
}
writeFileSync(spec.result, JSON.stringify(result));
process.exit(0);
