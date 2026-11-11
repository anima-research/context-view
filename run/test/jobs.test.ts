import "./hermetic-git.ts";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCRIPT, T, sh, git, repo, CM, world, env, lines, cli, registry, AF, MEMBRANE, useWorld, runJob, at, tagged, gone, poolGone, dropped, boot } from "./fixtures.ts";

useWorld();

test("R5: a host pull request runs as itself, its head checkout merged in the setup beside the base's, with no packs", () => {
  const w = world({ hostPR: true });
  const r = cli("connectome-host", 513, w.pr.head);
  expect([r.code, r.manifest.outcome, r.manifest.form]).toEqual([0, "ran", "host"]);
  const setup = r.calls[0]![r.calls[0]!.indexOf("--setup") + 1]!;
  expect(setup).toContain(`refs/pull/513/head`);
  expect(setup).toContain("--host-head ../connectome-head");
  expect(setup).not.toContain("packs-");
  expect(r.calls[0]![r.calls[0]!.indexOf("--with") + 1]).toBe(`anima-research/connectome-host@${w.host.main}`);
});

async function survivors(tag: string) {
  for (let t = 0; t < 200; t++) { if (!tagged(tag).length) return []; await Bun.sleep(50); }
  const left = tagged(tag);
  for (const p of left) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
  return left;
}

const memory = () => readFileSync("/proc/meminfo", "utf8").split("\n").filter((l) => /^(MemTotal|SwapTotal):/.test(l))
  .reduce((k, l) => k + Number(l.split(/\s+/)[1]) * 1024, 0);

const freshJob = () => {
  for (const f of ["job", "job-bin", "gh", "work", "pool.pid", "setsid.pid", "setsid.go", "harness.calls", "sudo.calls", "npm.calls", "npm.times"]) rmSync(join(T, f), { recursive: true, force: true });
  for (const f of readdirSync(T).filter((f) => f.startsWith("started-"))) rmSync(join(T, f), { force: true });
};

test("R9: a candidate that commits no lockfile installs its head arm from the lockfile its base arm's install wrote", () => {
  const { setup, npm } = runJob({ form: "agent-framework", files: { "package.json": JSON.stringify({ name: "@animalabs/agent-framework", version: "0.32.0" }) } });
  expect(setup.status).toBe(0);
  expect(npm).toEqual(["install in cand-before from no lockfile", `install in cand-after from {"written-by": "cand-before"}`]);
});

test("R9: a candidate that commits its lockfile installs each arm from its own", () => {
  const { setup, npm } = runJob({ files: { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": `{"committed": true}` } });
  expect(setup.status).toBe(0);
  expect(npm).toEqual([`ci in cand-before from {"committed": true}`, `ci in cand-after from {"committed": true}`]);
});

test("R11: the setup mounts a tmpfs above the runner's memory and swap, with no inode limit, and the share's pool and its hosts write there", () => {
  const { setup, command, sudo, calls, M } = runJob();
  expect([setup.status, command?.status]).toEqual([0, 0]);
  expect(sudo).toHaveLength(1);
  const mount = /^mount -t tmpfs -o size=(\d+),nr_inodes=0,mode=1777 tmpfs (\S+)$/.exec(sudo[0]!);
  expect(mount?.[2]).toBe(M);
  expect(Number(mount?.[1])).toBeGreaterThan(memory());
  const [call] = calls;
  for (const k of ["--ready", "--checkpoints", "--workdir", "--out"]) expect(at(call!.args, k)!.startsWith(`${M}/`)).toBe(true);
  expect(call!.home).toBe(join(M, "home"));
  expect(call!.tmp).toBe(join(M, "tmp"));
});

test("R11: a share whose work directory isn't on a tmpfs larger than memory and swap doesn't start, and says why", () => {
  for (const fs of [{ CV_FS_TYPE: "ext2/ext3" }, { CV_FS_BLOCKS: "1024" }] as Record<string, string>[]) {
    freshJob();
    const { setup, calls, M } = runJob({ env: fs });
    expect(setup.status).not.toBe(0);
    expect(setup.stderr).toMatch(/is .* bytes, not a tmpfs larger than memory plus swap \(\d+ bytes\), so the share won't start/);
    expect(existsSync(join(M, "pair.pid"))).toBe(false);
    expect(existsSync(join(T, "pool.pid"))).toBe(false);
    expect(calls).toHaveLength(0);
  }
});

test("R11: a mount that fails fails the setup, and no pool starts", () => {
  const { setup, calls, M } = runJob({ env: { CV_SUDO_FAIL: "1" } });
  expect(setup.status).not.toBe(0);
  expect(existsSync(join(M, "pair.pid"))).toBe(false);
  expect(existsSync(join(T, "pool.pid"))).toBe(false);
  expect(calls).toHaveLength(0);
});

test("R7: a job's one harness call drives both arms of its share three at once, each arm's packs read once its ready file is there, keeping records, prices and views but not logs", () => {
  const { setup, command, ev, calls, M } = runJob();
  expect([setup.status, command?.status]).toEqual([0, 0]);
  expect(calls).toHaveLength(1);
  const { args, ready } = calls[0]!;
  expect(args.slice(0, 2)).toEqual(["--pair", "--host"]);
  expect([at(args, "--host"), at(args, "--ready"), at(args, "--shard"), at(args, "--width")]).toEqual(["../connectome-host", join(M, "ready"), "7/12", "3"]);
  expect(args).toContain("--self-check");
  expect(args).not.toContain("--host-head");
  expect(ready).toEqual({ base: `${join(M, "packs-before", "own.tgz")}\n`, head: `${join(M, "packs-after", "own.tgz")}\n` });
  for (const arm of ["before", "after"]) {
    expect(readFileSync(join(ev, `rc-${arm}`), "utf8").trim()).toBe("0");
    expect(existsSync(join(ev, arm, "run.json"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "H1_W1.record"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "view.md"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "prices.json"))).toBe(true);
    expect(existsSync(join(ev, arm, "H1_W1", "log.jsonl"))).toBe(false);
  }
  expect(existsSync(join(ev, "after", "entries.json"))).toBe(true);
  expect(existsSync(join(ev, "pair.log"))).toBe(true);
});

test("R7: the share balances by the three drives the job spends on each run: the base arm's, the head arm's and its self-check's", () => {
  const { calls } = runJob();
  expect(at(calls[0]!.args, "--drives")).toBe("3");
  expect(calls[0]!.args).toContain("--self-check");
});

test("R7: the pool's one code is each arm's, and a harness failure's why comes home in failed.json", () => {
  const { command, ev } = runJob({ pool: { failed: "the head arm's drive of H1/W1 died by SIGKILL" } });
  expect(command?.status).toBe(0);
  for (const arm of ["before", "after"]) expect(readFileSync(join(ev, `rc-${arm}`), "utf8").trim()).toBe("2");
  expect(JSON.parse(readFileSync(join(ev, "failed.json"), "utf8"))).toEqual({ why: "the head arm's drive of H1/W1 died by SIGKILL" });
});

test("R7: a pool that dies without writing its code leaves both arms unfinished, and the command doesn't wait for it", () => {
  const p = { repo: "context-manager", number: 9, head: "a".repeat(40), form: "overlay", base: { ref: "main", sha: "b".repeat(40) },
    host: { sha: "c".repeat(40) }, harness: { repo: "x", sha: "d".repeat(40) }, merged: "e".repeat(40) };
  const { command } = JSON.parse(spawnSync("bun", ["-e", `import { job } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(job(${JSON.stringify(p)}, 1)))`],
    { encoding: "utf8", env: env() }).stdout) as { command: string };
  const dir = join(T, "dead"), top = join(dir, "smoke"), ev = join(dir, "evidence"), M = join(dir, "m");
  mkdirSync(top, { recursive: true }); mkdirSync(ev, { recursive: true }); mkdirSync(M, { recursive: true });
  const dead = spawnSync("bash", ["-c", "sh -c 'echo $$' & wait"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(M, "pair.pid"), dead);
  writeFileSync(join(M, "pair.rc.tmp"), "");
  const r = spawnSync("bash", ["-c", command], { cwd: top, encoding: "utf8", env: { ...env(), ON_GH_EVIDENCE_DIR: ev }, timeout: 30_000 });
  expect(r.status).toBe(0);
  for (const arm of ["before", "after"]) expect(readFileSync(join(ev, `rc-${arm}`), "utf8").trim()).toBe("255");
});

test("R7: the tables the pool writes to its step summary show in the command's step, where the pool ends, not the setup's", () => {
  const { command, summaries } = runJob();
  expect(command?.status).toBe(0);
  expect(readFileSync(summaries.command, "utf8")).toBe("the pool's tables\n");
  expect(existsSync(summaries.setup)).toBe(false);
});

test("R7: a host job's head arm reads which source lines of the change ran, from the diff of the base's src against the merged head's", () => {
  const { setup, command, ev, calls } = runJob({ form: "host", headFiles: { "b.txt": "b", "src/b.ts": "export const b = 1;\n" } });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  const { args, reach, reachErr } = calls[0]!;
  expect(args).toContain("--self-check");
  expect(reach).toContain("+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export const b = 1;");
  expect(reach).not.toContain("b.txt");
  expect(reachErr).toBeNull();
  expect(args).not.toContain("--reach-package");
  expect(existsSync(join(ev, "reach-diff.err"))).toBe(false);
});

test("R7: a head whose diff fails still runs, its setup writing git's words where the diff would be, and the job brings them home", () => {
  const { setup, command, ev, calls } = runJob({ form: "host", headFiles: { "b.txt": "b", "src/b.ts": "export const b = 1;\n" }, diffFails: true });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.reach).toBeNull();
  expect(calls[0]!.reachErr).toContain("fatal: a diff that fails");
  expect(readFileSync(join(ev, "reach-diff.err"), "utf8")).toContain("fatal: a diff that fails");
});

test("R7: an overlay job's head arm reads its candidate's src diff, and its reach.json and reach-digests.json come home", () => {
  const { setup, command, ev, calls } = runJob({ headFiles: { "x.ts": "two\n", "src/y.ts": "export const y = 1;\n" }, pool: { reach: true } });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  const { args, reach } = calls[0]!;
  expect(reach).toContain("+++ b/src/y.ts\n@@ -0,0 +1 @@\n+export const y = 1;\n");
  expect(reach).not.toContain("x.ts");
  expect(at(args, "--reach-package")).toBe(CM);
  expect(existsSync(join(ev, "before", "reach.json"))).toBe(false);
  expect(existsSync(join(ev, "after", "reach.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(ev, "after", "reach-digests.json"), "utf8")).harness).toBe(true);
});

test("R7: evidence still past on-gh's bounds once its views are dropped drops the reach files too, so the records come home", () => {
  const { command, ev } = runJob({ headFiles: { "src/y.ts": "export const y = 1;\n" }, pool: { reach: true, reachBytes: 52 * 1024 * 1024 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(true);
  expect(existsSync(join(ev, "after", "reach-digests.json"))).toBe(false);
  expect(existsSync(join(ev, "after", "reach.json"))).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "H1_W1.record"))).toBe(true);
  expect(Number(readFileSync(join(ev, "kb"), "utf8").split(" ")[0])).toBeLessThanOrEqual(51200);
  expect(existsSync(join(ev, "reach-dropped"))).toBe(true);
});

test("R7: a reach file that can't be copied home costs that share's reach, not the job, and says so", () => {
  const { command, ev } = runJob({ headFiles: { "src/y.ts": "export const y = 1;\n" }, pool: { reach: true }, blockReach: true });
  expect(command?.status).toBe(0);
  expect(existsSync(join(ev, "after", "H1_W1", "H1_W1.record"))).toBe(true);
  expect(existsSync(join(ev, "after", "reach-digests.json"))).toBe(false);
  expect(readFileSync(join(ev, "reach-uncopied"), "utf8")).toBe("reach-digests.json\n");
});

test("R7: evidence that fits once its views are dropped keeps its reach files", () => {
  const { ev } = runJob({ headFiles: { "src/y.ts": "export const y = 1;\n" }, pool: { reach: true, viewBytes: 26 * 1024 * 1024 } });
  expect(dropped(ev)).toBe(true);
  expect(existsSync(join(ev, "after", "reach-digests.json"))).toBe(true);
  expect(existsSync(join(ev, "after", "reach.json"))).toBe(true);
  expect(existsSync(join(ev, "reach-dropped"))).toBe(false);
});

test("R7: evidence that would pass on-gh's 50 MiB drops its views, and says so", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 26 * 1024 * 1024 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(true);
  expect(existsSync(join(ev, "after", "H1_W1", "view.md"))).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "H1_W1.record"))).toBe(true);
  expect(Number(readFileSync(join(ev, "kb"), "utf8").split(" ")[0])).toBeLessThanOrEqual(51200);
});

test("R7: the evidence is measured as on-gh measures it, in bytes rather than blocks", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 60 * 1024 * 1024, sparse: true } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(true);
});

test("R7: the paths are counted with the job's own kb in them, as on-gh counts them", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 1, records: 4944 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(true);
  expect(existsSync(join(ev, "after", "H1_W1", "prices.json"))).toBe(false);
  expect(Number(spawnSync("bash", ["-c", `find -L ${ev} -mindepth 1 | wc -l`], { encoding: "utf8" }).stdout.trim())).toBe(9899);
});

test("R7: evidence past on-gh's bounds drops its prices.json files first, which the view doesn't read, and keeps its views when that's enough", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 1, records: 4943 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "prices.json"))).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "view.md"))).toBe(true);
  expect(Number(spawnSync("bash", ["-c", `find -L ${ev} -mindepth 1 | wc -l`], { encoding: "utf8" }).stdout.trim())).toBe(9899);
});

test("R7: evidence past on-gh's 9,900 files and directories drops its views too", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 10, records: 5000 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(true);
});

test("R7: evidence under on-gh's 50 MiB keeps its views", () => {
  const { command, ev } = runJob({ pool: { viewBytes: 24 * 1024 * 1024 } });
  expect(command?.status).toBe(0);
  expect(dropped(ev)).toBe(false);
  expect(existsSync(join(ev, "after", "H1_W1", "view.md"))).toBe(true);
});

test("R5: a host job drives its base arm on the base checkout and its head arm on a head checkout the setup merged beside it", () => {
  const { setup, command, calls, merged, baseTree, npm } = runJob({ form: "host", headFiles: { "b.txt": "b" } });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  expect(calls).toHaveLength(1);
  const { args, ready, trees } = calls[0]!;
  expect([at(args, "--host"), at(args, "--host-head")]).toEqual(["../connectome-host", "../connectome-head"]);
  expect(trees).toEqual({ base: baseTree, head: merged });
  expect(ready).toEqual({ base: "", head: "" });
  expect(npm.sort()).toEqual(["ci in connectome-head from {}", "ci in connectome-host from {}"]);
});

test("R5: a host job's base and head checkouts sit at paths of one length, so a path a host sees can't tell the arms apart", () => {
  const { setup, calls } = runJob({ form: "host", headFiles: { "b.txt": "b" } });
  expect(setup.status).toBe(0);
  const top = join(T, "job", "smoke");
  const [base, head] = [at(calls[0]!.args, "--host")!, at(calls[0]!.args, "--host-head")!].map((d) => resolve(top, d));
  expect(base).not.toBe(head);
  expect(head.length).toBe(base.length);
});

test("R5: a host job whose merge doesn't give the tree planned fails its setup, and the pool it started stops", async () => {
  const { setup, calls, M } = runJob({ form: "host", headFiles: { "b.txt": "b" }, merged: "e".repeat(40) });
  expect(setup.status).not.toBe(0);
  expect(await poolGone(M)).toBe(true);
  expect(calls).toHaveLength(0);
});

test("R5: so does a host job whose base can't be fetched, though the pull request's head can", async () => {
  const { setup, calls, M } = runJob({ form: "host", headFiles: { "b.txt": "b" }, base: "1".repeat(40) });
  expect(setup.status).not.toBe(0);
  expect(await poolGone(M)).toBe(true);
  expect(calls).toHaveLength(0);
});

test("R7: a candidate whose pack doesn't appear fails its setup, and the pool it started stops", async () => {
  const { setup, calls, M } = runJob({ env: { CV_NO_PACK: "cand-before" } });
  expect(setup.status).not.toBe(0);
  expect(await poolGone(M)).toBe(true);
  expect(calls).toHaveLength(0);
});

test("R7: a setup a signal ends, as a cancel's does, stops the pool it started", async () => {
  const { setup, M } = runJob({ term: true, env: { CV_BUILD_SLEEP: "5" } });
  expect(setup.status).toBe(143);
  expect(await poolGone(M)).toBe(true);
});

test("R7: a setup that fails before setsid has made the pool's group stops the pool all the same", async () => {
  const { setup, tag } = runJob({ form: "host", headFiles: { "b.txt": "b" }, base: "1".repeat(40), slowSetsid: true });
  expect(setup.status).not.toBe(0);
  expect(existsSync(join(T, "setsid.pid"))).toBe(true);
  expect(await gone(join(T, "setsid.pid"))).toBe(true);
  writeFileSync(join(T, "setsid.go"), "");
  expect(await survivors(tag)).toEqual([]);
  expect(existsSync(join(T, "pool.pid"))).toBe(false);
});

test("R7: a setup that fails the instant after launching its pool leaves no pool, a thousand times over", async () => {
  const p = { repo: "context-manager", number: 9, head: "a".repeat(40), form: "overlay", base: { ref: "main", sha: "b".repeat(40) },
    host: { sha: "c".repeat(40) }, harness: { repo: "x", sha: "d".repeat(40) }, merged: "e".repeat(40) };
  const { setup } = JSON.parse(spawnSync("bun", ["-e", `import { job } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(job(${JSON.stringify(p)}, 1)))`],
    { encoding: "utf8", env: env() }).stdout) as { setup: string };
  const lines = setup.split("\n");
  const launch = lines.find((l) => l.includes("setsid bash -c"))!;
  const top = join(T, "race", "smoke"), bin = join(T, "race", "bin");
  mkdirSync(top, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "#!/bin/bash\nexec -a node sleep 60\n"); chmodSync(join(bin, "node"), 0o755);
  const shimmed = { ...env(), PATH: `${bin}:${env().PATH}` };
  const script = [lines[0], lines[1], `mkdir -p "$M" || exit 1`, launch, `exit 1`].join("\n");
  const control = crypto.randomUUID();
  spawnSync("bash", ["-c", [lines[0], lines[1], `mkdir -p "$M" || exit 1`, launch, "built=1", "exit 1"].join("\n")], { cwd: top, encoding: "utf8", env: { ...shimmed, CV_TAG: control }, timeout: 10_000 });
  const pool = () => tagged(control).filter((p) => { try { return /(^|\/)node$/.test(readFileSync(`/proc/${p}/cmdline`, "latin1").split("\0")[0]!); } catch { return false; } });
  for (let t = 0; t < 200 && !pool().length; t++) await Bun.sleep(50);
  const found = pool();
  for (const p of tagged(control)) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
  expect(found).toHaveLength(1);
  const tag = crypto.randomUUID();
  for (let batch = 1; batch <= 10; batch++) {
    const looped = spawnSync("bash", ["-c", `for i in $(seq 1 100); do bash -c "$CV_SCRIPT"; done; echo "ran $i"`], { cwd: top, encoding: "utf8", env: { ...shimmed, CV_SCRIPT: script, CV_TAG: tag }, timeout: 60_000 });
    expect([batch, looped.error?.message, looped.signal, looped.stdout.trim()]).toEqual([batch, undefined, null, "ran 100"]);
    expect([batch, await survivors(tag)]).toEqual([batch, []]);
  }
});

test("R7: a pool whose wrapper dies alone is stopped by the command, which calls both arms unfinished", async () => {
  const { setup, command, ev } = runJob({ pool: { hold: 5000 }, killWrapper: true });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  for (const arm of ["before", "after"]) expect(readFileSync(join(ev, `rc-${arm}`), "utf8").trim()).toBe("255");
  expect(await gone(join(T, "pool.pid"))).toBe(true);
});

test("R7: a setup that can't write the pool's pid or its seconds fails, and leaves no pool running", async () => {
  for (const [plant, seconds] of [["pair.pid", null], ["seconds.json", { runs: { "H1/W1": 3 }, checkpoints: {} }]] as const) {
    freshJob();
    const { setup, calls, tag } = runJob({ plant: [plant], seconds });
    expect(setup.status).not.toBe(0);
    expect(await survivors(tag)).toEqual([]);
    expect(await gone(join(T, "pool.pid"))).toBe(true);
    expect(calls).toHaveLength(0);
  }
});

test("R7: a run directory keeps its files and the links to them, and leaves out dotfiles, broken and looping links, and links to directories", () => {
  const { command, ev } = runJob({ pool: { odd: true } });
  expect(command?.status).toBe(0);
  for (const arm of ["before", "after"]) {
    expect(readdirSync(join(ev, arm, "H1_W1")).sort()).toEqual(["H1_W1.record", "l.record", "prices.json", "view.md"]);
    expect(lstatSync(join(ev, arm, "H1_W1", "l.record")).isFile()).toBe(true);
    expect(readFileSync(join(ev, arm, "H1_W1", "l.record"), "utf8")).toBe("r");
  }
});

test("R7: evidence that can't all be kept makes the command exit 1", () => {
  const { command, ev } = runJob({ pool: { unreadable: true } });
  expect(command?.status).toBe(1);
  expect(existsSync(join(ev, "after", "run.json"))).toBe(true);
});

test("R7: a run directory that can't be read makes the command exit 1, since its evidence can't be kept", () => {
  const { command, calls } = runJob({ pool: { unreadableDir: true } });
  chmodSync(join(at(calls[0]!.args, "--out"), "after", "H1_W1"), 0o755);
  expect(command?.status).toBe(1);
});

test("R9: a candidate that commits its lockfile installs its head arm from the head's own", () => {
  const { setup, npm } = runJob({ files: { "package.json": JSON.stringify({ name: CM, version: "0.24.1" }), "package-lock.json": `{"committed": "base"}` },
    headFiles: { "package-lock.json": `{"committed": "head"}` } });
  expect(setup.status).toBe(0);
  expect(npm).toEqual([`ci in cand-before from {"committed": "base"}`, `ci in cand-after from {"committed": "head"}`]);
});

test("R7: an arm with releases the plan chose lays each over the host beside the candidate's pack, ready only once all are packed", () => {
  const stack = { base: { [AF]: { version: "0.33.0", host: "0.32.0", ranges: [] } },
    head: { [AF]: { version: "0.33.0", host: "0.32.0", ranges: [] }, [MEMBRANE]: { version: "0.9.0", host: "0.8.0", ranges: [] } } };
  const { setup, command, calls, M, setupText } = runJob({ stack: stack as never });
  expect([setup.status, command?.status]).toEqual([0, 0]);
  const list = (s: string) => s.trim().split(",").sort();
  expect(list(calls[0]!.ready.base)).toEqual([join(M, "packs-before", "animalabs-agent-framework-0.33.0.tgz"), join(M, "packs-before", "own.tgz")]);
  expect(list(calls[0]!.ready.head)).toEqual([join(M, "packs-after", "animalabs-agent-framework-0.33.0.tgz"), join(M, "packs-after", "animalabs-membrane-0.9.0.tgz"),
    join(M, "packs-after", "own.tgz")]);
  const npm = "--registry 'https://registry.npmjs.org/' --ignore-scripts";
  expect(setupText.match(/npm pack '[^']*'[^&]*/g)!.map((s) => s.trim())).toEqual([`npm pack '${AF}@0.33.0' ${npm} --pack-destination "$M/packs-before" >/dev/null`,
    `npm pack '${AF}@0.33.0' ${npm} --pack-destination "$M/packs-after" >/dev/null`,
    `npm pack '${MEMBRANE}@0.9.0' ${npm} --pack-destination "$M/packs-after" >/dev/null`]);
});

test("R9: a job's setup reads its repositories from a git base whose path holds a space", () => {
  mkdirSync(join(T, "g h"));
  sh(`ln -s ${join(T, "gh")} '${join(T, "g h", "gh")}'`);
  const { setup, npm } = runJob({ form: "agent-framework", files: { "package.json": JSON.stringify({ name: "@animalabs/agent-framework", version: "0.32.0" }) },
    env: { CONTEXT_VIEW_GIT_BASE: `file://${join(T, "g h", "gh")}` } });
  expect(setup.status).toBe(0);
  expect(npm).toHaveLength(2);
});

test("R13: the base arm's build runs beside the head arm's install, each waiting in the stub until the other has started", () => {
  const { setup } = runJob({ form: "agent-framework", files: { "package.json": JSON.stringify({ name: "@animalabs/agent-framework", version: "0.32.0" }) }, env: { CV_MEET: "1" } });
  expect(setup.stderr).not.toMatch(/waited 10 s/);
  expect(setup.status).toBe(0);
  const t = Object.fromEntries(lines("npm.times").map((l) => { const [what, here, ms] = l.split(" "); return [`${what} ${here}`, Number(ms)]; }));
  expect(t["install-start cand-after"]).toBeLessThan(t["build-end cand-before"]!);
  expect(t["build-start cand-before"]).toBeLessThan(t["install-end cand-after"]!);
});

test("R17: each share's on-gh polls its run every 2 s", () => {
  const w = world();
  cli("context-manager", 417, w.pr.head);
  expect(lines("on-gh.poll")).toEqual(Array.from({ length: 12 }, () => "2000"));
});

const varying = {
  H4b_W1: { "H4b_W1.record": "the recording drive's record\n", "report.txt": "H4b/W1: varies\n", "view.md": "what changed\n",
    "self-check/recording-on-r3.json": '{"max_tokens":4096}', "self-check/recording-off-r3.json": '{"max_tokens":8192}' },
  H2_W7: { "H2_W7.record": "a steady run's record\n", "report.txt": "H2/W7: same\n" },
};

test("R22: a varying run's directory is kept in the view's varied/, through the post's clear of the shares and the next view into the same directory", () => {
  const w = world();
  const first = cli("context-manager", 417, w.pr.head, { 2: { runs: varying } });
  expect([first.code, first.manifest.outcome]).toEqual([0, "ran"]);
  expect(readFileSync(join(first.out, "share-2", "after", "H4b_W1", "self-check", "recording-on-r3.json"), "utf8")).toBe('{"max_tokens":4096}');
  for (const f of readdirSync(first.out)) if (f.startsWith("share-")) rmSync(join(first.out, f), { recursive: true });
  const second = cli("context-manager", 417, w.pr.head);
  expect([second.code, second.manifest.outcome]).toEqual([0, "ran"]);
  const views = readdirSync(join(second.out, "varied"));
  expect(views).toHaveLength(1);
  expect(views[0]).toMatch(/^\d{8}T\d{6}Z$/);
  expect(readdirSync(join(second.out, "varied", views[0]))).toEqual(["H4b_W1"]);
  const kept = join(second.out, "varied", views[0], "H4b_W1");
  for (const [f, text] of Object.entries(varying.H4b_W1)) expect(readFileSync(join(kept, f), "utf8")).toBe(text);
  expect(readdirSync(kept).sort()).toEqual(["H4b_W1.record", "report.txt", "self-check", "view.md"]);
});

test("R22: a varying run's directory that can't be kept fails its share", () => {
  const w = world();
  mkdirSync(join(T, "out"), { recursive: true });
  writeFileSync(join(T, "out", "varied"), "in the way");
  const r = cli("context-manager", 417, w.pr.head, { 2: { runs: varying } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail.share).toBe(2);
  expect(r.manifest.detail.why).toStartWith("the run side failed on it: ");
});

const reachDigest = (ran: number[]) => ({ named: { "src/a.ts": { code: [1, 2], ran } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} });

const reachPart = (drives: Record<string, unknown[]>, digests: unknown[]) =>
  ({ change: CM, writer: "w1", changed: { "src/a.ts": { lines: [1, 2], deletions: [] } }, onDisk: {}, drives, digests });

test("R20: reach.json names, for each changed line that ran, the drives that ran it, by each share's drives in order and each drive's boots", () => {
  const w = world();
  const scenario: Record<number, unknown> = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { reach: reachPart({ [`H1/W${k + 1}`]: [boot(1)] }, [reachDigest([])]) }]));
  scenario[3] = { reach: reachPart({ "H1/W3": [boot(1), boot(2)], "H2/W3": [boot(1)] },
    [reachDigest([1]), reachDigest([2]), reachDigest([1]), { named: {}, notes: ["H3/W3 had no profiled drive, since it couldn't run"], fallbacks: [], maplessBuilt: [], unprofiled: {}, noDrive: true }]) };
  scenario[5] = { reach: reachPart({ "H1/W5": [boot(1)] }, [reachDigest([1])]) };
  const r = cli("context-manager", 417, w.pr.head, scenario);
  expect(r.manifest.outcome).toBe("ran");
  const reach = JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"));
  expect(reach.files["src/a.ts"].ran).toEqual([1, 2]);
  expect(reach.ranBy).toEqual({ "src/a.ts": { 1: ["H1/W3", "H1/W5", "H2/W3"], 2: ["H1/W3"] } });
});

test("R20: a share whose digests outnumber its drives' boots makes the view's reach couldnt, since which drive ran a line can't be told", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, Object.fromEntries(Array.from({ length: 12 }, (_, k) => [k + 1, { reach: reachPart({ [`H1/W${k + 1}`]: [boot(1)] }, [reachDigest([1]), reachDigest([])]) }])));
  expect(r.manifest.outcome).toBe("ran");
  expect(JSON.parse(readFileSync(join(r.out, "reach.json"), "utf8"))).toEqual({ couldnt: "the shares' reach couldn't be joined: a share brought 2 digests of its 1 boot, so which drive ran a line can't be told" });
});
