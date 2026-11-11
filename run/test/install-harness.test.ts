import "./hermetic-git.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../install-harness.ts");
let T: string, main: string, branch: string;
const sh = (cmd: string) => {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), "cv-harness-"));
  const work = join(T, "work"), bare = join(T, "gh", "anima-research", "context-view");
  sh(`git init -q -b main ${work} && cd ${work} && echo a > a && git add -A && git -c user.name=t -c user.email=t@t commit -q -m a`);
  sh(`cd ${work} && git checkout -q -b side && echo b > b && git add -A && git -c user.name=t -c user.email=t@t commit -q -m b && git checkout -q main`);
  mkdirSync(join(T, "gh", "anima-research"), { recursive: true });
  sh(`git clone -q --bare ${work} ${bare}`);
  main = sh(`git -C ${bare} rev-parse main`);
  branch = sh(`git -C ${bare} rev-parse side`);
  writeFileSync(join(T, "release-gate"), `#!/usr/bin/env python3\nimport os, signal, sys\nt = os.environ["CV_T"]\nopen(os.path.join(t, "gate.calls"), "a").write(" ".join(sys.argv[1:]) + "\\n")\nopen(os.path.join(t, "gate.saw"), "w").write(open(os.path.join(t, "state", "harness")).read())\nprint("gate: " + " ".join(sys.argv[1:]))\nif os.environ.get("GATE_EXIT") == "kill": os.kill(os.getpid(), signal.SIGKILL)\nif os.environ.get("GATE_EXIT") == "flood": sys.stderr.write("gate: on stderr\\n"); sys.stderr.flush(); sys.stdout.write("x" * 4_000_000); sys.exit(0)\nif os.environ.get("GATE_EXIT", "").startswith("loud"): sys.stdout.write("x" * 900_000); sys.stderr.write("y" * 300_000); sys.exit(int(os.environ["GATE_EXIT"][4:]))\nif os.environ.get("GATE_EXIT", "").startswith("past"): signal.signal(signal.SIGTERM, signal.SIG_IGN); sys.stderr.write("gate: on stderr\\n"); sys.stderr.flush(); sys.stdout.write("x" * 1_048_577); sys.stdout.flush(); sys.exit(int(os.environ["GATE_EXIT"][4:]))\nsys.exit(int(os.environ.get("GATE_EXIT", "0")))\n`, { mode: 0o755 });
  mkdirSync(join(T, "state"));
  writeFileSync(join(T, "state", "harness"), `${"a".repeat(40)}\n`);
});
afterEach(() => rmSync(T, { recursive: true, force: true }));

const lines = (stream: string) => stream.split("\n").filter((line) => line !== "");
const overflowed = expect.stringMatching(/^install-harness: none of the gate's output is shown, since it passed what spawnSync keeps: .*ENOBUFS/);

function install(args: string[], gateExit: number | "kill" | "flood" | "loud0" | "loud3" | "past0" | "past3" = 0) {
  const r = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, CV_T: T, GATE_EXIT: String(gateExit), CONTEXT_VIEW_STATE: join(T, "state"),
      CONTEXT_VIEW_GIT_BASE: `file://${join(T, "gh")}`, CONTEXT_VIEW_GATE: join(T, "release-gate") },
  });
  const calls = existsSync(join(T, "gate.calls")) ? readFileSync(join(T, "gate.calls"), "utf8").trim().split("\n") : [];
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr, file: readFileSync(join(T, "state", "harness"), "utf8"), calls };
}

test("H1: the file names C once the gate's install of context-view-harness C passes", () => {
  const r = install([main, "--go", "d1g3st"]);
  expect(r.code).toBe(0);
  expect(r.calls).toEqual([`install context-view-harness ${main} --go d1g3st`]);
  expect(r.file).toBe(`${main}\n`);
  expect(readFileSync(join(T, "gate.saw"), "utf8")).toBe(`${"a".repeat(40)}\n`);
});

test("H1: a later install reads this repository's main on GitHub as it is now", () => {
  expect(install([main, "--go", "d1g3st"]).code).toBe(0);
  sh(`cd ${join(T, "work")} && echo c > c && git add -A && git -c user.name=t -c user.email=t@t commit -q -m c && git push -q ${join(T, "gh", "anima-research", "context-view")} main`);
  const later = sh(`git -C ${join(T, "gh", "anima-research", "context-view")} rev-parse main`);
  const r = install([later, "--go", "d1g3st"]);
  expect(r.code).toBe(0);
  expect(r.file).toBe(`${later}\n`);
});

test("H2: a gate that didn't finish leaves the file as it was, and says so rather than calling it a refusal", () => {
  const r = install([main, "--go", "d1g3st"], "kill");
  expect(r.code).toBe(2);
  expect(r.out).toContain("the gate didn't finish (SIGKILL)");
  expect(r.file).toBe(`${"a".repeat(40)}\n`);
});

test("H2: a gate that can't be started, its launcher missing or not executable, leaves the file as it was, saying why", () => {
  const gate = join(T, "release-gate");
  chmodSync(gate, 0o644);
  const unrunnable = install([main, "--go", "d1g3st"]);
  expect(unrunnable.code).toBe(2);
  expect(unrunnable.out).toContain(`the gate couldn't be started (EACCES: permission denied, posix_spawn '${gate}'); ${join(T, "state", "harness")} is unchanged`);
  expect(unrunnable.file).toBe(`${"a".repeat(40)}\n`);
  rmSync(gate);
  const missing = install([main, "--go", "d1g3st"]);
  expect(missing.code).toBe(2);
  expect(missing.out).toContain(`the gate couldn't be started (ENOENT: no such file or directory, posix_spawn '${gate}'); ${join(T, "state", "harness")} is unchanged`);
  expect(missing.file).toBe(`${"a".repeat(40)}\n`);
  expect(missing.calls).toEqual([]);
});

test("H2: a gate that ran but whose answer couldn't be read, past spawnSync's output limit, isn't called one that couldn't be started, and none of its output is shown", () => {
  const r = install([main, "--go", "d1g3st"], "flood");
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(lines(r.stderr)).toEqual([overflowed, `install-harness: spawnSync stopped the gate (SIGTERM) at that limit, so it gave no answer; ${join(T, "state", "harness")} is unchanged`]);
  expect(r.out).not.toContain("gate: ");
  expect(r.file).toBe(`${"a".repeat(40)}\n`);
});

test("H2: a gate whose output passed spawnSync's limit but which exited is answered by its exit, with none of its output shown", () => {
  for (const [gate, code] of [["past0", 0], ["past3", 3]] as const) {
    writeFileSync(join(T, "state", "harness"), `${"a".repeat(40)}\n`);
    const r = install([main, "--go", "d1g3st"], gate);
    expect(r.code).toBe(code);
    expect(r.file).toBe(code === 0 ? `${main}\n` : `${"a".repeat(40)}\n`);
    expect(r.stdout).toBe(code === 0 ? `install-harness: views run the harness at ${main} from now on (it was ${"a".repeat(40)})\n` : "");
    expect(lines(r.stderr)).toEqual(code === 0 ? [overflowed] : [overflowed, `install-harness: the gate refused ${main}; ${join(T, "state", "harness")} is unchanged`]);
    expect(r.out).not.toContain("gate: ");
  }
});

test("H2: a gate's whole output reaches install-harness's reader, ahead of install-harness's own line, before it exits with the gate's answer", () => {
  for (const [gate, code] of [["loud3", 3], ["loud0", 0]] as const) {
    writeFileSync(join(T, "state", "harness"), `${"a".repeat(40)}\n`);
    const r = install([main, "--go", "d1g3st"], gate);
    expect(r.code).toBe(code);
    const said = `gate: install context-view-harness ${main} --go d1g3st\n${"x".repeat(900_000)}`;
    expect(r.stdout).toBe(code === 0 ? `${said}install-harness: views run the harness at ${main} from now on (it was ${"a".repeat(40)})\n` : said);
    expect(r.stderr).toBe(`${"y".repeat(300_000)}${code === 0 ? "" : `install-harness: the gate refused ${main}; ${join(T, "state", "harness")} is unchanged\n`}`);
    expect(r.file).toBe(code === 0 ? `${main}\n` : `${"a".repeat(40)}\n`);
  }
});

test("H2: a C the gate refuses leaves the file as it was, with the gate's exit", () => {
  const r = install([main, "--go", "d1g3st"], 3);
  expect(r.code).toBe(3);
  expect(r.calls).toHaveLength(1);
  expect(r.file).toBe(`${"a".repeat(40)}\n`);
});

test("H3: a C that isn't on this repository's main on GitHub is refused before the gate is asked", () => {
  for (const C of [branch, "b".repeat(40)]) {
    const r = install([C, "--go", "d1g3st"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("isn't on anima-research/context-view's main");
    expect(r.calls).toEqual([]);
    expect(r.file).toBe(`${"a".repeat(40)}\n`);
  }
});

test("H4: anything but a full commit is refused", () => {
  for (const args of [[main.slice(0, 12)], [], [main, "--go"]]) {
    const r = install(args);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  }
});
