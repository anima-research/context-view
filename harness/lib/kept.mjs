import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const named = (versions) => Object.entries(versions ?? {}).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function keptReleases({ dir, lane, install, log = () => {} }) {
  const installs = new Map();
  const seconds = {};
  const pathOf = (tag) => (dir ? join(dir, 'releases', `${tag}-${lane.slice(0, 16)}.json`) : null);
  const changed = (tag, ours, theirs) => new Error(`${tag}'s kept facts (${pathOf(tag)}) name ${named(theirs)}, where this invocation's ${tag} is ${named(ours)}: the tag's contents changed between two installs, so checkpoints made from it can't all be from one release; give both arms an empty --checkpoints and run them again`);
  function read(tag) {
    const file = pathOf(tag);
    if (!file || !existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
  }
  function write(tag, entry) {
    const file = pathOf(tag);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const written = `${file}.${process.pid}`;
    writeFileSync(written, `${JSON.stringify(entry)}\n`);
    renameSync(written, file);
  }
  function installed(tag, reported) {
    if (!installs.has(tag)) {
      installs.set(tag, (async () => {
        try {
          const t = performance.now();
          let release;
          try { release = await install(tag); } catch (e) { throw new Error(`installing ${tag} failed: ${e.message}`); }
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
    return installs.get(tag).then(({ release, failed }) => {
      if (failed) throw failed;
      if (reported && !same(reported, release.versions)) throw changed(tag, release.versions, reported);
      return release;
    });
  }
  async function facts(tag, configName, factsOf, reported) {
    const kept = read(tag);
    if (kept && !same(kept.versions, reported)) throw changed(tag, reported, kept.versions);
    if (kept?.facts?.[configName]) return { versions: reported, facts: kept.facts[configName] };
    const own = await factsOf(await installed(tag, reported));
    const now = read(tag);
    if (now && !same(now.versions, reported)) throw changed(tag, reported, now.versions);
    write(tag, { versions: reported, facts: { ...(now?.facts ?? {}), [configName]: own } });
    return { versions: reported, facts: own };
  }
  const versions = async (tag) => read(tag)?.versions ?? (await installed(tag)).versions;
  return { installed, facts, versions, seconds };
}
