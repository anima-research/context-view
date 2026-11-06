#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXIT, type Outcome } from "./interfaces.ts";

export const REPOS: Record<string, { gh: string; pack: string | null }> = {
  "context-manager": { gh: "anima-research/context-manager", pack: "@animalabs/context-manager" },
  "agent-framework": { gh: "anima-research/agent-framework", pack: "@animalabs/agent-framework" },
  membrane: { gh: "antra-tess/membrane", pack: "@animalabs/membrane" },
  "connectome-host": { gh: "anima-research/connectome-host", pack: null },
};
export const HOST = "anima-research/connectome-host";
export const HARNESS = { repo: "anima-research/context-view", run: "harness/run.mjs" };
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

const GIT_BASE = process.env.CONTEXT_VIEW_GIT_BASE ?? "https://github.com";
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
  const on = spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", sha, main!]);
  if (on.status !== 0)
    return { why: `the harness release ${file} names, ${sha}, isn't a commit on ${HARNESS.repo}'s main, so no job could run it: install one with run/install-harness.ts` };
  return { sha };
}

const pull = (gh: string, number: number) =>
  JSON.parse(run(["gh", "api", `repos/${gh}/pulls/${number}`]).out) as { state: string; merged_at: string | null; head: { sha: string }; base: { ref: string } };

export type Plan = {
  repo: string; number: number; head: string; form: "overlay" | "host";
  base: { ref: string; sha: string }; host: { sha: string }; harness: { repo: string; sha: string };
  merged: string;
};
type Manifest = Omit<Plan, "merged"> & { outcome: Outcome; detail: unknown; shares: unknown[] };

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
    type Entry = { version?: string } & Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;
    const lock = JSON.parse(run(["git", "-C", hm, "show", `${host.sha}:package-lock.json`]).out) as { packages: Record<string, Entry> };
    const show = (rev: string, arm: string) => {
      const text = run(["git", "-C", m, "show", `${rev}:package.json`]).out;
      try { return JSON.parse(text) as Entry; } catch { throw new Error(`the ${arm}'s package.json isn't JSON`); }
    };
    const arms = [["base", show(base.sha, "base")], ["head", show(merged, "head")]] as const;
    for (const [arm, pkg] of arms) {
      for (const field of FIELDS) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) {
          if (!name.startsWith("@animalabs/") || name === r.pack) continue;
          const hostHas = lock.packages[`node_modules/${name}`]?.version;
          if (hostHas && !meets(hostHas, range)) return { stop: { outcome: "needs-companion", detail: { package: name, range, hostHas, arm }, partial } };
        }
      }
    }
    // npm, installing an arm's pack into the host, keeps a registry copy beside it wherever a range in the host's tree
    // isn't met by the pack's version.
    const own = `node_modules/${r.pack}/`;
    for (const [arm, { version }] of arms) {
      for (const [at, entry] of Object.entries(lock.packages)) {
        if (at === "" || at.includes(own)) continue;
        for (const field of FIELDS) {
          const range = entry[field]?.[r.pack];
          if (range === undefined) continue;
          if (!version || !meets(version, range))
            return { stop: { outcome: "needs-companion", detail: { package: r.pack, version: version ?? null, arm, wantedBy: at, range }, partial } };
        }
      }
    }
  }
  return { plan: { ...(partial as Plan), merged } };
}

export function job(p: Plan, i: number) {
  const r = REPOS[p.repo]!;
  const install = "npm ci --ignore-scripts --no-audit --no-fund";
  const fetchMerge = (dir: string, gh: string, baseSha: string) =>
    `{ git -C ${dir} fetch -q --unshallow ${q(url(gh))} ${baseSha} 2>/dev/null || git -C ${dir} fetch -q ${q(url(gh))} ${baseSha}; } && ` +
    `git -C ${dir} fetch -q ${q(url(gh))} refs/pull/${p.number}/head && ` +
    `{ [ "$(git -C ${dir} rev-parse FETCH_HEAD)" = ${p.head} ] || { git -C ${dir} rev-parse FETCH_HEAD > "$ON_GH_EVIDENCE_DIR/head-moved"; false; }; } && ` +
    `git -C ${dir} -c user.name=context-view -c user.email=context-view@invalid merge -q --no-ff --no-edit ${p.head} && ` +
    `[ "$(git -C ${dir} rev-parse HEAD^{tree})" = ${p.merged} ]`;
  // agent-framework commits no lockfile, so its head arm installs from the one its base arm's install wrote.
  const candInstall = (arm: string) => `{ if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else ${arm === "after" ? "cp ../cand-before/package-lock.json . && " : ""}npm install --ignore-scripts --no-audit --no-fund; fi; }`;
  const pack = (arm: string) => `(cd ../cand-${arm} && ${candInstall(arm)} >/dev/null && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination ../packs-${arm} >/dev/null)`;
  const clone = (arm: string, sha: string) => `git init -q ../cand-${arm} && git -C ../cand-${arm} fetch -q --depth=1 ${q(url(r.gh))} ${sha} && git -C ../cand-${arm} -c advice.detachedHead=false checkout -q FETCH_HEAD && mkdir -p ../packs-${arm}`;
  const setup = r.pack
    ? [clone("before", p.base.sha), pack("before"), clone("after", p.base.sha), fetchMerge("../cand-after", r.gh, p.base.sha), pack("after")].join(" && ")
    : `(cd ../connectome-host && ${install})`;
  const harness = `node ${HARNESS.run} --host ../connectome-host --checkpoints "$W/cp" --shard ${i}/${SHARES}`;
  const arm = (name: string, more: string) =>
    `${r.pack ? `P=$(ls ../packs-${name}/*.tgz) && ` : ""}${harness}${r.pack ? ` --overlay "$P"` : ""}${more} --out "$W/${name}" > "$E/${name}.log" 2>&1; echo $? > "$E/rc-${name}"`;
  const between = r.pack ? ":" : `${fetchMerge("../connectome-host", r.gh, p.base.sha)} && (cd ../connectome-host && ${install}) > "$E/install-after.log" 2>&1`;
  const arms = [
    arm("before", ""),
    `if ${between}; then ${arm("after", ` --self-check --against "$W/before"`)}; else echo between > "$E/failed"; fi`,
  ].join("\n");
  const keep = [
    `k=0`,
    `for arm in before after; do [ -d "$W/$arm" ] || continue; mkdir -p "$E/$arm" || k=1`,
    `  for f in run.json summary.md entries.json; do if [ -f "$W/$arm/$f" ]; then cp "$W/$arm/$f" "$E/$arm/" || k=1; fi; done`,
    `  for d in "$W/$arm"/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); [ "$n" = cp ] && continue; [ "$n" = checkpoints ] && continue; mkdir -p "$E/$arm/$n" || k=1`,
    `    for f in "$d"*.record "$d"report.txt "$d"view.md; do if [ -f "$f" ]; then cp "$f" "$E/$arm/$n/" || k=1; fi; done`,
    `    if [ -d "$d"self-check ]; then cp -r "$d"self-check "$E/$arm/$n/" || k=1; fi; done; done`,
    `printf '%07d 0\\n' 0 > "$E/kb"; dropped=0`,
    `if [ "$(du -sklL --apparent-size "$E" | cut -f1)" -gt 51200 ] || [ "$(find -L "$E" -mindepth 1 | wc -l)" -gt 9900 ]; then find "$E" -name view.md -delete; dropped=1; fi`,
    `printf '%07d %d\\n' "$(du -sklL --apparent-size "$E" | cut -f1)" "$dropped" > "$E/kb"`,
  ].join("\n");
  const command = [
    `E="$ON_GH_EVIDENCE_DIR"; W="$(mktemp -d)" || exit 1`,
    arms,
    keep,
    `exit $k`,
  ].join("\n");
  return { setup, command, with: `${HOST}@${p.host.sha}` };
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);

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
  else if (existsSync(join(ev, "failed"))) why = `its head couldn't be merged and installed in the job`;
  // A shell gives 128 plus the signal's number for a command a signal ended.
  const finished = (a: string) => existsSync(join(ev, a, "run.json")) && !(Number(read(join(ev, `rc-${a}`)) ?? NaN) > 128);
  const arm = why ? undefined : (["before", "after"] as const).find((a) => !finished(a));
  const armMissing = arm ? { arm, log: (read(join(ev, `${arm}.log`)) ?? "").split("\n").at(-1) || null } : null;
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
    for (const f of readdirSync(out)) if (f === "manifest.json" || f === "manifest.json.tmp" || /^share-\d+$/.test(f)) rmSync(join(out, f), { recursive: true, force: true });
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
  const { merged: _merged, ...plain } = p;
  const onGh = process.env.ON_GH ?? "on-gh";
  const token = randomUUID();
  let failure: { share: number; why: string } | null = null;
  const settled = await Promise.all(Array.from({ length: SHARES }, async (_, k) => {
    const i = k + 1, dir = join(out, `share-${i}`), own = join(dir, `receipt.${token}`);
    if (failure) return null;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      const j = job(p, i);
      child = spawn([onGh, "--repo", HARNESS.repo, "--sha", p.harness.sha, "--with", j.with, "--setup", j.setup, "--return-to", own, "--", "bash", "-c", j.command],
        { stdout: "pipe", stderr: "pipe" });
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
  return write({ ...plain, outcome: "ran", detail: null, shares });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`context-view-run: ${said(e)}`); process.exit(2); });
}
