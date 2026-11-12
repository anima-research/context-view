import "./hermetic-git.ts";
import { afterEach, beforeEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Stack } from "../context-view-run.ts";
export const SCRIPT = resolve(import.meta.dir, "../context-view-run.ts");
export let T: string;
export const sh = (cmd: string, cwd?: string) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};
export const git = (dir: string, args: string) => sh(`git -C ${dir} -c user.name=t -c user.email=t@t ${args}`);

export function repo(gh: string, files: Record<string, string>, pr?: { n: number; files: Record<string, string>; baseAfter?: Record<string, string> }) {
  const work = join(T, "work", gh), bare = join(T, "gh", `${gh}.git`);
  mkdirSync(work, { recursive: true });
  sh(`git init -q -b main ${work}`);
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(work, f)), { recursive: true }); writeFileSync(join(work, f), c); }
  git(work, "add -A"); git(work, "commit -q --allow-empty -m base");
  let head = "";
  if (pr) {
    git(work, "checkout -q -b pr");
    for (const [f, c] of Object.entries(pr.files)) { mkdirSync(dirname(join(work, f)), { recursive: true }); writeFileSync(join(work, f), c); }
    git(work, "add -A"); git(work, "commit -q --allow-empty -m head");
    head = git(work, "rev-parse HEAD");
    git(work, "checkout -q main");
    if (pr.baseAfter) { for (const [f, c] of Object.entries(pr.baseAfter)) writeFileSync(join(work, f), c); git(work, "add -A"); git(work, "commit -q --allow-empty -m moved"); }
  }
  mkdirSync(join(T, "gh", gh.split("/")[0]!), { recursive: true });
  sh(`git clone -q --bare ${work} ${bare}`);
  if (pr) git(bare, `update-ref refs/pull/${pr.n}/head ${head}`);
  return { main: git(bare, "rev-parse main"), head };
}

export const CM = "@animalabs/context-manager";
export const OPTIONS = readFileSync(resolve(import.meta.dir, "../../harness/options.json"), "utf8");
export const LOCK = (membrane: string, extra: Record<string, unknown> = {}) => JSON.stringify({ packages: {
  "": { dependencies: { [CM]: "^9.0.0" } },
  "node_modules/@animalabs/membrane": { version: membrane },
  [`node_modules/${CM}`]: { version: "0.24.0" },
  [`node_modules/${CM}/node_modules/@animalabs/inner`]: { version: "1.0.0", dependencies: { [CM]: "^9.0.0" } },
  "node_modules/@animalabs/agent-framework": { version: "0.32.0", dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } },
  "node_modules/@animalabs/chronicle": { version: "0.5.1", peerDependencies: { [CM]: "^0.24.0 || ^0.25.0" } },
  "node_modules/optional-user": { version: "1.0.0", optionalDependencies: { [CM]: "^0.24.0" } },
  [`node_modules/@animalabs/agent-framework/node_modules/${CM}`]: { version: "0.24.0" },
  ...extra,
} });

export function world(o: { harnessOptions?: string | null; prState?: string; prHead?: string; headPkgText?: string; cmPkg?: Record<string, string>; cmPeer?: Record<string, string>; cmBaseDeps?: Record<string, string>; cmVersion?: string; cmBaseVersion?: string; conflict?: boolean; hostPR?: boolean; lockExtra?: Record<string, unknown> } = {}) {
  const baseVersion = o.cmBaseVersion ?? "0.24.1", headVersion = o.cmVersion ?? baseVersion;
  const options = o.harnessOptions === undefined ? OPTIONS : o.harnessOptions;
  const harness = repo("anima-research/context-view", { "README.md": "harness", "harness/run.ts": "await harnessMain(process.argv.slice(2));\n", ...(options === null ? {} : { "harness/options.json": options }) });
  const host = repo("anima-research/connectome-host", { "package-lock.json": LOCK("0.8.0", o.lockExtra), "a.txt": "a" },
    o.hostPR ? { n: 513, files: { "b.txt": "b" } } : undefined);
  const cm = repo("anima-research/context-manager",
    { "package.json": JSON.stringify({ name: CM, version: baseVersion, dependencies: o.cmBaseDeps ?? { "@animalabs/membrane": "^0.8.0" } }), "x.txt": "one" },
    { n: 417, files: { "package.json": o.headPkgText ?? JSON.stringify({ name: CM, version: headVersion, dependencies: o.cmPkg ?? { "@animalabs/membrane": "^0.8.0" }, ...(o.cmPeer ? { peerDependencies: o.cmPeer } : {}) }), "x.txt": o.conflict ? "head" : "one" },
      baseAfter: o.conflict ? { "x.txt": "base" } : { "y.txt": "later" } });
  const pr = o.hostPR ? { n: 513, head: host.head } : { n: 417, head: cm.head };
  writeFileSync(join(T, "pr.json"), JSON.stringify({ state: o.prState ?? "open", merged_at: null, head: { sha: o.prHead ?? pr.head }, base: { ref: "main" } }));
  mkdirSync(join(T, "state"), { recursive: true });
  writeFileSync(join(T, "state", "harness"), `${harness.main}\n`);
  return { harness, host, cm, pr };
}

export const STUB_GH = `#!/bin/bash
echo x >> "$CV_T/gh.calls"
n=$(wc -l < "$CV_T/gh.calls")
[ -n "$CV_GH_FAIL" ] && { echo "gh: HTTP 502" >&2; exit 1; }
[ "$n" = "$CV_GH_FAIL_AT" ] && { echo "gh: HTTP 502" >&2; exit 1; }
if [ "$n" = "$CV_GH_HOLD" ]; then until [ -f "$CV_T/gh.release" ]; do sleep 0.05; done; fi
case "$*" in */commits*) echo "$*" >> "$CV_T/gh.commits"
  re='per_page=([0-9]+)'; [[ "$*" =~ $re ]] && per=\${BASH_REMATCH[1]} || per=30
  re='[?&]page=([0-9]+)'; [[ "$*" =~ $re ]] && page=\${BASH_REMATCH[1]} || page=1
  exec bun -e "const all = JSON.parse(require('node:fs').readFileSync(process.env.CV_T + '/pr-commits.json', 'utf8')); console.log(JSON.stringify(Array.isArray(all) ? all.slice(0, 250).slice(($page - 1) * $per, $page * $per) : all))" ;;
esac
if [ -f "$CV_T/pr-after.json" ] && [ "$(cat "$CV_T/on-gh.done" 2>/dev/null | wc -l)" -ge 12 ]; then cat "$CV_T/pr-after.json"; else cat "$CV_T/pr.json"; fi
`;
export const STUB_ON_GH = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
const a = process.argv.slice(2);
if (a[0] === "--stop") { appendFileSync(join(process.env.CV_T, "on-gh.stops"), a[1] + "\\n"); process.exit(0); }
appendFileSync(join(process.env.CV_T, "on-gh.poll"), (process.env.ON_GH_POLL_MS ?? "") + "\\n");
const at = (k) => a[a.indexOf(k) + 1];
const back = at("--return-to");
const i = Number(back.match(/share-(\\d+)/)[1]);
appendFileSync(join(process.env.CV_T, "on-gh.calls"), JSON.stringify(a) + "\\n");
const sc = JSON.parse(process.env.CV_SCENARIO || "{}")[i] || {};
const end = (code) => { appendFileSync(join(process.env.CV_T, "on-gh.done"), i + "\\n"); process.exit(code); };
if (sc.malformed) {
  const pids = join(process.env.CV_T, "on-gh.pids");
  const n = () => { try { return readFileSync(pids, "utf8").trim().split("\\n").filter(Boolean).length; } catch { return 0; } };
  while (n() < 11) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  mkdirSync(back, { recursive: true }); writeFileSync(join(back, "result.json"), "{not json"); process.exit(0);
}
if (process.env.CV_HANG || sc.hang) {
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { appendFileSync(join(process.env.CV_T, "on-gh.cancels"), i + " " + sig + "\\n"); process.exit(sig === "SIGTERM" ? 143 : 130); });
  appendFileSync(join(process.env.CV_T, "on-gh.pids"), process.pid + "\\n");
  setInterval(() => {}, 1000);
} else {
if (sc.onGh) { console.error("on-gh: " + sc.onGh.why); end(sc.onGh.exit); }
if (sc.bigStderr) require("node:fs").writeSync(2, "x".repeat(1 << 20));
const ev = join(back, "evidence");
const id = "on-gh: 20261105T010000Z-000000" + String(i).padStart(2, "0");
const named = (n) => { try { return readFileSync(join(process.env.CV_T, "on-gh.named"), "utf8").split("\\n").includes(String(n)); } catch { return false; } };
if (sc.afterNamed) while (!named(sc.afterNamed)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (sc.selfKill) { writeSync(1, id + " dispatched\\n"); appendFileSync(join(process.env.CV_T, "on-gh.done"), i + "\\n"); process.kill(process.pid, "SIGKILL"); }
if (sc.blockArm) { mkdirSync(back, { recursive: true }); writeFileSync(join(back, "..", "before"), "in the way"); }
if (sc.logDir) { mkdirSync(join(back, "..", "on-gh.log"), { recursive: true }); }
if (sc.setup || sc.headMoved) {
  mkdirSync(back, { recursive: true });
  if (sc.headMoved) { mkdirSync(ev, { recursive: true }); writeFileSync(join(ev, "head-moved"), sc.headMoved + "\\n"); }
  writeFileSync(join(back, "result.json"), JSON.stringify({ setup: { exitCode: sc.setup ?? 1, wallSeconds: 3 }, command: { exitCode: null }, evidence: sc.headMoved ? "returned" : "none" }));
  console.log(id + " setup-failed; receipt in " + back);
  end(sc.exit ?? 96);
}
mkdirSync(ev, { recursive: true });
writeFileSync(join(back, "result.json"), JSON.stringify({ setup: { exitCode: 0, wallSeconds: 10 }, command: { exitCode: sc.command ?? 0, wallSeconds: 100 }, evidence: sc.evidence ?? "returned" }));
if (sc.harnessFailed) writeFileSync(join(ev, "failed.json"), JSON.stringify({ why: sc.harnessFailed }));
if (sc.rc) for (const [arm, rc] of Object.entries(sc.rc)) writeFileSync(join(ev, "rc-" + arm), String(rc) + "\\n");
const ran = process.env.CV_SECONDS && !sc.noSeconds ? JSON.stringify({ seconds: { runs: { ["R" + i]: i }, checkpoints: { C: i } } }) : "{}";
for (const arm of ["before", "after"]) if (!(sc.missing === arm)) { mkdirSync(join(ev, arm), { recursive: true }); writeFileSync(join(ev, arm, "run.json"), arm === "before" ? ran : "{}"); }
if (sc.missing) writeFileSync(join(ev, "pair.log"), "[whole-host] shard 3/12\\n" + sc.log + "\\n");
if (sc.reach) writeFileSync(join(ev, "after", "reach-digests.json"), JSON.stringify(sc.reach));
if (sc.runs) for (const [run, files] of Object.entries(sc.runs)) for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(ev, "after", run, f)), { recursive: true }); writeFileSync(join(ev, "after", run, f), text); }
if (sc.reachDiffErr) writeFileSync(join(ev, "reach-diff.err"), sc.reachDiffErr);
if (sc.reachDropped) writeFileSync(join(ev, "reach-dropped"), "dropped\\n");
if (sc.reachUncopied) writeFileSync(join(ev, "reach-uncopied"), "reach-digests.json\\n");
writeFileSync(join(ev, "kb"), "0000100 0\\n");
console.log(id + " completed, exit 0; receipt in " + back);
if (sc.holdAfterId) { appendFileSync(join(process.env.CV_T, "on-gh.named"), i + "\\n"); setInterval(() => {}, 1000); } else end(sc.exit ?? 0);
}
`;

export function useWorld() {
  beforeEach(() => {
    T = mkdtempSync(join(tmpdir(), "cv-run-"));
    mkdirSync(join(T, "bin"));
    writeFileSync(join(T, "bin", "gh"), STUB_GH); chmodSync(join(T, "bin", "gh"), 0o755);
    writeFileSync(join(T, "bin", "on-gh"), STUB_ON_GH); chmodSync(join(T, "bin", "on-gh"), 0o755);
  });
  afterEach(() => {
    spawnSync("pkill", ["-KILL", "-f", `${T}/`]);
    rmSync(T, { recursive: true, force: true });
  });
}

export const env = (scenario: Record<number, unknown> = {}, extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${join(T, "bin")}:${process.env.PATH}`, CV_T: T, CV_SCENARIO: JSON.stringify(scenario),
  CONTEXT_VIEW_GIT_BASE: `file://${join(T, "gh")}`, CONTEXT_VIEW_STATE: join(T, "state"), ...extra,
});
export const lines = (f: string) => (existsSync(join(T, f)) ? readFileSync(join(T, f), "utf8").trim().split("\n").filter(Boolean) : []);
export const cancelled = () => lines("on-gh.cancels").map((l) => Number(l.split(" ")[0])).sort((a, b) => a - b);

export function cli(repoName: string, n: number, head: string, scenario: Record<number, unknown> = {}, extraEnv: Record<string, string> = {}, timeout?: number) {
  return cliAt(repoName, n, ["--head", head], scenario, extraEnv, timeout);
}
export function cliAt(repoName: string, n: number, at: string[], scenario: Record<number, unknown> = {}, extraEnv: Record<string, string> = {}, timeout?: number) {
  const out = join(T, "out");
  const r = spawnSync("bun", [SCRIPT, "--repo", repoName, "--pr", String(n), ...at, "--out", out], {
    encoding: "utf8", env: env(scenario, extraEnv), timeout,
  });
  const manifest = existsSync(join(out, "manifest.json")) ? JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) : null;
  const calls = existsSync(join(T, "on-gh.calls")) ? readFileSync(join(T, "on-gh.calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  return { code: r.status, stderr: r.stderr, manifest, calls, out };
}

export function registry(docs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  for (const [name, versions] of Object.entries(docs)) {
    mkdirSync(join(T, "reg", name.split("/")[0]!), { recursive: true });
    writeFileSync(join(T, "reg", name), JSON.stringify({ name, versions }));
  }
  return { CONTEXT_VIEW_REGISTRY: `file://${join(T, "reg")}` };
}
export const AF = "@animalabs/agent-framework", MEMBRANE = "@animalabs/membrane", CHRONICLE = "@animalabs/chronicle";
export const miss = (pkg: string, range: string, wantedBy: string | null, has: string | null) => ({ missed: { package: pkg, range, wantedBy, has } });
export const fresh = () => {
  for (const f of ["out", "gh", "work", "reg"]) rmSync(join(T, f), { recursive: true, force: true });
  rmSync(join(T, "on-gh.calls"), { force: true });
};

export type Shape = "merge" | "squash" | "squash-empty" | "rebase" | "rebase-near" | "cap" | "partial" | "evil" | "many" | "stacked" | "stacked-ff" | "renamed";
export const HOST_PKG = (version: string, deps: Record<string, Record<string, string>> = { dependencies: { x: "^1.0.0" } }) =>
  JSON.stringify({ name: "@animalabs/connectome-host", version, ...deps }, null, 2);
export const HOST_LOCK = (version: string, x = "1.0.0") => JSON.stringify({ name: "@animalabs/connectome-host", version, lockfileVersion: 3,
  packages: { "": { name: "@animalabs/connectome-host", version, dependencies: { x: "^1.0.0" } }, "node_modules/x": { version: x } } }, null, 2);
export function mergedHost(shape: Shape, pr: Record<string, unknown> = {}, own?: Record<string, string>[], base: Record<string, string> = {}) {
  const harness = repo("anima-research/context-view", { "README.md": "harness" });
  mkdirSync(join(T, "state"), { recursive: true });
  writeFileSync(join(T, "state", "harness"), `${harness.main}\n`);
  const work = join(T, "work", "anima-research/connectome-host"), bare = join(T, "gh", "anima-research/connectome-host.git");
  mkdirSync(join(work, "src"), { recursive: true });
  sh(`git init -q -b main ${work}`);
  const put = (files: Record<string, string>, message: string) => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(work, f)), { recursive: true }); writeFileSync(join(work, f), c); }
    git(work, "add -A"); git(work, `commit -q --allow-empty -m ${message}`);
    return git(work, "rev-parse HEAD");
  };
  const f = (b: string, d: string) => `a\n${b}\nc\n${d}\ne\nf\ng\n`;
  const g = (first: string, last: string) => `${first}\n1\n2\n3\n4\n5\n6\n${last}\n`;
  const r = (first: string, fifth: string) => `${first}\n2\n3\n4\n${fifth}\n6\n7\n8\n`;
  const start = put({ "package.json": HOST_PKG("1.0.0"), "package-lock.json": HOST_LOCK("1.0.0"), "f.txt": f("b", "d"), "g.txt": g("x", "x"),
    ...(shape === "renamed" ? { "src/r.ts": r("1", "5") } : {}), ...base }, "start");
  git(work, "checkout -q -b pr");
  const a = { "src/a.ts": "export const a = 1;\n" }, d = { "f.txt": f("b", "D") }, c = { "src/c.ts": "export const c = 3;\n" };
  if (shape === "many") sh(`for i in $(seq 0 100); do echo "export const m = $i;" > src/m$i.ts && git add -A && git -c user.name=t -c user.email=t@t commit -q -m m$i || exit 1; done`, work);
  else for (const [i, files] of (own ?? (shape === "cap" ? [a, { "g.txt": g("y", "x") }] : shape === "rebase" || shape === "partial" ? [a, d, c] : shape === "squash-empty" ? [a, {}]
    : shape === "stacked" || shape === "stacked-ff" ? [{ "src/y.ts": "export const y = 1;\n" }, { "src/x.ts": "export const x = 1;\n" }]
    : shape === "renamed" ? [{ "src/r.ts": r("one", "5") }, { "src/r.ts": r("one", "five") }] : [a, d])).entries()) put(files, `p${i + 1}`);
  const commits = git(work, `rev-list --reverse ${start}..pr`).split("\n");
  git(work, "checkout -q main");
  let M: string;
  try {
    process.env.GIT_COMMITTER_DATE = "2026-11-09T11:00:00Z";
    if (shape === "stacked") git(work, `cherry-pick ${commits[0]}`);
    else if (shape === "stacked-ff") git(work, `merge -q --ff-only ${commits[0]}`);
    else if (shape === "renamed") { git(work, "mv src/r.ts src/renamed.ts"); git(work, "commit -q -m main-renamed"); }
    else put(shape === "rebase-near" ? { "f.txt": f("B", "d") } : shape === "cap" ? { "g.txt": g("x", "y") } : { "h.txt": "h" }, "main-moved");
    process.env.GIT_COMMITTER_DATE = "2026-11-09T12:00:00Z";
    if (shape === "merge" || shape === "evil") git(work, "merge -q --no-ff --no-edit pr");
    if (shape === "evil") { writeFileSync(join(work, "evil.txt"), "e"); git(work, "add -A"); git(work, "commit -q --amend --no-edit"); }
    if (shape === "squash" || shape === "squash-empty" || shape === "many" || shape === "stacked" || shape === "stacked-ff") { git(work, "merge -q --squash pr"); git(work, "commit -q -m squashed"); }
    if (shape === "rebase" || shape === "rebase-near" || shape === "cap" || shape === "renamed") git(work, `cherry-pick ${commits.join(" ")}`);
    if (shape === "partial") { git(work, `cherry-pick ${commits[0]}`); put({ "f.txt": f("b", "DD") }, "p2-redone"); git(work, `cherry-pick ${commits[2]}`); }
    M = git(work, "rev-parse HEAD");
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  sh(`git clone -q --bare ${work} ${bare}`);
  const tip = commits.at(-1)!;
  git(bare, `update-ref refs/pull/513/head ${tip}`);
  writeFileSync(join(T, "pr-commits.json"), JSON.stringify(commits.map((sha) => ({ sha, parents: git(work, `rev-parse ${sha}^@`).split("\n").map((p) => ({ sha: p })) }))));
  writeFileSync(join(T, "pr.json"), JSON.stringify({ state: "closed", merged_at: "2026-11-09T12:00:00Z", merge_commit_sha: M, commits: commits.length, head: { sha: tip }, base: { ref: "main", repo: { default_branch: "main" } }, ...pr }));
  const patchId = (rev: string, context: string[] = ["-U0"]) => sh(`git -C ${work} show ${context.join(" ")} --no-color --format= ${rev} | git patch-id --stable`).split(" ")[0];
  return { M, tree: git(work, `rev-parse ${M}^{tree}`), rev: (r: string) => git(work, `rev-parse ${r}`), commits, patchId };
}
export const viaMerge = (M: string) => cliAt("connectome-host", 513, ["--merged", M]);
export const reset = () => {
  for (const f of ["out", "on-gh.calls", "on-gh.done", "gh.calls", "gh.commits", "gh", "work", "state"]) rmSync(join(T, f), { recursive: true, force: true });
};

export type Pool = { exit?: number; failed?: string; viewBytes?: number; sparse?: boolean; records?: number; unreadable?: boolean; unreadableDir?: boolean; odd?: boolean; reach?: boolean; reachBytes?: number; hold?: number };

export function runJob(o: {
  form?: "agent-framework" | "context-manager" | "host"; files?: Record<string, string>; headFiles?: Record<string, string>; pushAfterPlan?: boolean;
  merged?: string; base?: string; stack?: Stack; seconds?: { runs: Record<string, number>; checkpoints: Record<string, number> } | null;
  pool?: Pool; env?: Record<string, string>; allowFilter?: boolean; diffFails?: boolean; blockReach?: boolean;
  plant?: string[]; slowSetsid?: boolean; term?: boolean; killWrapper?: boolean; merge?: boolean;
} = {}) {
  const form = o.form ?? "context-manager";
  const gh = form === "host" ? "anima-research/connectome-host" : `anima-research/${form}`;
  const r = repo(gh, o.files ?? (form === "host" ? { "package-lock.json": "{}", "a.txt": "a" } : { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": "{}" }),
    { n: 9, files: o.headFiles ?? { "src.txt": "head" } });
  const bare = join(T, "gh", `${gh}.git`);
  if (o.pushAfterPlan) git(bare, `update-ref refs/pull/9/head ${r.main}`);
  if (o.allowFilter) git(bare, "config uploadpack.allowFilter true");
  const merged = sh(`git -C ${bare} merge-tree --write-tree ${r.main} ${r.head}`).split("\n")[0]!;
  const M = o.merge ? git(bare, `commit-tree ${merged} -p ${r.main} -p ${r.head} -m merge`) : null;
  const p = { repo: form === "host" ? "connectome-host" : form, number: 9, head: M ?? r.head, form: form === "host" ? "host" : "overlay", base: { ref: "main", sha: o.base ?? r.main },
    host: { sha: form === "host" ? r.main : "c".repeat(40) }, harness: { repo: "x", sha: "d".repeat(40) }, merged: o.merged ?? merged, ...(o.stack ? { stack: o.stack } : {}),
    ...(M ? { merge: { commit: M, k: 0, n: 1 } } : {}) };
  const built = spawnSync("bun", ["-e", `import { job } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(job(${JSON.stringify(p)}, 7, ${JSON.stringify(o.seconds ?? null)})))`],
    { encoding: "utf8", env: env({}, o.env ?? {}) });
  const { setup, command } = JSON.parse(built.stdout) as { setup: string; command: string };
  const dir = join(T, "job"), top = join(dir, "smoke"), ev = join(dir, "evidence"), bin = join(T, "job-bin");
  mkdirSync(join(top, "harness"), { recursive: true }); mkdirSync(ev, { recursive: true }); mkdirSync(bin, { recursive: true });
  if (form === "host") sh(`git clone -q ${bare} ${join(dir, "connectome-host")}`);
  if (M) { git(bare, `update-ref refs/heads/main ${M}`); git(bare, `update-ref refs/pull/9/head ${r.main}`); }
  const stub = (name: string, text: string) => { writeFileSync(join(bin, name), text); chmodSync(join(bin, name), 0o755); };
  stub("npm", `#!/bin/bash
here=$(basename "$PWD")
meet() { for t in $(seq 1 200); do [ -f "$CV_T/started-$2-$1" ] && return 0; sleep 0.05; done; echo "npm stub: $here waited 10 s for $1's $2" >&2; return 1; }
case "$1" in
  install|ci) echo "install-start $here" >> "$CV_T/npm.times"; touch "$CV_T/started-install-$here"
    if [ "$1" = install ]; then echo "install in $here from $(cat package-lock.json 2>/dev/null || echo no lockfile)" >> "$CV_T/npm.calls"; echo "{\\"written-by\\": \\"$here\\"}" > package-lock.json
    else echo "ci in $here from $(cat package-lock.json)" >> "$CV_T/npm.calls"; fi
    if [ -n "$CV_MEET" ] && [ "$here" = cand-after ]; then meet cand-before build || exit 1; fi
    echo "install-end $here" >> "$CV_T/npm.times" ;;
  run) echo "build-start $here" >> "$CV_T/npm.times"; touch "$CV_T/started-build-$here"
    if [ -n "$CV_MEET" ] && [ "$here" = cand-before ]; then meet cand-after install || exit 1; fi
    sleep "\${CV_BUILD_SLEEP:-0}"; echo "build-end $here" >> "$CV_T/npm.times" ;;
  pack) shift; spec=own; dest=
    while [ $# -gt 0 ]; do case "$1" in --pack-destination) dest=$2; shift ;; --registry) shift ;; --*) ;; *) [ "$spec" = own ] && spec=$1 ;; esac; shift; done
    [ "$here" = "$CV_NO_PACK" ] && exit 0
    touch "$dest/$(echo "$spec" | tr '@/' '--' | sed 's/^-//').tgz" ;;
esac
exit 0
`);
  stub("sudo", `#!/bin/bash\necho "$*" >> "$CV_T/sudo.calls"\n[ -n "$CV_SUDO_FAIL" ] && exit 32\nexit 0\n`);
  if (o.diffFails) stub("git", `#!/bin/bash\nfor a in "$@"; do [ "$a" = diff ] && { echo "fatal: a diff that fails" >&2; exit 128; }; done\nexec ${sh("command -v git")} "$@"\n`);
  if (o.blockReach) { mkdirSync(join(ev, "after"), { recursive: true }); writeFileSync(join(ev, "after", "reach-digests.json"), ""); chmodSync(join(ev, "after", "reach-digests.json"), 0o444); }
  stub("stat", `#!/bin/bash\nif [ "$1" = -f ]; then if [ "\${@: -1}" = ${JSON.stringify(join(dir, "m"))} ]; then echo "\${CV_FS_TYPE:-tmpfs} \${CV_FS_BLOCKS:-999999999999} 4096"; else echo "ext2/ext3 999999999999 4096"; fi; exit 0; fi\nexec /usr/bin/stat "$@"\n`);
  if (o.slowSetsid) {
    stub("setsid", `#!/bin/bash\necho $$ > ${JSON.stringify(join(T, "setsid.pid"))}\nuntil [ -e ${JSON.stringify(join(T, "setsid.go"))} ]; do sleep 0.05; done\nexec ${sh("command -v setsid")} "$@"\n`);
    stub("git", `#!/bin/bash\nfor t in $(seq 1 200); do [ -e ${JSON.stringify(join(T, "setsid.pid"))} ] && break; sleep 0.05; done\nexec ${sh("command -v git")} "$@"\n`);
  }
  for (const f of o.plant ?? []) mkdirSync(join(dir, "m", f), { recursive: true });
  const pool = { viewBytes: 10, records: 1, ...o.pool };
  writeFileSync(join(top, "harness", "run.ts"), `
    import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
    const a = process.argv.slice(2), at = (k) => a[a.indexOf(k) + 1], o = ${JSON.stringify(pool)};
    fs.writeFileSync(${JSON.stringify(join(T, "pool.pid"))}, String(process.pid));
    const seen = {};
    for (const side of ["base", "head"]) {
      const f = path.join(at("--ready"), side);
      for (let t = 0; !fs.existsSync(f); t++) { if (t > 600) process.exit(9); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
      seen[side] = fs.readFileSync(f, "utf8");
    }
    if (o.hold) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, o.hold);
    const tree = (d) => { try { return execSync("git -C " + d + " rev-parse HEAD^{tree}", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
    const file = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
    const reach = a.includes("--reach") ? file(at("--reach")) : null;
    fs.appendFileSync(${JSON.stringify(join(T, "harness.calls"))}, JSON.stringify({ args: a, ready: seen, home: process.env.HOME, tmp: process.env.TMPDIR,
      trees: { base: tree(at("--host")), head: a.includes("--host-head") ? tree(at("--host-head")) : null },
      reach, reachErr: a.includes("--reach") ? file(at("--reach") + ".err") : null }) + "\\n");
    const out = at("--out"); fs.mkdirSync(out, { recursive: true });
    if (o.failed) { fs.writeFileSync(path.join(out, "failed.json"), JSON.stringify({ why: o.failed })); process.exit(2); }
    for (const arm of ["before", "after"]) {
      const d = path.join(out, arm); fs.mkdirSync(path.join(d, "H1_W1"), { recursive: true });
      fs.writeFileSync(path.join(d, "run.json"), "{}"); fs.writeFileSync(path.join(d, "H1_W1", "H1_W1.record"), "r");
      for (let k = 1; k < o.records; k++) fs.writeFileSync(path.join(d, "H1_W1", "r" + k + ".record"), "r");
      if (o.sparse) { fs.writeFileSync(path.join(d, "H1_W1", "view.md"), ""); fs.truncateSync(path.join(d, "H1_W1", "view.md"), o.viewBytes); }
      else fs.writeFileSync(path.join(d, "H1_W1", "view.md"), Buffer.alloc(o.viewBytes, 120));
      fs.writeFileSync(path.join(d, "H1_W1", "log.jsonl"), "big");
      fs.writeFileSync(path.join(d, "H1_W1", "prices.json"), "{}");
      if (o.odd) {
        const h = path.join(d, "H1_W1");
        fs.symlinkSync("H1_W1.record", path.join(h, "l.record")); fs.writeFileSync(path.join(h, ".h.record"), "h");
        fs.symlinkSync("missing.record", path.join(h, "broken.record")); fs.symlinkSync(".", path.join(h, "dir.record")); fs.symlinkSync("x.record", path.join(h, "x.record"));
      }
    }
    fs.writeFileSync(path.join(out, "after", "entries.json"), "[]");
    if (o.reach && reach !== null) { fs.writeFileSync(path.join(out, "after", "reach.json"), "{}"); fs.writeFileSync(path.join(out, "after", "reach-digests.json"), JSON.stringify({ harness: true, diff: reach })); }
    if (o.reachBytes && reach !== null) fs.writeFileSync(path.join(out, "after", "reach-digests.json"), Buffer.alloc(o.reachBytes, 120));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "the pool's tables\\n");
    if (o.unreadable) fs.chmodSync(path.join(out, "after", "H1_W1", "H1_W1.record"), 0);
    if (o.unreadableDir) fs.chmodSync(path.join(out, "after", "H1_W1"), 0);
    process.exit(o.exit ?? 0);`);
  const tag = crypto.randomUUID();
  const runEnv = { ...env({}, o.env ?? {}), PATH: `${bin}:${process.env.PATH}`, ON_GH_EVIDENCE_DIR: ev, CV_TAG: tag };
  const summaries = { setup: join(dir, "setup-summary.md"), command: join(dir, "command-summary.md") };
  const s = o.term
    ? spawnSync("bash", ["-c", `bash -c "$CV_SETUP" & s=$!; for t in $(seq 1 200); do [ -f "$CV_T/pool.pid" ] && break; sleep 0.05; done; kill -TERM $s; wait $s`],
      { cwd: top, encoding: "utf8", env: { ...runEnv, GITHUB_STEP_SUMMARY: summaries.setup, CV_SETUP: setup }, timeout: 60_000 })
    : spawnSync("bash", ["-c", setup], { cwd: top, encoding: "utf8", env: { ...runEnv, GITHUB_STEP_SUMMARY: summaries.setup }, timeout: 60_000 });
  if (o.killWrapper && s.status === 0) {
    for (let t = 0; t < 200 && !existsSync(join(T, "pool.pid")); t++) Bun.sleepSync(50);
    process.kill(Number(readFileSync(join(dir, "m", "pair.pid"), "utf8")), "SIGKILL");
  }
  const c = s.status === 0 ? spawnSync("bash", ["-c", command], { cwd: top, encoding: "utf8", env: { ...runEnv, GITHUB_STEP_SUMMARY: summaries.command }, timeout: 60_000 }) : null;
  const calls = lines("harness.calls").map((l) => JSON.parse(l) as { args: string[]; ready: Record<string, string>; home: string; tmp: string; trees: { base: string | null; head: string | null };
    reach: string | null; reachErr: string | null });
  return { setup: s, command: c, ev, calls, summaries, npm: lines("npm.calls"), sudo: lines("sudo.calls"), M: join(dir, "m"), main: r.main, merged, baseTree: sh(`git -C ${bare} rev-parse ${r.main}^{tree}`), setupText: setup, tag };
}

export const at = (a: string[], k: string) => a[a.indexOf(k) + 1];

export function tagged(tag: string) {
  return readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "latin1");
      return stat[stat.lastIndexOf(")") + 2] !== "Z" && readFileSync(`/proc/${p}/environ`, "latin1").split("\0").includes(`CV_TAG=${tag}`);
    } catch { return false; }
  });
}

export async function gone(pidFile: string) {
  if (!existsSync(pidFile)) return true;
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let t = 0; t < 40; t++) { try { process.kill(pid, 0); } catch { return true; } await Bun.sleep(50); }
  return false;
}

export async function poolGone(M: string) {
  expect(existsSync(join(M, "pair.pid"))).toBe(true);
  const pg = Number(readFileSync(join(M, "pair.pid"), "utf8"));
  for (let t = 0; t < 40; t++) {
    try { process.kill(-pg, 0); } catch { return gone(join(T, "pool.pid")); }
    await Bun.sleep(50);
  }
  return false;
}

export const dropped = (ev: string) => readFileSync(join(ev, "kb"), "utf8").trim().split(" ")[1] === "1";

export const deps = (d: Record<string, string>) => ({ dependencies: d });

export const boot = (n: number) => ({ boot: n, read: true });
