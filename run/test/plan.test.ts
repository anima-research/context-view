import "./hermetic-git.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Stack } from "../context-view-run.ts";
import { SCRIPT, T, sh, git, repo, CM, world, lines, cli, registry, AF, miss, fresh, MEMBRANE, CHRONICLE, useWorld, runJob, at, tagged, poolGone, dropped, deps, boot } from "./fixtures.ts";

useWorld();

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
      `npm pack '${MEMBRANE}@0.9.0' --registry '${reg.CONTEXT_VIEW_REGISTRY}/' --ignore-scripts --pack-destination "$M/packs-after" >/dev/null`]);
    const own = setup.indexOf('npm pack --ignore-scripts --pack-destination "$M/packs-after"');
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

test("R3: where no published release of the package that asks admits the head's version, the head runs with that range forced: the asker stays, every range so refused is named, and the job lays the candidate over them", () => {
  const w = world({ cmVersion: "0.27.0" });
  const reg = registry({ [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } } }, [CHRONICLE]: { "0.5.1": { peerDependencies: { [CM]: "^0.24.0 || ^0.25.0" } } } });
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([0, "ran", 12]);
  expect(r.manifest.stack).toBeUndefined();
  expect(r.manifest.forced).toEqual({ base: [], head: [
    { range: "^0.24.0 || ^0.25.0 || ^0.26.0", wantedBy: `node_modules/${AF}`, has: "0.27.0" },
    { range: "^0.24.0 || ^0.25.0", wantedBy: `node_modules/${CHRONICLE}`, has: "0.27.0" },
    { range: "^0.24.0", wantedBy: "node_modules/optional-user", has: "0.27.0" }] });
  for (const call of r.calls) expect(call[call.indexOf("--setup") + 1]!).toContain(`--reach-package "${CM}" --forced-package "${CM}"`);
});

test("R3: a range on the candidate from a package the view can't move is forced too, and reads no release", () => {
  const w = world({ cmVersion: "0.25.0" });
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.manifest.forced).toEqual({ base: [], head: [{ range: "^0.24.0", wantedBy: "node_modules/optional-user", has: "0.25.0" }] });
});

test("R3: so is a base version's, in both arms where the head keeps it, as context-manager #423's base is past agent-framework's range", () => {
  const w = world({ cmBaseVersion: "0.27.0" });
  const reg = registry({ [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } } }, [CHRONICLE]: { "0.5.1": { peerDependencies: { [CM]: "^0.24.0 || ^0.25.0" } } } });
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([0, "ran", 12]);
  const ranges = [
    { range: "^0.24.0 || ^0.25.0 || ^0.26.0", wantedBy: `node_modules/${AF}`, has: "0.27.0" },
    { range: "^0.24.0 || ^0.25.0", wantedBy: `node_modules/${CHRONICLE}`, has: "0.27.0" },
    { range: "^0.24.0", wantedBy: "node_modules/optional-user", has: "0.27.0" }];
  expect(r.manifest.forced).toEqual({ base: ranges, head: ranges });
  for (const call of r.calls) expect(call[call.indexOf("--setup") + 1]!).toContain(`--forced-package "${CM}"`);
});

test("R3: a view that forces nothing passes no forced package to its jobs and writes no forced field", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([0, "ran", 12]);
  expect("forced" in r.manifest).toBe(false);
  for (const call of r.calls) expect(call.join(" ")).not.toContain("--forced-package");
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
  const shards = r.calls.map((a) => at(a, "--setup")!.match(/--shard (\d+)\/12/)![1]).map(Number).sort((x, y) => x - y);
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

test("R1: a job whose fetched head isn't the one dispatched fails its setup and says which head it met", async () => {
  const { setup, main, ev, calls, M } = runJob({ pushAfterPlan: true });
  expect(setup.status).not.toBe(0);
  expect(readFileSync(join(ev, "head-moved"), "utf8").trim()).toBe(main);
  expect(await poolGone(M)).toBe(true);
  expect(calls).toHaveLength(0);
});

test("R4: a view that ran joins its shares' reads into DIR/reach.json: a line that ran in one share ran", () => {
  const w = world();
  const part = (run: string, ran: number[]) => ({ change: CM, writer: "w1", changed: { "src/a.ts": { lines: [1, 2], deletions: [] } }, onDisk: {},
    drives: { [run]: [{ boot: 1, read: true }] }, digests: [{ named: { "src/a.ts": { code: [1, 2], ran } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }] });
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { reach: part(`H1/W${k + 1}`, k === 2 ? [1] : []) }])));
  expect(r.manifest.outcome).toBe("ran");
  const reach = JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"));
  expect(reach.files["src/a.ts"]).toMatchObject({ ran: [1], notRan: [2], couldntTell: [] });
  expect(Object.keys(reach.drives)).toHaveLength(12);
  expect(reach.code.wrote).toEqual(["w1"]);
});

test("R4: a share that brought no reads home makes the view's unseen lines couldn't tell, naming it", () => {
  const w = world();
  const part = { change: CM, writer: "w1", changed: { "src/a.ts": { lines: [1, 2], deletions: [] } }, onDisk: {}, drives: { "H1/W1": [{ boot: 1, read: true }] },
    digests: [{ named: { "src/a.ts": { code: [1, 2], ran: [1] } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }] };
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, k === 6 ? {} : { reach: part }])));
  const reach = JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"));
  expect(reach.files["src/a.ts"]).toMatchObject({ ran: [1], notRan: [], couldntTell: [2] });
  expect(reach.notes).toEqual(["share 7 brought no reach home"]);
});

test("R4: a share whose reach files were dropped for on-gh's bounds, or couldn't be copied home, says so", () => {
  const w = world();
  const part = { change: CM, writer: "w1", changed: { "src/a.ts": { lines: [1, 2], deletions: [] } }, onDisk: {}, drives: { "H1/W1": [{ boot: 1, read: true }] },
    digests: [{ named: { "src/a.ts": { code: [1, 2], ran: [1] } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }] };
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, k === 4 ? { reachDropped: true } : k === 5 ? { reachUncopied: true } : { reach: part }])));
  const reach = JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"));
  expect(reach.files["src/a.ts"]).toMatchObject({ ran: [1], couldntTell: [2] });
  expect(reach.notes).toEqual(["share 5's reach files were dropped to keep its evidence within on-gh's bounds", "share 6's reach files couldn't be copied home"]);
});

test("R4: a reach.json that can't be written is said, and leaves the run to write its manifest", () => {
  const { writeReach } = require(SCRIPT) as typeof import("../context-view-run.ts");
  const out = mkdtempSync(join(tmpdir(), "cv-reach-"));
  try {
    mkdirSync(join(out, "reach.json"));
    expect(writeReach(out)).toBe(false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("R4: a share whose diff failed makes the view's unseen lines couldn't tell, with git's words", () => {
  const w = world();
  const part = { change: CM, writer: "w1", changed: { "src/a.ts": { lines: [1, 2], deletions: [] } }, onDisk: {}, drives: { "H1/W1": [{ boot: 1, read: true }] },
    digests: [{ named: { "src/a.ts": { code: [1, 2], ran: [1] } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }] };
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, k === 2 ? { reachDiffErr: "fatal: bad object\n" } : { reach: part }])));
  expect(r.manifest.outcome).toBe("ran");
  const reach = JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"));
  expect(reach.files["src/a.ts"]).toMatchObject({ ran: [1], couldntTell: [2] });
  expect(reach.notes).toEqual(["share 3 couldn't make the change's diff, so its head arm ran without reach: fatal: bad object"]);
});

test("R4: shares' reads that can't be joined make the view's reach.json couldnt, and the run still writes its manifest", () => {
  const w = world();
  const part = { change: CM, changed: { "src/a.ts": { lines: [1], deletions: [] } }, onDisk: {}, drives: {}, digests: "not a list" };
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { reach: part }])));
  expect(r.manifest.outcome).toBe("ran");
  expect(JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8")).couldnt).toMatch(/^the shares' reach couldn't be joined: /);
});

test("R4: a run removes an earlier run's reach.json, so a view that didn't run reads none", () => {
  const w = world({ prState: "closed" });
  mkdirSync(join(T, "out"), { recursive: true });
  writeFileSync(join(T, "out", "reach.json"), "{}");
  const r = cli("context-manager", 417, w.pr.head);
  expect(r.manifest.outcome).toBe("closed");
  expect(existsSync(join(r.out, "reach.json"))).toBe(false);
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
  expect(Object.keys(r.manifest)).toEqual(["repo", "number", "head", "form", "base", "host", "harness", "seconds", "outcome", "detail", "shares"]);
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

test("R12: the head's merged source comes from a blobless clone, checked against the tree the plan merged", () => {
  const { setup, M } = runJob({ allowFilter: true });
  expect(setup.status).toBe(0);
  expect(sh(`git -C ${join(M, "cand-after")} config remote.origin.partialclonefilter`)).toBe("blob:none");
});

test("R16: every share plans from the base-arm seconds the newest whole view kept in its manifest, and the manifest says what it planned from", () => {
  const w = world();
  const views = join(T, "state", "views");
  const older = { runs: { "H1/W1": 1 }, checkpoints: { "H1/W2": 2 } }, newer = { runs: { "H1/W1": 5 }, checkpoints: { "H1/W2": 6 } };
  const kept = (d: string, m: unknown, at: number) => {
    mkdirSync(join(views, d), { recursive: true });
    writeFileSync(join(views, d, "manifest.json"), typeof m === "string" ? m : JSON.stringify({ outcome: "ran", seconds: { planned: null, ...(m ? { measured: m } : {}) } }));
    utimesSync(join(views, d, "manifest.json"), at, at);
  };
  kept("a", older, 1000); kept("b", newer, 2000); kept("c", null, 3000); kept("d", "{not json", 4000);
  const r = cli("context-manager", 417, w.pr.head);
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.manifest.seconds.planned).toEqual(newer);
  for (const call of r.calls) {
    const setup = call[call.indexOf("--setup") + 1]!;
    expect(setup).toContain(`--seconds "$M/seconds.json"`);
    expect(setup).toContain(`cat > "$M/seconds.json" <<'CONTEXT_VIEW_SECONDS' || exit 1\n${JSON.stringify(newer)}\nCONTEXT_VIEW_SECONDS`);
  }
});

test("R16: with no whole view to plan from, the shares plan from stack.json's seconds alone, and the manifest says so", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head);
  expect(r.manifest.seconds).toEqual({ planned: null });
  for (const call of r.calls) expect(call[call.indexOf("--setup") + 1]).not.toContain("--seconds");
});

test("R16: a view whose every share brought its base arm home keeps each run's base seconds and each checkpoint's longest build in its manifest", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, { CV_SECONDS: "1" });
  expect(r.manifest.seconds.measured).toEqual({
    runs: Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`R${k + 1}`, k + 1])), checkpoints: { C: 12 } });
  fresh();
  const w2 = world();
  const partial = cli("context-manager", 417, w2.pr.head, { 4: { noSeconds: true } }, { CV_SECONDS: "1" });
  expect(partial.manifest.seconds).toEqual({ planned: null });
});

test("R1: a read after the jobs that fails leaves what the jobs saw, and says so", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, {}, { CV_GH_FAIL_AT: "2" });
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(r.stderr).toContain("the read after the jobs failed, so what the jobs saw stands: gh api");
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

test("R10: in membrane's shape the package that asks moves, to a release whose own range admits each arm's version and not a prerelease, as no range is on it, or, where none is found, stays, with the range forced in each arm", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.32.0", ...deps({ [MEMBRANE]: "^0.8.0" }) } };
  const docs = (more: Record<string, Record<string, unknown>>) => ({ [AF]: { "0.32.0": deps({ [MEMBRANE]: "^0.8.0" }), "0.33.0": deps({ [MEMBRANE]: "^0.10.0" }), ...more } });
  const rc = { "0.33.1-rc.0": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) };
  const { out } = resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({ ...rc, "0.34.0": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) }), MEMBRANE);
  const chosen = (has: string) => ({ [AF]: { version: "0.34.0", host: "0.32.0", ranges: [], asks: "^0.8.0 || ^0.9.0", ...miss(MEMBRANE, "^0.8.0", `node_modules/${AF}`, has) } });
  expect(out).toEqual({ stack: { base: chosen("0.9.0"), head: chosen("0.9.1") } });
  const build = resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({ ...rc, "0.33.2+build-1": deps({ [MEMBRANE]: "^0.8.0 || ^0.9.0" }) }), MEMBRANE).out as { stack: Stack };
  expect([build.stack.base[AF]!.version, build.stack.head[AF]!.version]).toEqual(["0.33.2+build-1", "0.33.2+build-1"]);
  const forced = { stack: null, forced: { base: [{ range: "^0.8.0", wantedBy: `node_modules/${AF}`, has: "0.9.0" }], head: [{ range: "^0.8.0", wantedBy: `node_modules/${AF}`, has: "0.9.1" }] } };
  expect(resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs(rc), MEMBRANE).out).toEqual(forced);
  expect(resolved(lock, { version: "0.9.0" }, { version: "0.9.1" }, docs({}), MEMBRANE).out).toEqual(forced);
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

test("R10: an unmet range on an @animalabs package the plan doesn't move stops as no-mover, whether the arm or a chosen release asks it; one on the candidate's own, from a lockfile entry outside the four or a nested copy of one of them, is forced; and a package the lockfile gives no version isn't checked", () => {
  const MCPL = "@animalabs/mcpl-core";
  const own = resolved({ [`node_modules/${MCPL}`]: { version: "0.4.0" } }, { version: "0.33.0" }, { version: "0.33.0", ...deps({ [MCPL]: "^0.5.0" }) }, {});
  expect(own).toEqual({ out: { stop: { arm: "head", package: MCPL, range: "^0.5.0", wantedBy: null, has: "0.4.0", why: "no-mover" } }, reads: [] });
  const release = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${MCPL}`]: { version: "0.4.0" } }, { version: "0.33.0" },
    { version: "0.33.0", ...deps({ [CM]: "^0.26.0" }) }, { [CM]: { "0.25.0": {}, "0.26.0": deps({ [MCPL]: "^0.5.0" }) } }).out;
  expect(release).toEqual({ stop: { arm: "base", package: MCPL, range: "^0.5.0", wantedBy: `${CM}@0.26.0`, has: "0.4.0", why: "no-mover" } });
  const asker = resolved({ [`node_modules/${MCPL}`]: { version: "0.4.0", ...deps({ [AF]: "^0.32.0" }) } }, { version: "0.32.0" }, { version: "0.33.0" }, {});
  expect(asker).toEqual({ out: { stack: null, forced: { base: [], head: [{ range: "^0.32.0", wantedBy: `node_modules/${MCPL}`, has: "0.33.0" }] } }, reads: [] });
  const nested = `node_modules/${CHRONICLE}/node_modules/${MEMBRANE}`;
  const copy = resolved({ [`node_modules/${CHRONICLE}`]: { version: "0.6.0" }, [nested]: { version: "0.8.0", ...deps({ [AF]: "^0.32.0" }) } }, { version: "0.32.0" }, { version: "0.33.0" }, {});
  expect(copy).toEqual({ out: { stack: null, forced: { base: [], head: [{ range: "^0.32.0", wantedBy: nested, has: "0.33.0" }] } }, reads: [] });
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

test("R10: context-manager #423's shape: both arms' context-manager past every published agent-framework's range runs with that range forced in both, agent-framework kept at the lockfile's", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) } };
  const docs = { [AF]: { "0.32.0": deps({ [CM]: "^0.24.0" }), "0.33.0": deps({ [CM]: "^0.25.0" }) } };
  const ask = (has: string) => ({ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has });
  expect(resolved(lock, { version: "0.26.0" }, { version: "0.26.0" }, docs, CM)).toEqual({ out: { stack: null, forced: { base: [ask("0.26.0")], head: [ask("0.26.0")] } }, reads: [AF] });
  expect(resolved(lock, { version: "0.25.1" }, { version: "0.26.0" }, docs, CM).out).toEqual({ stack: null, forced: { base: [], head: [ask("0.26.0")] } });
});

test("R10: a release that admits the candidate is still preferred to forcing it, in the arm that has one", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) } };
  const docs = { [AF]: { "0.33.0": deps({ [CM]: "^0.25.0" }), "0.34.0": deps({ [CM]: "^0.26.0" }) } };
  const { out } = resolved(lock, { version: "0.26.0" }, { version: "0.27.0" }, docs, CM);
  expect(out).toEqual({ stack: { base: { [AF]: { version: "0.34.0", host: "0.33.0", ranges: [], asks: "^0.26.0", ...miss(CM, "^0.25.0", `node_modules/${AF}`, "0.26.0") } }, head: {} },
    forced: { base: [], head: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.27.0" }] } });
});

test("R10: a companion that has to move, whose only releases meeting its ranges don't admit the candidate, takes the nearest, and its range on the candidate is forced", () => {
  const { out, reads } = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" } }, { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) }, { version: "0.33.0", ...deps({ [CM]: "^0.26.0" }) },
    { [CM]: { "0.25.0": {}, "0.26.0": { peerDependencies: { [AF]: "^0.34.0" } }, "0.26.1": { peerDependencies: { [AF]: "^0.34.0" } } } });
  expect(out).toEqual({ stack: { base: {}, head: { [CM]: { version: "0.26.0", host: "0.25.0", ranges: [{ range: "^0.26.0", wantedBy: null }], asks: "^0.34.0",
    ...miss(CM, "^0.26.0", null, "0.25.0") } } }, forced: { base: [], head: [{ range: "^0.34.0", wantedBy: `${CM}@0.26.0`, has: "0.33.0" }] } });
  expect(reads).toEqual([CM]);
});

test("R10: a range forced on a companion's release that later moves again is no longer named; the release it moved to names its own", () => {
  const ask = { dependencies: { [AF]: "^0.34.0" }, peerDependencies: { [CHRONICLE]: "^0.7.0" } };
  const { out } = resolved({ [`node_modules/${CM}`]: { version: "0.25.0" }, [`node_modules/${CHRONICLE}`]: { version: "0.6.0" } },
    { version: "0.33.0" }, { version: "0.33.0", ...deps({ [CM]: ">=0.26.0" }) },
    { [CM]: { "0.25.0": {}, "0.26.0": ask, "0.26.2": ask }, [CHRONICLE]: { "0.6.0": {}, "0.7.0": deps({ [CM]: ">=0.26.2" }) } });
  const o = out as { stack: Stack; forced: { base: unknown[]; head: unknown[] } };
  expect([o.stack.head[CM]!.version, o.stack.head[CHRONICLE]!.version, o.stack.base[CM]!.version]).toEqual(["0.26.2", "0.7.0", "0.26.2"]);
  const now = [{ range: "^0.34.0", wantedBy: `${CM}@0.26.2`, has: "0.33.0" }];
  expect(o.forced).toEqual({ base: now, head: now });
});

test("R10: a range forced while another package's lockfile release kept its asker from moving is decided again once that package moves, so the asker moves to a release that admits the candidate rather than staying forced", () => {
  const lock = { [`node_modules/${AF}`]: { version: "1.0.0", ...deps({ [CM]: "^0.9.0" }) }, [`node_modules/${CHRONICLE}`]: { version: "1.0.0", ...deps({ [CM]: "^0.9.0", [AF]: "^1.0.0" }) } };
  const docs = { [AF]: { "1.0.0": deps({ [CM]: "^0.9.0" }), "2.0.0": deps({ [CM]: "^1.0.0" }) }, [CHRONICLE]: { "1.0.0": deps({ [CM]: "^0.9.0", [AF]: "^1.0.0" }), "2.0.0": {} } };
  const { out } = resolved(lock, { version: "1.0.0" }, { version: "1.0.0" }, docs, CM);
  expect("forced" in (out as object)).toBe(false);
  const stack = (out as { stack: Stack }).stack;
  expect([stack.base[AF]?.version, stack.base[CHRONICLE]?.version, stack.head[AF]?.version, stack.head[CHRONICLE]?.version]).toEqual(["2.0.0", "2.0.0", "2.0.0", "2.0.0"]);
});

test("R10: the arm that has a release admitting the candidate moves to it and the other forces, whichever arm that is", () => {
  const lock = { [`node_modules/${AF}`]: { version: "0.33.0", ...deps({ [CM]: "^0.25.0" }) } };
  const docs = { [AF]: { "0.33.0": deps({ [CM]: "^0.25.0" }), "0.34.0": deps({ [CM]: "^0.26.0" }) } };
  const { out } = resolved(lock, { version: "0.27.0" }, { version: "0.26.0" }, docs, CM);
  expect(out).toEqual({ stack: { base: {}, head: { [AF]: { version: "0.34.0", host: "0.33.0", ranges: [], asks: "^0.26.0", ...miss(CM, "^0.25.0", `node_modules/${AF}`, "0.26.0") } } },
    forced: { base: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.27.0" }], head: [] } });
});

test("R10: a range forced in one arm alone is decided again once a move in that arm frees its asker, and the other arm, which met its ranges, forces nothing", () => {
  const lock = { [`node_modules/${AF}`]: { version: "1.0.0", ...deps({ [CM]: "^0.9.0" }) }, [`node_modules/${CHRONICLE}`]: { version: "1.0.0", ...deps({ [CM]: "^0.9.0", [AF]: "^1.0.0" }) } };
  const docs = { [AF]: { "1.0.0": deps({ [CM]: "^0.9.0" }), "2.0.0": deps({ [CM]: "^1.0.0" }) }, [CHRONICLE]: { "1.0.0": deps({ [CM]: "^0.9.0", [AF]: "^1.0.0" }), "2.0.0": {} } };
  const { out } = resolved(lock, { version: "0.9.5" }, { version: "1.0.0" }, docs, CM);
  expect("forced" in (out as object)).toBe(false);
  const stack = (out as { stack: Stack }).stack;
  expect(stack.base[AF]).toBeUndefined();
  expect([stack.head[AF]?.version, stack.head[CHRONICLE]?.version]).toEqual(["2.0.0", "2.0.0"]);
});
