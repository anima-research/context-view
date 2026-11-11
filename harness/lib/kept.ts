import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Versions } from './shapes/interfaces.ts';

type Facts = Record<string, unknown>;
interface Entry { versions: Versions; facts: Record<string, Facts> }

const named = (versions: Versions | null | undefined) => Object.entries(versions ?? {}).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function keptReleases<R extends { versions: Versions }>({ dir, lane, install, log = () => {} }: {
  dir: string | null | undefined;
  lane: string;
  install: (tag: string) => R | Promise<R>;
  log?: (line: string) => void;
}) {
  const installs = new Map<string, Promise<{ release: R } | { failed: unknown }>>();
  const seconds: Record<string, number> = {};
  const pathOf = (tag: string) => (dir ? join(dir, 'releases', `${tag}-${lane.slice(0, 16)}.json`) : null);
  const changed = (tag: string, ours: Versions | undefined, theirs: Versions | undefined) => new Error(`${tag}'s kept facts (${pathOf(tag)}) name ${named(theirs)}, where this invocation's ${tag} is ${named(ours)}: the tag's contents changed between two installs, so checkpoints made from it can't all be from one release; give both arms an empty --checkpoints and run them again`);
  function read(tag: string): Entry | null {
    const file = pathOf(tag);
    if (!file || !existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
  }
  function write(tag: string, entry: Entry) {
    const file = pathOf(tag);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const written = `${file}.${process.pid}`;
    writeFileSync(written, `${JSON.stringify(entry)}\n`);
    renameSync(written, file);
  }
  function installed(tag: string, reported?: Versions): Promise<R> {
    if (!installs.has(tag)) {
      installs.set(tag, (async () => {
        try {
          const t = performance.now();
          let release: R;
          try { release = await install(tag); } catch (e) { throw new Error(`installing ${tag} failed: ${(e as Error).message}`); }
          seconds[tag] = Math.round((performance.now() - t) / 100) / 10;
          const kept = read(tag);
          if (kept && !same(kept.versions, release.versions)) throw changed(tag, release.versions, kept.versions);
          if (reported && !same(reported, release.versions)) throw changed(tag, release.versions, reported);
          if (!kept) write(tag, { versions: release.versions, facts: {} });
          log(`installed ${tag}: ${named(release.versions)}`);
          return { release };
        } catch (e) {
          return { failed: e };
        }
      })());
    }
    return installs.get(tag)!.then((got) => {
      if ('failed' in got) throw got.failed;
      const { release } = got;
      if (reported && !same(reported, release.versions)) throw changed(tag, release.versions, reported);
      return release;
    });
  }
  const reading = new Map<string, Promise<Facts>>();
  async function facts(tag: string, configName: string, factsOf: (release: R) => Facts | Promise<Facts>, reported: Versions) {
    const kept = read(tag);
    if (kept && !same(kept.versions, reported)) throw changed(tag, reported, kept.versions);
    if (kept?.facts?.[configName]) return { versions: reported, facts: kept.facts[configName] };
    const key = `${tag}\n${configName}`;
    if (!reading.has(key)) reading.set(key, (async () => factsOf(await installed(tag, reported)))());
    const own = await reading.get(key)!;
    const now = read(tag);
    if (now && !same(now.versions, reported)) throw changed(tag, reported, now.versions);
    write(tag, { versions: reported, facts: { ...(now?.facts ?? {}), [configName]: own } });
    return { versions: reported, facts: own };
  }
  const versions = async (tag: string) => read(tag)?.versions ?? (await installed(tag)).versions;
  return { installed, facts, versions, seconds };
}
