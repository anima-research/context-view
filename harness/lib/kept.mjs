import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const named = (versions) => Object.entries(versions ?? {}).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

export function keptReleases({ dir, lane, install, log = () => {} }) {
  const installs = new Map();
  const seconds = {};
  const pathOf = (tag) => (dir ? join(dir, 'releases', `${tag}-${lane.slice(0, 16)}.json`) : null);
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
  function installed(tag) {
    if (!installs.has(tag)) {
      const t = performance.now();
      let release;
      try { release = install(tag); } catch (e) { throw new Error(`installing ${tag} failed: ${e.message}`); }
      seconds[tag] = Math.round((performance.now() - t) / 100) / 10;
      const kept = read(tag);
      if (kept && JSON.stringify(kept.versions) !== JSON.stringify(release.versions)) throw new Error(`${tag} installed as ${named(release.versions)}, where its kept facts name ${named(kept.versions)}`);
      if (!kept) write(tag, { versions: release.versions, facts: {} });
      log(`installed ${tag}: ${named(release.versions)}`);
      installs.set(tag, release);
    }
    return installs.get(tag);
  }
  function facts(tag, configName, factsOf) {
    const kept = read(tag);
    if (kept?.facts?.[configName]) return { versions: kept.versions, facts: kept.facts[configName] };
    const release = installed(tag);
    const own = factsOf(release);
    write(tag, { versions: release.versions, facts: { ...(read(tag)?.facts ?? {}), [configName]: own } });
    return { versions: release.versions, facts: own };
  }
  const versions = (tag) => read(tag)?.versions ?? installed(tag).versions;
  return { installed, facts, versions, seconds };
}
