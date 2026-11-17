import "./hermetic-git.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(join(T, "state"));
  writeFileSync(join(T, "state", "harness"), `${"a".repeat(40)}\n`);
  mkdirSync(join(T, "home", ".local", "bin"), { recursive: true });
  writeFileSync(join(T, "home", ".local", "bin", "release-gate"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(T, "gate-asked"))}\nexit 3\n`, { mode: 0o755 });
});
afterEach(() => rmSync(T, { recursive: true, force: true }));

function install(args: string[]) {
  const r = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: join(T, "home"), CONTEXT_VIEW_GATE: join(T, "home", ".local", "bin", "release-gate"),
      CONTEXT_VIEW_STATE: join(T, "state"), CONTEXT_VIEW_GIT_BASE: `file://${join(T, "gh")}` },
  });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, file: readFileSync(join(T, "state", "harness"), "utf8") };
}

test("H1: with a release gate there that would refuse, the file names C, a later install a commit after it, and a return the one before, and the gate never runs", () => {
  const first = install([main]);
  expect(first.code).toBe(0);
  expect(first.file).toBe(`${main}\n`);
  expect(first.stdout).toBe(`install-harness: views run the harness at ${main} from now on (it was ${"a".repeat(40)})\n`);
  sh(`cd ${join(T, "work")} && echo c > c && git add -A && git -c user.name=t -c user.email=t@t commit -q -m c && git push -q ${join(T, "gh", "anima-research", "context-view")} main`);
  const later = sh(`git -C ${join(T, "gh", "anima-research", "context-view")} rev-parse main`);
  expect(install([later]).file).toBe(`${later}\n`);
  const back = install([main]);
  expect(back.code).toBe(0);
  expect(back.file).toBe(`${main}\n`);
  expect(existsSync(join(T, "gate-asked"))).toBe(false);
});

test("H3: a C that isn't on this repository's main on GitHub is refused", () => {
  for (const C of [branch, "b".repeat(40)]) {
    const r = install([C]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("isn't on anima-research/context-view's main");
    expect(r.file).toBe(`${"a".repeat(40)}\n`);
  }
});

test("H4: anything but one full commit is refused", () => {
  for (const args of [[main.slice(0, 12)], [], [main, "--go", "d1g3st"], [main, main]]) {
    const r = install(args);
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage: install-harness C40");
    expect(r.file).toBe(`${"a".repeat(40)}\n`);
  }
});
