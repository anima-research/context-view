import "./hermetic-git.ts";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT, T, repo, world, env, lines, cancelled, cli, useWorld, at } from "./fixtures.ts";

useWorld();

test("R6: a share whose setup, on-gh or harness failed, or whose evidence didn't come home, makes it couldnt-run", () => {
  for (const [sc, why] of [
    [{ setup: 1 }, /setup exited 1/],
    [{ evidence: "not uploaded: 69136 KB is over 50 MB" }, /^its evidence was past on-gh's bounds, so it wasn't uploaded$/],
    [{ harnessFailed: "a drive died by SIGKILL" }, /^the harness failed, in its failed\.json's words, which the head's code could have written: `a drive died by SIGKILL`$/],
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

test("R8: a stop passes to every on-gh still following its run, and the manifest says it was stopped, after how long, and which jobs", async () => {
  const w = world();
  const began = performance.now();
  const child = await hanging(w.pr.head);
  const up = performance.now();
  await Bun.sleep(3500);
  const killed = (performance.now() - up) / 1000;
  child.kill("SIGTERM");
  expect(await child.exited).toBe(2);
  const whole = (performance.now() - began) / 1000;
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.outcome).toBe("couldnt-run");
  expect(m.detail.why).toMatch(/^stopped by SIGTERM after \d+ s$/);
  stoppedAs(m, "SIGTERM");
  expect(m.detail.stopped.seconds).toBeGreaterThanOrEqual(Math.floor(killed));
  expect(m.detail.stopped.seconds).toBeLessThanOrEqual(Math.ceil(whole));
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

function stoppedAs(m: { detail: { why: string; stopped?: unknown } }, signal: string) {
  expect(m.detail.stopped).toEqual({ signal, seconds: Number(/after (\d+) s$/.exec(m.detail.why)![1]) });
}

test("R18: a share whose harness failed is the run's failure, naming why as its failed.json's words, quoted as data", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { harnessFailed: "the head arm's drive of H1/W1 died by SIGKILL" } });
  expect([r.code, r.manifest.outcome]).toEqual([2, "couldnt-run"]);
  expect(r.manifest.detail).toEqual({ share: 6,
    why: "the harness failed, in its failed.json's words, which the head's code could have written: `the head arm's drive of H1/W1 died by SIGKILL`" });
});

test("R18: a failed.json's why, which the head's code can write, comes as one line of at most 500 characters in a code span nothing in it can close", () => {
  const w = world();
  const said = "`` @someone **done**\nsee [this](https://example.invalid) " + "x".repeat(2000);
  const r = cli("context-manager", 417, w.pr.head, { 6: { harnessFailed: said } });
  const shown = [...said.replace("\n", " ")].slice(0, 500).join("");
  expect(r.manifest.detail.why).toBe(`the harness failed, in its failed.json's words, which the head's code could have written: \`\`\` ${shown} \`\`\`, its first 500 of ${said.length} characters`);
});

test("R18: a failed.json's why of spaces and control characters alone comes as a code span holding exactly what it shows", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { harnessFailed: "\t \n" } });
  expect(r.manifest.detail.why).toBe("the harness failed, in its failed.json's words, which the head's code could have written: `   `");
});

test("R6: what a receipt says of its evidence reaches the why only as the run side's own words", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 5: { evidence: "not uploaded: @someone **see https://example.invalid** KB is over 50 MB" } });
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

test("R8: SIGINT stops it as SIGTERM does", async () => {
  const w = world();
  const child = await hanging(w.pr.head);
  child.kill("SIGINT");
  expect(await child.exited).toBe(2);
  const m = JSON.parse(readFileSync(join(T, "out", "manifest.json"), "utf8"));
  expect(m.detail.why).toMatch(/^stopped by SIGINT after \d+ s$/);
  stoppedAs(m, "SIGINT");
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
  stoppedAs(m, "SIGTERM");
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
  stoppedAs(m, "SIGTERM");
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
  stoppedAs(m, "SIGTERM");
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

const killedAfterNaming = (out: string) => readdirSync(out).filter((d) => d.startsWith("share-")).map((d) => join(out, d))
  .filter((d) => existsSync(join(d, "on-gh.stop")) && existsSync(join(d, "on-gh.id")) && readFileSync(join(d, "on-gh.exit"), "utf8") === "143")
  .map((d) => readFileSync(join(d, "on-gh.id"), "utf8"));

test("R6: an on-gh that ended not knowing its run's state is asked to cancel it before anything else is written", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { exit: 255, logDir: true } });
  expect([r.code, r.manifest.outcome, r.manifest.detail.share]).toEqual([2, "couldnt-run", 6]);
  expect(r.manifest.detail.why).toMatch(/^the run side failed on it: EISDIR/);
  const [first, ...rest] = lines("on-gh.stops");
  expect(first).toBe("20261105T010000Z-00000006");
  const killed = killedAfterNaming(r.out);
  expect(rest.filter((id) => !killed.includes(id))).toEqual([]);
});

test("R6: a share the failure's teardown killed after it named its run is asked to cancel that run", () => {
  const w = world();
  const r = cli("context-manager", 417, w.pr.head, { 6: { exit: 255, logDir: true, afterNamed: 9 }, 9: { holdAfterId: true } }, {}, 20_000);
  expect([r.code, r.manifest?.outcome, r.manifest?.detail.share]).toEqual([2, "couldnt-run", 6]);
  expect(killedAfterNaming(r.out)).toContain("20261105T010000Z-00000009");
  expect(lines("on-gh.stops")).toContain("20261105T010000Z-00000009");
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
  stoppedAs(m, "SIGTERM");
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
