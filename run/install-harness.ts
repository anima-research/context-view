#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS } from "./context-view-run.ts";

const STATE = process.env.CONTEXT_VIEW_STATE ?? join(process.env.HOME ?? "/home/nissa", ".local/state/context-view");
const GIT_BASE = process.env.CONTEXT_VIEW_GIT_BASE ?? "https://github.com";
const GATE = process.env.CONTEXT_VIEW_GATE ?? join(process.env.HOME ?? "/home/nissa", ".local/bin/release-gate");
export const CHECKOUT = join(STATE, "connectome-smoke");
const FILE = join(STATE, "harness");

const git = (...args: string[]) => spawnSync("git", ["-C", CHECKOUT, ...args], { encoding: "utf8" });

export function installHarness(argv: string[]): number {
  const C = argv[0], at = argv.indexOf("--go"), go = at >= 0 ? argv[at + 1] : undefined;
  const refuse = (why: string, code = 2) => { console.error(`install-harness: ${why}`); return code; };
  if (!C || !/^[0-9a-f]{40}$/.test(C) || (at >= 0 && !go)) return refuse("usage: install-harness C40 [--go DIGEST]");
  if (!existsSync(join(CHECKOUT, ".git"))) {
    mkdirSync(CHECKOUT, { recursive: true });
    const init = spawnSync("git", ["clone", "-q", `${GIT_BASE}/${HARNESS.repo}`, CHECKOUT], { encoding: "utf8" });
    if (init.status !== 0) return refuse(`couldn't clone ${HARNESS.repo} into ${CHECKOUT}: ${(init.stderr ?? init.error?.message ?? "").trim()}`);
  }
  const f = git("fetch", "-q", `${GIT_BASE}/${HARNESS.repo}`, "+refs/heads/main:refs/remotes/origin/main");
  if (f.status !== 0) return refuse(`couldn't read ${HARNESS.repo}'s main: ${(f.stderr ?? f.error?.message ?? "").trim()}`);
  const notOn = () => refuse(`${C} isn't on ${HARNESS.repo}'s main, so a view's jobs couldn't be sure of fetching it`);
  if (git("cat-file", "-e", `${C}^{commit}`).status !== 0) return notOn();
  const on = git("merge-base", "--is-ancestor", C, "refs/remotes/origin/main");
  if (on.status === 1) return notOn();
  if (on.status !== 0) return refuse(`couldn't tell whether ${C} is on ${HARNESS.repo}'s main: ${(on.stderr ?? on.error?.message ?? "").trim() || `git exited ${on.status}`}`);
  const gate = spawnSync(GATE, ["install", "context-view-harness", C, ...(go ? ["--go", go] : [])], { encoding: "utf8" });
  // spawnSync answers a program it couldn't start with an error and pid 0; one that ran and then failed, such as ENOBUFS, has its pid.
  if (gate.error && !gate.pid) return refuse(`the gate couldn't be started (${gate.error.message}); ${FILE} is unchanged`);
  process.stdout.write(gate.stdout ?? ""); process.stderr.write(gate.stderr ?? "");
  if (gate.status === null) return refuse(`the gate didn't finish (${gate.signal ?? gate.error?.message ?? "no exit"}); ${FILE} is unchanged`);
  if (gate.status !== 0) return refuse(`the gate refused ${C}; ${FILE} is unchanged`, gate.status);
  const was = existsSync(FILE) ? readFileSync(FILE, "utf8").split("\n")[0]!.trim() : null;
  writeFileSync(`${FILE}.tmp`, `${C}\n`);
  renameSync(`${FILE}.tmp`, FILE);
  console.log(`install-harness: views run the harness at ${C} from now on${was ? ` (it was ${was})` : ""}`);
  return 0;
}

if (import.meta.main) process.exit(installHarness(process.argv.slice(2)));
