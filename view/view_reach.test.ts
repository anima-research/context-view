import { describe, expect, test } from "bun:test";
import { cpLength, type Json } from "review-workflow/view";
import { ALL_RAN, reachedFile } from "./testing.ts";
import { LISTED, reachItems, reachParagraph } from "./view_reach.ts";

const said = (files: Record<string, Json>, notes: string[] = []): string => reachParagraph({ files, notes });

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

const two = (i: number): string => String(i).padStart(2, "0");

describe("Reach", () => {
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
