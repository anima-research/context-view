import "./hermetic-git.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT, T, sh, git, repo, env, lines, cliAt, HOST_PKG, HOST_LOCK, mergedHost, viaMerge, reset, useWorld, runJob, at, deps } from "./fixtures.ts";

useWorld();

test("R19: a merged pull request's view runs its merge commit as the head, on the commit the merge was made onto as the base", () => {
  for (const shape of ["merge", "squash"] as const) {
    reset();
    const h = mergedHost(shape);
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
    const base = h.rev(`${h.M}^1`);
    expect([r.manifest.head, r.manifest.base, r.manifest.merge]).toEqual([h.M, { ref: "main", sha: base }, shape === "merge" ? { commit: h.M, k: 0, src: true } : { commit: h.M, k: 0, n: 2, src: true }]);
    expect(lines("gh.commits")).toHaveLength(shape === "merge" ? 0 : 1);
    expect(r.calls).toHaveLength(12);
    for (const a of r.calls) {
      expect(at(a, "--with")).toBe(`anima-research/connectome-host@${base}`);
      expect(at(a, "--setup")).toContain(`fetch -q '${`file://${join(T, "gh")}/anima-research/connectome-host`}' ${h.M} && `);
      expect(at(a, "--setup")).not.toContain("refs/pull/");
      expect(at(a, "--setup")).toContain(`rev-parse HEAD^{tree})" = ${h.tree} ]`);
    }
  }
});

test("R19: a rebase merge's base is the commit below its replayed commits, found by their patch-ids without context, though main changed a line beside one", () => {
  for (const [shape, n] of [["rebase", 3], ["rebase-near", 2]] as const) {
    reset();
    const h = mergedHost(shape);
    if (shape === "rebase-near") {
      expect(h.patchId(h.M, [])).not.toBe(h.patchId(h.commits[1]!, []));
      expect(h.patchId(h.M)).toBe(h.patchId(h.commits[1]!));
    }
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
    expect(r.manifest.base.sha).toBe(h.rev(`${h.M}~${n}`));
    expect(r.manifest.merge).toEqual({ commit: h.M, k: n, n, src: true });
  }
});

test("R19: an empty commit of the pull request's, which has no patch-id, isn't counted, so a squash of a change and an empty commit runs on the commit it was made onto", () => {
  const h = mergedHost("squash-empty");
  expect(h.commits).toHaveLength(2);
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.base.sha, r.manifest.merge]).toEqual([0, "ran", h.rev(`${h.M}^1`), { commit: h.M, k: 1, n: 1, src: true }]);
});

test("R19: the walk stops at the pull request's count of commits, so a change main made before it can't walk the base back", () => {
  const h = mergedHost("cap");
  expect(h.patchId(`${h.M}~2`)).toBe(h.patchId(h.commits[1]!));
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.base.sha, r.manifest.merge]).toEqual([0, "ran", h.rev(`${h.M}~2`), { commit: h.M, k: 2, n: 2, src: true }]);
});

test("R19: a merge below which only some of the pull request's commits are found runs nothing, saying the base can't be named", () => {
  const h = mergedHost("partial");
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: "only some of the pull request's commits were found below its merge, so the base it was made onto can't be named", k: 1, n: 3 });
  expect(r.manifest.merge).toEqual({ commit: h.M, k: 1, n: 3 });
});

test("R19: a squash whose whole change is one of its commits' own, a change beside another and that one's revert, runs on the commit it was made onto", () => {
  const undone = (d: string) => ({ "f.txt": `a\nb\nc\n${d}\ne\nf\ng\n` });
  const h = mergedHost("squash", {}, [{ "src/a.ts": "export const a = 1;\n" }, undone("D"), undone("d")]);
  expect(h.patchId(h.M)).toBe(h.patchId(h.commits[0]!));
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.base?.sha, r.manifest.merge]).toEqual([0, "ran", h.rev(`${h.M}^1`), { commit: h.M, k: 1, n: 3, src: true }]);
});

test("R19: a squash onto a branch that already had one of the pull request's commits, as a stacked pull request's, by a squash or by its own sha, runs nothing, saying the base can't be named", () => {
  for (const shape of ["stacked", "stacked-ff"] as const) {
    reset();
    const h = mergedHost(shape);
    expect([shape, h.patchId(h.M), h.patchId(`${h.M}~1`)]).toEqual([shape, h.patchId(h.commits[1]!), h.patchId(h.commits[0]!)]);
    expect([shape, h.rev(`${h.M}~1`) === h.commits[0]]).toEqual([shape, shape === "stacked-ff"]);
    const r = viaMerge(h.M);
    expect([shape, r.code, r.manifest.outcome, r.calls.length]).toEqual([shape, 2, "couldnt-run", 0]);
    expect(r.manifest.detail).toEqual({ why: "a commit the walk counted below the merge has one of the pull request's patches but was on the branch before it merged, so the base it was made onto can't be named", k: 2, n: 2 });
  }
});

test("R19: a rebase whose replays' patches changed, as on a file the branch renamed, isn't read as a squash: it runs nothing, saying the base can't be named", () => {
  const h = mergedHost("renamed");
  expect(h.patchId(h.M)).not.toBe(h.patchId(h.commits[1]!));
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: "none of the pull request's commits was found at its merge, and the merge's change isn't the pull request's whole change, so the base it was made onto can't be named", k: 0, n: 2 });
});

test("R19: a merge whose tree isn't the pull request's head merged onto the base named for it runs nothing, saying so without speaking of a walk", () => {
  const h = mergedHost("evil");
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({
    why: "the pull request's head merged onto the base named for its merge doesn't give the merge's tree, so the base it was made onto can't be named",
    k: 0, base: h.rev(`${h.M}^1`),
  });
});

test("R19: a merge commit's base is its first parent whatever the pull request's commits are, so none are listed, and one with more than GitHub lists runs", () => {
  const h = mergedHost("merge", { commits: 300 });
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.base.sha, r.manifest.merge]).toEqual([0, "ran", h.rev(`${h.M}^1`), { commit: h.M, k: 0, src: true }]);
  expect(lines("gh.commits")).toEqual([]);
});

test("R19: a pull request GitHub doesn't say merged at the commit given runs nothing, in GitHub's terms, and lists no commits", () => {
  const other = "e".repeat(40);
  for (const [pr, detail] of [
    [{ state: "open", merged_at: null }, { why: "GitHub doesn't say the pull request merged", state: "open" }],
    [{ state: "closed", merged_at: null }, { why: "GitHub doesn't say the pull request merged", state: "closed" }],
    [{ merge_commit_sha: other }, { why: "GitHub says the pull request merged at another commit", mergeCommit: other }],
  ] as const) {
    reset();
    const h = mergedHost("merge", pr);
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome, r.manifest.detail, r.manifest.head, r.calls.length]).toEqual([2, "couldnt-run", detail, h.M, 0]);
    expect(lines("gh.commits")).toEqual([]);
  }
});

test("R19: a pull request's commits are read page by page until GitHub has listed them all", () => {
  const h = mergedHost("many");
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.merge]).toEqual([0, "ran", { commit: h.M, k: 0, n: 101, src: true }]);
  expect(lines("gh.commits").map((l) => [/per_page=100\b/.test(l), l.match(/[?&]page=(\d+)/)?.[1]])).toEqual([[true, "1"], [true, "2"]]);
});

test("R19: commits GitHub lists fewer of than it counts runs nothing, saying the base can't be named; a list that isn't one fails the run", () => {
  const h = mergedHost("squash", { commits: 3 });
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: "GitHub doesn't list all of the pull request's commits, so the base its merge was made onto can't be named", listed: 2, commits: 3 });
  writeFileSync(join(T, "pr.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(T, "pr.json"), "utf8")), commits: 2 }));
  writeFileSync(join(T, "pr-commits.json"), JSON.stringify({ message: "Not Found" }));
  const bad = viaMerge(h.M);
  expect([bad.code, bad.manifest.outcome, bad.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(bad.manifest.detail.why).toStartWith("the run side failed before any job: ");
});

test("R19: a merge's view reads the pull request before its jobs and not after, so its being merged doesn't make it closed", () => {
  const h = mergedHost("squash");
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  expect(lines("gh.calls")).toHaveLength(2);
});

test("R19: --merged beside --head, neither, or a --merged that isn't a full commit is a usage error, with no manifest", () => {
  const h = mergedHost("merge");
  for (const args of [["--merged", h.M, "--head", h.M], [], ["--merged", h.M.slice(0, 12)]]) {
    const r = cliAt("connectome-host", 513, args);
    expect([r.code, r.manifest]).toEqual([2, null]);
    expect(r.stderr).toContain("usage: context-view-run");
  }
});

test("R19: a merge's job fetches the merge commit itself, not the pull request's ref, and merges it onto the base to the merge's tree", () => {
  const { setup, command, calls, baseTree, merged, setupText } = runJob({ form: "host", merge: true });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  expect(calls[0]!.trees).toEqual({ base: baseTree, head: merged });
  expect(setupText).not.toContain("refs/pull/");
});

test("R21: a merge into a branch other than its repository's default runs nothing, as elsewhere naming the branch, before listing or fetching anything", () => {
  const h = mergedHost("squash", { base: { ref: "release", repo: { default_branch: "main" } } });
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.detail, r.manifest.merge, r.calls.length]).toEqual([3, "elsewhere", { branch: "release" }, { commit: h.M }, 0]);
  expect(lines("gh.commits")).toEqual([]);
  expect(existsSync(join(T, "state", "mirrors"))).toBe(false);
  reset();
  const unsaid = mergedHost("squash", { base: { ref: "main" } });
  const u = viaMerge(unsaid.M);
  expect([u.code, u.manifest.outcome, u.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(u.manifest.detail.why).toStartWith("the run side failed before any job: ");
});

test("R21: a merge that changes no src/ file, no dependency map in package.json, and the root lockfile in nothing but the package's own version runs no job, as unchanged", () => {
  for (const own of [[{ "README.md": "docs" }], [{ "package.json": HOST_PKG("1.1.0"), "package-lock.json": HOST_LOCK("1.1.0") }], [{ "ui/package-lock.json": "{}" }]]) {
    reset();
    const h = mergedHost("merge", {}, own);
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome, r.manifest.detail, r.manifest.merge, r.manifest.base.sha, r.calls.length]).toEqual([3, "unchanged", null, { commit: h.M, k: 0 }, h.rev(`${h.M}^1`), 0]);
  }
});

test("R21: a dependency map or a package-lock.json whose keys a merge only reorders is unchanged", () => {
  const deps = (order: string[]) => Object.fromEntries(order.map((k) => [k, k === "x" ? "^1.0.0" : "^2.0.0"]));
  const lock = (keys: string[]) => {
    const l = JSON.parse(HOST_LOCK("1.0.0"));
    return JSON.stringify({ ...l, packages: Object.fromEntries(keys.map((k) => [k, l.packages[k]])) }, null, 2);
  };
  for (const [base, own] of [
    [{ "package.json": HOST_PKG("1.0.0", { dependencies: deps(["x", "y"]) }) }, { "package.json": HOST_PKG("1.0.0", { dependencies: deps(["y", "x"]) }) }],
    [{}, { "package-lock.json": lock(["node_modules/x", ""]) }],
  ] as const) {
    reset();
    const h = mergedHost("merge", {}, [own as Record<string, string>], base as Record<string, string>);
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([3, "unchanged", 0]);
  }
});

test("R21: a merge that changes a dependency, in any of package.json's four maps or the root lockfile, runs its view, marked as changing no src/ file; one that changes src/ is marked so", () => {
  for (const [own, src] of [
    [[{ "package.json": HOST_PKG("1.0.0", { dependencies: { x: "^1.2.0" } }) }], false],
    [[{ "package.json": HOST_PKG("1.0.0", { dependencies: { x: "^1.0.0" }, devDependencies: { y: "^2.0.0" } }) }], false],
    [[{ "package.json": HOST_PKG("1.0.0", { dependencies: { x: "^1.0.0" }, peerDependencies: { y: "^2.0.0" } }) }], false],
    [[{ "package.json": HOST_PKG("1.0.0", { dependencies: { x: "^1.0.0" }, optionalDependencies: { y: "^2.0.0" } }) }], false],
    [[{ "package-lock.json": HOST_LOCK("1.0.0", "1.0.1") }], false],
    [[{ "bun.lock": "{}\n" }], false],
    [[{ "src/a.ts": "export const a = 1;\n" }], true],
  ] as const) {
    reset();
    const h = mergedHost("merge", {}, own as unknown as Record<string, string>[]);
    const r = viaMerge(h.M);
    expect([r.code, r.manifest.outcome, r.manifest.merge, r.calls.length]).toEqual([0, "ran", { commit: h.M, k: 0, src }, 12]);
  }
});

test("R21: a merge that runs writes its src/ diff from the base it was made onto to merge.diff, and one that runs no job leaves none", () => {
  const h = mergedHost("rebase");
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome]).toEqual([0, "ran"]);
  const base = h.rev(`${h.M}~3`);
  expect(readFileSync(join(r.out, "merge.diff"), "utf8")).toBe(sh(`git -C ${join(T, "work", "anima-research/connectome-host")} diff --no-color --no-ext-diff --no-renames ${base} ${h.M} -- src/`) + "\n");
  reset();
  const docs = mergedHost("merge", {}, [{ "README.md": "docs" }]);
  mkdirSync(join(T, "out"), { recursive: true });
  writeFileSync(join(T, "out", "merge.diff"), "an earlier run's");
  const u = viaMerge(docs.M);
  expect([u.manifest.outcome, existsSync(join(u.out, "merge.diff"))]).toEqual(["unchanged", false]);
});

test("R21: a merge whose one change is a src/ file with a name git would quote runs its view, marked as changing src/", () => {
  const h = mergedHost("merge", {}, [{ "src/café.ts": "export const x = 1;\n" }]);
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.merge, r.calls.length]).toEqual([0, "ran", { commit: h.M, k: 0, src: true }, 12]);
});

test("R21: a merge that adds a root lockfile holding null runs its view, since a lockfile that's there isn't one that's absent", () => {
  const h = mergedHost("merge", {}, [{ "npm-shrinkwrap.json": "null\n" }]);
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.manifest.merge, r.calls.length]).toEqual([0, "ran", { commit: h.M, k: 0, src: false }, 12]);
});

test("R21: a merge whose merge.diff can't be written runs nothing, writing a couldnt-run manifest that says why", async () => {
  const h = mergedHost("rebase");
  const out = join(T, "out");
  const child = Bun.spawn(["bun", SCRIPT, "--repo", "connectome-host", "--pr", "513", "--merged", h.M, "--out", out], { env: env({}, { CV_GH_HOLD: "1" }), stdout: "pipe", stderr: "pipe" });
  for (let t = 0; t < 100 && lines("gh.calls").length < 1; t++) await Bun.sleep(100);
  mkdirSync(join(out, "merge.diff", "in-the-way"), { recursive: true });
  writeFileSync(join(T, "gh.release"), "");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  expect([m.outcome, m.shares, m.merge, existsSync(join(T, "on-gh.calls"))]).toEqual(["couldnt-run", [], { commit: h.M, k: 3, n: 3, src: true }, false]);
  expect(m.detail.why).toStartWith("the run side failed before any job: ");
});

test("R21: a merge whose package.json isn't JSON fails before any job, naming the side and not the revision, so every such merge says the same", () => {
  const h = mergedHost("merge", {}, [{ "package.json": "{ not json\n" }]);
  const r = viaMerge(h.M);
  expect([r.code, r.manifest.outcome, r.calls.length]).toEqual([2, "couldnt-run", 0]);
  expect(r.manifest.detail).toEqual({ why: "the run side failed before any job: the merge's package.json isn't JSON" });
});
