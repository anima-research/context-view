import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { sh } from './common.ts';
import { KEY_PACKAGES, stackVersions } from './strategies/lane.ts';
import type { Pack, Versions } from './shapes/interfaces.ts';

type Overrides = { [key: string]: unknown };
interface Installed { hostDir: string; installDir: string; versions: Versions }
interface PackageJson { dependencies?: Overrides; optionalDependencies?: Overrides; devDependencies?: Overrides; overrides?: Overrides }

export function readPacks(paths: string[]): Pack[] {
  return paths.map((p) => {
    let name: string;
    try { name = JSON.parse(sh('tar', ['-xzOf', p, 'package/package.json']).stdout).name; } catch (e) { throw new Error(`the overlay ${p} couldn't be read as a packed release: ${(e as Error).message}`); }
    if (name === '@animalabs/connectome-host') throw new Error(`the overlay ${p} is connectome-host, which --host is: give --host the host change's checkout to run a host change`);
    if (!KEY_PACKAGES.includes(name)) throw new Error(`the overlay ${p} is ${name}; overlay one of ${KEY_PACKAGES.filter((k) => k !== '@animalabs/connectome-host').join(', ')}`);
    return { path: p, name, integrity: `sha512-${createHash('sha512').update(readFileSync(p)).digest('base64')}` };
  });
}

// Every override of NAME, by its name or a version-qualified NAME@RANGE, at the top or nested under another package, set to
// the root's own NAME, the pack. An override object's own version is its '.' key; its other keys pin packages under it, which stay.
const pointed = (overrides: Overrides, name: string, top: boolean): Overrides => {
  const out: Overrides = {};
  for (const [key, given] of Object.entries(overrides)) {
    const inner = given !== null && typeof given === 'object' ? pointed(given as Overrides, name, false) : given;
    out[key] = key !== name && !key.startsWith(`${name}@`) ? inner : inner !== null && typeof inner === 'object' ? { ...inner, '.': `$${name}` } : `$${name}`;
  }
  if (top && out[name] === undefined) out[name] = `$${name}`;
  return out;
};

// forced: packages whose pack replaces every copy through npm's overrides, even where a range in the host's tree refuses its version.
export function installCandidate({ root, packs, dir, leaveOut = [], npmCi, forced = [] }: { root: string; packs: Pack[]; dir: string; leaveOut?: string[]; npmCi: ((dir: string) => unknown) | null; forced?: string[] }): Installed {
  if (forced.length && !packs.length) throw new Error(`the forced package ${forced.join(', ')} has no pack to lay over the host`);
  for (const name of forced) if (!packs.some((p) => p.name === name)) throw new Error(`the forced package ${name} has no pack among the overlays`);
  if (!packs.length) {
    if (!existsSync(join(root, 'node_modules'))) throw new Error(`there's no install at ${root}; run npm ci first`);
    return { hostDir: root, installDir: root, versions: stackVersions(root, { installDir: root }) };
  }
  mkdirSync(dir, { recursive: true });
  const inside = [dir, ...leaveOut].map((p) => relative(root, p)).filter((rel) => rel && !rel.startsWith('..') && !isAbsolute(rel));
  const excludes = ['node_modules', '.git', ...inside].map((rel) => `--exclude=./${rel}`);
  sh('bash', ['-c', 'set -o pipefail; tar -C "$ROOT" "$@" -cf - . | tar -x -C "$DIR"', 'copy', ...excludes], { env: { ROOT: root, DIR: dir } });
  npmCi!(dir);
  const pinned = packs.filter((p) => forced.includes(p.name));
  if (pinned.length) {
    const file = join(dir, 'package.json');
    const pkg: PackageJson = JSON.parse(readFileSync(file, 'utf-8'));
    for (const { name, path } of pinned) {
      // npm's `$NAME` names the root's own dependency on NAME, so the pack goes wherever the root names NAME (an
      // optionalDependencies entry outranks a dependencies one), or into its dependencies, as a plain overlay's `npm install` puts it.
      const fields = (['dependencies', 'optionalDependencies', 'devDependencies'] as const).filter((f) => pkg[f]?.[name] !== undefined);
      for (const field of fields.length ? fields : (['dependencies'] as const)) pkg[field] = { ...pkg[field], [name]: `file:${path}` };
      pkg.overrides = pointed(pkg.overrides ?? {}, name, true);
    }
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...packs.filter((p) => !pinned.includes(p)).map((p) => p.path)], { cwd: dir, timeout: 900_000 });
  const lock: Record<string, { integrity?: string; resolved?: string }> = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages ?? {};
  for (const { path, name, integrity } of packs) {
    const copies = Object.entries(lock).filter(([at]) => at.endsWith(`node_modules/${name}`));
    if (!copies.length || copies.some(([, l]) => l.integrity !== integrity)) {
      throw new Error(`the overlay ${path} didn't replace every copy of ${name}: ${copies.map(([at, l]) => `${at} from ${l.resolved}`).join('; ')}`);
    }
  }
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir, source: root }) };
}
