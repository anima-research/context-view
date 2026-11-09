#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXIT, type Outcome } from "./interfaces.ts";
import { reachJoined } from "../harness/lib/reach.ts";

export const REPOS: Record<string, { gh: string; pack: string | null }> = {
  "context-manager": { gh: "anima-research/context-manager", pack: "@animalabs/context-manager" },
  "agent-framework": { gh: "anima-research/agent-framework", pack: "@animalabs/agent-framework" },
  membrane: { gh: "antra-tess/membrane", pack: "@animalabs/membrane" },
  "connectome-host": { gh: "anima-research/connectome-host", pack: null },
};
export const HOST = "anima-research/connectome-host";
export const HARNESS = { repo: "anima-research/context-view", run: "harness/run.ts" };
export const SHARES = 12;
const FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
// Bun.semver.satisfies meets any spec it can't read as a range (npm:, github:, git+, file:, a dist-tag such as rc1),
// where npm fetches what the spec names instead; node-semver's README gives the grammar of a range.
const XR = "(?:[xX*]|0|[1-9]\\d*)";
const PARTIAL = `v?${XR}(?:\\.${XR}(?:\\.${XR}(?:-[-0-9A-Za-z]+(?:\\.[-0-9A-Za-z]+)*)?(?:\\+[-0-9A-Za-z]+(?:\\.[-0-9A-Za-z]+)*)?)?)?`;
const SIMPLE = new RegExp(`^(?:[<>]=?|=|~>?|\\^)?${PARTIAL}$`);
const HYPHEN = new RegExp(`^${PARTIAL} - ${PARTIAL}$`);
export const plainRange = (range: string) => range.split("||").every((part) => {
  const t = part.trim().replace(/([<>]=?|=|~>?|\^)\s+/g, "$1").replace(/\s+/g, " ");
  return t === "" || HYPHEN.test(t) || t.split(" ").every((c) => SIMPLE.test(c));
});
export const meets = (version: string, range: string) => plainRange(range) && Bun.semver.satisfies(version, range);

// The packages the harness lays over a host and records in candidate.versions, connectome-host aside.
const MOVABLE = ["@animalabs/agent-framework", "@animalabs/context-manager", "@animalabs/membrane", "@animalabs/chronicle"];
type Field = (typeof FIELDS)[number];
export type Entry = { version?: string } & Partial<Record<Field, Record<string, string>>>;
type Side = "base" | "head";
const SIDES = ["base", "head"] as const;
// wantedBy: the lockfile path of the entry that asks, `NAME@VERSION` for a release the plan chose, or null for the arm's
// own package.json.
export type Ask = { range: string; wantedBy: string | null };
export type Chosen = { version: string; host: string; ranges: Ask[]; asks?: string; missed?: Ask & { package: string; has: string | null } };
export type Stack = Record<Side, Record<string, Chosen>>;
// A range on the candidate's own package that no published release of its asker can be moved to meet, laid over in that arm.
export type Forced = Record<Side, (Ask & { has: string })[]>;
type Asked = Ask & { target: string; by: string | null };

// The releases each arm runs besides the pull request's own package, where the host's lockfile's don't meet every range
// in the arm's stack (AGENTS.md, "The stack"), or why none could be chosen. releases(name), a package's published
// releases by version, is called only once a package has to move.
export function resolve(lock: Record<string, Entry>, pack: string, pkgs: Record<Side, Entry>, releases: (name: string) => Record<string, Entry>):
  { stack: Stack | null; forced?: Forced } | { stop: Record<string, unknown> } {
  const top = (name: string) => lock[`node_modules/${name}`];
  const stacked = (name: string) => name.startsWith("@animalabs/") && name !== pack && top(name)?.version !== undefined;
  const movable = (name: string) => MOVABLE.includes(name) && stacked(name);
  const copyOf = (at: string, name: string) => at === `node_modules/${name}` || at.endsWith(`/node_modules/${name}`) || at.includes(`node_modules/${name}/`);
  const read = new Map<string, Record<string, Entry>>();
  const docOf = (name: string) => { let d = read.get(name); if (!d) read.set(name, d = releases(name)); return d; };
  const chosen: Record<Side, Record<string, string>> = { base: {}, head: {} };
  const forced: Forced = { base: [], head: [] };
  const isForced = (side: Side, a: Asked) => a.target === pack && forced[side].some((f) => f.range === a.range && f.wantedBy === a.wantedBy);
  const has = (side: Side, name: string) => (name === pack ? pkgs[side].version : chosen[side][name] ?? top(name)!.version);
  const asked = (side: Side, moved: Record<string, string>, except?: string) => {
    const out: Asked[] = [];
    const add = (entry: Entry, wantedBy: string | null, by: string | null, on: (n: string) => boolean) => {
      for (const field of FIELDS) for (const [target, range] of Object.entries(entry[field] ?? {})) if (on(target)) out.push({ target, range, wantedBy, by });
    };
    add(pkgs[side], null, null, stacked);
    // npm, laying a pack over the host, keeps a registry copy beside it wherever a range in the host's tree isn't met by
    // the pack's version, and the harness refuses an overlay that leaves a copy.
    for (const [at, entry] of Object.entries(lock)) {
      if (at === "" || [pack, ...Object.keys(moved)].some((n) => copyOf(at, n))) continue;
      const name = at.slice("node_modules/".length);
      add(entry, at, at.startsWith("node_modules/") && movable(name) ? name : null, (n) => n === pack || n in moved);
    }
    for (const [name, version] of Object.entries(moved).sort(([a], [b]) => (a < b ? -1 : 1)))
      if (name !== except) add(docOf(name)[version]!, `${name}@${version}`, name, (n) => n === pack || stacked(n));
    return out;
  };
  const missed = (side: Side) => asked(side, chosen[side]).filter((a) => { if (isForced(side, a)) return false; const v = has(side, a.target); return v === undefined || !meets(v, a.range); });
  const mover = (a: Asked) => (a.target !== pack ? (movable(a.target) ? a.target : null) : a.by);
  const on = (side: Side, name: string) => asked(side, { ...chosen[side], [name]: "" }, name).filter((a) => a.target === name);
  const admits = (name: string, v: string, side: Side) => FIELDS.every((field) => {
    const range = docOf(name)[v]![field]?.[pack];
    return range === undefined || (pkgs[side].version !== undefined && meets(pkgs[side].version!, range));
  });
  const candidates = (name: string, among: readonly Side[], admitting = true) => {
    const ranges = among.map((side) => on(side, name));
    return Object.keys(docOf(name)).filter((v) => among.every((side, i) => ranges[i]!.every((a) => meets(v, a.range)) && (!admitting || admits(name, v, side))
      && (ranges[i]!.length > 0 || !/^\d+\.\d+\.\d+-/.test(v))));
  };
  const force = (side: Side, a: Asked) => { forced[side].push({ range: a.range, wantedBy: a.wantedBy, has: has(side, a.target)! }); };
  const pick = (vs: string[], h: string) => (vs.includes(h) ? h
    : vs.filter((v) => Bun.semver.order(v, h) > 0).sort(Bun.semver.order)[0] ?? vs.filter((v) => Bun.semver.order(v, h) < 0).sort(Bun.semver.order).at(-1)!);
  const lead = (side: Side, a: Asked) => ({ arm: side, package: a.target, range: a.range, wantedBy: a.wantedBy, has: has(side, a.target) ?? null });
  const state = () => JSON.stringify(SIDES.map((side) => [Object.entries(chosen[side]).sort(([a], [b]) => (a < b ? -1 : 1)), forced[side].length]));
  const seen = new Set([state()]);
  for (;;) {
    const side = SIDES.find((s) => missed(s).length);
    if (!side) break;
    const found = missed(side)[0]!, at = lead(side, found);
    if (!plainRange(found.range)) return { stop: { ...at, why: "not-plain" } };
    if (at.has === null) return { stop: { ...at, why: "no-mover" } };
    const name = mover(found);
    if (!name && found.target === pack) { force(side, found); seen.add(state()); continue; }
    if (!name) return { stop: { ...at, why: "no-mover" } };
    const h = top(name)!.version!;
    const set = (s: Side, v: string) => { if (v === h) delete chosen[s][name]; else chosen[s][name] = v; };
    const both = candidates(name, SIDES);
    if (both.length) for (const s of SIDES) set(s, pick(both, h));
    else {
      const picks: [Side, string][] = [];
      for (const s of SIDES) {
        const miss = missed(s).find((a) => mover(a) === name);
        if (!miss) continue;
        const ranges = on(s, name);
        const bent = ranges.find((a) => !plainRange(a.range));
        if (bent) return { stop: { ...lead(s, { ...bent, target: name, by: null }), why: "not-plain" } };
        const own = candidates(name, [s]);
        if (own.length) { picks.push([s, pick(own, h)]); continue; }
        if (miss.target === pack) {
          if (has(s, pack) === undefined) return { stop: { ...lead(s, miss), why: "no-mover" } };
          force(s, miss);
          continue;
        }
        const near = candidates(name, [s], false);
        if (!near.length) return { stop: { ...lead(s, miss), why: "no-release", release: name, ranges: ranges.map(({ range, wantedBy }) => ({ range, wantedBy })) } };
        picks.push([s, pick(near, h)]);
      }
      for (const [s, v] of picks) set(s, v);
    }
    if (seen.has(state())) return { stop: { ...at, why: "unsettled", tried: { ...chosen[side] } } };
    seen.add(state());
  }
  const back = (name: string, sides: readonly Side[]) => {
    const kept = sides.map((s) => chosen[s][name]!);
    for (const s of sides) delete chosen[s][name];
    const stays = sides.map((s) => { const a = missed(s)[0]; return a && { package: a.target, range: a.range, wantedBy: a.wantedBy, has: has(s, a.target) ?? null }; });
    sides.forEach((s, i) => { chosen[s][name] = kept[i]!; });
    return stays;
  };
  for (let moved = true; moved;) {
    moved = false;
    for (const name of [...new Set(SIDES.flatMap((s) => Object.keys(chosen[s])))].sort()) {
      const agree = chosen.base[name] !== undefined && chosen.base[name] === chosen.head[name];
      for (const group of agree ? [SIDES] : SIDES.filter((s) => chosen[s][name] !== undefined).map((s) => [s] as const)) {
        if (back(name, group).some((a) => a !== undefined)) continue;
        for (const s of group) delete chosen[s][name];
        moved = true;
      }
    }
  }
  for (const side of SIDES) forced[side] = forced[side].filter((f) => asked(side, chosen[side]).some((a) => a.target === pack && a.range === f.range && a.wantedBy === f.wantedBy));
  const anyForced = SIDES.some((side) => forced[side].length);
  if (!SIDES.some((side) => Object.keys(chosen[side]).length)) return anyForced ? { stack: null, forced } : { stack: null };
  const stack: Stack = { base: {}, head: {} };
  for (const side of SIDES) {
    for (const [name, version] of Object.entries(chosen[side]).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const asks = FIELDS.map((field) => docOf(name)[version]![field]?.[pack]).find((r) => r !== undefined);
      const need = back(name, [side])[0];
      stack[side][name] = { version, host: top(name)!.version!, ranges: on(side, name).map(({ range, wantedBy }) => ({ range, wantedBy })), ...(asks !== undefined ? { asks } : {}),
        ...(need ? { missed: need } : {}) };
    }
  }
  return anyForced ? { stack, forced } : { stack };
}

const GIT_BASE = process.env.CONTEXT_VIEW_GIT_BASE ?? "https://github.com";
const REGISTRY = (process.env.CONTEXT_VIEW_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const STATE = process.env.CONTEXT_VIEW_STATE ?? join(homedir(), ".local/state/context-view");
const url = (gh: string) => `${GIT_BASE}/${gh}`;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

function run(cmd: string[], opts: { cwd?: string; ok?: number[] } = {}) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`${cmd[0]} couldn't run: ${r.error.message}`);
  if (!(opts.ok ?? [0]).includes(r.status ?? -1)) throw new Error(`${cmd.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
  return { status: r.status ?? -1, out: r.stdout };
}
const tip = (gh: string, ref: string) => {
  const line = run(["git", "ls-remote", url(gh), `refs/heads/${ref}`]).out.trim().split("\n")[0] ?? "";
  const sha = line.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${gh} has no branch ${ref}`);
  return sha;
};
function mirror(gh: string, refs: string[]) {
  const dir = join(STATE, "mirrors", `${gh.replace("/", "__")}.git`);
  run(["git", "init", "-q", "--bare", dir]);
  const own = refs.map((_, i) => `refs/cv/${randomUUID()}/${i}`);
  try {
    run(["git", "-C", dir, "fetch", "-q", "--no-tags", url(gh), ...refs.map((r, i) => `+${r}:${own[i]}`)]);
    return { dir, shas: own.map((ref) => run(["git", "-C", dir, "rev-parse", ref]).out.trim()) };
  } finally {
    for (const ref of own) spawnSync("git", ["-C", dir, "update-ref", "-d", ref]);
  }
}

export function harnessRelease(): { sha: string } | { why: string } {
  const branch = process.env.CONTEXT_VIEW_HARNESS_REF;
  if (branch) return { sha: tip(HARNESS.repo, branch) };
  const file = join(STATE, "harness");
  const sha = existsSync(file) ? readFileSync(file, "utf8").split("\n")[0]!.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return { why: `no harness release: ${file} names no commit` };
  const { dir, shas: [main] } = mirror(HARNESS.repo, ["refs/heads/main"]);
  const install = "so no job could run it: install one with run/install-harness.ts";
  if (spawnSync("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`]).status !== 0)
    return { why: `the harness release ${file} names, ${sha}, isn't among the commits fetched from ${HARNESS.repo}'s main, ${install}` };
  const on = spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", sha, main!], { encoding: "utf8" });
  if (on.status === 1) return { why: `the harness release ${file} names, ${sha}, is a commit of ${HARNESS.repo} that isn't on its main, ${install}` };
  if (on.status !== 0)
    return { why: `couldn't tell whether the harness release ${file} names, ${sha}, is on ${HARNESS.repo}'s main: ${(on.stderr ?? "").trim() || on.error?.message || `git exited ${on.status}`}` };
  return { sha };
}

const pull = (gh: string, number: number) =>
  JSON.parse(run(["gh", "api", `repos/${gh}/pulls/${number}`]).out) as { state: string; merged_at: string | null; head: { sha: string }; base: { ref: string } };

export type Plan = {
  repo: string; number: number; head: string; form: "overlay" | "host";
  base: { ref: string; sha: string }; host: { sha: string }; harness: { repo: string; sha: string }; stack?: Stack; forced?: Forced;
  merged: string;
};
type Manifest = Omit<Plan, "merged"> & { outcome: Outcome; detail: unknown; shares: unknown[]; seconds?: { planned: Seconds | null; measured?: Seconds } };

export function plan(repo: string, number: number, head: string): { plan?: Plan; stop?: { outcome: Outcome; detail: unknown; partial: Partial<Plan> } } {
  const r = REPOS[repo]!;
  const pr = pull(r.gh, number);
  const partial: Partial<Plan> = { repo, number, head, form: r.pack ? "overlay" : "host" };
  if (pr.state !== "open") return { stop: { outcome: "closed", detail: { state: pr.merged_at ? "merged" : pr.state }, partial } };
  if (pr.head.sha !== head) return { stop: { outcome: "moved", detail: { headNow: pr.head.sha }, partial } };
  const { dir: m, shas: [baseSha, headNow] } = mirror(r.gh, [`refs/heads/${pr.base.ref}`, `refs/pull/${number}/head`]);
  const base = { ref: pr.base.ref, sha: baseSha! };
  const host = { sha: r.pack ? tip(HOST, "main") : base.sha };
  const pinned = harnessRelease();
  if ("why" in pinned) return { stop: { outcome: "couldnt-run", detail: { why: pinned.why }, partial: { ...partial, base, host } } };
  const harness = { repo: HARNESS.repo, sha: pinned.sha };
  Object.assign(partial, { base, host, harness });
  if (headNow !== head) return { stop: { outcome: "moved", detail: { headNow }, partial } };
  const mt = run(["git", "-C", m, "merge-tree", "--write-tree", "--no-messages", base.sha, head], { ok: [0, 1] });
  if (mt.status === 1) return { stop: { outcome: "doesnt-merge", detail: null, partial } };
  const merged = mt.out.trim().split("\n")[0]!;
  if (r.pack) {
    const hm = mirror(HOST, [host.sha]).dir;
    const lock = JSON.parse(run(["git", "-C", hm, "show", `${host.sha}:package-lock.json`]).out) as { packages: Record<string, Entry> };
    const show = (rev: string, arm: string) => {
      const text = run(["git", "-C", m, "show", `${rev}:package.json`]).out;
      try { return JSON.parse(text) as Entry; } catch { throw new Error(`the ${arm}'s package.json isn't JSON`); }
    };
    const pkgs = { base: show(base.sha, "base"), head: show(merged, "head") };
    let resolved: ReturnType<typeof resolve>;
    try {
      resolved = resolve(lock.packages, r.pack, pkgs, (name) => {
        const text = run(["curl", "-fsSL", "--max-time", "120", `${REGISTRY}/${name.replace("/", "%2f")}`]).out;
        let doc: { versions?: unknown };
        try { doc = JSON.parse(text); } catch { throw new Error(`the registry's document for ${name} isn't JSON`); }
        if (!doc || typeof doc.versions !== "object" || doc.versions === null) throw new Error(`the registry's document for ${name} gives no versions`);
        return doc.versions as Record<string, Entry>;
      });
    } catch (e) {
      return { stop: { outcome: "couldnt-run", detail: { why: `the run side failed before any job: ${said(e)}` }, partial } };
    }
    if ("stop" in resolved) return { stop: { outcome: "needs-companion", detail: resolved.stop, partial } };
    if (resolved.stack) partial.stack = resolved.stack;
    if (resolved.forced) partial.forced = resolved.forced;
  }
  return { plan: { ...(partial as Plan), merged } };
}

export type Seconds = { runs: Record<string, number>; checkpoints: Record<string, number> };
export const WIDTH = 3;

const table = (v: unknown): Seconds | null => {
  const t = v as Seconds | null;
  const fine = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  return t && typeof t === "object" && fine(t.runs) && fine(t.checkpoints) ? { runs: t.runs, checkpoints: t.checkpoints } : null;
};

export function newestSeconds(views: string, besides: string): Seconds | null {
  if (!existsSync(views)) return null;
  const found = readdirSync(views).map((d) => join(views, d, "manifest.json")).filter((f) => f !== join(besides, "manifest.json"))
    .flatMap((f) => { try { return [{ f, at: statSync(f).mtimeMs }]; } catch { return []; } }).sort((a, b) => b.at - a.at);
  for (const { f } of found) {
    let m: { seconds?: { measured?: unknown } };
    try { m = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    const t = table(m?.seconds?.measured);
    if (t) return t;
  }
  return null;
}

export function measured(out: string, shares: number): Seconds | null {
  const runs: Record<string, number> = {}, checkpoints: Record<string, number> = {};
  for (let i = 1; i <= shares; i++) {
    let r: { seconds?: unknown };
    try { r = JSON.parse(readFileSync(join(out, `share-${i}`, "before", "run.json"), "utf8")); } catch { return null; }
    const t = table(r?.seconds);
    if (!t) return null;
    Object.assign(runs, t.runs);
    for (const [k, v] of Object.entries(t.checkpoints)) checkpoints[k] = Math.max(checkpoints[k] ?? 0, v);
  }
  return { runs, checkpoints };
}

export function job(p: Plan, i: number, seconds: Seconds | null = null) {
  const r = REPOS[p.repo]!;
  const install = "npm ci --ignore-scripts --no-audit --no-fund";
  const headCheck = (dir: string) =>
    `{ [ "$(git -C ${dir} rev-parse FETCH_HEAD)" = ${p.head} ] || { git -C ${dir} rev-parse FETCH_HEAD > "$ON_GH_EVIDENCE_DIR/head-moved"; false; }; }`;
  const blobless = (dir: string, gh: string) =>
    `git clone -q --filter=blob:none --no-checkout ${q(url(gh))} ${dir} && git -C ${dir} -c advice.detachedHead=false checkout -q ${p.base.sha} && ` +
    `git -C ${dir} fetch -q ${q(url(gh))} refs/pull/${p.number}/head && ${headCheck(dir)} && ` +
    `git -C ${dir} -c user.name=context-view -c user.email=context-view@invalid merge -q --no-ff --no-edit ${p.head} && ` +
    `[ "$(git -C ${dir} rev-parse HEAD^{tree})" = ${p.merged} ]`;
  // agent-framework commits no lockfile, so its head arm installs from the one its base arm's install wrote.
  const candInstall = (arm: string) => `{ if [ -f package-lock.json ]; then ${install}; else ${arm === "after" ? `cp "$M/cand-before/package-lock.json" . && ` : ""}npm install --ignore-scripts --no-audit --no-fund; fi; }`;
  const companions = (side: "base" | "head", arm: string) => Object.entries(p.stack?.[side] ?? {})
    .map(([name, c]) => `npm pack ${q(`${name}@${c.version}`)} --registry ${q(`${REGISTRY}/`)} --ignore-scripts --pack-destination "$M/packs-${arm}" >/dev/null`);
  const ready = (side: "base" | "head", list: string) => `{ ${list} > "$M/ready/${side}.tmp" && mv "$M/ready/${side}.tmp" "$M/ready/${side}"; }`;
  const packs = (arm: string) => `{ p=$(ls "$M/packs-${arm}"/*.tgz) && echo "$p" | paste -sd, -; }`;
  const reachDiff = (dir: string) =>
    `{ if git -C ${dir} diff -U0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ ${p.base.sha} HEAD -- src > "$M/reach.diff.tmp" 2> "$M/reach.diff.err.tmp"; ` +
    `then mv "$M/reach.diff.tmp" "$M/reach.diff" && rm -f "$M/reach.diff.err.tmp"; else rm -f "$M/reach.diff.tmp" && mv "$M/reach.diff.err.tmp" "$M/reach.diff.err"; fi; }`;
  const both = (a: string, b: string) => `{ { ${a}; } & a=$!; { ${b}; } & b=$!; wait $a; ra=$?; wait $b; rb=$?; [ $ra -eq 0 ] && [ $rb -eq 0 ]; }`;
  const builds = r.pack
    ? [
      both(
        `git init -q "$M/cand-before" && git -C "$M/cand-before" fetch -q --depth=1 ${q(url(r.gh))} ${p.base.sha} && git -C "$M/cand-before" -c advice.detachedHead=false checkout -q FETCH_HEAD && (cd "$M/cand-before" && ${candInstall("before")} >/dev/null)`,
        `${blobless(`"$M/cand-after"`, r.gh)} && ${reachDiff(`"$M/cand-after"`)}`,
      ),
      both(
        [`(cd "$M/cand-before" && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination "$M/packs-before" >/dev/null)`, ...companions("base", "before"), ready("base", packs("before"))].join(" && "),
        [`(cd "$M/cand-after" && ${candInstall("after")} >/dev/null && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination "$M/packs-after" >/dev/null)`, ...companions("head", "after"), ready("head", packs("after"))].join(" && "),
      ),
    ].join(" && ")
    : both(
      `(cd ../connectome-host && ${install}) && ${ready("base", "printf ''")}`,
      `${blobless("../connectome-head", r.gh)} && ${reachDiff("../connectome-head")} && (cd ../connectome-head && ${install}) && ${ready("head", "printf ''")}`,
    );
  const pair = [
    `node ${HARNESS.run} --pair --host ../connectome-host${r.pack ? "" : " --host-head ../connectome-head"} --ready "$M/ready"`,
    `--checkpoints "$M/cp" --workdir "$M/work" --out "$M/out" --shard ${i}/${SHARES} --drives 3 --width ${WIDTH}`,
    `${seconds ? `--seconds "$M/seconds.json" ` : ""}--self-check --reach "$M/reach.diff"${r.pack ? ` --reach-package "${r.pack}"` : ""}${p.forced ? ` --forced-package "${r.pack}"` : ""}`,
  ].join(" ");
  const setup = [
    `M="$(cd .. && pwd)/m"; E="$ON_GH_EVIDENCE_DIR"; pg=""; built=""`,
    `trap '[ -n "$built" ] || [ -z "$pg" ] || kill -TERM -- -$pg 2>/dev/null || kill -KILL $pg 2>/dev/null' EXIT`,
    `memory=$(awk '/^(MemTotal|SwapTotal):/ { k += $2 } END { printf "%d", k * 1024 }' /proc/meminfo)`,
    `mkdir -p "$M" && sudo mount -t tmpfs -o "size=$((memory + 1073741824)),nr_inodes=0,mode=1777" tmpfs "$M" || exit 1`,
    `fs=$(stat -f -c '%T %b %S' "$M") || exit 1; set -- $fs`,
    `[ "$1" = tmpfs ] && [ $(($2 * $3)) -gt "$memory" ] ||`,
    `  { echo "context-view: $M is $1 of $(($2 * $3)) bytes, not a tmpfs larger than memory plus swap ($memory bytes), so the share won't start" >&2; exit 1; }`,
    `mkdir -p "$M/home" "$M/tmp" "$M/work" "$M/ready"${r.pack ? ` "$M/packs-before" "$M/packs-after"` : ""} || exit 1`,
    ...(seconds ? [`cat > "$M/seconds.json" <<'CONTEXT_VIEW_SECONDS' || exit 1`, JSON.stringify(seconds), `CONTEXT_VIEW_SECONDS`] : []),
    `M="$M" HOME="$M/home" TMPDIR="$M/tmp" NODE_COMPILE_CACHE="$M/node-compile-cache" GITHUB_STEP_SUMMARY="$M/step-summary.md" setsid bash -c '${pair} > "$M/pair.log" 2>&1; echo $? > "$M/pair.rc.tmp" && mv "$M/pair.rc.tmp" "$M/pair.rc"' < /dev/null > /dev/null 2>&1 & pg=$!`,
    `echo $pg > "$M/pair.pid" || exit 1`,
    `${builds} || exit 1`,
    `built=1`,
  ].join("\n");
  const keep = [
    `k=0`,
    `for arm in before after; do [ -d "$W/$arm" ] || continue; mkdir -p "$E/$arm" || k=1`,
    `  for f in run.json summary.md entries.json; do if [ -f "$W/$arm/$f" ]; then cp "$W/$arm/$f" "$E/$arm/" || k=1; fi; done`,
    `  for f in reach.json reach-digests.json; do if [ -f "$W/$arm/$f" ]; then cp "$W/$arm/$f" "$E/$arm/" || { rm -f "$E/$arm/$f"; echo "$f" >> "$E/reach-uncopied"; }; fi; done`,
    `  for d in "$W/$arm"/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); [ "$n" = cp ] && continue; [ "$n" = checkpoints ] && continue; mkdir -p "$E/$arm/$n" || k=1`,
    `    for f in "$d"*.record "$d"report.txt "$d"view.md; do if [ -f "$f" ]; then cp "$f" "$E/$arm/$n/" || k=1; fi; done`,
    `    if [ -d "$d"self-check ]; then cp -r "$d"self-check "$E/$arm/$n/" || k=1; fi; done; done`,
    `for f in "$W/failed.json" "$M/pair.log"; do if [ -f "$f" ]; then cp "$f" "$E/" || k=1; fi; done`,
    `if [ -f "$M/reach.diff.err" ]; then cp "$M/reach.diff.err" "$E/reach-diff.err" || k=1; fi`,
    `printf '%07d 0\\n' 0 > "$E/kb"; dropped=0`,
    `over() { [ "$(du -sklL --apparent-size "$E" | cut -f1)" -gt 51200 ] || [ "$(find -L "$E" -mindepth 1 | wc -l)" -gt 9900 ]; }`,
    `if over; then find "$E" -name view.md -delete; dropped=1; fi`,
    `if over; then rm -f "$E"/*/reach.json "$E"/*/reach-digests.json; echo dropped > "$E/reach-dropped"; fi`,
    `printf '%07d %d\\n' "$(du -sklL --apparent-size "$E" | cut -f1)" "$dropped" > "$E/kb"`,
  ].join("\n");
  const command = [
    `E="$ON_GH_EVIDENCE_DIR"; M="$(cd .. && pwd)/m"; W="$M/out"`,
    `pg=$(cat "$M/pair.pid") || exit 1`,
    `while [ ! -f "$M/pair.rc" ] && kill -0 "$pg" 2>/dev/null; do sleep 0.2; done`,
    `rc=$(cat "$M/pair.rc" 2>/dev/null) || { rc=255; kill -TERM -- -$pg 2>/dev/null; }`,
    `echo "$rc" > "$E/rc-before"; echo "$rc" > "$E/rc-after"`,
    `if [ -f "$M/step-summary.md" ] && [ -n "\${GITHUB_STEP_SUMMARY:-}" ]; then cat "$M/step-summary.md" >> "$GITHUB_STEP_SUMMARY"; fi`,
    keep,
    `exit $k`,
  ].join("\n");
  return { setup, command, with: `${HOST}@${p.host.sha}` };
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);
export const QUOTED = 500;
/** Words the head's code could have written, as data: one line of at most QUOTED characters, in a code span that no
 *  backtick in them can close, which CommonMark reads with one space trimmed from each end. */
export function quoted(text: string) {
  const all = [...text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ")];
  const shown = all.slice(0, QUOTED).join("");
  const fence = "`".repeat(Math.max(0, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = /^[` ]|[` ]$/.test(shown) ? " " : "";
  return `${fence}${pad}${shown}${pad}${fence}${all.length > QUOTED ? `, its first ${QUOTED} of ${all.length} characters` : ""}`;
}
const harnessWhy = (text: string) => {
  try {
    const why = (JSON.parse(text) as { why?: unknown }).why;
    if (typeof why === "string" && why) return `, in its failed.json's words, which the head's code could have written: ${quoted(why)}`;
  } catch {}
  return ": its failed.json gives no why";
};

export function share(dir: string, i: number, dispatched: string) {
  const res = JSON.parse(read(join(dir, "receipt", "result.json")) ?? "null") as { setup?: { exitCode?: number; wallSeconds?: number }; command?: { exitCode?: number | null; wallSeconds?: number }; evidence?: string } | null;
  const ev = join(dir, "receipt", "evidence");
  const kb = (read(join(ev, "kb")) ?? "").split(" ");
  const s = {
    i, dir: `share-${i}`, onGh: read(join(dir, "on-gh.id")), setupExit: res?.setup?.exitCode ?? null, commandExit: res?.command?.exitCode ?? null,
    seconds: { setup: res?.setup?.wallSeconds ?? null, command: res?.command?.wallSeconds ?? null }, kb: Number(kb[0]) || null,
    viewsDropped: kb[1] === "1", home: res?.evidence === "returned",
  };
  const ogh = Number(read(join(dir, "on-gh.exit")) ?? NaN);
  const wrote = read(join(ev, "head-moved"));
  const met = wrote !== null && /^[0-9a-f]{40}$/.test(wrote) && wrote !== dispatched ? wrote : null;
  let why: string | null = null;
  if (s.commandExit !== null && s.commandExit !== 0) why = `its command exited ${s.commandExit}`;
  else if (ogh !== 0 && ogh !== 96) why = `on-gh exited ${Number.isNaN(ogh) ? "without a code" : ogh}${read(join(dir, "on-gh.last")) ? `: ${read(join(dir, "on-gh.last"))}` : ""}`;
  else if (wrote === null && (ogh === 96 || (s.setupExit !== null && s.setupExit !== 0))) why = `its setup exited ${s.setupExit ?? "without a code"}`;
  else if (!s.home) why = res?.evidence === "none" ? "it brought no evidence home"
    : res?.evidence?.startsWith("not uploaded") ? "its evidence was past on-gh's bounds, so it wasn't uploaded" : "its evidence didn't come home";
  else if (met) why = `its head check met ${met}, not the head dispatched`;
  else if (wrote !== null) why = /^[0-9a-f]{40}$/.test(wrote) ? "it wrote the head dispatched as one it met in its place" : "it wrote a head that isn't a commit";
  else if (existsSync(join(ev, "failed.json"))) why = `the harness failed${harnessWhy(read(join(ev, "failed.json"))!)}`;
  // A shell gives 128 plus the signal's number for a command a signal ended.
  const finished = (a: string) => existsSync(join(ev, a, "run.json")) && !(Number(read(join(ev, `rc-${a}`)) ?? NaN) > 128);
  const arm = why ? undefined : (["before", "after"] as const).find((a) => !finished(a));
  const armMissing = arm ? { arm, log: (read(join(ev, "pair.log")) ?? "").split("\n").at(-1) || null } : null;
  return { s, why, armMissing, headMoved: why === `its head check met ${met}, not the head dispatched` ? met : null };
}

export async function main(argv: string[], spawn: typeof Bun.spawn = Bun.spawn) {
  const started = performance.now();
  const halt: { by: "SIGTERM" | "SIGINT" | null } = { by: null };
  const children = new Map<number, ReturnType<typeof Bun.spawn>>();
  const handlers = (["SIGTERM", "SIGINT"] as const).map((sig) => [sig, () => { halt.by ??= sig; for (const c of children.values()) c.kill(sig); }] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    return await view(argv, spawn, started, halt, children);
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

async function view(argv: string[], spawn: typeof Bun.spawn, started: number, halt: { by: "SIGTERM" | "SIGINT" | null }, children: Map<number, ReturnType<typeof Bun.spawn>>) {
  const arg = (k: string) => { const at = argv.indexOf(`--${k}`); return at >= 0 ? argv[at + 1] : undefined; };
  const repo = arg("repo"), number = Number(arg("pr")), head = arg("head"), out = arg("out");
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const f of readdirSync(out)) if (f === "manifest.json" || f === "manifest.json.tmp" || f === "reach.json" || /^share-\d+$/.test(f)) rmSync(join(out, f), { recursive: true, force: true });
  }
  if (!repo || !REPOS[repo] || !Number.isInteger(number) || !head || !/^[0-9a-f]{40}$/.test(head) || !out)
    throw new Error(`usage: context-view-run --repo ${Object.keys(REPOS).join("|")} --pr N --head SHA40 --out DIR`);
  const write = (m: Manifest) => { writeFileSync(join(out, "manifest.json.tmp"), JSON.stringify(m, null, 1)); renameSync(join(out, "manifest.json.tmp"), join(out, "manifest.json")); return EXIT[m.outcome]; };
  const stopped = () => `stopped by ${halt.by} after ${Math.round((performance.now() - started) / 1000)} s`;
  // Bun runs a signal's handler only when its event loop turns, which a synchronous read holds off.
  const turn = () => new Promise((r) => setImmediate(r));
  const known = { repo, number, head } as Plan;
  let decided: ReturnType<typeof plan>;
  try {
    decided = plan(repo, number, head);
  } catch (e) {
    await turn();
    if (halt.by) return write({ ...known, outcome: "couldnt-run", detail: { why: stopped(), shares: [] }, shares: [] });
    return write({ ...known, outcome: "couldnt-run", detail: { why: `the run side failed before any job: ${said(e)}` }, shares: [] });
  }
  await turn();
  if (halt.by) {
    const { merged: _unsaid, ...reached } = (decided.stop?.partial ?? decided.plan!) as Plan;
    return write({ ...known, ...reached, outcome: "couldnt-run", detail: { why: stopped(), shares: [] }, shares: [] });
  }
  if (decided.stop) return write({ ...(decided.stop.partial as Plan), outcome: decided.stop.outcome, detail: decided.stop.detail, shares: [] });
  const p = decided.plan!;
  const { merged: _merged, ...planned } = p;
  const seconds = newestSeconds(join(STATE, "views"), out);
  const onGh = process.env.ON_GH ?? "on-gh";
  const token = randomUUID();
  let failure: { share: number; why: string } | null = null;
  const settled = await Promise.all(Array.from({ length: SHARES }, async (_, k) => {
    const i = k + 1, dir = join(out, `share-${i}`), own = join(dir, `receipt.${token}`);
    if (failure) return null;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      const j = job(p, i, seconds);
      child = spawn([onGh, "--repo", HARNESS.repo, "--sha", p.harness.sha, "--node", "24", "--with", j.with, "--setup", j.setup, "--return-to", own, "--", "bash", "-c", j.command],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, ON_GH_POLL_MS: "2000" } });
      children.set(i, child);
      const [o, e, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
      children.delete(i);
      const id = (o + e).match(/on-gh: (\d{8}T\d{6}Z-[0-9a-f]+)/)?.[1];
      let cancel: string | null = null;
      if (id && (code === 255 || child.signalCode !== null)) {
        const stop = spawn([onGh, "--stop", id], { stdout: "pipe", stderr: "pipe" });
        const [so, se, sc] = await Promise.all([new Response(stop.stdout as ReadableStream).text(), new Response(stop.stderr as ReadableStream).text(), stop.exited]);
        cancel = `${so}${se}on-gh --stop exited ${sc}\n`;
      }
      writeFileSync(join(dir, "on-gh.log"), o + e);
      writeFileSync(join(dir, "on-gh.exit"), String(code));
      if (id) writeFileSync(join(dir, "on-gh.id"), id);
      writeFileSync(join(dir, "on-gh.last"), (o + e).trim().split("\n").at(-1) ?? "");
      if (cancel !== null) writeFileSync(join(dir, "on-gh.stop"), cancel);
      if (existsSync(own)) renameSync(own, join(dir, "receipt"));
      const result = share(dir, i, p.head);
      const ev = join(dir, "receipt", "evidence");
      for (const a of ["before", "after"]) if (existsSync(join(ev, a))) renameSync(join(ev, a), join(dir, a));
      return result;
    } catch (e) {
      failure ??= { share: i, why: `the run side failed on it: ${said(e)}` };
      for (const c of children.values()) c.kill("SIGTERM");
      if (child) await child.exited;
      children.delete(i);
      return null;
    }
  }));
  const jobs = settled.filter((j) => j !== null);
  const shares = jobs.map((j) => j.s);
  const came = measured(out, SHARES);
  const plain = { ...planned, seconds: { planned: seconds, ...(came ? { measured: came } : {}) } };
  const halted = () => write({ ...plain, outcome: "couldnt-run", detail: {
    why: stopped(), shares: Array.from({ length: SHARES }, (_, k) => k + 1).filter((i) => !jobs.some((j) => j.s.i === i && j.s.home)) }, shares });
  await turn();
  if (halt.by) return halted();
  const now = (() => {
    try { return pull(REPOS[repo]!.gh, number); } catch (e) { console.error(`context-view-run: the read after the jobs failed, so what the jobs saw stands: ${said(e)}`); return null; }
  })();
  await turn();
  if (halt.by) return halted();
  const meanwhile = now && now.state !== "open" ? { state: now.merged_at ? "merged" : now.state }
    : now && now.head.sha !== head ? { headNow: now.head.sha } : null;
  const failed = failure ?? (() => {
    const j = jobs.find((j) => j.why && !(meanwhile && j.headMoved !== null && j.headMoved === now!.head.sha));
    return j ? { share: j.s.i, why: j.why! } : null;
  })();
  if (failed) return write({ ...plain, outcome: "couldnt-run", detail: { ...failed, ...meanwhile }, shares });
  if (meanwhile) return write({ ...plain, outcome: "state" in meanwhile ? "closed" : "moved", detail: meanwhile, shares });
  const missing = jobs.find((j) => j.armMissing);
  if (missing) return write({ ...plain, outcome: "arm-missing", detail: { share: missing.s.i, ...missing.armMissing }, shares });
  writeReach(out);
  return write({ ...plain, outcome: "ran", detail: null, shares });
}

function reachOfView(out: string) {
  try { return reachJoined(Array.from({ length: SHARES }, (_, k) => reachOfShare(out, k + 1))); } catch (e) {
    return { couldnt: `the shares' reach couldn't be joined: ${said(e)}` };
  }
}

/** Writes DIR/reach.json; one that can't be written leaves the manifest to be written all the same, and the view then
 *  refuses the run for the missing file, naming it, rather than finding no manifest. */
export function writeReach(out: string) {
  try { writeFileSync(join(out, "reach.json"), JSON.stringify(reachOfView(out), null, 1)); return true; } catch (e) {
    console.error(`reach.json couldn't be written: ${said(e)}`);
    return false;
  }
}

function reachOfShare(out: string, i: number) {
  const f = join(out, `share-${i}`, "after", "reach-digests.json");
  const diffFailed = read(join(out, `share-${i}`, "receipt", "evidence", "reach-diff.err"));
  if (diffFailed !== null) return { missing: `share ${i} couldn't make the change's diff, so its head arm ran without reach: ${diffFailed.slice(-500)}` };
  const evidence = join(out, `share-${i}`, "receipt", "evidence");
  if (existsSync(join(evidence, "reach-dropped"))) return { missing: `share ${i}'s reach files were dropped to keep its evidence within on-gh's bounds` };
  if (existsSync(join(evidence, "reach-uncopied"))) return { missing: `share ${i}'s reach files couldn't be copied home` };
  if (!existsSync(f)) return { missing: `share ${i} brought no reach home` };
  try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { return { missing: `share ${i}'s reach-digests.json couldn't be read: ${said(e)}` }; }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`context-view-run: ${said(e)}`); process.exit(2); });
}
