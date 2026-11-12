import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LEFT_OUT = /^(node_modules|\.venv|__pycache__|.*\.egg-info)$/;

function stage(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-view-stage-")));
  made.push(root);
  cpSync(import.meta.dir, join(root, "view"), { recursive: true, filter: (from) => !LEFT_OUT.test(basename(from)) });
  return root;
}

const ran = (args: string[], stdin?: string) => {
  // spawnSync blocks Bun's test runner, so its per-test guard can't end a spawn that hangs: 10 s lets the spawn's own
  // timeout land first.
  const p = Bun.spawnSync(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

const build = (root: string) => ran(["bash", join(root, "view", "build.sh"), root]);

test("a stage copied without node_modules builds, and once moved its launchers run its steps and poll; without its node_modules the step fails and the poll refuses rather than look like a pass with nothing to start", () => {
  const root = stage();
  const built = build(root);
  expect({ code: built.code, err: built.err.slice(-2000) }).toEqual({ code: 0, err: expect.any(String) });
  expect(built.out).toContain(`view/build.sh: ${root}/view installs from bun.lock, and its launchers run the stage's steps and poll\n`);
  expect(existsSync(join(root, "view", "node_modules", "typescript"))).toBe(false);
  const moved = `${root}-moved`;
  renameSync(root, moved);
  made.push(moved);
  expect(ran([join(moved, "view", "step"), "facts"], "[]")).toEqual({ code: 1, out: "", err: "view.ts facts: stdin: one JSON object\n" });
  const polled = ran([join(moved, "view", "poll"), "--help"]);
  expect({ code: polled.code, out: polled.out.slice(0, 500) }).toEqual({ code: 0, out: expect.stringMatching(/^usage: poll\.ts \[-h\] \[--job\] \[\{views,asks,merges\}\]/) });
  renameSync(join(moved, "view", "node_modules"), join(moved, "view", "node_modules-gone"));
  const step = ran([join(moved, "view", "step"), "--help"]);
  expect({ code: step.code, err: step.err }).toEqual({ code: 1, err: expect.stringContaining("Cannot find module 'review-workflow/view'") });
  expect(ran([join(moved, "view", "poll"), "--job"])).toEqual({
    code: 2,
    out: "",
    err: `view/poll: ${join(moved, "view")}/node_modules holds no review-workflow, so the poll can't load: its release isn't installed whole\n`,
  });
});

test("a stage whose package.json bun.lock doesn't hold is refused, rather than resolved again", () => {
  const root = stage();
  const manifest = join(root, "view", "package.json");
  const held = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies: Record<string, string> };
  delete held.dependencies["review-workflow"];
  writeFileSync(manifest, JSON.stringify(held));
  const built = build(root);
  expect({ code: built.code, err: built.err }).toEqual({ code: 1, err: expect.stringContaining("lockfile had changes, but lockfile is frozen") });
});

test("a stage whose step or poll can't load is refused, before anything switches to it", () => {
  for (const [launcher, file] of [["step", "view.ts"], ["poll", "poll.ts"]] as const) {
    const root = stage();
    writeFileSync(join(root, "view", file), "export const = ;\n");
    const built = build(root);
    expect({ launcher, code: built.code, err: built.err }).toEqual({
      launcher,
      code: 1,
      err: expect.stringContaining(`view/build.sh: view/${launcher} didn't run the stage's ${launcher}\n`),
    });
  }
});

test("a stage whose step writes a file naming the stage's path when it first loads is refused, since the check runs after the loads", () => {
  const root = stage();
  const step = join(root, "view", "view.ts");
  writeFileSync(step, `import { writeFileSync as written } from "node:fs";\nwritten(new URL("./loaded.txt", import.meta.url), import.meta.dir);\n${readFileSync(step, "utf8")}`);
  const built = build(root);
  expect({ code: built.code, err: built.err }).toEqual({
    code: 1,
    err: expect.stringContaining(`view/build.sh: a file in the stage names the stage's path, so it would break once moved into place: ${root}/view/loaded.txt\n`),
  });
});

test("a stage holding a file outside view that names the stage's own path is refused, so a release that would break once moved never switches", () => {
  const root = stage();
  writeFileSync(join(root, "named.txt"), root);
  const built = build(root);
  expect({ code: built.code, err: built.err }).toEqual({
    code: 1,
    err: expect.stringContaining(`view/build.sh: a file in the stage names the stage's path, so it would break once moved into place: ${root}/named.txt\n`),
  });
});

test("a stage holding a symbolic link into the stage's own path is refused, since the link breaks once the stage moves", () => {
  const root = stage();
  symlinkSync(join(root, "view", "view.ts"), join(root, "view", "linked.ts"));
  const built = build(root);
  expect({ code: built.code, err: built.err }).toEqual({
    code: 1,
    err: expect.stringContaining(`view/build.sh: a symbolic link in the stage points into the stage's path, so it would break once moved into place: ${root}/view/linked.ts\n`),
  });
});
