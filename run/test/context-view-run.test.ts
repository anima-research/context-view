import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Stack } from "../context-view-run.ts";

const SCRIPT = resolve(import.meta.dir, "../context-view-run.ts");
let T: string;
const sh = (cmd: string, cwd?: string) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};
const git = (dir: string, args: string) => sh(`git -C ${dir} -c user.name=t -c user.email=t@t ${args}`);

function repo(gh: string, files: Record<string, string>, pr?: { n: number; files: Record<string, string>; baseAfter?: Record<string, string> }) {
  const work = join(T, "work", gh), bare = join(T, "gh", `${gh}.git`);
  mkdirSync(work, { recursive: true });
  sh(`git init -q -b main ${work}`);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c);
  git(work, "add -A"); git(work, "commit -q --allow-empty -m base");
  let head = "";
  if (pr) {
    git(work, "checkout -q -b pr");
    for (const [f, c] of Object.entries(pr.files)) writeFileSync(join(work, f), c);
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

const CM = "@animalabs/context-manager";
const LOCK = (membrane: string, extra: Record<string, unknown> = {}) => JSON.stringify({ packages: {
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

function world(o: { prState?: string; prHead?: string; headPkgText?: string; cmPkg?: Record<string, string>; cmPeer?: Record<string, string>; cmBaseDeps?: Record<string, string>; cmVersion?: string; cmBaseVersion?: string; conflict?: boolean; hostPR?: boolean; lockExtra?: Record<string, unknown> } = {}) {
  const baseVersion = o.cmBaseVersion ?? "0.24.1", headVersion = o.cmVersion ?? baseVersion;
  const harness = repo("anima-research/context-view", { "README.md": "harness" });
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

const STUB_GH = `#!/bin/bash
echo x >> "$CV_T/gh.calls"
n=$(wc -l < "$CV_T/gh.calls")
[ -n "$CV_GH_FAIL" ] && { echo "gh: HTTP 502" >&2; exit 1; }
[ "$n" = "$CV_GH_FAIL_AT" ] && { echo "gh: HTTP 502" >&2; exit 1; }
if [ "$n" = "$CV_GH_HOLD" ]; then until [ -f "$CV_T/gh.release" ]; do sleep 0.05; done; fi
if [ -f "$CV_T/pr-after.json" ] && [ "$(cat "$CV_T/on-gh.done" 2>/dev/null | wc -l)" -ge 12 ]; then cat "$CV_T/pr-after.json"; else cat "$CV_T/pr.json"; fi
`;
const STUB_ON_GH = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const a = process.argv.slice(2);
if (a[0] === "--stop") { appendFileSync(join(process.env.CV_T, "on-gh.stops"), a[1] + "\\n"); process.exit(0); }
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
const id = "on-gh: 20261105T010000Z-0000000" + (i % 10);
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
if (sc.between) writeFileSync(join(ev, "failed"), "between\\n");
if (sc.rc) for (const [arm, rc] of Object.entries(sc.rc)) writeFileSync(join(ev, "rc-" + arm), String(rc) + "\\n");
for (const arm of ["before", "after"]) if (!(sc.missing === arm)) { mkdirSync(join(ev, arm), { recursive: true }); writeFileSync(join(ev, arm, "run.json"), "{}"); }
if (sc.missing) writeFileSync(join(ev, sc.missing + ".log"), "[whole-host] shard 3/12\\n" + sc.log + "\\n");
writeFileSync(join(ev, "kb"), "0000100 0\\n");
console.log(id + " completed, exit 0; receipt in " + back);
end(sc.exit ?? 0);
}
`;

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

const env = (scenario: Record<number, unknown> = {}, extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${join(T, "bin")}:${process.env.PATH}`, CV_T: T, CV_SCENARIO: JSON.stringify(scenario),
  CONTEXT_VIEW_GIT_BASE: `file://${join(T, "gh")}`, CONTEXT_VIEW_STATE: join(T, "state"), ...extra,
});
const lines = (f: string) => (existsSync(join(T, f)) ? readFileSync(join(T, f), "utf8").trim().split("\n").filter(Boolean) : []);
const cancelled = () => lines("on-gh.cancels").map((l) => Number(l.split(" ")[0])).sort((a, b) => a - b);

function cli(repoName: string, n: number, head: string, scenario: Record<number, unknown> = {}, extraEnv: Record<string, string> = {}, timeout?: number) {
  const out = join(T, "out");
  const r = spawnSync("bun", [SCRIPT, "--repo", repoName, "--pr", String(n), "--head", head, "--out", out], {
    encoding: "utf8", env: env(scenario, extraEnv), timeout,
  });
  const manifest = existsSync(join(out, "manifest.json")) ? JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) : null;
  const calls = existsSync(join(T, "on-gh.calls")) ? readFileSync(join(T, "on-gh.calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  return { code: r.status, stderr: r.stderr, manifest, calls, out };
}

test("R1: a head the pull request has moved past runs nothing", () => {
  const w = world({ prHead: "f".repeat(40) });
  const r = cli("context-manager", 417, w.pr.head);
  expect(r.code).toBe(3);
  expect(r.manifest.outcome).toBe("moved");
  expect(r.manifest.detail.headNow).toBe("f".repeat(40));
  expect(r.calls).toHaveLength(0);
});

test("R1: a head GitHub's pull ref has moved past by the time it's fetched runs nothing", () => {
  const w = world();
  git(join(T, "gh", "anima-research/context-manager.git"), `update-ref refs/pull/417/head ${w.cm.main}`);
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome, r.manifest.detail.headNow, r.calls.length]).toEqual([3, "moved", w.cm.main, 0]);
});

test("R1: a pull request pushed to or closed while its jobs ran comes out moved or closed, after the jobs", () => {
  for (const [after, outcome] of [[{ state: "open", head: "f".repeat(40) }, "moved"], [{ state: "closed", head: null }, "closed"]] as const) {
    rmSync(join(T, "out"), { recursive: true, force: true }); rmSync(join(T, "on-gh.calls"), { force: true }); rmSync(join(T, "gh.calls"), { force: true }); rmSync(join(T, "on-gh.done"), { force: true });
    rmSync(join(T, "gh"), { recursive: true, force: true }); rmSync(join(T, "work"), { recursive: true, force: true });
    const w = world();
    writeFileSync(join(T, "pr-after.json"), JSON.stringify({ state: after.state, merged_at: null, head: { sha: after.head ?? w.pr.head }, base: { ref: "main" } }));
    const r = cli("context-manager", 417, w.pr.head);
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, outcome, 12]);
    if (outcome === "moved") expect(r.manifest.detail).toEqual({ headNow: "f".repeat(40) });
    expect(r.manifest.shares).toHaveLength(12);
  }
});

test("R1: a failure of the house's beside a push stays couldnt-run, naming the new head", () => {
  const w = world();
  writeFileSync(join(T, "pr-after.json"), JSON.stringify({ state: "open", merged_at: null, head: { sha: "f".repeat(40) }, base: { ref: "main" } }));
  const r = cli("context-manager", 417, w.pr.head, { 2: { headMoved: "f".repeat(40) }, 6: { setup: 1 } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toEqual({ share: 6, why: "its setup exited 1", headNow: "f".repeat(40) });
});

test("R1: jobs that failed only at their head check make it moved, by the house's own read of the pull request", () => {
  const w = world();
  writeFileSync(join(T, "pr-after.json"), JSON.stringify({ state: "open", merged_at: null, head: { sha: "f".repeat(40) }, base: { ref: "main" } }));
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: "f".repeat(40) }, 8: { headMoved: "f".repeat(40) } });
  expect([r.code, r.manifest.outcome, r.manifest.detail]).toEqual([3, "moved", { headNow: "f".repeat(40) }]);
});

test("R1: a job's word that the head moved, while the pull request is read not to have, is a failure, not a push", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: "e".repeat(40) } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toEqual({ share: 3, why: `its head check met ${"e".repeat(40)}, not the head dispatched` });
});

test("R1: a head-moved that names no commit is the job's failure, even with the pull request moved", () => {
  const w = world();
  writeFileSync(join(T, "pr-after.json"), JSON.stringify({ state: "open", merged_at: null, head: { sha: "f".repeat(40) }, base: { ref: "main" } }));
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: "not a commit, but anything a head might write" } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toEqual({ share: 3, why: "it wrote a head that isn't a commit", headNow: "f".repeat(40) });
});

test("R1: a closed pull request runs nothing", () => {
  const w = world({ prState: "closed" });
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "closed", 0]);
});

test("R2: a head that doesn't merge onto the base tip runs nothing", () => {
  const w = world({ conflict: true });
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "doesnt-merge", 0]);
});

// A registry holding each package's published releases, by version, as the run side reads it: CONTEXT_VIEW_REGISTRY
// for cli's extraEnv. With none given, it names a registry that answers nothing, so any read fails the run.
function registry(docs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  for (const [name, versions] of Object.entries(docs)) {
    mkdirSync(join(T, "reg", name.split("/")[0]!), { recursive: true });
    writeFileSync(join(T, "reg", name), JSON.stringify({ name, versions }));
  }
  return { CONTEXT_VIEW_REGISTRY: `file://${join(T, "reg")}` };
}
const AF = "@animalabs/agent-framework", MEMBRANE = "@animalabs/membrane", CHRONICLE = "@animalabs/chronicle";
const miss = (pkg: string, range: string, wantedBy: string | null, has: string | null) => ({ missed: { package: pkg, range, wantedBy, has } });
const fresh = () => {
  for (const f of ["out", "gh", "work", "reg"]) rmSync(join(T, f), { recursive: true, force: true });
  rmSync(join(T, "on-gh.calls"), { force: true });
};

test("R3: a head asking for a stack package past the host's lockfile, across a caret boundary, runs with the least release above the lockfile's that its range admits, packed for the head arm alone", () => {
  const w = world({ cmPkg: { [MEMBRANE]: "^0.9.0" } });
  const reg = registry({ [MEMBRANE]: { "0.8.0": {}, "0.8.1": {}, "0.9.0": {}, "0.9.1": {}, "0.10.0": {} } });
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([0, "ran", 12]);
  expect(r.manifest.stack).toEqual({ base: {}, head: { [MEMBRANE]: { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }],
    ...miss(MEMBRANE, "^0.9.0", null, "0.8.0") } } });
  for (const call of r.calls) {
    const setup = call[call.indexOf("--setup") + 1]!;
    expect(setup.match(/npm pack '[^']*'[^&]*/g)!.map((s) => s.trim())).toEqual([
      `npm pack '${MEMBRANE}@0.9.0' --registry '${reg.CONTEXT_VIEW_REGISTRY}/' --ignore-scripts --pack-destination ../packs-after >/dev/null`]);
    const own = setup.indexOf("npm pack --ignore-scripts --pack-destination ../packs-after");
    expect(own).toBeGreaterThan(-1);
    expect(setup.indexOf(`npm pack '${MEMBRANE}@0.9.0'`)).toBeGreaterThan(own);
  }
});

test("R3: a head asking for a stack package no published release meets runs nothing, naming the ask and that no release meets it", () => {
  const w = world({ cmPkg: { [MEMBRANE]: "^0.9.0" } });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [MEMBRANE]: { "0.8.0": {}, "0.8.1": {} } }));
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toEqual({ arm: "head", package: MEMBRANE, range: "^0.9.0", wantedBy: null, has: "0.8.0", why: "no-release",
    release: MEMBRANE, ranges: [{ range: "^0.9.0", wantedBy: null }] });
  expect(r.manifest.stack).toBeUndefined();
});

test("R3: a head version a package at the top of the host's lockfile asks for at a range it doesn't meet moves that package to a release that admits it", () => {
  const w = world({ cmVersion: "0.27.0", lockExtra: { "node_modules/optional-user": { version: "1.0.0" } } });
  const reg = registry({
    [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } }, "0.33.0": { dependencies: { [CM]: "^0.26.0 || ^0.27.0" } } },
    [CHRONICLE]: { "0.5.1": { peerDependencies: { [CM]: "^0.24.0 || ^0.25.0" } }, "0.6.0": { peerDependencies: { [CM]: "^0.27.0" } } },
  });
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.manifest.stack).toEqual({ base: {}, head: {
    [AF]: { version: "0.33.0", host: "0.32.0", ranges: [], asks: "^0.26.0 || ^0.27.0", ...miss(CM, "^0.24.0 || ^0.25.0 || ^0.26.0", `node_modules/${AF}`, "0.27.0") },
    [CHRONICLE]: { version: "0.6.0", host: "0.5.1", ranges: [], asks: "^0.27.0", ...miss(CM, "^0.24.0 || ^0.25.0", `node_modules/${CHRONICLE}`, "0.27.0") } } });
});

test("R3: in membrane's shape, where no published release of the package that asks admits the arm's version, it runs nothing, saying so", () => {
  const w = world({ cmVersion: "0.27.0" });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } } } }));
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toEqual({ arm: "head", package: CM, range: "^0.24.0 || ^0.25.0 || ^0.26.0", wantedBy: "node_modules/@animalabs/agent-framework",
    has: "0.27.0", why: "no-release", release: AF, ranges: [], admits: { package: CM, version: "0.27.0" } });
});

test("R3: a range on the candidate from a package the view can't move runs nothing, naming it, and reads no release", () => {
  const w = world({ cmVersion: "0.25.0" });
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toEqual({ arm: "head", package: CM, range: "^0.24.0", wantedBy: "node_modules/optional-user", has: "0.25.0", why: "no-mover" });
});

test("R3: so does a base version, base first", () => {
  const w = world({ cmBaseVersion: "0.27.0" });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } } } }));
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toMatchObject({ arm: "base", has: "0.27.0", wantedBy: "node_modules/@animalabs/agent-framework", why: "no-release", release: AF });
});

test("R3: an ask of the candidate's package that isn't a plain range stops before dispatch, naming the spec, and reads no release", () => {
  for (const spec of ["npm:@animalabs/context-manager@^0.24.0", "github:anima-research/context-manager#v0.24.1", "latest", "rc1", "file:../cm"]) {
    fresh();
    const w = world({ lockExtra: { "node_modules/aliased": { version: "1.0.0", dependencies: { [CM]: spec } } } });
    const r = cli("context-manager", 417, w.pr.head, {}, registry());
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
    expect(r.manifest.detail).toEqual({ arm: "base", package: CM, range: spec, wantedBy: "node_modules/aliased", has: "0.24.1", why: "not-plain" });
  }
});

test("R3: a plain range is node-semver's range grammar: dist-tags with digits aren't, x-ranges and hyphen ranges are", () => {
  const { plainRange } = require(SCRIPT) as typeof import("../context-view-run.ts");
  for (const r of ["^0.8.0", "~0.24", "1.x", "x.x.x", "*", "", ">=0.24.0 <0.25.0", "1.2.3 - 2.3.4", "^0.24.0 || ^0.25.0", "0.24.0-rc.1", ">= 0.24.0", "v1.2.3", "~>1.2", "=1.2.3"])
    expect([r, plainRange(r)]).toEqual([r, true]);
  for (const r of ["rc1", "beta3", "next-2", "latest", "npm:@a/b@^1", "github:a/b#v1", "git+https://x", "file:../x", "workspace:*", "01.2.3", "1.2-rc1"])
    expect([r, plainRange(r)]).toEqual([r, false]);
});

test("R3: so does a candidate's own ask of a stack package that isn't a plain range", () => {
  const w = world({ cmPkg: { [MEMBRANE]: "github:antra-tess/membrane#v0.8.0" } });
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toEqual({ arm: "head", package: MEMBRANE, range: "github:antra-tess/membrane#v0.8.0", wantedBy: null, has: "0.8.0", why: "not-plain" });
});

test("R3: the candidate's own asks are read for the base too, base first", () => {
  const w = world({ cmBaseDeps: { [MEMBRANE]: "^0.9.0" } });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [MEMBRANE]: { "0.8.0": {} } }));
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toMatchObject({ arm: "base", package: MEMBRANE, range: "^0.9.0", wantedBy: null, has: "0.8.0", why: "no-release" });
});

test("R3: so is an arm's optional ask of a stack package, as npm installs those too", () => {
  const w = world({ headPkgText: JSON.stringify({ name: CM, version: "0.24.1", dependencies: { [MEMBRANE]: "^0.8.0" }, optionalDependencies: { [MEMBRANE]: "^0.9.0" } }) });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [MEMBRANE]: { "0.8.0": {}, "0.9.0": {} } }));
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "needs-companion", 0]);
  expect(r.manifest.detail).toEqual({ arm: "head", package: MEMBRANE, range: "^0.9.0", wantedBy: null, has: "0.8.0", why: "no-release", release: MEMBRANE,
    ranges: [{ range: "^0.8.0", wantedBy: null }, { range: "^0.9.0", wantedBy: null }] });
});

test("R4: 12 jobs at one harness commit and one host commit, one share each; all home with both arms is ran", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head);
  expect(r.code).toBe(0);
  expect(r.manifest.outcome).toBe("ran");
  expect(r.manifest.base.sha).not.toBe(r.manifest.head);
  expect(r.calls).toHaveLength(12);
  const at = (a: string[], k: string) => a[a.indexOf(k) + 1];
  expect(new Set(r.calls.map((a) => at(a, "--sha")))).toEqual(new Set([w.harness.main]));
  expect(new Set(r.calls.map((a) => at(a, "--with")))).toEqual(new Set([`anima-research/connectome-host@${w.host.main}`]));
  const shards = r.calls.map((a) => a.at(-1)!.match(/--shard (\d+)\/12/)![1]).map(Number).sort((x, y) => x - y);
  expect(shards).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
  for (let i = 1; i <= 12; i++) {
    expect(existsSync(join(r.out, `share-${i}`, "before", "run.json"))).toBe(true);
    expect(existsSync(join(r.out, `share-${i}`, "after", "run.json"))).toBe(true);
  }
  expect(r.manifest.shares).toHaveLength(12);
  const tree = sh(`git -C ${join(T, "gh", "anima-research/context-manager.git")} merge-tree --write-tree ${w.cm.main} ${w.pr.head}`).split("\n")[0]!;
  for (const a of r.calls) expect(at(a, "--setup")).toContain(`rev-parse HEAD^{tree})" = ${tree} ]`);
});

test("R4: with no harness release named, nothing runs", () => {
  for (const content of [null, "", "main\n", "abc123\n"]) {
    rmSync(join(T, "out"), { recursive: true, force: true }); rmSync(join(T, "on-gh.calls"), { force: true });
    rmSync(join(T, "gh"), { recursive: true, force: true }); rmSync(join(T, "work"), { recursive: true, force: true });
    world();
    if (content === null) rmSync(join(T, "state", "harness")); else writeFileSync(join(T, "state", "harness"), content);
    const r = cli("context-manager", 417, JSON.parse(readFileSync(join(T, "pr.json"), "utf8")).head.sha);
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
    expect(r.manifest.detail.why).toMatch(/^no harness release: .*harness names no commit$/);
  }
});

test("R4: a harness release that isn't a commit on this repository's main runs nothing, naming whether the mirror has it", () => {
  const w = world();
  const bare = join(T, "gh", "anima-research/context-view.git");
  const work = join(T, "work", "anima-research/context-view");
  const mirrored = join(T, "state", "mirrors", "anima-research__context-view.git");
  git(work, "checkout -q -b aside"); writeFileSync(join(work, "aside.txt"), "a"); git(work, "add -A"); git(work, "commit -q -m aside");
  git(work, `push -q ${bare} aside:aside`);
  const aside = git(bare, "rev-parse aside");
  git(T, `init -q --bare ${mirrored}`); git(mirrored, `fetch -q ${bare} aside:refs/cv/aside`); git(mirrored, "update-ref -d refs/cv/aside");
  const file = join(T, "state", "harness");
  const cases: [string, string][] = [
    [aside, `the harness release ${file} names, ${aside}, is a commit of anima-research/context-view that isn't on its main, so no job could run it: install one with run/install-harness.ts`],
    ...[w.cm.main, "0123456789abcdef0123456789abcdef01234567"].map((sha): [string, string] => [sha, `the harness release ${file} names, ${sha}, isn't among the commits fetched from anima-research/context-view's main, so no job could run it: install one with run/install-harness.ts`]),
  ];
  for (const [sha, why] of cases) {
    rmSync(join(T, "out"), { recursive: true, force: true }); rmSync(join(T, "on-gh.calls"), { force: true });
    writeFileSync(file, `${sha}\n`);
    const r = cli("context-manager", 417, w.pr.head);
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
    expect(r.manifest.detail.why).toBe(why);
  }
});

test("R4: when git can't tell whether the harness release is on main, nothing runs, and git's words say why", () => {
  const w = world();
  const bare = join(T, "gh", "anima-research/context-view.git");
  const work = join(T, "work", "anima-research/context-view");
  const mirrored = join(T, "state", "mirrors", "anima-research__context-view.git");
  git(work, "checkout -q -b aside"); writeFileSync(join(work, "aside.txt"), "a"); git(work, "add -A"); git(work, "commit -q -m aside");
  const parent = git(work, "rev-parse HEAD");
  writeFileSync(join(work, "aside.txt"), "b"); git(work, "add -A"); git(work, "commit -q -m aside2");
  git(work, `push -q ${bare} aside:aside`);
  const top = git(bare, "rev-parse aside");
  git(T, `init -q --bare ${mirrored}`); git(mirrored, `fetch -q ${bare} aside:refs/cv/aside`); git(mirrored, "update-ref -d refs/cv/aside");
  rmSync(join(mirrored, "objects", parent.slice(0, 2), parent.slice(2)));
  const file = join(T, "state", "harness");
  writeFileSync(file, `${top}\n`);
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail.why).toStartWith(`couldn't tell whether the harness release ${file} names, ${top}, is on anima-research/context-view's main: `);
  expect(r.manifest.detail.why).toContain(parent);
});

test("R4: the harness is the release STATE/harness names, or the branch CONTEXT_VIEW_HARNESS_REF names", () => {
  const w = world();
  const named = join(T, "state", "harness");
  expect(readFileSync(named, "utf8").trim()).toBe(w.harness.main);
  const bare = join(T, "gh", "anima-research/context-view.git");
  const work = join(T, "work", "anima-research/context-view");
  git(work, "checkout -q -b trial"); writeFileSync(join(work, "t.txt"), "t"); git(work, "add -A"); git(work, "commit -q -m trial");
  git(work, `push -q ${bare} trial:trial trial:main`);
  const trial = git(bare, "rev-parse trial");
  const r1 = cli("context-manager", 417, w.pr.head);
  expect(r1.manifest.harness.sha).toBe(w.harness.main);
  expect(new Set(r1.calls.map((a) => a[a.indexOf("--sha") + 1]))).toEqual(new Set([w.harness.main]));
  rmSync(join(T, "on-gh.calls"), { force: true });
  const r = cli("context-manager", 417, w.pr.head, {}, { CONTEXT_VIEW_HARNESS_REF: "trial" });
  expect(r.manifest.harness.sha).toBe(trial);
  expect(new Set(r.calls.map((a) => a[a.indexOf("--sha") + 1]))).toEqual(new Set([trial]));
});

test("R5: a host pull request runs as itself, merged in the job between the arms, with no overlay", () => {
  const w = world({ hostPR: true });
  const r = cli("connectome-host", 513, w.pr.head);
  expect([r.code, r.manifest.outcome, r.manifest.form]).toEqual([0, "ran", "host"]);
  const cmd = r.calls[0]!.at(-1)!;
  const setup = r.calls[0]![r.calls[0]!.indexOf("--setup") + 1]!;
  expect(cmd).toContain(`refs/pull/513/head`);
  expect(cmd).not.toContain("--overlay");
  expect(setup).not.toContain("packs-");
  expect(r.calls[0]![r.calls[0]!.indexOf("--with") + 1]).toBe(`anima-research/connectome-host@${w.host.main}`);
});

test("R6: a share whose setup, on-gh or in-job merge failed, or whose evidence didn't come home, makes it couldnt-run", () => {
  for (const [sc, why] of [
    [{ setup: 1 }, /setup exited 1/],
    [{ evidence: "not uploaded: 69136 KB is over 50 MB" }, /^its evidence was past on-gh's bounds, so it wasn't uploaded$/],
    [{ between: true }, /head couldn't be merged and installed in the job/],
    [{ onGh: { exit: 255, why: "unknown outcome" } }, /on-gh exited 255/],
  ] as const) {
    rmSync(join(T, "out"), { recursive: true, force: true }); rmSync(join(T, "on-gh.calls"), { force: true });
    rmSync(join(T, "gh"), { recursive: true, force: true }); rmSync(join(T, "work"), { recursive: true, force: true });
    const w = world();
    const r = cli("context-manager", 417, w.pr.head, { 5: sc });
    expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 5]);
    expect(r.manifest.detail.why).toMatch(why);
  }
});

test("R6: an error reading a share passes the stop to every job still running, and the run comes out couldnt-run", async () => {
  const w = world();
  const sc = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, k + 1 === 4 ? { malformed: true } : { hang: true }]));
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env(sc), stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  for (const pid of lines("on-gh.pids")) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  expect(code).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.share]).toEqual(["couldnt-run", 4]);
  expect(m.detail.why).toMatch(/^the run side failed on it: /);
  expect(cancelled()).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("R6: a share that fails before its job starts leaves no later share started, and stops those started", async () => {
  const w = world();
  const sc = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { hang: true }]));
  const code = `import { main } from ${JSON.stringify(SCRIPT)};
const spawn = (args, opts) => { if (args.some((a) => a.includes("/share-4/receipt."))) throw new Error("EAGAIN, spawn"); return Bun.spawn(args, opts); };
process.exit(await main(["--repo", "context-manager", "--pr", "417", "--head", ${JSON.stringify(w.pr.head)}, "--out", ${JSON.stringify(join(T, "out"))}], spawn));`;
  const child = Bun.spawn(["bun", "-e", code], { env: env(sc), stdout: "pipe", stderr: "pipe" });
  const exit = await child.exited;
  const alive = spawnSync("pgrep", ["-f", join(T, "bin", "on-gh")], { encoding: "utf8" }).stdout.trim();
  for (const pid of lines("on-gh.pids")) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  expect(exit).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail]).toEqual(["couldnt-run", { share: 4, why: "the run side failed on it: EAGAIN, spawn" }]);
  const started = lines("on-gh.calls").map((l) => Number((JSON.parse(l) as string[]).find((a) => a.includes("/share-"))!.match(/share-(\d+)/)![1]));
  expect(started.every((i) => i < 4)).toBe(true);
  expect(alive).toBe("");
});

test("R6: a share home without an arm's run.json makes it arm-missing", () => {
  const w = world();
  const log = "[whole-host] installing the candidate failed: the overlay didn't replace every copy";
  const r = cli("context-manager", 417, w.pr.head, { 3: { missing: "after", log } });
  expect([r.code, r.manifest.outcome]).toEqual([3, "arm-missing"]);
  expect(r.manifest.detail).toEqual({ share: 3, arm: "after", log });
});

async function hanging(head: string) {
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", head, "--out", join(T, "out")],
    { env: env({}, { CV_HANG: "1" }), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 600 && lines("on-gh.pids").length < 12; t++) await Bun.sleep(100);
  expect(lines("on-gh.pids")).toHaveLength(12);
  return child;
}

test("R8: a stop passes to every on-gh still following its run, and the manifest says it was stopped and which jobs", async () => {
  const w = world();
  const child = await hanging(w.pr.head);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.outcome).toBe("couldnt-run");
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
  expect(m.detail.shares).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
  expect(cancelled()).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
});

test("R8: a run killed before its manifest leaves none from an earlier run, nor its shares", async () => {
  const w = world();
  mkdirSync(join(T, "out", "share-3"), { recursive: true });
  writeFileSync(join(T, "out", "share-3", "run.json"), "earlier");
  writeFileSync(join(T, "out", "manifest.json"), JSON.stringify({ outcome: "ran" }));
  const child = await hanging(w.pr.head);
  child.kill("SIGKILL");
  await child.exited;
  for (const pid of lines("on-gh.pids")) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  expect(existsSync(join(T, "out", "manifest.json"))).toBe(false);
  expect(existsSync(join(T, "out", "share-3", "run.json"))).toBe(false);
});

function setupRun(repoName: "agent-framework" | "context-manager", gh: string, files: Record<string, string>, pushAfterPlan = false,
  headFiles: Record<string, string> = { "src.txt": "head" }, extraEnv: Record<string, string> = {}) {
  const r = repo(gh, files, { n: 9, files: headFiles });
  const bare = join(T, "gh", `${gh}.git`);
  if (pushAfterPlan) git(bare, `update-ref refs/pull/9/head ${r.main}`);
  const merged = sh(`git -C ${bare} merge-tree --write-tree ${r.main} ${r.head}`).split("\n")[0]!;
  const p = { repo: repoName, number: 9, head: r.head, form: "overlay", base: { ref: "main", sha: r.main }, host: { sha: "c".repeat(40) },
    harness: { repo: "x", sha: "d".repeat(40) }, merged };
  const setup = spawnSync("bun", ["-e", `import { job } from ${JSON.stringify(SCRIPT)}; console.log(job(${JSON.stringify(p)}, 1).setup)`],
    { encoding: "utf8", env: env({}, extraEnv) }).stdout;
  mkdirSync(join(T, "npm-bin"), { recursive: true });
  writeFileSync(join(T, "npm-bin", "npm"), `#!/bin/bash
here=$(basename "$PWD")
case "$1" in
  install) echo "install in $here from $(cat package-lock.json 2>/dev/null || echo no lockfile)" >> "$CV_T/npm.calls"; echo "{\\"written-by\\": \\"$here\\"}" > package-lock.json ;;
  ci) echo "ci in $here from $(cat package-lock.json)" >> "$CV_T/npm.calls" ;;
  pack) while [ $# -gt 0 ]; do [ "$1" = --pack-destination ] && touch "$2/c.tgz"; shift; done ;;
esac
exit 0
`);
  chmodSync(join(T, "npm-bin", "npm"), 0o755);
  const top = join(T, "setup", "smoke");
  mkdirSync(top, { recursive: true });
  mkdirSync(join(T, "setup", "evidence"), { recursive: true });
  const run = spawnSync("bash", ["-c", setup], { cwd: top, encoding: "utf8",
    env: { ...env({}, extraEnv), PATH: `${join(T, "npm-bin")}:${process.env.PATH}`, ON_GH_EVIDENCE_DIR: join(T, "setup", "evidence") } });
  return { run, calls: lines("npm.calls"), main: r.main, evidence: join(T, "setup", "evidence") };
}

test("R1: a job whose fetched head isn't the one dispatched fails its setup and says which head it met", () => {
  const { run, main, evidence } = setupRun("context-manager", "anima-research/context-manager",
    { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": "{}" }, true);
  expect(run.status).not.toBe(0);
  expect(readFileSync(join(evidence, "head-moved"), "utf8").trim()).toBe(main);
});

test("R9: a candidate that commits no lockfile installs its head arm from the lockfile its base arm's install wrote", () => {
  const { run, calls } = setupRun("agent-framework", "anima-research/agent-framework", { "package.json": JSON.stringify({ name: "@animalabs/agent-framework", version: "0.32.0" }) });
  expect(run.status).toBe(0);
  expect(calls).toEqual(["install in cand-before from no lockfile", `install in cand-after from {"written-by": "cand-before"}`]);
});

test("R9: a candidate that commits its lockfile installs each arm from its own", () => {
  const { run, calls } = setupRun("context-manager", "anima-research/context-manager",
    { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": `{"committed": true}` });
  expect(run.status).toBe(0);
  expect(calls).toEqual([`ci in cand-before from {"committed": true}`, `ci in cand-after from {"committed": true}`]);
});

const dropped = (ev: string) => readFileSync(join(ev, "kb"), "utf8").trim().split(" ")[1] === "1";

function jobRun(viewBytes: number, sparse = false, records = 1, o: { noPack?: boolean; unreadable?: boolean; tmp?: string; more?: Record<string, string[]> } = {}) {
  const { job } = require(SCRIPT) as typeof import("../context-view-run.ts");
  const p = { repo: "context-manager", number: 417, head: "a".repeat(40), form: "overlay" as const, base: { ref: "main", sha: "b".repeat(40) },
    host: { sha: "c".repeat(40) }, harness: { repo: "x", sha: "d".repeat(40) }, merged: "e".repeat(40) };
  const top = join(T, "job", "smoke"), ev = join(T, "job", "ev");
  mkdirSync(join(top, "harness"), { recursive: true }); mkdirSync(join(T, "job", "packs-before"), { recursive: true }); mkdirSync(join(T, "job", "packs-after"), { recursive: true });
  if (!o.noPack) writeFileSync(join(T, "job", "packs-before", "cm.tgz"), "");
  writeFileSync(join(T, "job", "packs-after", "cm.tgz"), "");
  for (const [dir, files] of Object.entries(o.more ?? {})) for (const f of files) writeFileSync(join(T, "job", dir, f), "");
  mkdirSync(ev, { recursive: true });
  writeFileSync(join(top, "harness", "run.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    const a = process.argv.slice(2), at = (k) => a[a.indexOf(k) + 1];
    fs.appendFileSync(${JSON.stringify(join(T, "harness.calls"))}, JSON.stringify(a) + "\\n");
    const out = at("--out"); fs.mkdirSync(path.join(out, "H1_W1"), { recursive: true });
    fs.writeFileSync(path.join(out, "run.json"), "{}"); fs.writeFileSync(path.join(out, "H1_W1", "H1_W1.record"), "r");
    for (let k = 1; k < ${records}; k++) fs.writeFileSync(path.join(out, "H1_W1", "r" + k + ".record"), "r");
    if (${sparse}) { fs.writeFileSync(path.join(out, "H1_W1", "view.md"), ""); fs.truncateSync(path.join(out, "H1_W1", "view.md"), ${viewBytes}); }
    else fs.writeFileSync(path.join(out, "H1_W1", "view.md"), Buffer.alloc(${viewBytes}, 120));
    fs.writeFileSync(path.join(out, "H1_W1", "log.jsonl"), "big");
    if (${!!o.unreadable} && a.includes("--against")) fs.chmodSync(path.join(out, "H1_W1", "H1_W1.record"), 0);`);
  const j = job(p, 7);
  const r = spawnSync("bash", ["-c", j.command], { cwd: top, encoding: "utf8", env: { ...process.env, ON_GH_EVIDENCE_DIR: ev, ...(o.tmp ? { TMPDIR: o.tmp } : {}) } });
  const calls = lines("harness.calls").map((l) => JSON.parse(l) as string[]);
  return { r, ev, calls };
}

function hostJobRun(o: { merged?: string; base?: string } = {}) {
  const host = repo("anima-research/connectome-host", { "package-lock.json": "{}", "a.txt": "a" }, { n: 513, files: { "b.txt": "b" } });
  const bare = join(T, "gh", "anima-research/connectome-host.git");
  const merged = sh(`git -C ${bare} merge-tree --write-tree ${host.main} ${host.head}`).split("\n")[0]!;
  const p = { repo: "connectome-host", number: 513, head: host.head, form: "host" as const, base: { ref: "main", sha: o.base ?? host.main },
    host: { sha: host.main }, harness: { repo: "x", sha: "d".repeat(40) }, merged: o.merged ?? merged };
  const top = join(T, "hj", "smoke"), ev = join(T, "hj", "ev");
  mkdirSync(join(top, "harness"), { recursive: true }); mkdirSync(ev, { recursive: true });
  sh(`git clone -q ${bare} ${join(T, "hj", "connectome-host")}`);
  mkdirSync(join(T, "npm-bin"), { recursive: true });
  writeFileSync(join(T, "npm-bin", "npm"), `#!/bin/bash\necho "$1 in $(basename "$PWD")" >> "$CV_T/npm.calls"\n`);
  chmodSync(join(T, "npm-bin", "npm"), 0o755);
  writeFileSync(join(top, "harness", "run.mjs"), `
    import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
    const a = process.argv.slice(2), at = (k) => a[a.indexOf(k) + 1];
    const tree = execSync("git -C ../connectome-host rev-parse HEAD^{tree}", { encoding: "utf8" }).trim();
    fs.appendFileSync(${JSON.stringify(join(T, "harness.calls"))}, JSON.stringify({ args: a, tree }) + "\\n");
    fs.mkdirSync(at("--out"), { recursive: true }); fs.writeFileSync(path.join(at("--out"), "run.json"), "{}");`);
  const command = spawnSync("bun", ["-e", `import { job } from ${JSON.stringify(SCRIPT)}; console.log(job(${JSON.stringify(p)}, 2).command)`],
    { encoding: "utf8", env: env() }).stdout;
  const r = spawnSync("bash", ["-c", command], { cwd: top, encoding: "utf8",
    env: { ...env(), PATH: `${join(T, "npm-bin")}:${process.env.PATH}`, ON_GH_EVIDENCE_DIR: ev } });
  const calls = lines("harness.calls").map((l) => JSON.parse(l) as { args: string[]; tree: string });
  return { r, ev, calls, merged, baseTree: sh(`git -C ${bare} rev-parse ${host.main}^{tree}`) };
}

test("R7: in a job the base arm runs first and the head arm against it, keeping records and views but not logs", () => {
  const { r, ev, calls } = jobRun(1000);
  expect(r.status).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("../packs-before/cm.tgz");
  expect(calls[0]).not.toContain("--against");
  expect(calls[1]).toContain("--self-check");
  expect(calls[1]![calls[1]!.indexOf("--overlay") + 1]).toBe("../packs-after/cm.tgz");
  expect(calls[1]![calls[1]!.indexOf("--against") + 1]).toBe(calls[0]![calls[0]!.indexOf("--out") + 1]);
  expect(calls[1]).toContain("--shard");
  expect(calls[1]![calls[1]!.indexOf("--shard") + 1]).toBe("7/12");
  for (const arm of ["before", "after"]) {
    expect(existsSync(join(ev, arm, "run.json"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "H1_W1.record"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "view.md"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "log.jsonl"))).toBe(false);
  }
});

test("R7: both arms balance their share by the three drives the job spends on each run: the base arm's, the head arm's and its self-check's", () => {
  const { r, calls } = jobRun(1000);
  expect(r.status).toBe(0);
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call[call.indexOf("--drives") + 1]).toBe("3");
  expect(calls[1]).toContain("--self-check");
});

test("R7: evidence that would pass on-gh's 50 MiB drops its views, and says so", () => {
  const { r, ev } = jobRun(26 * 1024 * 1024);
  expect(r.status).toBe(0);
  expect(dropped(ev)).toBe(true);
  expect(existsSync(join(ev, "after", "H1_W1", "view.md"))).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "H1_W1.record"))).toBe(true);
  expect(Number(readFileSync(join(ev, "kb"), "utf8").split(" ")[0])).toBeLessThanOrEqual(51200);
});

test("R7: the evidence is measured as on-gh measures it, in bytes rather than blocks", () => {
  const { r, ev } = jobRun(60 * 1024 * 1024, true);
  expect(r.status).toBe(0);
  expect(dropped(ev)).toBe(true);
});

test("R7: the paths are counted with the job's own kb in them, as on-gh counts them", () => {
  const { r, ev } = jobRun(1, false, 4944);
  expect(r.status).toBe(0);
  expect(dropped(ev)).toBe(true);
  expect(Number(spawnSync("bash", ["-c", `find -L ${ev} -mindepth 1 | wc -l`], { encoding: "utf8" }).stdout.trim())).toBe(9899);
});

test("R7: evidence past on-gh's 9,900 files and directories drops its views too", () => {
  const { r, ev } = jobRun(10, false, 5000);
  expect(r.status).toBe(0);
  expect(dropped(ev)).toBe(true);
});

test("R7: evidence under on-gh's 50 MiB keeps its views", () => {
  const { r, ev } = jobRun(24 * 1024 * 1024);
  expect(r.status).toBe(0);
  expect(dropped(ev)).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "view.md"))).toBe(true);
});

const movedTo = (sha: string) => writeFileSync(join(T, "pr-after.json"), JSON.stringify({ state: "open", merged_at: null, head: { sha }, base: { ref: "main" } }));

test("R1: a job's head check beside a failure of on-gh's stays couldnt-run, though the pull request moved", () => {
  const w = world();
  movedTo("f".repeat(40));
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: "f".repeat(40), exit: 255 } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toMatchObject({ share: 3, headNow: "f".repeat(40) });
  expect(r.manifest.detail.why).toMatch(/^on-gh exited 255/);
});

test("R1: a job that met a head the house's read doesn't name stays couldnt-run, though the pull request moved", () => {
  const w = world();
  movedTo("f".repeat(40));
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: "e".repeat(40) } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toEqual({ share: 3, why: `its head check met ${"e".repeat(40)}, not the head dispatched`, headNow: "f".repeat(40) });
});

test("R1: a head-moved naming the head dispatched is the job's failure, not a push", () => {
  const w = world();
  movedTo("f".repeat(40));
  const r = cli("context-manager", 417, w.pr.head, { 3: { headMoved: w.pr.head } });
  expect(r.manifest.detail).toEqual({ share: 3, why: "it wrote the head dispatched as one it met in its place", headNow: "f".repeat(40) });
});

test("R3: so is a candidate's own peer ask of a stack package", () => {
  const w = world({ cmPkg: {}, cmPeer: { [MEMBRANE]: "^0.9.0" } });
  const r = cli("context-manager", 417, w.pr.head, {}, registry({ [MEMBRANE]: { "0.8.0": {}, "0.9.0": {} } }));
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.manifest.stack).toEqual({ base: {}, head: { [MEMBRANE]: { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }],
    ...miss(MEMBRANE, "^0.9.0", null, "0.8.0") } } });
});

test("R3: a registry document that gives no versions fails the run before any job, saying so", () => {
  const w = world({ cmPkg: { [MEMBRANE]: "^0.9.0" } });
  const reg = registry();
  mkdirSync(join(T, "reg", "@animalabs"), { recursive: true });
  writeFileSync(join(T, "reg", MEMBRANE), JSON.stringify({ error: "temporarily unavailable" }));
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: `the run side failed before any job: the registry's document for ${MEMBRANE} gives no versions` });
  expect([r.manifest.form, r.manifest.base.ref, r.manifest.host.sha, r.manifest.harness.sha]).toEqual(["overlay", "main", w.host.main, w.harness.main]);
  expect(r.manifest.base.sha).toMatch(/^[0-9a-f]{40}$/);
});

test("R3: a lockfile that meets every range reads no release, and the manifest is as it was before the plan could choose any", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(Object.keys(r.manifest)).toEqual(["repo", "number", "head", "form", "base", "host", "harness", "outcome", "detail", "shares"]);
  for (const call of r.calls) expect(call[call.indexOf("--setup") + 1]).not.toMatch(/npm pack '/);
});

test("R3: an arm's version meets a range as npm's semver does, prereleases and build metadata included", () => {
  const { meets } = require(SCRIPT) as typeof import("../context-view-run.ts");
  for (const [v, range, ok] of [["0.9.1-dev.0", "^0.9.0", false], ["0.9.1", "^0.9.0", true], ["0.24.1-rc.1", ">=0.24.1-rc.0", true],
    ["0.24.1-rc.1", "^0.24.0", false], ["1.2.3+build.1", "1.2.3", true], ["0.24.1", ">= 0.24.0", true], ["0.23.9", ">= 0.24.0", false],
    ["1.2.5", "~>1.2", true], ["1.3.0", "~>1.2", false], ["1.2.3", "v1.2.3", true], ["1.2.4", "v1.2.3", false], ["0.0.1", "", true],
    ["2.0.0", "1.2.3 - 2.0.0", true], ["2.0.1", "1.2.3 - 2.0.0", false]] as const)
    expect([v, range, meets(v, range)]).toEqual([v, range, ok]);
});

test("R4: a read that fails before any job writes couldnt-run, saying so", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, { CV_GH_FAIL: "1" });
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail.why).toMatch(/^the run side failed before any job: gh api .* exited 1: gh: HTTP 502$/);
});

test("R4: a head whose package.json isn't JSON is named, not quoted", () => {
  const w = world({ headPkgText: "Oscar-1005 please look" });
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: "the run side failed before any job: the head's package.json isn't JSON" });
});

test("R4: each read of a mirror leaves none of its refs behind", () => {
  const w = world();
  expect(cli("context-manager", 417, w.pr.head).code).toBe(0);
  for (const m of ["anima-research__context-manager.git", "anima-research__connectome-host.git"])
    expect(sh(`git -C ${join(T, "state", "mirrors", m)} for-each-ref refs/cv`)).toBe("");
});

test("R5: a host job runs its base arm on the base, then merges the head and runs the head arm on the merged tree", () => {
  const { r, ev, calls, merged, baseTree } = hostJobRun();
  expect(r.status).toBe(0);
  expect(calls.map((c) => c.tree)).toEqual([baseTree, merged]);
  expect(calls[0]!.args).not.toContain("--against");
  expect(calls[1]!.args).toContain("--against");
  expect(existsSync(join(ev, "failed"))).toBe(false);
});

test("R5: a host job whose merge doesn't give the tree planned writes its failure, and runs no head arm", () => {
  const { ev, calls } = hostJobRun({ merged: "e".repeat(40) });
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(ev, "failed"), "utf8")).toBe("between\n");
  expect(existsSync(join(ev, "rc-after"))).toBe(false);
});

test("R5: so does a host job whose base can't be fetched, though the pull request's head can", () => {
  const { ev, calls } = hostJobRun({ base: "1".repeat(40) });
  expect(calls).toHaveLength(1);
  expect(existsSync(join(ev, "failed"))).toBe(true);
});

test("R6: what a receipt says of its evidence reaches the why only as the run side's own words", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 5: { evidence: "not uploaded: @Oscar-1005 **see https://example.invalid** KB is over 50 MB" } });
  expect(r.manifest.detail).toEqual({ share: 5, why: "its evidence was past on-gh's bounds, so it wasn't uploaded" });
});

test("R8: a stop during the reads, once they have planned the jobs, is the stopped run, its manifest without the merged tree", async () => {
  const w = world();
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env({}, { CV_GH_HOLD: "1" }), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 100 && lines("gh.calls").length < 1; t++) await Bun.sleep(100);
  child.kill("SIGTERM");
  writeFileSync(join(T, "gh.release"), "");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.shares, m.base.sha, m.harness.sha, "merged" in m]).toEqual(["couldnt-run", [], w.cm.main, w.harness.main, false]);
  expect(lines("on-gh.calls")).toHaveLength(0);
});

test("R6: a job whose command exited nonzero is couldnt-run, naming the command", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 7: { command: 1, exit: 1 } });
  expect([r.code, r.manifest.outcome, r.manifest.detail]).toEqual([2, "couldnt-run", { share: 7, why: "its command exited 1" }]);
});

test("R6: an on-gh that ended not knowing how its run stands is asked to cancel the run", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { exit: 255 } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 6]);
  expect(lines("on-gh.stops")).toEqual(["20261105T010000Z-00000006"]);
});

test("R6: an arm-missing's log is the arm log's whole last line", () => {
  const w = world();
  const log = `[whole-host] ${"y".repeat(1500)}`;
  const r = cli("context-manager", 417, w.pr.head, { 3: { missing: "after", log } });
  expect(r.manifest.detail).toEqual({ share: 3, arm: "after", log });
});

test("R6: an arm whose harness was killed by a signal didn't finish, whatever run.json it left; one that exited 1 did", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 5: { rc: { before: 1, after: 137 } } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share, r.manifest.detail.arm]).toEqual([3, "arm-missing", 5, "after"]);
  expect(cli("context-manager", 417, w.pr.head, { 5: { rc: { before: 1, after: 1 } } }).manifest.outcome).toBe("ran");
});

test("R6: an on-gh that writes more than a pipe holds to stderr before it's done still comes home", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 4: { bigStderr: true } }, {}, 60_000);
  expect([r.code, r.manifest?.outcome]).toEqual([0, "ran"]);
});

test("R6: a job whose output can't be read stops every job, its own among them, and leaves none running", async () => {
  const w = world();
  const sc = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { hang: true }]));
  const code = `import { main } from ${JSON.stringify(SCRIPT)};
import { readFileSync } from "node:fs";
const pids = () => { try { return readFileSync(${JSON.stringify(join(T, "on-gh.pids"))}, "utf8").trim().split("\\n").filter(Boolean).length; } catch { return 0; } };
const spawn = (args, opts) => {
  const c = Bun.spawn(args, opts);
  if (!args.some((a) => a.includes("/share-3/receipt."))) return c;
  const broken = new ReadableStream({ start(ctl) { const wait = () => (pids() >= 12 ? ctl.error(new Error("the pipe broke")) : setTimeout(wait, 50)); wait(); } });
  return new Proxy(c, { get(t, k) { if (k === "stdout") return broken; const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; } });
};
process.exit(await main(["--repo", "context-manager", "--pr", "417", "--head", ${JSON.stringify(w.pr.head)}, "--out", ${JSON.stringify(join(T, "out"))}], spawn));`;
  const child = Bun.spawn(["bun", "-e", code], { env: env(sc), stdout: "pipe", stderr: "pipe" });
  const exit = await child.exited;
  const alive = spawnSync("pgrep", ["-f", join(T, "bin", "on-gh")], { encoding: "utf8" }).stdout.trim();
  for (const pid of lines("on-gh.pids")) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  expect(exit).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail]).toEqual(["couldnt-run", { share: 3, why: "the run side failed on it: the pipe broke" }]);
  expect(cancelled()).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
  expect(alive).toBe("");
});

test("R7: a pack that has gone runs no arm on it, and the arm comes home missing", () => {
  const { r, ev, calls } = jobRun(10, false, 1, { noPack: true });
  expect(r.status).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("../packs-after/cm.tgz");
  expect(existsSync(join(ev, "before", "run.json"))).toBe(false);
});

test("R7: evidence that can't all be kept makes the command exit 1", () => {
  const { r, ev } = jobRun(10, false, 1, { unreadable: true });
  expect(r.status).toBe(1);
  expect(existsSync(join(ev, "after", "run.json"))).toBe(true);
});

test("R8: SIGINT stops it as SIGTERM does", async () => {
  const w = world();
  const child = await hanging(w.pr.head);
  child.kill("SIGINT");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.detail.why).toMatch(/^stopped by SIGINT after \d+ s$/);
  expect(cancelled()).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
  expect(lines("on-gh.cancels").every((l) => l.endsWith(" SIGINT"))).toBe(true);
});

test("R8: a stop after some jobs came home names only those that didn't, one whose evidence wasn't uploaded among them", async () => {
  const w = world();
  const sc = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, k >= 3 ? { hang: true } : k === 1 ? { evidence: "not uploaded: 69136 KB is over 50 MB" } : {}]));
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env(sc), stdout: "pipe", stderr: "pipe" });
  const home = () => [1, 2, 3].every((i) => existsSync(join(T, "out", `share-${i}`, "on-gh.exit")));
  for (let t = 0; t < 600 && (lines("on-gh.pids").length < 9 || !home()); t++) await Bun.sleep(100);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.detail.shares).toEqual([2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("R8: a stop during the reads before any job is the stopped run, even when the read then answers", async () => {
  const w = world({ prState: "closed" });
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env({}, { CV_GH_HOLD: "1" }), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 100 && lines("gh.calls").length < 1; t++) await Bun.sleep(100);
  child.kill("SIGTERM");
  writeFileSync(join(T, "gh.release"), "");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.shares]).toEqual(["couldnt-run", []]);
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
});

test("R8: a stop during the read after the jobs is the stopped run, though the read then answers", async () => {
  const w = world();
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env({}, { CV_GH_HOLD: "2" }), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 600 && lines("gh.calls").length < 2; t++) await Bun.sleep(100);
  child.kill("SIGTERM");
  writeFileSync(join(T, "gh.release"), "");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.shares]).toEqual(["couldnt-run", []]);
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
});

test("R8: a stop to the whole process group during the reads, which kills the read, is the stopped run too", async () => {
  const w = world();
  const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
  const c = nodeSpawn("bun", [SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env({}, { CV_GH_HOLD: "1" }), detached: true, stdio: "ignore" });
  for (let t = 0; t < 100 && lines("gh.calls").length < 1; t++) await Bun.sleep(100);
  process.kill(-c.pid!, "SIGTERM");
  const code = await new Promise((r) => c.on("exit", (code) => r(code)));
  expect(code).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.outcome).toBe("couldnt-run");
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
});

test("R8: a run refused for its arguments leaves no manifest an earlier run wrote", () => {
  mkdirSync(join(T, "out"), { recursive: true });
  writeFileSync(join(T, "out", "manifest.json"), JSON.stringify({ outcome: "ran" }));
  writeFileSync(join(T, "out", "manifest.json.tmp"), "{");
  for (const [repo, head] of [["context-manager", "not-a-commit"], ["somewhere-else", "a".repeat(40)]]) {
    const r = spawnSync("bun", [SCRIPT, "--repo", repo, "--pr", "417", "--head", head, "--out", join(T, "out")], { encoding: "utf8", env: env() });
    expect([repo, r.status, r.stderr]).toEqual([repo, 2, expect.stringContaining("usage: context-view-run --repo context-manager|")]);
    expect(readdirSync(join(T, "out"))).toEqual([]);
  }
});

test("R6: an on-gh that ended not knowing its run's state is asked to cancel it before anything else is written", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { exit: 255, logDir: true } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 6]);
  expect(r.manifest.detail.why).toMatch(/^the run side failed on it: EISDIR/);
  expect(lines("on-gh.stops")).toEqual(["20261105T010000Z-00000006"]);
});

test("R6: an on-gh that was killed is asked to cancel its run", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { selfKill: true } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 6]);
  expect(lines("on-gh.stops")).toEqual(["20261105T010000Z-00000006"]);
});

test("R6: a job whose arms can't be moved into its share is couldnt-run, naming it", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 5: { blockArm: true } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 5]);
  expect(r.manifest.detail.why).toMatch(/^the run side failed on it: /);
});

test("R1: a read after the jobs that fails leaves what the jobs saw, and says so", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, { CV_GH_FAIL_AT: "2" });
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.stderr).toContain("the read after the jobs failed, so what the jobs saw stands: gh api");
});

test("R7: a job that can't make its scratch directory exits 1 and runs no arm", () => {
  const { r, calls } = jobRun(10, false, 1, { tmp: join(T, "no-such-dir") });
  expect(r.status).toBe(1);
  expect(calls).toHaveLength(0);
});

test("R8: timeout's signal to the whole group while the jobs run is the stopped run, every job cancelled", async () => {
  const w = world();
  const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
  const c = nodeSpawn("bun", [SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")],
    { env: env({}, { CV_HANG: "1" }), detached: true, stdio: "ignore" });
  for (let t = 0; t < 600 && lines("on-gh.pids").length < 12; t++) await Bun.sleep(100);
  process.kill(-c.pid!, "SIGTERM");
  const code = await new Promise((r) => c.on("exit", (code) => r(code)));
  expect(code).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.shares.length]).toEqual(["couldnt-run", 12]);
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
  expect([...new Set(cancelled())]).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
});

test("R8: main leaves no signal handler behind once it returns", () => {
  const w = world({ prState: "closed" });
  const code = `import { main } from ${JSON.stringify(SCRIPT)};
const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
const exit = await main(["--repo", "context-manager", "--pr", "417", "--head", ${JSON.stringify(w.pr.head)}, "--out", ${JSON.stringify(join(T, "out"))}]);
console.log(JSON.stringify([exit, ...before, process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]));`;
  const r = spawnSync("bun", ["-e", code], { env: env(), encoding: "utf8" });
  expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual([3, 0, 0, 0, 0]);
});

test("R9: a candidate that commits its lockfile installs its head arm from the head's own", () => {
  const { run, calls } = setupRun("context-manager", "anima-research/context-manager",
    { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": `{"committed": "base"}` }, false,
    { "package-lock.json": `{"committed": "head"}` });
  expect(run.status).toBe(0);
  expect(calls).toEqual([`ci in cand-before from {"committed": "base"}`, `ci in cand-after from {"committed": "head"}`]);
});

test("R7: an arm with releases the plan chose lays each over the host beside the candidate's pack", () => {
  const { job } = require(SCRIPT) as typeof import("../context-view-run.ts");
  const { r, calls } = jobRun(1000, false, 1, { more: { "packs-after": ["membrane.tgz"] } });
  expect(r.status).toBe(0);
  expect(calls[0]![calls[0]!.indexOf("--overlay") + 1]).toBe("../packs-before/cm.tgz");
  expect(calls[1]![calls[1]!.indexOf("--overlay") + 1]).toBe("../packs-after/cm.tgz,../packs-after/membrane.tgz");
  const p = { repo: "context-manager", number: 417, head: "a".repeat(40), form: "overlay" as const, base: { ref: "main", sha: "b".repeat(40) },
    host: { sha: "c".repeat(40) }, harness: { repo: "x", sha: "d".repeat(40) }, merged: "e".repeat(40),
    stack: { base: { [AF]: { version: "0.33.0", host: "0.32.0", ranges: [] } }, head: { [AF]: { version: "0.33.0", host: "0.32.0", ranges: [] }, [MEMBRANE]: { version: "0.9.0", host: "0.8.0", ranges: [] } } } };
  const steps = job(p, 1).setup.split(" && ");
  const packs = steps.filter((s) => s.startsWith("npm pack '"));
  const npm = "--registry 'https://registry.npmjs.org/' --ignore-scripts";
  expect(packs).toEqual([`npm pack '${AF}@0.33.0' ${npm} --pack-destination ../packs-before >/dev/null`,
    `npm pack '${AF}@0.33.0' ${npm} --pack-destination ../packs-after >/dev/null`,
    `npm pack '${MEMBRANE}@0.9.0' ${npm} --pack-destination ../packs-after >/dev/null`]);
  expect(steps.indexOf(packs[0]!)).toBeLessThan(steps.findIndex((s) => s.startsWith("git init -q ../cand-after")));
});

// The resolution alone, over a lockfile, each arm's package.json and the registry's releases, each read counted.
function resolved(lock: Record<string, unknown>, base: Record<string, unknown>, head: Record<string, unknown>,
  docs: Record<string, Record<string, Record<string, unknown>>>, pack = AF) {
  const { resolve } = require(SCRIPT) as typeof import("../context-view-run.ts");
  const reads: string[] = [];
  const out = resolve({ "": { dependencies: { [pack]: "^1.0.0" } }, ...lock } as never, pack, { base, head } as never, (name) => {
    reads.push(name);
    if (!docs[name]) throw new Error(`no registry document for ${name} in this test`);
    return docs[name] as never;
  });
  return { out, reads };
}
const deps = (d: Record<string, string>) => ({ dependencies: d });

test("R10: a raise within the base's range moves both arms to one release, the least above the lockfile's", () => {
  const { out, reads } = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) }, { version: "0.33.0", ...deps({ [CM]: "^0.25.1" }) },
    { [CM]: { "0.24.2": {}, "0.25.0": {}, "0.25.1": {}, "0.25.2": {}, "0.26.0": {} } });
  const chosen = (ask: string, more = {}) => ({ [CM]: { version: "0.25.1", host: "0.25.0", ranges: [{ range: ask, wantedBy: null }], ...more } });
  expect(out).toEqual({ stack: { base: chosen("^0.25.0"), head: chosen("^0.25.1", miss(CM, "^0.25.1", null, "0.25.0")) } });
  expect(reads).toEqual([CM]);
});

test("R10: a raise past the base's range moves the head alone, and a range excluding the lockfile's version from above takes the greatest release below", () => {
  const docs = { [CM]: { "0.24.0": {}, "0.24.1": {}, "0.24.2": {}, "0.25.0": {}, "0.25.1": {} } };
  const caret = resolved({ [`node_modules/${CM}`]: { version: "0.24.2" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.24.0" }) }, { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) }, docs).out;
  expect(caret).toEqual({ stack: { base: {}, head: { [CM]: { version: "0.25.0", host: "0.24.2", ranges: [{ range: "^0.25.0", wantedBy: null }],
    ...miss(CM, "^0.25.0", null, "0.24.2") } } } });
  const below = resolved({ [`node_modules/${CM}`]: { version: "0.24.2" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.24.0" }) }, { version: "0.33.0", ...deps({ [CM]: ">=0.24.0 <0.24.2" }) }, docs).out as { stack: Record<string, Record<string, { version: string }>> };
  expect([below.stack.base![CM]!.version, below.stack.head![CM]!.version]).toEqual(["0.24.1", "0.24.1"]);
});

test("R10: a chosen release's own range moves another package, and a release whose own range doesn't admit the arm's version isn't chosen", () => {
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "0.24.2", ...deps({ [CHRONICLE]: "^0.6.0" }) }, [`node_modules/${CHRONICLE}`]: { version: "0.6.0" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.24.0" }) }, { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) },
    { [CM]: { "0.24.2": deps({ [CHRONICLE]: "^0.6.0" }), "0.25.0": { peerDependencies: { [AF]: "^0.40.0" } }, "0.25.1": deps({ [CHRONICLE]: "^0.7.0", [AF]: "^0.33.0" }) },
      [CHRONICLE]: { "0.6.0": {}, "0.7.0": {}, "0.7.1": {} } });
  expect(out).toEqual({ stack: { base: {}, head: {
    [CHRONICLE]: { version: "0.7.0", host: "0.6.0", ranges: [{ range: "^0.7.0", wantedBy: `${CM}@0.25.1` }], ...miss(CHRONICLE, "^0.7.0", `${CM}@0.25.1`, "0.6.0") },
    [CM]: { version: "0.25.1", host: "0.24.2", ranges: [{ range: "^0.25.0", wantedBy: null }], asks: "^0.33.0", ...miss(CM, "^0.25.0", null, "0.24.2") } } } });
});

test("R10: an earlier choice moves again when a later one's range excludes it", () => {
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "0.24.2", ...deps({ [CHRONICLE]: "^0.6.0" }) }, [`node_modules/${CHRONICLE}`]: { version: "0.6.0" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.24.0", [CHRONICLE]: "^0.6.0" }) }, { version: "0.33.0", ...deps({ [CM]: "^0.25.0", [CHRONICLE]: "^0.7.0" }) },
    { [CM]: { "0.24.2": deps({ [CHRONICLE]: "^0.6.0" }), "0.25.0": deps({ [CHRONICLE]: "^0.6.0 || ^0.7.0" }), "0.25.1": deps({ [CHRONICLE]: "^0.6.0 || ^0.7.0" }) },
      [CHRONICLE]: { "0.6.0": {}, "0.7.0": deps({ [CM]: "^0.25.1" }) } });
  expect(out).toEqual({ stack: { base: {}, head: {
    [CHRONICLE]: { version: "0.7.0", host: "0.6.0", ranges: [{ range: "^0.7.0", wantedBy: null }, { range: "^0.6.0 || ^0.7.0", wantedBy: `${CM}@0.25.1` }],
      ...miss(CHRONICLE, "^0.7.0", null, "0.6.0") },
    [CM]: { version: "0.25.1", host: "0.24.2", ranges: [{ range: "^0.25.0", wantedBy: null }, { range: "^0.25.1", wantedBy: `${CHRONICLE}@0.7.0` }],
      ...miss(CM, "^0.25.0", null, "0.24.2") } } } });
});

test("R10: in membrane's shape the package that asks moves, to a release whose own range admits each arm's version and not a prerelease, as no range is on it, or none is found and it says so, and whether a prerelease would have served", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.32.0", ...deps({ [MEMBRANE]: "^0.8.0" }) } };
  const docs = (more: Record<string, Record<string, unknown>>) => ({ [AF]: { "0.32.0": deps({ [MEMBRANE]: "^0.8.0" }), "0.33.0": deps({ [MEMBRANE]: "^0.10.0" }), ...more } });
  const rc = { "0.33.1-rc.0": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) };
  const { out } = resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({ ...rc, "0.34.0": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) }), MEMBRANE);
  const chosen = (has: string) => ({ [AF]: { version: "0.34.0", host: "0.32.0", ranges: [], asks: "^0.8.0 || ^0.9.0", ...miss(MEMBRANE, "^0.8.0", `node_modules/${AF}`, has) } });
  expect(out).toEqual({ stack: { base: chosen("0.9.0"), head: chosen("0.9.1") } });
  const build = resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({ ...rc, "0.33.2+build-1": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) }), MEMBRANE).out as { stack: Stack };
  expect([build.stack.base[AF]!.version, build.stack.head[AF]!.version]).toEqual(["0.33.2+build-1", "0.33.2+build-1"]);
  expect(resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs(rc), MEMBRANE).out).toEqual({ stop: { arm: "base", package: MEMBRANE, range: "^0.8.0",
    wantedBy: `node_modules/${AF}`, has: "0.9.0", why: "no-release", release: AF, ranges: [], admits: { package: MEMBRANE, version: "0.9.0" }, prerelease: true } });
  const none = resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({}), MEMBRANE).out;
  expect(none).toEqual({ stop: { arm: "base", package: MEMBRANE, range: "^0.8.0", wantedBy: `node_modules/${AF}`, has: "0.9.0", why: "no-release",
    release: AF, ranges: [], admits: { package: MEMBRANE, version: "0.9.0" } } });
});

test("R10: where no release serves both arms, the arm whose range misses moves alone and the other keeps what it has, which settles where moving that one back would go round", () => {
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${CHRONICLE}`]: { version: "0.6.0" }, [`node_modules/${MEMBRANE}`]: { version: "0.8.0" } },
    { version: "0.33.0", ...deps({ [CM]: "^0.25.0", [MEMBRANE]: "^0.8.0" }) },
    { version: "0.33.0", ...deps({ [CHRONICLE]: "^0.7.0", [MEMBRANE]: "^0.9.0", [CM]: "^0.25.0 || ^0.26.0" }) },
    { [CHRONICLE]: { "0.6.0": {}, "0.7.0": deps({ [CM]: "^0.25.1 || ^0.26.0" }) }, [CM]: { "0.25.0": {}, "0.25.1": {}, "0.26.0": {} },
      [MEMBRANE]: { "0.8.0": {}, "0.9.0": deps({ [CM]: "^0.26.0" }) } });
  const chronicle = (ranges: { range: string; wantedBy: string | null }[], more = {}) => ({ version: "0.7.0", host: "0.6.0", ranges, ...more });
  expect(out).toEqual({ stack: {
    base: { [CHRONICLE]: chronicle([]),
      [CM]: { version: "0.25.1", host: "0.25.0", ranges: [{ range: "^0.25.0", wantedBy: null }, { range: "^0.25.1 || ^0.26.0", wantedBy: `${CHRONICLE}@0.7.0` }],
        ...miss(CM, "^0.25.1 || ^0.26.0", `${CHRONICLE}@0.7.0`, "0.25.0") } },
    head: { [CHRONICLE]: chronicle([{ range: "^0.7.0", wantedBy: null }], miss(CHRONICLE, "^0.7.0", null, "0.6.0")),
      [CM]: { version: "0.26.0", host: "0.25.0", ranges: [{ range: "^0.25.0 || ^0.26.0", wantedBy: null }, { range: "^0.25.1 || ^0.26.0", wantedBy: `${CHRONICLE}@0.7.0` },
        { range: "^0.26.0", wantedBy: `${MEMBRANE}@0.9.0` }], ...miss(CM, "^0.25.1 || ^0.26.0", `${CHRONICLE}@0.7.0`, "0.25.0") },
      [MEMBRANE]: { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }], ...miss(MEMBRANE, "^0.9.0", null, "0.8.0") } } } });
});

test("R10: once settled, a release the lockfile's would serve as well goes back to it, so a kept release always names the range the lockfile's leaves unmet, or is the same in both arms", () => {
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "1.0.0" }, [`node_modules/${CHRONICLE}`]: { version: "1.0.0" } },
    { version: "0.33.0", ...deps({ [CM]: ">=1 <3", [CHRONICLE]: "<2" }) }, { version: "0.33.0", ...deps({ [CM]: ">=2 <4", [CHRONICLE]: ">=2" }) },
    { [CM]: { "1.0.0": {}, "2.0.0": {}, "3.0.0": {} }, [CHRONICLE]: { "1.0.0": {}, "2.0.0": deps({ [CM]: ">=3" }) } });
  expect(out).toEqual({ stack: { base: {}, head: {
    [CHRONICLE]: { version: "2.0.0", host: "1.0.0", ranges: [{ range: ">=2", wantedBy: null }], ...miss(CHRONICLE, ">=2", null, "1.0.0") },
    [CM]: { version: "3.0.0", host: "1.0.0", ranges: [{ range: ">=2 <4", wantedBy: null }, { range: ">=3", wantedBy: `${CHRONICLE}@2.0.0` }],
      ...miss(CM, ">=2 <4", null, "1.0.0") } } } });
});

test("R10: the stack doesn't depend on the order of an input's keys, though the releases that go back once settled are tried in turn", () => {
  const lock = { [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${CHRONICLE}`]: { version: "0.6.0" }, [`node_modules/${MEMBRANE}`]: { version: "0.8.0" } };
  const base = { [MEMBRANE]: "<0.10.0", [CHRONICLE]: "<0.8.0", [CM]: "^0.25.0" }, head = { [MEMBRANE]: ">=0.9.0", [CM]: "^0.26.0" };
  const docs = { [MEMBRANE]: { "0.8.0": {}, "0.9.0": deps({ [CHRONICLE]: "^0.7.0" }), "0.10.0": deps({ [CHRONICLE]: "^0.8.0" }) },
    [CHRONICLE]: { "0.6.0": {}, "0.7.0": {}, "0.8.0": {} }, [CM]: { "0.25.0": {}, "0.26.0": deps({ [MEMBRANE]: "^0.10.0" }) } };
  const reversed = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).reverse()) as T;
  const one = resolved(lock, { version: "0.33.0", ...deps(base) }, { version: "0.33.0", ...deps(head) }, docs).out;
  const other = resolved(reversed(lock), { version: "0.33.0", ...deps(reversed(base)) }, { version: "0.33.0", ...deps(reversed(head)) }, reversed(docs)).out;
  expect(one).toEqual({ stack: { base: {}, head: {
    [CHRONICLE]: { version: "0.8.0", host: "0.6.0", ranges: [{ range: "^0.8.0", wantedBy: `${MEMBRANE}@0.10.0` }], ...miss(CHRONICLE, "^0.8.0", `${MEMBRANE}@0.10.0`, "0.6.0") },
    [CM]: { version: "0.26.0", host: "0.25.0", ranges: [{ range: "^0.26.0", wantedBy: null }], ...miss(CM, "^0.26.0", null, "0.25.0") },
    [MEMBRANE]: { version: "0.10.0", host: "0.8.0", ranges: [{ range: ">=0.9.0", wantedBy: null }, { range: "^0.10.0", wantedBy: `${CM}@0.26.0` }],
      ...miss(MEMBRANE, ">=0.9.0", null, "0.8.0") } } } });
  expect(other).toEqual(one);
});

test("R10: a named prerelease is chosen as npm would, and a prerelease of another version isn't", () => {
  const named = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" } }, { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) },
    { version: "0.33.0", ...deps({ [CM]: "^0.26.0-rc.1" }) }, { [CM]: { "0.25.0": {}, "0.26.0-rc.1": {}, "0.26.0-rc.2": {}, "0.27.0-rc.0": {} } }).out as { stack: Stack };
  expect(named.stack.head[CM]!.version).toBe("0.26.0-rc.1");
  const other = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" } }, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [CM]: ">=0.26.0-rc.0 <0.28.0" }) },
    { [CM]: { "0.25.0": {}, "0.27.0-rc.0": {} } }).out;
  expect(other).toMatchObject({ stop: { why: "no-release", release: CM } });
  expect("prerelease" in (other as { stop: object }).stop).toBe(false);
});

test("R10: an unmet range on an @animalabs package the plan doesn't move stops as no-mover, whether the arm, a chosen release or a lockfile entry asks it, and a package the lockfile gives no version isn't checked", () => {
  const MCPL = "@animalabs/mcpl-core";
  const own = resolved({ [`node_modules/${MCPL}`]: { version: "0.4.0" } }, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MCPL]: "^0.5.0" }) }, {});
  expect(own).toEqual({ out: { stop: { arm: "head", package: MCPL, range: "^0.5.0", wantedBy: null, has: "0.4.0", why: "no-mover" } }, reads: [] });
  const release = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${MCPL}`]: { version: "0.4.0" } }, { version: "0.33.0" },
    { version: "0.33.0", ...deps({ [CM]: "^0.26.0" }) }, { [CM]: { "0.25.0": {}, "0.26.0": deps({ [MCPL]: "^0.5.0" }) } }).out;
  expect(release).toEqual({ stop: { arm: "base", package: MCPL, range: "^0.5.0", wantedBy: `${CM}@0.26.0`, has: "0.4.0", why: "no-mover" } });
  const asker = resolved({ [`node_modules/${MCPL}`]: { version: "0.4.0", ...deps({ [AF]: "^0.32.0" }) } }, { version: "0.32.0" }, { version: "0.33.0" }, {});
  expect(asker).toEqual({ out: { stop: { arm: "head", package: AF, range: "^0.32.0", wantedBy: `node_modules/${MCPL}`, has: "0.33.0", why: "no-mover" } }, reads: [] });
  for (const lock of [{ [`node_modules/${MCPL}`]: {} }, {}]) {
    expect(resolved(lock, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MCPL]: "^0.5.0" }) }, {})).toEqual({ out: { stack: null }, reads: [] });
  }
});

test("R10: where a lockfile entry under one moved package is a copy of another, the release tried second of the two can't go back, and the order is by name", () => {
  const nested = `node_modules/${CHRONICLE}/node_modules/${CM}`;
  const { out } = resolved({ [`node_modules/${CHRONICLE}`]: { version: "1.0.0" }, [`node_modules/${CM}`]: { version: "1.0.0" }, [`node_modules/${MEMBRANE}`]: { version: "1.0.0" },
    [nested]: { version: "1.0.0", ...deps({ [MEMBRANE]: "<3" }) } }, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MEMBRANE]: ">=2" }) },
  { [MEMBRANE]: { "1.0.0": {}, "2.0.0": deps({ [CHRONICLE]: ">=2", [CM]: ">=2" }), "3.0.0": {} }, [CHRONICLE]: { "1.0.0": {}, "2.0.0": {} },
    [CM]: { "1.0.0": {}, "2.0.0": deps({ [MEMBRANE]: ">=3" }) } });
  const cm = { version: "2.0.0", host: "1.0.0", ranges: [], ...miss(MEMBRANE, "<3", nested, "3.0.0") };
  expect(out).toEqual({ stack: {
    base: { [CM]: cm, [MEMBRANE]: { version: "3.0.0", host: "1.0.0", ranges: [{ range: ">=3", wantedBy: `${CM}@2.0.0` }], ...miss(MEMBRANE, ">=3", `${CM}@2.0.0`, "1.0.0") } },
    head: { [CM]: cm, [MEMBRANE]: { version: "3.0.0", host: "1.0.0", ranges: [{ range: ">=2", wantedBy: null }, { range: ">=3", wantedBy: `${CM}@2.0.0` }],
      ...miss(MEMBRANE, ">=2", null, "1.0.0") } } } });
});

test("R10: a candidate whose package.json gives no version stops as no-mover, and a range found while choosing that isn't plain stops as not-plain, naming it", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.32.0", ...deps({ [MEMBRANE]: "^0.8.0" }) } };
  expect(resolved(lock, { version: "0.8.0" }, {}, {}, MEMBRANE)).toEqual({ out: { stop: { arm: "head", package: MEMBRANE, range: "^0.8.0",
    wantedBy: `node_modules/${AF}`, has: null, why: "no-mover" } }, reads: [] });
  const bent = resolved({ [`node_modules/${MEMBRANE}`]: { version: "0.8.0" }, "node_modules/tagged": { version: "1.0.0", ...deps({ [MEMBRANE]: "latest" }) } },
    { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MEMBRANE]: "^0.9.0" }) }, { [MEMBRANE]: { "0.8.0": {}, "0.9.0": {} } }).out;
  expect(bent).toEqual({ stop: { arm: "head", package: MEMBRANE, range: "latest", wantedBy: "node_modules/tagged", has: "0.8.0", why: "not-plain" } });
});

test("R10: choices that don't settle stop, naming what the arm came back to", () => {
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "0.24.0" }, [`node_modules/${CHRONICLE}`]: { version: "0.5.0" } },
    { version: "0.33.0" }, { version: "0.33.0", ...deps({ [CM]: ">=0.25.0" }) },
    { [CM]: { "0.24.0": {}, "0.25.0": deps({ [CHRONICLE]: "0.6.0" }), "0.26.0": deps({ [CHRONICLE]: "0.7.0" }) },
      [CHRONICLE]: { "0.5.0": {}, "0.6.0": deps({ [CM]: "0.26.0" }), "0.7.0": deps({ [CM]: "0.25.0" }) } });
  expect(out).toEqual({ stop: { arm: "base", package: CHRONICLE, range: "0.6.0", wantedBy: `${CM}@0.25.0`, has: "0.7.0", why: "unsettled",
    tried: { [CHRONICLE]: "0.6.0", [CM]: "0.25.0" } } });
});

test("R10: a lockfile that meets every range, or a range that isn't plain, reads no release", () => {
  const lock = { [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${MEMBRANE}`]: { version: "0.8.0" } };
  const met = resolved(lock, { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) }, { version: "0.33.1", ...deps({ [CM]: "^0.25.0", [MEMBRANE]: "^0.8.0" }) }, {});
  expect(met).toEqual({ out: { stack: null }, reads: [] });
  const bent = resolved(lock, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MEMBRANE]: "github:antra-tess/membrane#v0.9.0" }) }, {});
  expect(bent).toEqual({ out: { stop: { arm: "head", package: MEMBRANE, range: "github:antra-tess/membrane#v0.9.0", wantedBy: null, has: "0.8.0", why: "not-plain" } }, reads: [] });
});

test("R9: a job's setup reads its repositories from a git base whose path holds a space", () => {
  mkdirSync(join(T, "g h"));
  sh(`ln -s ${join(T, "gh")} '${join(T, "g h", "gh")}'`);
  const { run, calls } = setupRun("agent-framework", "anima-research/agent-framework", { "package.json": JSON.stringify({ name: "@animalabs/agent-framework", version: "0.32.0" }) },
    false, undefined, { CONTEXT_VIEW_GIT_BASE: `file://${join(T, "g h", "gh")}` });
  expect(run.status).toBe(0);
  expect(calls).toHaveLength(2);
});
