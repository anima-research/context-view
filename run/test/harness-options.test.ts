import "./hermetic-git.ts";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plan, declaredOptions, job, undeclared } from "../context-view-run.ts";
import { AF, CHRONICLE, CM, OPTIONS, SCRIPT, T, cli, env, git, lines, mergedHost, registry, sh, useWorld, viaMerge, world } from "./fixtures.ts";

useWorld();

const forcing = () => registry({ [AF]: { "0.32.0": { dependencies: { [CM]: "^0.24.0 || ^0.25.0 || ^0.26.0" } } }, [CHRONICLE]: { "0.5.1": { peerDependencies: { [CM]: "^0.24.0 || ^0.25.0" } } } });
const declaring = (edit: (o: { valued: string[]; flags: string[] }) => object) => JSON.stringify(edit(JSON.parse(OPTIONS)));
const without = (name: string) => declaring((o) => ({ ...o, valued: o.valued.filter((n) => n !== name) }));

test("a forced view on a harness whose options.json doesn't declare --forced-package runs nothing, naming why it forces, the release or branch, and the fix", () => {
  const w = world({ cmVersion: "0.27.0", harnessOptions: without("forced-package") });
  const reg = forcing();
  const r = cli("context-manager", 417, w.pr.head, {}, reg);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail.why).toBe(`the plan lays ${CM} over a range in the head's stack that refuses it, and the harness release, ${w.harness.main}, doesn't declare --forced-package, so no job could run it: install one that does with run/install-harness.ts`);
  expect([r.manifest.forced !== undefined, r.manifest.base?.sha, r.manifest.harness?.sha]).toEqual([true, expect.any(String), w.harness.main]);
  git(join(T, "work", "anima-research/context-view"), `push -q ${join(T, "gh", "anima-research/context-view.git")} main:old`);
  const b = cli("context-manager", 417, w.pr.head, {}, { ...reg, CONTEXT_VIEW_HARNESS_REF: "old" });
  expect([b.code, b.calls.length, b.manifest.detail.why]).toEqual([2, 0, `the plan lays ${CM} over a range in the head's stack that refuses it, and the harness at the tip of old, ${w.harness.main}, doesn't declare --forced-package, so no job could run it: the branch old that CONTEXT_VIEW_HARNESS_REF names needs a harness that does`]);
});

test("a harness with no options.json runs a view that sends only what the run side sent unchecked before, and refuses a forced one", () => {
  const w = world({ harnessOptions: null });
  const r = cli("context-manager", 417, w.pr.head, {}, registry());
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([0, "ran", 12]);
  rmSync(join(T, "on-gh.calls"), { force: true });
  for (const f of ["out", "gh", "work", "reg"]) rmSync(join(T, f), { recursive: true, force: true });
  const f = world({ cmVersion: "0.27.0", harnessOptions: null });
  const forced = cli("context-manager", 417, f.pr.head, {}, forcing());
  expect([forced.code, forced.calls.length, forced.manifest.detail.why]).toEqual([2, 0, `the plan lays ${CM} over a range in the head's stack that refuses it, and the harness release, ${f.harness.main}, doesn't declare --forced-package, so no job could run it: install one that does with run/install-harness.ts`]);
});

test("an options.json the run side can't read as two lists of names, with none in both, runs nothing, as a failure before any job; a key it doesn't know is ignored", () => {
  const cases: [string, RegExp][] = [
    ["{", /the run side failed before any job: the harness's options.json at [0-9a-f]{40} isn't JSON/],
    [declaring((o) => ({ valued: o.valued })), /the run side failed before any job: the harness's options.json at [0-9a-f]{40} isn't \{"valued": \[names\], "flags": \[names\]\}/],
    [declaring((o) => ({ ...o, flags: [...o.flags, 3] })), /isn't \{"valued": \[names\], "flags": \[names\]\}/],
    [declaring((o) => ({ ...o, flags: [...o.flags, "out"] })), /declares out as both valued and a flag/],
    [declaring((o) => ({ ...o, flags: [...o.flags, "pair"] })), /names pair twice in flags/],
  ];
  for (const [text, why] of cases) {
    for (const f of ["out", "gh", "work"]) rmSync(join(T, f), { recursive: true, force: true });
    rmSync(join(T, "on-gh.calls"), { force: true });
    const w = world({ harnessOptions: text });
    const r = cli("context-manager", 417, w.pr.head, {}, registry());
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
    expect(r.manifest.detail.why).toMatch(why);
  }
  for (const f of ["out", "gh", "work"]) rmSync(join(T, f), { recursive: true, force: true });
  const w = world({ harnessOptions: declaring((o) => ({ ...o, version: 2 })) });
  expect(cli("context-manager", 417, w.pr.head, {}, registry()).manifest.outcome).toBe("ran");
});

test("declaredOptions tells a commit without options.json from a read that fails, and reads neither as the other", () => {
  const dir = mkdtempSync(join(tmpdir(), "declared-"));
  try {
    sh(`git init -q ${dir} && git -C ${dir} -c user.name=t -c user.email=t@t commit -q --allow-empty -m none`);
    const none = sh(`git -C ${dir} rev-parse HEAD`);
    const old = declaredOptions(dir, none);
    expect("why" in old).toBe(false);
    expect([(old as { valued: string[] }).valued.includes("host"), (old as { valued: string[] }).valued.includes("forced-package")]).toEqual([true, false]);
    expect(declaredOptions(dir, "0".repeat(40))).toEqual({ why: expect.stringMatching(/^couldn't tell what the harness at 0{40} declares: git ls-tree exited 128/) });
    expect(declaredOptions(join(dir, "missing"), none)).toEqual({ why: expect.stringMatching(/^couldn't tell what the harness at [0-9a-f]{40} declares/) });
    sh(`mkdir -p ${dir}/harness && echo '{"valued": [], "flags": []}' > ${dir}/harness/options.json && git -C ${dir} add -A && git -C ${dir} -c user.name=t -c user.email=t@t commit -q -m o`);
    const listed = sh(`git -C ${dir} rev-parse HEAD`), blob = sh(`git -C ${dir} rev-parse HEAD:harness/options.json`);
    expect(declaredOptions(dir, listed)).toEqual({ valued: [], flags: [] });
    unlinkSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    expect(declaredOptions(dir, listed)).toEqual({ why: expect.stringMatching(/^couldn't read the harness's options.json at [0-9a-f]{40}: git show exited 128/) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an option the view sends as a flag, or gives a value, is refused where the harness declares it as the other kind", () => {
  const options = { valued: ["out", "pair"], flags: ["self-check"] };
  expect(undeclared([{ name: "pair" }], options, "s")).toBe("the view sends --pair, and the harness release, s, declares --pair as taking a value, and the view sends it as a flag, so no job could run it: install one that declares --pair as a flag with run/install-harness.ts");
  expect(undeclared([{ name: "self-check", value: "x", why: "the view checks itself" }], options, "s")).toBe("the view checks itself, and the harness release, s, declares --self-check as a flag, and the view gives it a value, so no job could run it: install one that declares --self-check as taking a value with run/install-harness.ts");
  expect(undeclared([{ name: "out", value: "o" }, { name: "self-check" }], options, "s")).toBe(null);
});

test("a share's job passes the harness the same command as before the options were declared, for each shape of plan", () => {
  const plan = (repo: string, forced: boolean): Plan => ({
    repo, number: 7, head: "a".repeat(40), form: repo === "connectome-host" ? "host" : "overlay", base: { ref: "main", sha: "b".repeat(40) },
    host: { sha: "c".repeat(40) }, harness: { repo: "anima-research/context-view", sha: "d".repeat(40) }, merged: "e".repeat(40),
    ...(forced ? { forced: { base: [], head: [{ range: "^0.24.0", wantedBy: "node_modules/optional-user", has: "0.27.0" }] } } : {}),
  } as Plan);
  const seconds = { runs: { R: 1 }, checkpoints: {} };
  const fixed = `--ready "$M/ready" --checkpoints "$M/cp" --workdir "$M/work" --out "$M/out"`;
  const shapes: [Plan, number, typeof seconds | null, string][] = [
    [plan("connectome-host", false), 1, null, `node harness/run.ts --pair --host ../connectome-host --host-head ../connectome-head ${fixed} --shard 1/12 --drives 3 --width 3 --self-check --reach "$M/reach.diff"`],
    [plan("context-manager", false), 5, seconds, `node harness/run.ts --pair --host ../connectome-host ${fixed} --shard 5/12 --drives 3 --width 3 --seconds "$M/seconds.json" --self-check --reach "$M/reach.diff" --reach-package "${CM}"`],
    [plan("context-manager", true), 12, null, `node harness/run.ts --pair --host ../connectome-host ${fixed} --shard 12/12 --drives 3 --width 3 --self-check --reach "$M/reach.diff" --reach-package "${CM}" --forced-package "${CM}"`],
  ];
  for (const [p, i, s, command] of shapes) expect(job(p, i, s).setup).toContain(`bash -c '${command} > "$M/pair.log"`);
});

test("a host view whose harness doesn't declare --host-head, and any view whose harness declares --pair as taking a value, run nothing, each naming what it sends", () => {
  const w = world({ hostPR: true, harnessOptions: without("host-head") });
  const r = cli("connectome-host", 513, w.pr.head);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail.why).toBe(`the view drives the head's own checkout of the host, and the harness release, ${w.harness.main}, doesn't declare --host-head, so no job could run it: install one that does with run/install-harness.ts`);
  for (const f of ["out", "gh", "work"]) rmSync(join(T, f), { recursive: true, force: true });
  const v = world({ harnessOptions: declaring((o) => ({ valued: [...o.valued, "pair"], flags: o.flags.filter((n) => n !== "pair") })) });
  const k = cli("context-manager", 417, v.pr.head, {}, registry());
  expect([k.code, k.calls.length, k.manifest.detail.why]).toEqual([2, 0, `the view sends --pair, and the harness release, ${v.harness.main}, declares --pair as taking a value, and the view sends it as a flag, so no job could run it: install one that declares --pair as a flag with run/install-harness.ts`]);
});

test("a branch's tip the mirror lacks is fetched and read, not the release on main", () => {
  const w = world({ cmVersion: "0.27.0" });
  const work = join(T, "work", "anima-research/context-view");
  writeFileSync(join(work, "harness", "options.json"), without("forced-package"));
  git(work, "commit -q -am trial");
  const trial = git(work, "rev-parse HEAD");
  git(work, `push -q ${join(T, "gh", "anima-research/context-view.git")} HEAD:refs/heads/trial`);
  const r = cli("context-manager", 417, w.pr.head, {}, { ...forcing(), CONTEXT_VIEW_HARNESS_REF: "trial" });
  expect([r.code, r.calls.length, r.manifest.harness?.sha]).toEqual([2, 0, trial]);
  expect(r.manifest.detail.why).toBe(`the plan lays ${CM} over a range in the head's stack that refuses it, and the harness at the tip of trial, ${trial}, doesn't declare --forced-package, so no job could run it: the branch trial that CONTEXT_VIEW_HARNESS_REF names needs a harness that does`);
  rmSync(join(T, "out"), { recursive: true, force: true });
  const main = cli("context-manager", 417, w.pr.head, {}, forcing());
  expect([main.code, main.manifest.outcome, main.calls.length]).toEqual([0, "ran", 12]);
});

test("a merged view refused for an option its harness doesn't declare writes no merge.diff, where one that runs would", () => {
  const h = mergedHost("rebase");
  const work = join(T, "work", "anima-research/context-view");
  sh(`mkdir -p ${work}/harness`);
  writeFileSync(join(work, "harness", "options.json"), without("host-head"));
  git(work, "add -A"); git(work, "commit -q -m declared");
  git(work, `push -q ${join(T, "gh", "anima-research/context-view.git")} HEAD:main`);
  writeFileSync(join(T, "state", "harness"), `${git(work, "rev-parse HEAD")}\n`);
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail.why).toMatch(/doesn't declare --host-head/);
  expect(existsSync(join(r.out, "merge.diff"))).toBe(false);
});

test("a stop while the run side reads what the harness declares is the stopped run, with no job started", async () => {
  const w = world();
  const real = sh("command -v git");
  writeFileSync(join(T, "bin", "git"), `#!/bin/bash\nif [[ " $* " == *" ls-tree "* ]]; then touch "${T}/git.held"; until [ -f "${T}/git.release" ]; do sleep 0.05; done; fi\nexec ${real} "$@"\n`);
  chmodSync(join(T, "bin", "git"), 0o755);
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "context-manager", "--pr", "417", "--head", w.pr.head, "--out", join(T, "out")], { env: env({}, registry()), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 200 && !existsSync(join(T, "git.held")); t++) await Bun.sleep(50);
  expect(existsSync(join(T, "git.held"))).toBe(true);
  child.kill("SIGTERM");
  writeFileSync(join(T, "git.release"), "");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect([m.outcome, m.detail.shares, m.harness?.sha, m.detail.stopped?.signal]).toEqual(["couldnt-run", [], w.harness.main, "SIGTERM"]);
  expect(lines("on-gh.calls")).toHaveLength(0);
});
