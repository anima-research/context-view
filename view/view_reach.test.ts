import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cpLength, dumps, Failed, inert, oneLine, readJson, type Json } from "review-workflow/view";

import { ALL_RAN, raises, reachedFile, readFile, result, Steps } from "./testing.ts";
import { post, resultOf } from "./view.ts";
import { LISTED, reachItems, reachParagraph, reachSaid } from "./view_reach.ts";

const said = (files: Record<string, Json>, notes: string[] = []): string => reachParagraph({ files, notes });

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

const two = (i: number): string => String(i).padStart(2, "0");

class Reach extends Steps {
  async reachComment(reach: Json): Promise<string> {
    const d = this.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { reach });
    await this.facts(d);
    await post({ dir: d, reader: null, post: false });
    return readFile(join(d, "comment.md"));
  }
}

const FOLD = "<details><summary>Changed source lines and deletions not seen to run, by file</summary>";

const after = (text: string, from: string): string => text.slice(text.indexOf(from));

describe("Reach", () => {
  let t: Reach;
  beforeEach(async () => {
    t = new Reach();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("facts reads reach json into view json and a ran run without one fails", async () => {
    const d = t.unchangedRun();
    expect((await t.facts(d)).reach).toEqual({ files: { "src/a.ts": reachedFile("read", { ran: [1, 2] }) }, notes: [] });
    rmSync(join(d, "reach.json"));
    await raises(() => t.facts(d), Failed, "the run wrote no reach.json, though its outcome is ran");
    const joined = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { reach: { couldnt: "no share brought its reach home" } });
    expect((await t.facts(joined)).reach).toEqual({ couldnt: "no share brought its reach home" });
  });

  test("a reach json whose lists dont hold what the harness gives fails the step", async () => {
    const cases: [Record<string, Json>, string[], string][] = [
      [{ "src/a.ts": reachedFile("gone", { ran: [1] }) }, [], "src/a.ts's state isn't one reach knows, 'gone'"],
      [{ "src/a.ts": reachedFile("read", { unloaded: [1] }) }, [], "src/a.ts, a read file, has unloaded lines"],
      [{ "src/a.ts": reachedFile("not-loaded", { couldntTell: [1], reason: "r" }) }, [], "src/a.ts, a not-loaded file, has couldntTell lines"],
      [{ "src/a.ts": reachedFile("couldnt-tell", { ran: [1], reason: "r" }) }, [], "src/a.ts, a couldnt-tell file, has ran lines"],
      [{ "src/a.ts": reachedFile("read", { ran: [1], notRan: [1] }) }, [], "src/a.ts has a line in two lists"],
      [{ "src/a.ts": reachedFile("read", { ran: [0] }) }, [], "src/a.ts's ran isn't a list of line numbers"],
      [{ "src/a.ts": reachedFile("read", { deletions: [[2, "unloaded", null]] }) }, [], "src/a.ts's deletions aren't each one a read file can have"],
      [{ "src/a.ts": reachedFile("couldnt-tell", { unloaded: [1] }) }, [], "src/a.ts names no reason for what it couldn't tell"],
      [{ "src/a.ts": reachedFile("read", { couldntTell: [1] }) }, ["n"], "src/a.ts names no reason for what it couldn't tell"],
      [{ "src/a.ts": reachedFile("read", { ran: [1], reason: "r" }) }, [], "src/a.ts names a reason for nothing it couldn't tell"],
      [{ "src/a.ts": reachedFile() }, [], "src/a.ts has no changed line or deletion"],
      [{ "test/a.ts": reachedFile("read", { ran: [1] }) }, [], "'test/a.ts' isn't a path under src/"],
      [{}, ["n", "n"], "notes aren't distinct lines of text"],
      [{ "src/a.ts": reachedFile("read", { ran: [1], deletions: [[3, "reached", null]] }) }, [], "src/a.ts's deletions aren't each one a read file can have"],
      [{ "src/a.ts": reachedFile("read", { ran: [1], deletions: [[3, "not-reached", 0]] }) }, [], "src/a.ts's deletions aren't each one a read file can have"],
      [{ "src/a.ts": reachedFile("read", { ran: [1], deletions: [[3, "no-code", 2]] }) }, [], "src/a.ts's deletions aren't each one a read file can have"],
      [
        { "src/a.ts": reachedFile("not-loaded", { unloaded: [1], deletions: [[3, "unloaded", 2]] }) },
        [],
        "src/a.ts's deletions aren't each one a not-loaded file can have",
      ],
      [{ "src/a.ts": reachedFile("read", { couldntTell: [1], reason: "another reason" }) }, ["n"], "src/a.ts's reason doesn't hold the notes once, as the harness joins them"],
      [
        { "src/a.ts": { ...reachedFile("couldnt-tell", { unloaded: [1], reason: "r" }), binary: true } },
        [],
        "src/a.ts is marked binary, and a binary file is a couldnt-tell one with no line or deletion",
      ],
      [
        { "src/a.ts": { ...reachedFile("read", { reason: "r" }), binary: true } },
        [],
        "src/a.ts is marked binary, and a binary file is a couldnt-tell one with no line or deletion",
      ],
      [
        {
          "src/a.ts": reachedFile("read", {
            couldntTell: [1],
            reason: "dist/x; n1; y ran with no source map; n1; it can run in a worker the host started (w; n1; v), which isn't profiled",
          }),
        },
        ["n1"],
        "src/a.ts's reason doesn't hold the notes once, as the harness joins them",
      ],
    ];
    for (const [files, notes, why] of cases) {
      const d = t.unchangedRun();
      writeFileSync(join(d, "reach.json"), dumps({ files, notes }));
      await raises(() => t.facts(d), Failed, `reach.json: ${why}`);
    }
  });

  test("a couldnt tell deletion with no code beside it in the loaded script as a split build gives is one a read file can have", async () => {
    const d = t.unchangedRun();
    const files = { "src/a.ts": reachedFile("read", { ran: [1], couldntTell: [2], deletions: [[3, "couldnt-tell", null]], reason: "src/a.ts is built into more than one script" }) };
    writeFileSync(join(d, "reach.json"), dumps({ files, notes: [] }));
    await t.facts(d);
  });

  test("the paragraph follows the records sentence whether or not the records differ and its result is part of the comments", async () => {
    const unchanged = t.unchangedRun();
    await t.facts(unchanged);
    await t.post(unchanged);
    expect(t.bodies().at(-1)).toContain(`The records of the 3 runs don't differ between the base and this head.\n\n${ALL_RAN}\n\n`);
    const changed = t.changedRun();
    await t.facts(changed);
    await t.post(changed, t.reader());
    expect(t.bodies().at(-1)).toContain(`The records of 2 of the 3 runs differ between the base and this head.\n\n${ALL_RAN}\n\n`);
    const view = readJson(join(unchanged, "view.json")) as Record<string, Json>;
    const other = { ...view, reach: { files: { "src/a.ts": reachedFile("read", { ran: [1], notRan: [2] }) }, notes: [] } };
    expect(resultOf(view)).not.toBe(resultOf(other));
  });

  test("lines that ran in no profiled drive are listed by file in ranges that never span a line outside the list", () => {
    const files = {
      "src/framework.ts": reachedFile("read", { notRan: [3, 4, 6, 10, 11, 12], ran: [5], noCode: [7] }),
      "src/mcpl/channel.ts": reachedFile("read", { notRan: [9] }),
    };
    expect(said(files)).toBe(
      "**In the files profiled hosts loaded, 7 changed source lines that map to code ran in no profiled " +
        "drive:** `src/framework.ts` lines 3–4, 6 and 10–12; `src/mcpl/channel.ts` line 9. 1 changed source " +
        "line maps to nothing the host runs: 1 of `src/framework.ts`'s. The whole list is in the fold below.",
    );
  });

  test("a list longer than its room is cut saying how much it leaves out", () => {
    const files = Object.fromEntries(range(0, 20).map((i) => [`src/f${two(i)}.ts`, reachedFile("read", { notRan: [1, 2, 4] })]));
    const text = said(files);
    const shown = /drive:\*\* (.*); and (\d+) more lines in (\d+) files\. The whole list/.exec(text);
    expect(shown).not.toBeNull();
    const [, listing, more, rest] = shown!;
    expect(cpLength(listing!)).toBeLessThanOrEqual(LISTED);
    const named = [...listing!.matchAll(/`(src\/f\d\d\.ts)` lines 1–2 and 4/g)].map((m) => m[1]);
    expect([named.length * 3 + Number(more), named.length + Number(rest), named]).toEqual([60, 20, range(0, named.length).map((i) => `src/f${two(i)}.ts`)]);
    expect(text.startsWith("**In the files profiled hosts loaded, 60 changed source lines")).toBe(true);
  });

  test("files no profiled host loaded are named with all their changed lines and deletions", () => {
    const files = {
      "src/cli/args.ts": reachedFile("not-loaded", { notRan: [1, 2], noCode: [3], unloaded: [], deletions: [[5, "not-reached", 4]] }),
      "src/cli/serve.ts": reachedFile("not-loaded", { unloaded: range(1, 13) }),
    };
    expect(said(files)).toBe(
      "**No profiled host loaded `src/cli/args.ts` (3 changed lines and 1 deletion) or `src/cli/serve.ts` " +
        "(12 changed lines).** The whole list is in the fold below.",
    );
  });

  test("deletions no profiled drive reached are named by the line they follow", () => {
    const files = {
      "src/a.ts": reachedFile("read", {
        ran: [1],
        deletions: [
          [3, "not-reached", 2],
          [9, "not-reached", 10],
          [12, "reached", 1],
        ],
      }),
      "src/b.ts": reachedFile("read", { deletions: [[4, "not-reached", 5]] }),
    };
    expect(said(files)).toBe(
      "No profiled drive reached 3 of this change's deletions: `src/a.ts`, the ones after lines 3 and 9; " + "`src/b.ts`, the one after line 4.",
    );
  });

  test("where everything that could run ran it says so never counting the changes deletions as a whole", () => {
    for (const [files, words] of [
      [{ "src/a.ts": reachedFile("read", { ran: [1, 2] }) }, ALL_RAN],
      [{ "src/a.ts": reachedFile("read", { ran: [1] }) }, "This change's 1 changed source line that maps to code ran in at least one profiled drive."],
      [
        {
          "src/a.ts": reachedFile("read", {
            ran: [1, 2],
            deletions: [
              [3, "reached", 2],
              [5, "reached", 2],
            ],
          }),
        },
        "All 2 of this change's changed source lines that map to code ran in at least one profiled drive, as did code beside each " + "of 2 of its deletions.",
      ],
      [
        { "src/a.ts": reachedFile("read", { ran: [1, 2], deletions: [[3, "reached", 2]] }) },
        "All 2 of this change's changed source lines that map to code ran in at least one profiled drive, as did code beside 1 of " + "its deletions.",
      ],
      [
        { "src/a.ts": reachedFile("read", { deletions: [[3, "reached", 2]] }), "src/t.ts": reachedFile("read", { deletions: [[2, "no-code", null]] }) },
        "Code beside 1 of this change's deletions ran in at least one profiled drive. 1 of this change's deletions has no code " +
          "line on either side of it to be judged by: `src/t.ts`'s deletion after line 2. The whole list is in the fold below.",
      ],
      [
        { "src/a.ts": reachedFile("read", { ran: [1], noCode: [2, 3] }) },
        "This change's 1 changed source line that maps to code ran in at least one profiled drive. 2 changed source lines map to " +
          "nothing the host runs: 2 of `src/a.ts`'s. The whole list is in the fold below.",
      ],
    ] as const) {
      expect(said(files)).toBe(words);
    }
  });

  test("with a note it says how many lines and deletions it couldnt tell about and why", () => {
    const files = {
      "src/a.ts": reachedFile("read", { ran: [1], couldntTell: [2, 3], deletions: [[4, "couldnt-tell", 3]], reason: "r1; r2" }),
      "src/b.ts": reachedFile("couldnt-tell", { unloaded: [1, 2], noCode: [3], reason: "r1; r2" }),
    };
    expect(said(files, ["H1/W9: its profiled drive failed at step 648143.2", "r2"])).toBe(
      "Couldn't tell whether 4 changed source lines ran, or whether 1 deletion was reached, since H1\\/W9\\: its profiled " +
        "drive failed at step 648143\\.2; and 1 more reason. 1 changed source line maps to nothing the host runs: 1 of " +
        "`src/b.ts`'s. The whole list is in the fold below.",
    );
    expect(said({ "src/a.ts": reachedFile("read", { couldntTell: [2], reason: "a host exited before its blocks were read" }) }, ["a host exited before its blocks were read"])).toBe(
      "Couldn't tell whether 1 changed source line ran, since a host exited before its blocks were read. The whole list " + "is in the fold below.",
    );
  });

  test("without a note each file it couldnt tell about says how much and its own reason", () => {
    const files = {
      "src/a.ts": reachedFile("read", { ran: [1], couldntTell: [2, 3], deletions: [[9, "couldnt-tell", 3]], reason: "a worker can run it" }),
      "src/b.ts": reachedFile("couldnt-tell", { unloaded: [4], reason: "dist/x.js ran with no source map" }),
      "src/c.ts": reachedFile("couldnt-tell", {
        deletions: [
          [2, "unloaded", null],
          [7, "unloaded", null],
        ],
        reason: "dist/x.js ran",
      }),
    };
    expect(said(files)).toBe(
      "Couldn't tell whether 2 of `src/a.ts`'s changed lines ran, or whether its deletion after line 9 was " +
        "reached: a worker can run it. Couldn't tell whether 1 of `src/b.ts`'s changed lines ran: dist\\/x\\.js " +
        "ran with no source map. Couldn't tell whether `src/c.ts`'s deletions after lines 2 and 7 were " +
        "reached: dist\\/x\\.js ran. The whole list is in the fold below.",
    );
  });

  test("lines and deletions with nothing to run are counted apart by file", () => {
    const files = {
      "src/types/agent.ts": reachedFile("read", { noCode: range(1, 13), deletions: [[9, "no-code", null]] }),
      "src/framework.ts": reachedFile("read", { ran: [1], noCode: [2, 3, 4] }),
    };
    expect(said(files)).toBe(
      "This change's 1 changed source line that maps to code ran in at least one profiled drive. 15 changed " +
        "source lines map to nothing the host runs, and 1 deletion has no code line on either side of it to " +
        "be judged by: 3 of `src/framework.ts`'s lines, and 12 of `src/types/agent.ts`'s lines and its " +
        "deletion after line 9. The whole list is in the fold below.",
    );
  });

  test("a file whose only part with nothing to run is a deletion names it as one beside files with lines", () => {
    const files = {
      "src/a.ts": reachedFile("read", { ran: [1], noCode: [2, 3, 4] }),
      "src/t.ts": reachedFile("read", { deletions: [[9, "no-code", null]] }),
      "src/u.ts": reachedFile("read", { noCode: [1, 2] }),
    };
    expect(said(files)).toBe(
      "This change's 1 changed source line that maps to code ran in at least one profiled drive. 5 changed " +
        "source lines map to nothing the host runs, and 1 deletion has no code line on either side of it to " +
        "be judged by: 3 of `src/a.ts`'s lines, `src/t.ts`'s deletion after line 9, and 2 of `src/u.ts`'s " +
        "lines. The whole list is in the fold below.",
    );
  });

  test("past the cut the files it couldnt tell about for their own reasons are counted with their deletions", () => {
    const files: Record<string, Json> = Object.fromEntries(
      range(0, 8).map((i) => [`src/pkg/f${two(i)}.ts`, reachedFile("couldnt-tell", { unloaded: [1, 2], reason: "dist/bundle.js ran with no source map" })]),
    );
    files["src/pkg/z.ts"] = reachedFile("couldnt-tell", { deletions: [[4, "unloaded", null]], reason: "dist/bundle.js ran with no source map" });
    const text = said(files);
    const shown =
      /Couldn't tell either whether (\d+) more changed lines ran, or whether 1 more deletion was reached, in (\d+) more files, each for its own reason\. The whole list is in the fold below\.$/.exec(
        text,
      );
    expect(shown).not.toBeNull();
    const told = [...text.matchAll(/Couldn't tell whether 2 of `(src\/pkg\/f\d\d\.ts)`'s changed lines ran: /g)];
    expect([told.length * 2 + Number(shown![1]), told.length + Number(shown![2])]).toEqual([16, 9]);
  });

  test("a long list of lines with nothing to run is cut the same way", () => {
    const files = Object.fromEntries(range(0, 30).map((i) => [`src/types/t${two(i)}.ts`, reachedFile("read", { noCode: [1, 2, 3] })]));
    const text = said(files);
    const shown = /^90 changed source lines map to nothing the host runs: (.*), and (\d+) more lines in (\d+) more files\. The whole list is in the fold below\.$/.exec(text);
    expect(shown).not.toBeNull();
    const named = [...shown![1]!.matchAll(/3 of `(src\/types\/t\d\d\.ts)`'s/g)];
    expect(cpLength(shown![1]!)).toBeLessThanOrEqual(LISTED);
    expect([named.length * 3 + Number(shown![2]), named.length + Number(shown![3])]).toEqual([90, 30]);
  });

  test("a list the paragraph cuts is held whole in a fold below it", async () => {
    const files: Record<string, Json> = Object.fromEntries(range(0, 20).map((i) => [`src/f${two(i)}.ts`, reachedFile("read", { notRan: [1, 2, 4] })]));
    files["src/t.ts"] = reachedFile("read", { ran: [1], noCode: [2, 3], deletions: [[5, "no-code", null], [9, "not-reached", 10]] });
    files["src/cli.ts"] = reachedFile("not-loaded", { unloaded: [1, 2], deletions: [[4, "unloaded", null]] });
    const text = await t.reachComment({ files, notes: [] });
    expect(text).toContain("The whole list is in the fold below.");
    const fold = after(text, FOLD);
    for (const i of range(0, 20)) expect(fold).toContain(`\n\n\`src/f${two(i)}.ts\`: lines 1–2 and 4 ran in no profiled drive.\n\n`);
    expect(fold).toContain(
      "\n\n`src/t.ts`: no profiled drive reached its deletion after line 9; lines 2–3 map to nothing the host runs; its deletion " +
        "after line 5 has no code line on either side.\n\n",
    );
    expect(fold).toContain("\n\n`src/cli.ts`: no profiled host loaded it: changed lines 1–2 and its deletion after line 4.\n\n");
    expect(text.slice(0, text.indexOf(FOLD))).toMatch(/; and \d+ more lines in \d+ files\. /);
  });

  test("reasons the paragraph leaves out or cuts are held whole in the fold and nothing cut means no fold", async () => {
    const notes = ["H1/W9: its profiled drive failed at step 648143.2", "share 4 brought no reach home", "x ".repeat(300)];
    const text = await t.reachComment({ files: { "src/a.ts": reachedFile("read", { ran: [1], couldntTell: [2, 3], reason: notes.join("; ") }) }, notes });
    expect(text).toContain("; and 2 more reasons. The whole list is in the fold below.");
    const fold = after(text, FOLD);
    for (const n of notes) expect(fold).toContain(`Couldn't tell for any line or deletion not seen to run, since ${inert(oneLine(n))}.`);
    expect(fold).toContain("\n\n`src/a.ts`: couldn't tell whether lines 2–3 ran.\n\n");
    const long = await t.reachComment({ files: { "src/a.ts": reachedFile("read", { couldntTell: [2], reason: "y ".repeat(300) }) }, notes: [] });
    expect(long.slice(0, long.indexOf(FOLD))).toContain("(the reason's first");
    expect(after(long, FOLD)).toContain(`\n\n\`src/a.ts\`: couldn't tell whether line 2 ran, since ${"y ".repeat(299)}y.\n\n`);
    const own = await t.reachComment({
      files: {
        ...Object.fromEntries(range(0, 20).map((i) => [`src/f${two(i)}.ts`, reachedFile("read", { notRan: [1, 2, 4] })])),
        "src/b.ts": reachedFile("couldnt-tell", { noCode: [5], reason: "dist/bundle.js ran with no source map" }),
      },
      notes: [],
    });
    expect(after(own, FOLD)).toContain("\n\n`src/b.ts`: line 5 maps to nothing the host runs.\n\n");
    const couldnt = await t.reachComment({ couldnt: "z ".repeat(300) });
    const m = /which of this change's source lines ran: ((?:z )+z) \(the reason's first ([0-9]+) of 599 characters\)\. The whole reason is in the fold below\.\n\n/.exec(couldnt);
    expect([cpLength(m![1]!), Number(m![2]) <= LISTED]).toEqual([Number(m![2]), true]);
    const why = "<details><summary>Why it couldn&#x27;t tell which of this change&#x27;s source lines ran</summary>";
    expect(couldnt).toContain(`${why}\n\nCouldn't tell which of this change's source lines ran: ${"z ".repeat(299)}z.\n\n`);
    expect(couldnt).not.toContain(FOLD);
    const whole = await t.reachComment({ files: { "src/a.ts": reachedFile("read", { ran: [1], notRan: [2], deletions: [[4, "not-reached", 5]] }) }, notes: [] });
    expect(whole).not.toContain(FOLD);
    expect(whole).not.toContain("The whole list");
    expect(whole).not.toContain("view.json");
    const countedOnly = await t.reachComment({ files: { "src/a.ts": reachedFile("read", { ran: [1], noCode: [2, 3] }) }, notes: [] });
    expect(countedOnly).toContain("2 of `src/a.ts`'s. The whole list is in the fold below.");
    expect(after(countedOnly, FOLD)).toContain("\n\n`src/a.ts`: lines 2–3 map to nothing the host runs.\n\n");
    const beside = await t.reachComment({ files: { "src/a.ts": reachedFile("read", { ran: [1], couldntTell: [2], reason: "n1; a worker the host started can run it" }) }, notes: ["n1"] });
    expect(after(beside, FOLD)).toContain("\n\n`src/a.ts`: couldn't tell whether line 2 ran, since a worker the host started can run it, besides the reasons above.\n\n");
    expect(beside).not.toContain("view.json");
  });

  test("a files own reason beside the notes is what the harness added to them whole even where it holds a notes text", async () => {
    const files = { "src/m.ts": reachedFile("couldnt-tell", { unloaded: [1], reason: "dist/a; n1; b.js ran with no source map; n1; n2" }) };
    const text = await t.reachComment({ files, notes: ["n1", "n2"] });
    expect(after(text, FOLD)).toContain("\n\n`src/m.ts`: couldn't tell whether line 1 ran, since dist\\/a\\; n1\\; b\\.js ran with no source map, besides the reasons above.\n\n");
  });

  test("a changed binary file is said as a change it couldnt tell ran never as no line changed", async () => {
    const why = "src/q.wasm isn't script source, so whether its change ran can't be read";
    const q = { ...reachedFile("couldnt-tell", { reason: why }), binary: true };
    expect(said({ "src/q.wasm": q })).toBe(`Couldn't tell whether the change to \`src/q.wasm\` ran: ${inert(why)}.`);
    const both = said({ "src/a.ts": reachedFile("read", { couldntTell: [2, 3], reason: "n1" }), "src/q.wasm": { ...q, reason: `n1; ${why}` } }, ["n1"]);
    expect(both.startsWith("Couldn't tell whether 2 changed source lines ran, or whether the change to 1 binary file ran, since n1.")).toBe(true);
    const alone = await t.reachComment({ files: { "src/q.wasm": q }, notes: [] });
    expect(alone).not.toContain(FOLD);
    expect(alone).not.toContain("adds or edits no line");
    const text = await t.reachComment({ files: { "src/q.wasm": { ...q, reason: `n1; ${why}` } }, notes: ["n1"] });
    expect(after(text, FOLD)).toContain(`\n\n\`src/q.wasm\`: couldn't tell whether its change ran, since ${inert(why)}, besides the reasons above.\n\n`);
  });

  test("a change with no source line or a join that couldnt be made says so alone", () => {
    expect(said({})).toBe("This change adds or edits no line under `src/`.");
    expect(reachParagraph({ couldnt: "no share brought its reach home" })).toBe("Couldn't tell which of this change's source lines ran: no share brought its reach home.");
    const long = "x ".repeat(400);
    const text = reachParagraph({ couldnt: long });
    const m =
      /^Couldn't tell which of this change's source lines ran: ((?:x )+x) \(the reason's first ([0-9]+) of 799 characters\)\. The whole reason is in the fold below\.$/.exec(
        text,
      );
    expect([cpLength(m![1]!), Number(m![2]) <= LISTED]).toEqual([Number(m![2]), true]);
  });
});

const raised = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
  return "nothing raised";
};

describe("Shapes reach_of refuses", () => {
  test("a value that isn't a list or a str where one is read raises a TypeError in the TS's own words", () => {
    const told = { ...reachedFile("read", { couldntTell: [2] }), reason: 7 };
    expect([
      raised(() => reachParagraph({ files: { "src/a.ts": { ...reachedFile("read"), notRan: 5 } }, notes: [] })),
      raised(() => reachParagraph({ files: {}, notes: "ab" })),
      raised(() => reachItems({ files: { "src/a.ts": told }, notes: [] }, 10_000)),
    ]).toEqual(["TypeError: a list is needed here", "TypeError: a list is needed here", "TypeError: a str is needed here"]);
  });
});

describe("The fold", () => {
  test("reachSaid's flag says a fold follows exactly where its paragraph says so", () => {
    const cut = Object.fromEntries(range(0, 20).map((i) => [`src/f${two(i)}.ts`, reachedFile("read", { notRan: [1, 2, 4] })]));
    const fits = { "src/framework.ts": reachedFile("read", { notRan: [3, 4] }) };
    expect([cut, fits].map((files) => reachSaid({ files, notes: [] })).map(([text, fold]) => [text.endsWith("The whole list is in the fold below."), fold])).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});
