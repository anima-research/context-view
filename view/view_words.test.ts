import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMMENT_MAX, cpLength, cpSlice, dumps, Failed, grouped, inert, oneLine, readJson, type Json } from "review-workflow/view";
import { readable } from "review-workflow/testing";

import * as poll from "./poll.ts";
import { AF, ALL_RAN, BASE, entry, H1, HARNESS, M, nesting, raises, READS, readFile, result, Steps, type Reader } from "./testing.ts";
import { post, resultOf } from "./view.ts";
import { ASKERS, changeBlock, clipped, COMMAND, couldNot, flagsLine, flagsText, folded, forcedLine, known, listed, runFolds, UNREAD } from "./view_words.ts";

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const REASON_LEAD = "This head couldn't be compared at `H1/W1`: the head couldn't run it (";

const reasonLine = (reason: string, line: string): string[] =>
  couldNot({ outcome: "ran", broken: [{ run: "H1/W1", what: "head", reason }] }, cpLength(line));

const FLAG_LINE = "- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base";

const cutCounts = (view: Json): Set<number> => {
  const counted = new Set<number>();
  for (let room = cpLength(FLAG_LINE) + cpLength(" (the flag's first 0 of 63 characters)"); room < cpLength(FLAG_LINE) + 100; room++) {
    const said = flagsText(view, room)[1]!;
    const m = new RegExp(`^${escaped(FLAG_LINE)}(?:: (.*))? \\(the flag's first ([0-9,]+) of 63 characters\\)$`, "u").exec(said);
    if (m) {
      const shown = readable(m[1] ?? "");
      expect([room, cpLength(shown)]).toEqual([room, Number(m[2]!.replaceAll(",", ""))]);
      counted.add(Number(m[2]!.replaceAll(",", "")));
    }
  }
  return counted;
};

const raised = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return `${e instanceof Failed ? "Failed" : (e as Error).name}: ${(e as Error).message}`;
  }
  return "nothing raised";
};

const count = (text: string, part: string): number => text.split(part).length - 1;

const summaries = (text: string): string[] => [...text.matchAll(/<details><summary>(.*?)<\/summary>/g)].map((m) => m[1]!);

const partsIn = (d: string): string[] =>
  readdirSync(d)
    .filter((f) => /^comment(-[0-9]+)?\.md$/.test(f))
    .sort((a, b) => Number(a.slice(8, -3) || 1) - Number(b.slice(8, -3) || 1))
    .map((f) => readFile(join(d, f)));

const OPENING = `**Automatic context view** of \`${H1.slice(0, 12)}\` merged onto \`${BASE.slice(0, 12)}\`.\n\n`;

const LINKED = `What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/${HARNESS}/CHECKS.md).\n\n`;

describe("Words", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("a changed view opens with the link the counts and the account and nests each changed runs changes in the runs fold", async () => {
    const flags = { new: [{ check: 11, step: "q.3", what: "invariant", detail: "a pinned message was summarised" }], gone: [], kept: [] };
    const d = t.runDir([
      [
        [
          result("H1/W1", { record: "differs" }),
          result("H1/W2", { record: "differs", flags }),
          result("C6h/W11", { outcome: "couldnt-run", reason: "the store @x was unreadable" }),
        ],
        [
          entry("aaaaaaaaaaaa", [
            ["H1/W1", 2],
            ["H1/W2", 1],
          ]),
          entry("bbbbbbbbbbbb", [
            ["H1/W1", 5],
            ["H1/W1", 6],
          ]),
        ],
      ],
    ]);
    const reader: Reader = {
      summary: ["Merges now go first.", "Refusals report a floor."],
      changes: [
        {
          title: "Merges go first",
          where: "In both runs at the first compile",
          base: "It asked for a summary first",
          head: "It asks for a merge first",
          refs: ["aaaaaaaaaaaa"],
          before: "b1",
          after: "a1",
          place: { run: "H1/W1", step: 2 },
        },
        {
          title: "Refusals report floor",
          where: "In the first run at the refusal",
          base: "The refusal gave the budget",
          head: "It gives the budget and a floor",
          follows: 1,
          unmentioned: true,
          refs: ["bbbbbbbbbbbb"],
          before: "b2",
          after: "a2",
          place: { run: "H1/W1", step: 5 },
        },
      ],
    };
    const text = await t.comment(d, reader);
    const top =
      OPENING +
      LINKED +
      "The records of 2 of the 2 runs it could compare differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
      "1 run couldn't be compared; its reason is below.\n\n" +
      "Separately, 1 of the checks' flags differs between the base and the head, in 1 run; it's listed under " +
      '"Checks\' flags that differ", below.\n\n' +
      "*A model's account of those records:*\n\n" +
      "**Delta 1: Merges go first**\n\nIn both runs at the first compile.\n\n" +
      "- base (`main`): It asked for a summary first.\n- head (`aaaaaaaaaaaa`): It asks for a merge first.\n\n" +
      "**Delta 2: Refusals report floor** (the description doesn't mention it)\n\nIn the first run at the refusal. Follows from Delta 1.\n\n" +
      "- base (`main`): The refusal gave the budget.\n- head (`aaaaaaaaaaaa`): It gives the budget and a floor.\n\n" +
      "<details>";
    expect(text.slice(0, top.length)).toBe(top);
    const runs =
      "<details><summary>Runs whose records differ: 2 of 2, with 2 changes</summary>\n\n" +
      "<details><summary><code>H1/W1</code>: 2 changes</summary>\n\n" +
      "*Merges go first*\n\nAt step `2`.\n\nBefore:\n\n```text\nb1\n```\n\nAfter:\n\n```text\na1\n```\n\n" +
      "*Refusals report floor*\n\nAt 2 steps; the quotes are from step `5`.\n\nBefore:\n\n```text\nb2\n```\n\n" +
      "After:\n\n```text\na2\n```\n\n</details>\n\n" +
      "<details><summary><code>H1/W2</code>: 1 change</summary>\n\n" +
      "*Merges go first*\n\nAt step `1`. Its before and after are quoted under `H1/W1`, at step `2`.\n\n</details>\n\n" +
      "</details>";
    expect(text).toContain(runs);
    expect(summaries(text)).toEqual([
      "Runs whose records differ: 2 of 2, with 2 changes",
      "<code>H1/W1</code>: 2 changes",
      "<code>H1/W2</code>: 1 change",
      "Runs that couldn&#x27;t be compared (1)",
      "Checks&#x27; flags that differ (1)",
    ]);
    expect(text).toContain(
      "<details><summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `C6h/W11`: " +
        "the head couldn't run it (the store `@x` was unreadable).\n\n</details>",
    );
    const flagged = "`H1/W2` step `q.3`, check `11` flagged on the head 1 more time than on the base";
    expect(text).toContain(`<details><summary>Checks&#x27; flags that differ (1)</summary>\n\n- ${flagged}`);
    expect(count(text, flagged)).toBe(1);
    const paragraphs = text.split("\n\n");
    expect(paragraphs.at(-2)!.startsWith("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, ")).toBe(true);
    expect(paragraphs.at(-1)!.startsWith("<!--")).toBe(true);
    for (const gone of ["About this view", "Between them", "a model's reading", "good faith", "Merges now go first", "Refusals report a floor"]) expect(text).not.toContain(gone);
  });

  test("several runs that couldnt be compared are counted above in the plural and folded beside the runs that differ", async () => {
    const d = t.runDir([
      [
        [result("H1/W1", { record: "differs" }), result("H1/W2", { outcome: "couldnt-run", reason: "r2" }), result("C6h/W11", { outcome: "couldnt-run", reason: "r3" })],
        [entry("aaaaaaaaaaaa", [["H1/W1", 4]])],
      ],
    ]);
    const text = await t.comment(d, { changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" }] });
    const top =
      OPENING +
      LINKED +
      "The records of 1 of the 1 run it could compare differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n2 runs " +
      "couldn't be compared; the reasons are below.\n\n*A model's account of those records:*";
    expect(text.slice(0, top.length)).toBe(top);
    expect(text).toContain(
      "<details><summary>Runs whose records differ: 1 of 1, with 1 change</summary>\n\n" + "<details><summary><code>H1/W1</code>: 1 change</summary>\n\n*T*\n\nAt step `4`.\n\n",
    );
    expect(text).toContain(
      "</details>\n\n</details>\n\n<details><summary>Runs that couldn&#x27;t be compared (2)</summary>\n\nThis head " +
        "couldn't be compared at `H1/W2`: the head couldn't run it (r2).\n\nThis head couldn't be compared at `C6h/W11`: the " +
        "head couldn't run it (r3).\n\n</details>",
    );
    expect(count(text, "couldn't be compared at `H1/W2`")).toBe(1);
  });

  test("a head whose compared runs dont differ says so and how many werent and folds the reasons", async () => {
    const d = t.runDir([[[result("H1/W1"), result("H1/W2", { outcome: "couldnt-run", reason: "r2" }), result("C6h/W11")], []]]);
    const text = await t.comment(d);
    const top =
      OPENING +
      LINKED +
      "The records of the 2 runs it could compare don't differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
      "1 run couldn't be compared; its reason is below.\n\n" +
      "<details><summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `H1/W2`: " +
      "the head couldn't run it (r2).\n\n</details>\n\n" +
      "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, ";
    expect(text.slice(0, top.length)).toBe(top);
    expect(text.split("\n\n").at(-1)!.startsWith("<!--")).toBe(true);
    expect(count(text, "couldn't be compared at `H1/W2`")).toBe(1);
  });

  test("the flags line counts the flags with the runs they re in apart from the records", () => {
    const two = { flags: [{ run: "A", new: [{}, {}], gone: [] }, { run: "B", new: [], gone: [{}] }, { run: "C", new: [], gone: [] }] };
    expect(flagsLine(two, 3)).toBe(
      "Separately, 3 of the checks' flags differ between the base and the head, in 2 runs; " + 'they\'re listed under "Checks\' flags that differ", below.',
    );
  });

  test("flags too many for one comment are folded across comments each fold whole and titled as continued", async () => {
    const flags = { new: Array.from({ length: 120 }, (_, i) => ({ check: i + 1, step: String(i), what: "w", detail: "d".repeat(900) })), gone: [], kept: [] };
    const d = t.runDir([[[result("H1/W1", { record: "differs", flags }), result("H1/W2"), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 4]])]]]);
    await t.facts(d);
    const reader = { changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" }] };
    await post({ dir: d, reader: t.write(d, reader), post: false, reads: READS });
    const texts = partsIn(d);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((x) => cpLength(x) <= COMMENT_MAX)).toBe(true);
    expect(texts[0]).toContain(
      "Separately, 120 of the checks' flags differ between the base and the head, in 1 run; they're listed under " + '"Checks\' flags that differ", below.',
    );
    const whole = texts.join("\n\n");
    for (const x of texts) expect(count(x, "<details>")).toBe(count(x, "</details>"));
    const folds = texts.flatMap((x) =>
      [...x.matchAll(/<details><summary>(Checks&#x27; flags that differ \(120\)(?:, continued)?)<\/summary>(.*?)<\/details>/gs)].map((m) => [m[1]!, m[2]!] as const),
    );
    expect(folds.length).toBeGreaterThan(1);
    expect(folds.map(([x]) => x)).toEqual(["Checks&#x27; flags that differ (120)", ...Array(folds.length - 1).fill("Checks&#x27; flags that differ (120), continued")]);
    const shown = folds.flatMap(([, body]) =>
      [...body.matchAll(/^- `H1\/W1` step `([0-9]+)`, check `([0-9]+)` flagged on the head 1 more time than on the base/gm)].map((m) => [Number(m[2]), m[1]]),
    );
    expect(shown).toEqual(Array.from({ length: 120 }, (_, i) => [i + 1, String(i)]));
    expect(whole).not.toContain("The checks' flags that differ between base and head:");
  });

  test("the runs fold lists runs in the harnesss order not by name", async () => {
    const d = t.runDir([
      [
        [result("H1/W1"), result("H1/W2", { record: "differs" }), result("C6h/W11", { record: "differs" })],
        [
          entry("aaaaaaaaaaaa", [
            ["H1/W2", 3],
            ["C6h/W11", 8],
          ]),
        ],
      ],
    ]);
    const text = await t.comment(d, {
      changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a", place: { run: "H1/W2", step: 3 } }],
    });
    expect(text).toContain(
      "<details><summary>Runs whose records differ: 2 of 3, with 1 change</summary>\n\n" +
        "<details><summary><code>H1/W2</code>: 1 change</summary>\n\n*T*\n\nAt step `3`.\n\n" +
        "Before:\n\n```text\nb\n```\n\nAfter:\n\n```text\na\n```\n\n</details>\n\n" +
        "<details><summary><code>C6h/W11</code>: 1 change</summary>\n\n*T*\n\n" +
        "At step `8`. Its before and after are quoted under `H1/W2`, at step `3`.\n\n</details>\n\n</details>",
    );
  });

  test("a delta that follows no earlier one says unmentioned otherwise than true or lacks a line fails naming it", async () => {
    const d = t.changedRun();
    const two = (second: Record<string, Json>): Reader => ({
      changes: [
        { title: "A", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" },
        { title: "B", where: "w", base: "b0", head: "h0", refs: ["bbbbbbbbbbbb"], before: "b", after: "a", ...second },
      ],
    });
    const cases: [Record<string, Json>, string][] = [
      [{ follows: 2 }, "change 'B' follows 2, which isn't an earlier delta's number"],
      [{ follows: 0 }, "change 'B' follows 0"],
      [{ follows: true }, "change 'B' follows True"],
      [{ unmentioned: false }, "change 'B' gives unmentioned as False"],
      [{ unmentioned: 1 }, "change 'B' gives unmentioned as 1"],
      [{ head: " \n " }, "change 'B' gives a head that isn't a line of text"],
      [{ where: null }, "change 'B' gives a where that isn't a line of text"],
      [{ base: "" }, "change 'B' gives a base that isn't a line of text"],
      [{ follows: null }, "change 'B' follows None"],
      [{ unmentioned: null }, "change 'B' gives unmentioned as None"],
      [{ also: "" }, "change 'B' gives an also that isn't a line of text"],
      [{ also: null }, "change 'B' gives an also that isn't a line of text"],
      [{ also: ["x"] }, "change 'B' gives an also that isn't a line of text"],
    ];
    for (const [second, said] of cases) await raises(() => t.comment(d, two(second)), Failed, said);
    await t.comment(d, two({ follows: 1, unmentioned: true }));
  });

  test("a change carried into later requests says where else under its head line", async () => {
    const d = t.changedRun();
    const change = {
      title: "A",
      where: "w",
      base: "b0",
      head: "h0",
      also: "Later requests in\nthat turn carry it, @maintainer, #3 <b>",
      refs: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
      before: "b",
      after: "a",
    };
    const text = await t.comment(d, { changes: [change] });
    expect(text).toContain(
      "- base (`main`): b0.\n- head (`aaaaaaaaaaaa`): h0.\n- Also in: " + inert("Later requests in that turn carry it, @maintainer, #3 <b>") + ".\n\n<details>",
    );
    expect(text).not.toContain(" @maintainer");
    expect(text).not.toContain("<b>");
    const { also: _, ...without } = change;
    const bare = await t.comment(t.changedRun(), { changes: [without] });
    expect(bare).not.toContain("Also in");
  });

  test("a change with no place its quotes are from fails rather than quoting them under a guessed run", async () => {
    const d = t.runDir([
      [
        [result("H1/W1"), result("H1/W2", { record: "differs" }), result("C6h/W11", { record: "differs" })],
        [
          entry("aaaaaaaaaaaa", [
            ["H1/W2", 3],
            ["C6h/W11", 8],
          ]),
        ],
      ],
    ]);
    await t.facts(d);
    const path = join(d, "reader.json");
    writeFileSync(path, dumps({ changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" }] }));
    await raises(() => post({ dir: d, reader: path, post: false, reads: READS }), Failed, "change 'T' names no place its quotes are from");
    expect(existsSync(join(d, "comment.md"))).toBe(false);
  });

  test("a change quoted from a place it doesnt have fails rather than posting quotes no place shows", async () => {
    const d = t.runDir([[[result("H1/W1"), result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 3]])]]]);
    for (const [run, step] of [
      ["H1/W1", 3],
      ["H1/W2", 9],
    ] as const) {
      const reader = { changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a", place: { run, step } }] };
      await raises(() => t.comment(d, reader), Failed, `quoted from \`${run}\` at step \`${step}\`, a place it doesn't have`);
    }
  });

  test("a runs changes too long for one comment continue in the next each fold whole and titled as continued", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await post({ dir: d, reader: t.write(d, t.four("w")), post: false, reads: READS });
    const texts = partsIn(d);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((x) => cpLength(x) <= COMMENT_MAX)).toBe(true);
    const nested = texts.flatMap((x) => nesting(x));
    for (const [summary, parent] of nested) {
      expect([summary, parent === null]).toEqual([summary, !summary.startsWith("<code>")]);
      if (parent !== null) expect([summary, parent.startsWith("Runs whose records differ: 2 of 3, with 4 changes")]).toEqual([summary, true]);
    }
    const whole = texts.join("\n\n");
    const folds = nested.map(([summary]) => summary);
    const outer = folds.filter((f) => f.startsWith("Runs whose records differ"));
    expect(outer.length).toBeGreaterThan(1);
    expect(outer).toEqual(["Runs whose records differ: 2 of 3, with 4 changes", ...Array(outer.length - 1).fill("Runs whose records differ: 2 of 3, with 4 changes, continued")]);
    expect(nested).toContainEqual(["<code>H1/W1</code>: 4 changes, continued", "Runs whose records differ: 2 of 3, with 4 changes, continued"]);
    const runs = folds.filter((f) => f.startsWith("<code>"));
    expect(runs[0]).toBe("<code>H1/W1</code>: 4 changes");
    expect(runs).toContain("<code>H1/W1</code>: 4 changes, continued");
    expect(runs.at(-1)).toBe("<code>H1/W2</code>: 4 changes");
    expect([...whole.matchAll(/^\*(C[0-9])\*$/gm)].map((m) => m[1])).toEqual(["C0", "C1", "C2", "C3", "C0", "C1", "C2", "C3"]);
    expect(count(whole, "```text\n" + "x".repeat(20_000) + "\n```")).toBe(8);
  });

  test("a later change too long for its continued runs collapsible cuts its quote and every part fits", async () => {
    const d = t.changedRun();
    await t.facts(d);
    const reader = t.four("w");
    reader.changes[3]!.before = "y".repeat(70_000);
    await post({ dir: d, reader: t.write(d, reader), post: false, reads: READS });
    const texts = partsIn(d);
    expect(texts.every((x) => cpLength(x) <= COMMENT_MAX)).toBe(true);
    const cuts = texts.filter((x) => x.includes("Before, its first"));
    expect(cuts.length).toBe(1);
    const shown = /\*C3\*\n\nAt step `7`\.\n\nBefore, its first ([0-9,]+) of 70,000 characters:\n\n```text\n(y+)\n```/.exec(cuts[0]!);
    expect(shown).not.toBeNull();
    expect(Number(shown![1]!.replaceAll(",", ""))).toBe(shown![2]!.length);
    const runs = nesting(cuts[0]!).filter((n) => n[0].startsWith("<code>H1/W1</code>"));
    expect(runs).toEqual([["<code>H1/W1</code>: 4 changes, continued", "Runs whose records differ: 2 of 3, with 4 changes, continued"]]);
  });

  test("a runs name holding blank lines or markdown stays one line of code in its collapsibles summary", () => {
    const run = "H1\n\n[click](https://example.com)\n\n<b>Z</b>";
    const entries = new Map<string, Json>([["aaaaaaaaaaaa", { places: [{ run, step: 1 }] }]]);
    const reader = {
      changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a", place: { run, step: 1 } }],
    };
    const folds = runFolds({ order: [run] }, reader, entries, 10_000);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.startsWith("<details><summary><code>H1 [click](https://example.com) &lt;b&gt;Z&lt;/b&gt;</code>: 1 change</summary>\n\n*T*")).toBe(true);
  });

  test("folded continues a list too long for one comment in order each fold titled and within room", () => {
    const items = Array.from({ length: 40 }, (_, i) => `- \`R${i}\`: *T* at step \`${i}\`.`);
    const room = 400;
    const folds = folded("Runs whose records differ (40 of 40)", items, room);
    expect(folds.length).toBeGreaterThan(1);
    expect(folds.every((f) => cpLength(f) <= room)).toBe(true);
    const titles = folds.map((f) => /^<details><summary>([^<]*)<\/summary>/.exec(f)![1]);
    expect(titles).toEqual(["Runs whose records differ (40 of 40)", ...Array(folds.length - 1).fill("Runs whose records differ (40 of 40), continued")]);
    expect(folds.flatMap((f) => f.split("\n\n").filter((line) => line.startsWith("- ")))).toEqual(items);
  });

  test("folded takes a first item that fits under the first title only", () => {
    const title = "Runs whose records differ (1 of 1)";
    const room = cpLength(`<details><summary>${title}</summary>\n\n\n\n</details>`) + 40;
    const one = "x".repeat(40);
    expect(folded(title, [one], room)).toEqual([`<details><summary>${title}</summary>\n\n${one}\n\n</details>`]);
    expect(() => folded(title, [one, one], room)).toThrow(Failed);
    expect(() => folded(title, [one, one], room)).toThrow(/doesn't fit/);
  });

  test("one changed run with every run compared and no flag says so above with no clause", async () => {
    const d = t.runDir([[[result("H1/W1", { record: "differs" }), result("H1/W2"), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 4]])]]]);
    const text = await t.comment(d, { changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" }] });
    expect(text).toContain(
      "/CHECKS.md).\n\nThe records of 1 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
        "*A model's account of those records:*\n\n**Delta 1: T**\n\nw.\n\n- base (`main`): b0.\n- head (`aaaaaaaaaaaa`): h0." +
        "\n\n<details>",
    );
    expect(text).toContain("<details><summary>Runs whose records differ: 1 of 3, with 1 change</summary>\n\n" + "<details><summary><code>H1/W1</code>: 1 change</summary>\n\n");
    expect(text).not.toContain("couldn't be compared");
    expect(text).not.toContain("Checks&#x27; flags");
  });

  test("where both arms forced one range a line after the count says so and that a difference or a failure may come from it", async () => {
    const ask = (has: string) => ({ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has });
    const d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [ask("0.26.0")], head: [ask("0.26.1")] } });
    const view = await t.facts(d);
    expect([view.forced, view.pack]).toEqual([{ base: [ask("0.26.0")], head: [ask("0.26.1")] }, "@animalabs/context-manager"]);
    const said =
      "In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework, a range that neither the base's `0.26.0` nor " +
      "the head's `0.26.1` meets: it could choose no release of agent\\-framework that admits them. So any difference or failure this view shows may come from that range, and the view can't tell whether it does.";
    expect(await t.comment(d)).toContain(`The records of the 3 runs don't differ between the base and this head.\n\n${said}\n\n${ALL_RAN}`);
  });

  test("where one arm forced a range the line names that arm and that a difference may come from it", async () => {
    const ask = { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" };
    const d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [], head: [ask] } });
    const said =
      "In the head, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: " +
      "it could choose no release of agent\\-framework that admits it. So any difference this view shows, or any failure in the head, may come from that range, and the view can't tell whether it does.";
    expect(await t.comment(d)).toContain(`The records of the 3 runs don't differ between the base and this head.\n\n${said}\n\n${ALL_RAN}`);
    const base = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [ask], head: [] } });
    expect(await t.comment(base)).toContain(
      "In the base, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: " +
        "it could choose no release of agent\\-framework that admits it. So any difference this view shows, or any failure in the base or of a checkpoint, may come from that range, and the view can't tell whether it does.",
    );
    expect(await t.comment(base)).not.toContain("any failure in the head");
    expect(await t.comment(d)).not.toContain("checkpoint");
    const plain = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]]);
    expect(Object.hasOwn(await t.facts(plain), "forced")).toBe(false);
    expect(resultOf(await t.facts(d))).not.toBe(resultOf(await t.facts(plain)));
  });

  test("the forced line speaks of those ranges where there are more than one", async () => {
    const ask = (has: string, wanted = `node_modules/${AF}`, range = "^0.25.0") => ({ range, wantedBy: wanted, has });
    const two = [ask("0.26.0"), ask("0.26.0", "node_modules/@animalabs/chronicle", "^0.24.0 || ^0.25.0")];
    let d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: two, head: two } });
    expect(await t.comment(d)).toContain(
      "ranges that neither the base's `0.26.0` nor the head's `0.26.0` meets: it could choose no release of agent\\-framework and chronicle that admits them. " +
        "So any difference or failure this view shows may come from those ranges, and the view can't tell whether it does.",
    );
    d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [], head: two } });
    expect(await t.comment(d)).toContain(
      "ranges that version doesn't meet: it could choose no release of agent\\-framework and chronicle that admits it. " +
        "So any difference this view shows, or any failure in the head, may come from those ranges, and the view can't tell whether it does.",
    );
    expect(await t.comment(d)).not.toContain("No resident");
  });

  test("where both arms forced differently each arm is said with its own version askers and ranges", async () => {
    const d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], {
      forced: {
        base: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" }],
        head: [
          { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.27.0" },
          { range: "^0.26.0", wantedBy: "node_modules/@animalabs/membrane", has: "0.27.0" },
        ],
      },
    });
    const said =
      "In the base, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: it " +
      "could choose no release of agent\\-framework that admits it. In the head, the view laid context\\-manager `0.27.0` over `^0.25.0` from " +
      "agent\\-framework and `^0.26.0` from membrane, ranges that version doesn't meet: it could choose no release of agent\\-framework and " +
      "membrane that admits it. So any difference this view shows may come from the ranges named for either arm, and the view can't tell whether it does. Any failure in an arm may come from that arm's own ranges. " +
      "A checkpoint's failure may come from the base's ranges. The view can't tell whether either does.";
    expect(await t.comment(d)).toContain(`\n\n${said}\n\n`);
  });

  test("an asker the view chose is named as a package where no release of it could be chosen and once", async () => {
    const d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], {
      forced: {
        base: [],
        head: [
          { range: "^0.34.0", wantedBy: `${AF}@0.33.0`, has: "0.26.0" },
          { range: ">=0.25.0 <0.26.0", wantedBy: `${AF}@0.33.0`, has: "0.26.0" },
        ],
      },
    });
    expect(await t.comment(d)).toContain(
      "over `^0.34.0` from agent\\-framework `0.33.0` and `>=0.25.0 <0.26.0` from agent\\-framework `0.33.0`, ranges that version " +
        "doesn't meet: it could choose no release of agent\\-framework that admits it.",
    );
  });

  test("the same forced ranges in another order in each arm are said as both arms alike", async () => {
    const a = { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" };
    const b = { range: "^0.24.0 || ^0.25.0", wantedBy: "node_modules/@animalabs/chronicle", has: "0.26.0" };
    const d = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [a, b], head: [b, a] } });
    expect(await t.comment(d)).toContain(
      "In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework and `^0.24.0 || ^0.25.0` from chronicle, " +
        "ranges that neither the base's `0.26.0` nor the head's `0.26.0` meets",
    );
  });

  test("where none of its runs could be compared the forced line still says what the view laid and that a failure may come from it", async () => {
    const ask = { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" };
    const d = t.runDir([[["H1/W1", "H1/W2", "C6h/W11"].map((run) => result(run, { outcome: "couldnt-run", reason: "x" })), []]], { forced: { base: [ask], head: [ask] } });
    expect(await t.comment(d)).toContain(
      "In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework, a range that neither the base's `0.26.0` nor " +
        "the head's `0.26.0` meets: it could choose no release of agent\\-framework that admits them. So any difference or failure this view shows may come from that range, and the view can't tell whether it does.",
    );
  });

  test("a nested copy that asks is named as the copy it is and said to be one the view chooses no release of", async () => {
    const forced = (head: Json[]) => t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]], { forced: { base: [], head } });
    const said = await t.comment(forced([{ range: "^0.25.0", wantedBy: "node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane", has: "0.26.0" }]));
    expect(said).toContain(
      "In the head, the view laid context\\-manager `0.26.0` over `^0.25.0` from chronicle's membrane, a range that version doesn't " +
        "meet: the view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's " +
        "lockfile holds them at its top level, so it couldn't choose a release of chronicle's membrane.",
    );
    expect(said).not.toContain("could choose no release of chronicle");
    const two = forced([
      { range: "^0.25.0", wantedBy: "node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane", has: "0.26.0" },
      { range: "^0.24.0", wantedBy: "node_modules/@animalabs/mcpl", has: "0.26.0" },
    ]);
    expect(await t.comment(two)).toContain("so it couldn't choose a release of chronicle's membrane and mcpl.");
    const workspace = forced([{ range: "^0.24.0", wantedBy: "packages/plugin", has: "0.26.0" }]);
    expect(await t.comment(workspace)).toContain(
      "over `^0.24.0` from packages\\/plugin, a range that version doesn't meet: the view chooses releases only of agent-framework, " +
        "context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so it couldn't choose a " +
        "release of packages\\/plugin.",
    );
    const both = forced([
      { range: "^0.25.0", wantedBy: "node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane", has: "0.26.0" },
      { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" },
    ]);
    expect(await t.comment(both)).toContain(
      "ranges that version doesn't meet: it could choose no release of agent\\-framework that admits it, and the view chooses releases only " +
        "of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so it " +
        "couldn't choose a release of chronicle's membrane.",
    );
  });

  test("where the arms ran different releases besides the head a line after the count says which why and that a difference may be theirs", async () => {
    const stack = {
      base: {},
      head: {
        [M]: {
          version: "0.9.0",
          host: "0.8.0",
          ranges: [
            { range: "^0.9.0", wantedBy: null },
            { range: "^0.8.0 || ^0.9.0", wantedBy: `node_modules/${AF}` },
          ],
          missed: { package: M, range: "^0.9.0", wantedBy: null, has: "0.8.0" },
        },
      },
    };
    const d = t.chosenRun({}, { membrane: "0.9.0 (sha512-m)" }, stack);
    const view = await t.facts(d);
    expect([view.differing, view.held]).toEqual([[{ package: "membrane", base: "0.8.0", head: "0.9.0" }], { "agent-framework": "0.32.0", chronicle: "0.5.1" }]);
    const said =
      "Besides this head, the arms ran different releases of membrane: `0.8.0` in the base and `0.9.0` in the head. The view " +
      "chose the head's membrane `0.9.0`, since connectome-host's lockfile holds `0.8.0`, which doesn't meet `^0.9.0` from this head. So a " +
      "difference this view shows may come from membrane as well as from this head, and it can't tell which.";
    expect(await t.comment(d)).toContain(
      `The records of the 3 runs don't differ between the base and this head.\n\n${said}\n\n${ALL_RAN}\n\nHeld the same in base and head: ` +
        "connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`.",
    );
    const changed = t.chosenRun({}, { membrane: "0.9.0 (sha512-m)" }, stack, entry("aaaaaaaaaaaa", [["H1/W1", 4]]));
    const text = await t.comment(changed, { changes: [{ title: "T", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b", after: "a" }] });
    expect(text).toContain(`The records of 1 of the 3 runs differ between the base and this head.\n\n${said}\n\n${ALL_RAN}\n\n*A model's account of those records:*`);
    const asker = {
      base: {},
      head: {
        [AF]: {
          version: "0.34.0",
          host: "0.32.0",
          ranges: [],
          asks: "^0.24.0 || ^0.25.0",
          missed: { package: "@animalabs/context-manager", range: "^0.24.0", wantedBy: `node_modules/${AF}`, has: "0.25.0" },
        },
      },
    };
    expect(await t.comment(t.chosenRun({}, { "agent-framework": "0.34.0 (sha512-a)" }, asker))).toContain(
      "Besides this head, the arms ran different releases of agent\\-framework: `0.32.0` in the base and `0.34.0` in the head. " +
        "The view chose the head's agent\\-framework `0.34.0`, since connectome-host's lockfile holds `0.32.0`, and with it " +
        "agent\\-framework asks for context\\-manager `^0.24.0`, which the head's `0.25.0` doesn't meet. So a difference this view shows may come from " +
        "agent\\-framework as well as from this head, and it can't tell which.",
    );
    const both = {
      base: { [M]: { version: "0.7.9", host: "0.8.0", ranges: [{ range: "~0.7.9", wantedBy: null }], missed: { package: M, range: "~0.7.9", wantedBy: null, has: "0.8.0" } } },
      head: {
        [M]: { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }] },
        [AF]: {
          version: "0.34.0",
          host: "0.32.0",
          ranges: [{ range: "^0.34.0", wantedBy: `${M}@0.9.0` }],
          missed: { package: AF, range: "^0.34.0", wantedBy: `${M}@0.9.0`, has: "0.32.0" },
        },
      },
    };
    expect(await t.comment(t.chosenRun({ membrane: "0.7.9 (sha512-o)" }, { membrane: "0.9.0 (sha512-m)", "agent-framework": "0.34.0 (sha512-a)" }, both))).toContain(
      "Besides this head, the arms ran different releases of agent\\-framework and membrane: agent\\-framework `0.32.0` in the " +
        "base and `0.34.0` in the head; membrane `0.7.9` in the base and `0.9.0` in the head. The view chose the head's " +
        "agent\\-framework `0.34.0`, since connectome-host's lockfile holds `0.32.0`, which doesn't meet `^0.34.0` from membrane `0.9.0`. The view chose " +
        "the base's membrane `0.7.9`, since connectome-host's lockfile holds `0.8.0`, which doesn't meet `~0.7.9` from the base. The view chose the head's " +
        "membrane `0.9.0`, where connectome-host's lockfile has `0.8.0`. So a difference this view shows may come from " +
        "agent\\-framework and membrane as well as from this head, and it can't tell which.",
    );
  });

  test("a release both arms ran that the plan chose is held saying why and no line above", async () => {
    const chosen = { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.8.1", wantedBy: null }] };
    const missed = { ...chosen, missed: { package: M, range: "^0.8.1", wantedBy: null, has: "0.8.0" } };
    const cases: [Json, string][] = [
      [{ base: { [M]: chosen }, head: { [M]: missed } }, "since connectome-host's lockfile holds `0.8.0`, which doesn't meet `^0.8.1` from this head"],
      [{ base: { [M]: chosen }, head: { [M]: chosen } }, "where connectome-host's lockfile has `0.8.0`"],
    ];
    for (const [stack, why] of cases) {
      const d = t.chosenRun({ membrane: "0.9.0 (sha512-m)" }, { membrane: "0.9.0 (sha512-m)" }, stack);
      const view = await t.facts(d);
      expect(view.held).toEqual({ "agent-framework": "0.32.0", chronicle: "0.5.1", membrane: "0.9.0" });
      expect(Object.hasOwn(view, "differing")).toBe(false);
      const text = await t.comment(d);
      expect(text).toContain("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`, " + `membrane \`0.9.0\` (the view chose it for both arms, ${why}).`);
      expect(text).not.toContain("Besides this head");
    }
  });

  test("no entry differing in runs all compared says the records show no request changed then what was held", async () => {
    const text = await t.comment(t.unchangedRun({ quarantines: { compression: 0, merge: 1 } }));
    const top =
      OPENING +
      LINKED +
      "The records of the 3 runs don't differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
      "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, ";
    expect(text.slice(0, top.length)).toBe(top);
    expect(text.split("\n\n").length).toBe(6);
    expect(text).not.toContain("<details>");
  });

  test("a part an arms stack can t run is named with its run and arm after the count so no reader takes it for one that passed", async () => {
    const bump = t.runDir([
      [
        [result("H1/W1", { record: "differs", baseAbsent: ["suppression", "onboarding"] }), result("H1/W2"), result("C6h/W11")],
        [entry("aaaaaaaaaaaa", [["H1/W1", 3]])],
      ],
    ]);
    expect(await t.comment(bump, t.reader(["aaaaaaaaaaaa"]))).toContain(
      "The records of 1 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
        "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s suppression and onboarding on the base.\n\n" +
        "*A model's account of those records:*",
    );
    const both = t.runDir([
      [[result("H1/W1", { absent: ["suppression", "onboarding"], baseAbsent: ["suppression", "onboarding"] }), result("H1/W2"), result("C6h/W11")], []],
    ]);
    expect(await t.comment(both)).toContain(
      "The records of the 3 runs don't differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n" +
        "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s suppression and onboarding on the base; " +
        "`H1/W1`'s suppression and onboarding on the head.\n\n",
    );
    expect(await t.comment(t.unchangedRun())).not.toContain("Parts left out");
    const part = t.runDir([[[result("H1/W1", { record: "differs", absent: ["conversations"] }), result("H1/W2"), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 3]])]]]);
    expect(await t.comment(part, t.reader(["aaaaaaaaaaaa"]))).toContain(
      "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s conversations on the head.\n\n",
    );
  });

  test("every kind of view links checks md at its own harness commit first and says what was held last", async () => {
    const link = `What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/${HARNESS}/CHECKS.md).`;
    const changed = t.changedRun();
    const shapes: [string, string][] = [
      ["unchanged", await t.comment(t.unchangedRun())],
      ["unmerged", await t.comment(t.runDir([[[], []]], { outcome: "doesnt-merge" }))],
      ["none compared", await t.comment(t.runDir([[["H1/W1", "H1/W2", "C6h/W11"].map((run) => result(run, { outcome: "couldnt-run", reason: "x" })), []]]))],
      ["read", await t.comment(changed, t.reader(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]))],
    ];
    for (const [shape, text] of shapes) {
      const paragraphs = text.split("\n\n");
      expect([shape, paragraphs[1]]).toEqual([shape, link]);
      expect([shape, count(text, link)]).toEqual([shape, 1]);
      expect([shape, paragraphs.at(-2)!.startsWith("Held the same in base and head:")]).toEqual([shape, shape !== "unmerged"]);
      for (const gone of ["About this view", "Between them", "good faith"]) expect(text).not.toContain(gone);
    }
  });

  test("a run whose outcome the view doesnt know isnt compared and says why and the known ones are", async () => {
    const d = t.runDir([[[result("H1/W1", { outcome: "exploded" }), result("H1/W2", { outcome: "flags" }), result("C6h/W11", { outcome: "invalid" })], []]]);
    const view = await t.facts(d);
    expect(view.runs).toEqual({ total: 3, compared: 2 });
    const text = await t.comment(d);
    expect(text).toContain("couldn't be compared at `H1/W1`: the harness gave it an outcome the view doesn't know (exploded).");
    const none = t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11", { outcome: "skipped", record: null })], []]]);
    expect(await t.comment(none)).toContain("couldn't be compared at `C6h/W11`: the harness gave it an outcome the view doesn't know (skipped).");
    expect(text.split("The records of")[0]).not.toContain("`H1/W2`");
  });

  test("each kind of head that couldnt be compared says which in fixed words with no reader", async () => {
    const cases: [string, Json, string][] = [
      [
        "doesnt-merge",
        null,
        `This head couldn't be compared: it conflicts with \`main\` at \`${BASE.slice(0, 12)}\`, and a view ` +
          "runs the head merged onto its base, so those conflicts need resolving before it can be " +
          "viewed.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "^0.9.0", wantedBy: null, has: "0.8.0", why: "no-release", release: M, ranges: [{ range: "^0.9.0", wantedBy: null }] },
        "This head couldn't be compared: it asks for membrane `^0.9.0`, and no published release of membrane meets it.",
      ],
      [
        "needs-companion",
        {
          arm: "base",
          package: M,
          range: "^0.9.0",
          wantedBy: null,
          has: "0.8.0",
          why: "no-release",
          release: M,
          ranges: [
            { range: "^0.9.0", wantedBy: null },
            { range: "^0.8.0", wantedBy: "node_modules/@animalabs/agent-framework" },
            { range: "~0.9.1", wantedBy: "@animalabs/chronicle@0.7.0" },
          ],
        },
        "This head couldn't be compared: its base asks for membrane `^0.9.0`, and no published release of membrane meets every " +
          "range on it in the base's stack (`^0.9.0` from the base, `^0.8.0` from agent\\-framework and `~0.9.1` from chronicle " +
          "`0.7.0`).",
      ],
      [
        "needs-companion",
        {
          arm: "head",
          package: "@animalabs/chronicle",
          range: "^0.7.0",
          wantedBy: `${AF}@0.34.0`,
          has: "0.6.0",
          why: "no-release",
          release: "@animalabs/chronicle",
          ranges: [{ range: "^0.7.0", wantedBy: `${AF}@0.34.0` }],
        },
        "This head couldn't be compared: agent\\-framework `0.34.0`, which the view chose for the head, asks for chronicle `^0.7.0`, " +
          "and no published release of chronicle meets it.",
      ],
      [
        "needs-companion",
        { arm: "head", package: "@animalabs/chronicle", range: "^0.7.0", wantedBy: `${AF}@0.34.0`, has: "0.6.0", why: "no-release", release: "@animalabs/chronicle", ranges: [] },
        "This head couldn't be compared: agent\\-framework `0.34.0`, which the view chose for the head, asks for chronicle `^0.7.0`, " +
          "and chronicle has no published release.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "github:antra-tess/membrane#v0.9.0", wantedBy: null, has: "0.8.0", why: "not-plain" },
        "This head couldn't be compared: it asks for membrane `github:antra-tess/membrane#v0.9.0`, which isn't a version range, so " +
          "the view can't choose a release to meet it.",
      ],
      [
        "needs-companion",
        { arm: "base", package: M, version: "0.9.0", range: "^0.8.0", wantedBy: "node_modules/optional-user", has: "0.9.0", why: "no-mover" },
        "This head couldn't be compared: optional\\-user in the host's stack asks for membrane `^0.8.0`, and the base's is " +
          "`0.9.0`. The view chooses releases only of agent-framework, context-manager, membrane and chronicle where " +
          "connectome-host's lockfile holds them at its top level, so it can't change that.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "^0.8.0", wantedBy: "node_modules/@animalabs/agent-framework", has: null, why: "no-mover" },
        "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and the head's " + "`package.json` gives no version.",
      ],
      [
        "needs-companion",
        {
          arm: "base",
          package: "@animalabs/chronicle",
          range: "0.6.0",
          wantedBy: "@animalabs/context-manager@0.25.0",
          has: "0.7.0",
          why: "unsettled",
          tried: { "@animalabs/context-manager": "0.25.0", "@animalabs/chronicle": "0.6.0" },
        },
        "This head couldn't be compared: context\\-manager `0.25.0`, which the view chose for the base, asks for chronicle `0.6.0`, " +
          "and choosing releases for the arms came back to choices it had already made, so it stopped there. The base's were " +
          "chronicle `0.6.0` and context\\-manager `0.25.0`.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "^0.8.0", wantedBy: `node_modules/${AF}`, has: "0.9.0", why: "unsettled", tried: {} },
        "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and choosing releases for " +
          "the arms came back to choices it had already made, so it stopped there.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "^0.8.0", wantedBy: "packages/tools", has: "0.9.0", why: "no-mover" },
        "This head couldn't be compared: packages\\/tools in the host's stack asks for membrane `^0.8.0`, and the head's is `0.9.0`. " +
          "The view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's " +
          "lockfile holds them at its top level, so it can't change that.",
      ],
      [
        "needs-companion",
        { arm: "head", package: M, range: "^0.8.0", wantedBy: "node_modules/@animalabs/mcpl-core", has: "0.9.0", why: "no-mover" },
        "This head couldn't be compared: mcpl\\-core in the host's stack asks for membrane `^0.8.0`, and the head's is `0.9.0`. " +
          "The view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's " +
          "lockfile holds them at its top level, so it can't change that.",
      ],
      [
        "needs-companion",
        { arm: "head", package: "@animalabs/mcpl-core", range: "^0.5.0", wantedBy: null, has: "0.4.0", why: "no-mover" },
        "This head couldn't be compared: it asks for mcpl\\-core `^0.5.0`, and the head's is `0.4.0`. The view chooses releases only " +
          "of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so " +
          "it can't change that.",
      ],
      [
        "arm-missing",
        { share: 2, arm: "after", log: "boot failed: @x port in use" },
        "This head couldn't be compared: one of its 2 jobs came back without the head arm's results (its last log line: " + "boot failed\\: `@x` port in use).",
      ],
      ["arm-missing", { share: 1, arm: "before", log: null }, "This head couldn't be compared: one of its 2 jobs came back without the base arm's results."],
    ];
    for (const [outcome, detail, said] of cases) {
      const d = t.runDir(
        [
          [[], []],
          [[], []],
        ],
        { outcome, detail },
      );
      const text = await t.comment(d);
      expect([outcome, text.split("\n\n").slice(1, 3)]).toEqual([
        outcome,
        [`What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/${HARNESS}/CHECKS.md).`, said],
      ]);
      expect(text).not.toContain("This view");
    }
  });

  test("a head that conflicts with a stacked base names that branch", async () => {
    const d = t.runDir([[[], []]], { outcome: "doesnt-merge" });
    const path = join(d, "manifest.json");
    const m = readJson(path) as Record<string, Json>;
    writeFileSync(path, dumps({ ...m, base: { ...(m.base as Record<string, Json>), ref: "stack/@x-part-1" } }));
    expect(await t.comment(d)).toContain(`it conflicts with \`stack/@x-part-1\` at \`${BASE.slice(0, 12)}\`, and a view runs`);
  });

  test("a head that doesnt merge is named against the base not merged onto it", async () => {
    const text = await t.comment(t.runDir([[[], []]], { outcome: "doesnt-merge" }));
    expect(text.startsWith(`**Automatic context view** of \`${H1.slice(0, 12)}\` against \`${BASE.slice(0, 12)}\`.`)).toBe(true);
    expect(text).not.toContain("Held the same");
  });

  test("a head run without a self check or whose drive with recording off couldnt show it says which and why", async () => {
    const unchecked = result("H1/W1", { check: null });
    const drive = result("H1/W2", { check: "couldnt-run" });
    (drive.selfCheck as Record<string, Json>).reason = "it logged 3 compiles with recording off";
    const text = await t.comment(t.runDir([[[unchecked, drive, result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the head wasn't self-checked.");
    expect(text).toContain(
      "couldn't be compared at `H1/W2`: the head's second drive, with recording off, couldn't show that recording " + "changes nothing it sends (it logged 3 compiles with recording off).",
    );
  });

  test("a run either arm couldnt run or whose records varied is left out of the comparison and named", async () => {
    const missing = t.runDir([[[result("H1/W1"), result("H1/W2", { record: "missing" }), result("C6h/W11")], []]]);
    const some = await t.comment(missing);
    expect(some).toContain("The records of the 2 runs it could compare don't differ between the base and this head.");
    expect(some).not.toContain("Between them");
    const d = t.runDir([
      [
        [
          result("H1/W1", { outcome: "couldnt-run", reason: "the store @x was unreadable" }),
          result("H1/W2", { record: "missing" }),
          { ...result("C6h/W11", { check: null }), selfCheck: { outcome: "differs", at: 0, detail: "no request bodies were saved in /w/on" } },
        ],
        [entry("aaaaaaaaaaaa", [["C6h/W11", 1]])],
      ],
    ]);
    const text = await t.comment(d);
    expect(text).toContain("couldn't be compared at `H1/W1`: the head couldn't run it (the store `@x` was unreadable).");
    expect(text).toContain("couldn't be compared at `H1/W2`: the base couldn't run it.");
    expect(text).toContain(
      "couldn't be compared at `C6h/W11`: its self-check, which drives this head again with recording off, didn't " +
        "find the two drives' requests the same, so a difference from the base can't be put down to the change alone " +
        `(${inert("no request bodies were saved in /w/on")}).`,
    );
    expect(text).not.toContain("requests differed");
    expect(text).not.toContain("don't differ between the base and this head");
    expect(text).not.toContain("it could compare");
  });

  test("a run the base couldnt run gives the bases own reason and never the heads", async () => {
    const said = { ...result("H1/W2", { record: "missing", reason: "the head arm said this too" }), baseReason: "its checkpoint failed: H1/W2 exited 1" };
    const heads = { ...result("H1/W1", { record: "missing" }), reason: "the head arm said this" };
    const silent = { ...result("C6h/W11", { record: "missing" }), baseReason: "" };
    let text = await t.comment(t.runDir([[[heads, said, silent], []]]));
    expect(text).toContain("couldn't be compared at `H1/W2`: the base couldn't run it (its checkpoint failed\\: H1\\/W2 exited 1).");
    expect(text).toContain("couldn't be compared at `H1/W1`: the base couldn't run it.");
    expect(text).toContain("couldn't be compared at `C6h/W11`: the base couldn't run it.");
    expect(text).not.toContain("the head arm said this");
    const head = { ...result("H1/W1", { outcome: "couldnt-run", reason: "the store was unreadable" }), baseReason: "the base arm said this" };
    text = await t.comment(t.runDir([[[head, result("H1/W2"), result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the head couldn't run it (the store was unreadable).");
    expect(text).not.toContain("the base arm said this");
  });

  test("a run whose read failed on either arm is left out of the comparison naming the arm and the read", async () => {
    const heads = result("H1/W1", { record: "differs" });
    heads.readsFailed = ["messages", "receipt"];
    heads.baseReadsFailed = ["summaries"];
    const q = result("H1/W2", { quarantines: { compression: "unreadable", merge: 0 } });
    const text = await t.comment(t.runDir([[[heads, q, result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 1]])]]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the head's reads of messages and receipt, and the base's read of summaries, " + "failed.");
    expect(text).toContain("couldn't be compared at `H1/W2`: the head's quarantine count couldn't be read.");
    expect(text).not.toMatch(/(?<!don't) differ between the base and this head\./);
  });

  test("a run that failed gives the failing arms own reason from its run level check 1 flag", async () => {
    const failure = (text: string, whole: string | null = null) => ({ check: 1, step: "the run", detail: `the run failed: ${text}`, ...(whole ? { whole } : {}) });
    const later = { check: 1, step: "s2", detail: "unclassified request: its last message carries none of step s2's canaries" };
    const other = { check: 1, step: "the run", detail: "the host raised an operator alert" };
    const stepped = { check: 1, step: "s1", detail: "the run failed: a step-level flag with the prefix" };
    const checked = { check: 11, step: "the run", detail: "the run failed: another check with the prefix" };
    const flags = (n: Json[], g: Json[], k: Json[]) => ({ new: n, gone: g, kept: k });
    const head = {
      ...result("H1/W1", { outcome: "flags", flags: flags([other, stepped, checked, failure("the stand-in got a request it couldn't classify (r6)"), later], [], []) }),
      unmeasured: ["the run failed"],
    };
    const base = { ...result("H1/W2", { flags: flags([], [failure("boot 1 exited 1")], []) }), baseUnmeasured: ["the run failed"] };
    const apart = {
      ...result("C6h/W11", { outcome: "flags", flags: flags([failure("the head said this")], [failure("the base said this")], []) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["the run failed"],
    };
    const alike = { ...result("H1/W1", { outcome: "flags", flags: flags([], [], [failure("both said this")]) }), unmeasured: ["the run failed"], baseUnmeasured: ["the run failed"] };
    const mixed = {
      ...result("H1/W1", { outcome: "flags", flags: flags([failure("the head said this")], [], []) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["its folds were clamped (check 10)"],
    };
    const judged = {
      ...result("H1/W2", { outcome: "flags", flags: flags([failure("the head said this")], [], []) }),
      unmeasured: ["the run failed", "check 4 (coverage) judged nothing"],
    };
    const text = await t.comment(t.runDir([[[head, base, apart], []]]));
    const others = await t.comment(t.runDir([[[mixed, judged, result("C6h/W11")], []]]));
    const one = {
      ...result("H1/W2", { outcome: "flags", flags: flags([failure("only the head said why")], [], []) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["the run failed"],
    };
    const both = await t.comment(t.runDir([[[alike, one, result("C6h/W11")], []]]));
    const cutApart = {
      ...result("H1/W1", { outcome: "flags", flags: flags([failure("alike up to the cut", "aaaaaaaaaaaa")], [failure("alike up to the cut", "bbbbbbbbbbbb")], []) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["the run failed"],
    };
    const cutAlike = {
      ...result("H1/W2", { outcome: "flags", flags: flags([], [], [failure("cut the same", "cccccccccccc")]) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["the run failed"],
    };
    const paired = {
      ...result("C6h/W11", { outcome: "flags", flags: flags([failure("said alike")], [failure("said alike")], []) }),
      unmeasured: ["the run failed"],
      baseUnmeasured: ["the run failed"],
    };
    const cut = await t.comment(t.runDir([[[cutApart, cutAlike, paired], []]]));
    const q = (parts: string[]) => inert(parts.join("'"));
    expect(cut).toContain(`(${q(["the head", "s run failed: alike up to the cut (cut by the harness); the base", "s run failed: alike up to the cut (cut by the harness)"])}).`);
    expect(cut).toContain(`(${q(["both arms", " runs failed: cut the same (cut by the harness)"])}).`);
    expect(cut).toContain(`(${q(["both arms", " runs failed: said alike"])}).`);
    expect(text).toContain(
      "couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed) " + `(${q(["the head", "s run failed: the stand-in got a request it couldn", "t classify (r6)"])}).`,
    );
    expect(text).toContain(`couldn't be compared at \`H1/W2\`: the run didn't measure (on the base, the run failed) (${q(["the base", "s run failed: boot 1 exited 1"])}).`);
    expect(text).toContain(
      "couldn't be compared at `C6h/W11`: the run didn't measure (on the head, the run failed; on the base, the run failed) " +
        `(${q(["the head", "s run failed: the head said this; the base", "s run failed: the base said this"])}).`,
    );
    expect(both).toContain(
      "couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, the run failed) " + `(${q(["both arms", " runs failed: both said this"])}).`,
    );
    expect(both).toContain(
      "couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed; on the base, the run failed) " +
        `(${q(["the head", "s run failed: only the head said why"])}).`,
    );
    expect(others).toContain(
      "couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, its folds were clamped " +
        `\\(check 10\\)) (${q(["the head", "s run failed: the head said this"])}).`,
    );
    expect(others).toContain(
      "couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed and check 4 \\(coverage\\) judged " + `nothing) (${q(["the head", "s run failed: the head said this"])}).`,
    );
    expect(text).not.toContain("operator alert");
    expect(text).not.toContain("unclassified request");
    expect(text).not.toContain("with the prefix");
  });

  test("a run that didnt measure and whose read failed says both", async () => {
    const r = { ...result("H1/W1"), unmeasured: ["the run failed"], baseReadsFailed: ["summaries"] };
    const text = await t.comment(t.runDir([[[r, result("H1/W2"), result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed), and the base's read of " + "summaries failed.");
  });

  test("a run that didnt measure and whose quarantine count couldnt be read says both", async () => {
    const r = { ...result("H1/W1", { quarantines: { compression: "unreadable", merge: 0 } }), unmeasured: ["the run failed"] };
    const text = await t.comment(t.runDir([[[r, result("H1/W2"), result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed), and the head's quarantine " + "count couldn't be read.");
  });

  test("a flag list too long for one comment goes on in the next", async () => {
    const flags = { new: Array.from({ length: 120 }, (_, i) => ({ check: i + 1, step: String(i), what: "w", detail: "d".repeat(900) })), gone: [], kept: [] };
    const d = t.runDir([[[result("H1/W1", { flags }), result("H1/W2"), result("C6h/W11")], []]]);
    await t.facts(d);
    const out = await t.post(d);
    expect(t.bodies().length).toBeGreaterThan(1);
    expect(t.bodies().reduce((n, b) => n + count(b, "flagged on the head 1 more time than on the base"), 0)).toBe(120);
    expect(out.action).toBe("posted");
  });

  test("a cut shows the longest prefix whose rendered form fits", () => {
    const words = (shown: string, part: string) => `x${part}: ${inert(shown)}`;
    for (const text of ["*".repeat(100_000), "a*".repeat(50_000)]) {
      const said = clipped(words, text, 65_000);
      const n = Number(/'s first ([0-9,]+) of 100,000 characters/.exec(said)![1]!.replaceAll(",", ""));
      expect(cpLength(said)).toBeLessThanOrEqual(65_000);
      expect(cpLength(words(cpSlice(text, 0, n + 1), `'s first ${grouped(n + 1)} of 100,000 characters`))).toBeGreaterThan(65_000);
    }
  });

  test("a flag cut counts only the characters it shows even between its name and its detail", () => {
    const counted = cutCounts({ flags: [{ run: "H1/W1", new: [{ check: "kv", step: 3, what: "a pin moved", detail: "z".repeat(50) }], gone: [] }] });
    expect(counted.has(11)).toBe(true);
    expect([...counted].some((n) => n > 13)).toBe(true);
  });

  test("a flag cut counts none of the whitespace rendering takes out", () => {
    const view = { flags: [{ run: "H1/W1", new: [{ check: "kv", step: 3, what: " a pin\tmoved  ", detail: "\n   " + "z".repeat(50) }], gone: [] }] };
    const counted = cutCounts(view);
    expect(counted.has(11)).toBe(true);
    expect([...counted].some((n) => n > 13)).toBe(true);
    expect(flagsText(view, 1000)[1]).toBe(FLAG_LINE + ": a pin moved\\: " + "z".repeat(50));
  });

  test("a flag with no words is listed by its check and place", () => {
    const view: Json = { flags: [{ run: "H1/W1", new: [{ check: "kv", step: 3 }, { check: "k2", step: 4, what: " \n", detail: "" }], gone: [] }] };
    expect(flagsText(view, 1000).slice(1)).toEqual([
      "- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base",
      "- `H1/W1` step `4`, check `k2` flagged on the head 1 more time than on the base",
    ]);
  });

  test("identical flags in one run at one step on one side are one line saying how many times", () => {
    const same = { check: 4, step: "405389.11", what: "more-than-once", detail: "1 message(s) reach the request more than once" };
    const said = inert("more-than-once: 1 message(s) reach the request more than once");
    const view = {
      flags: [
        {
          run: "C6h/W9",
          new: [same, { ...same }, { ...same, step: "405389.12" }, { ...same, step: "405389.12" }, { ...same, step: "405389.12" }, { ...same, check: 11 }, same],
          gone: [{ ...same }],
        },
        { run: "C6h/W10", new: [{ ...same }], gone: [] },
      ],
    };
    expect(flagsText(view, 1000).slice(1)).toEqual([
      "- `C6h/W9` step `405389.11`, check `4` flagged on the head 3 more times than on the base: " + said,
      "- `C6h/W9` step `405389.12`, check `4` flagged on the head 3 more times than on the base: " + said,
      "- `C6h/W9` step `405389.11`, check `11` flagged on the head 1 more time than on the base: " + said,
      "- `C6h/W9` step `405389.11`, check `4` flagged on the base 1 more time than on the head: " + said,
      "- `C6h/W10` step `405389.11`, check `4` flagged on the head 1 more time than on the base: " + said,
    ]);
    const mark = " (another line of this run shows the same text for a different flag)";
    const apart = { flags: [{ run: "C6h/W9", new: [{ ...same, whole: "a".repeat(40) }, { ...same, whole: "b".repeat(40) }], gone: [] }] };
    expect(flagsText(apart, 1000).slice(1).map((l) => l.split(" on the head")[0])).toEqual(Array(2).fill(`- \`C6h/W9\` step \`405389.11\`, check \`4\`${mark} flagged`));
    const three = {
      flags: [{ run: "C6h/W9", new: [{ ...same, whole: "a".repeat(40) }, { ...same, whole: "a".repeat(40) }, { ...same, whole: "b".repeat(40) }], gone: [] }],
    };
    expect(flagsText(three, 1000).slice(1).map((l) => l.split(": ")[0])).toEqual([
      `- \`C6h/W9\` step \`405389.11\`, check \`4\`${mark} flagged on the head 2 more times than on the base`,
      `- \`C6h/W9\` step \`405389.11\`, check \`4\`${mark} flagged on the head 1 more time than on the base`,
    ]);
    for (const field of ["what", "detail"]) {
      const alone = { flags: [{ run: "C6h/W9", new: [same, { ...same, [field]: "other" }], gone: [] }] };
      expect(flagsText(alone, 1000).slice(1)).toHaveLength(2);
    }
    const past = {
      flags: [
        { run: "C6h/W9", new: [{ ...same, whole: "a".repeat(12) }], gone: [{ ...same, whole: "b".repeat(12) }] },
        { run: "C6h/W10", new: [{ ...same, whole: "a".repeat(12) }, { ...same, whole: "b".repeat(12) }], gone: [{ ...same, step: "9" }] },
      ],
    };
    expect(flagsText(past, 1000).slice(1).map((l) => l.split(" flagged")[0])).toEqual([
      "- `C6h/W9` step `405389.11`, check `4`" + mark,
      "- `C6h/W9` step `405389.11`, check `4`" + mark,
      "- `C6h/W10` step `405389.11`, check `4`" + mark,
      "- `C6h/W10` step `405389.11`, check `4`" + mark,
      "- `C6h/W10` step `9`, check `4`",
    ]);
    const split: Json = {
      flags: [{ run: "C6h/W9", new: [{ check: 4, step: "the run", what: "x", detail: "y" }, { check: 4, detail: "x: y" }], gone: [] }],
    };
    expect(flagsText(split, 1000).slice(1).map((l) => l.split(" flagged")[0])).toEqual(Array(2).fill(`- \`C6h/W9\`, check \`4\`${mark}`));
    const gone = { flags: [{ run: "C6h/W9", new: [], gone: [same, { ...same }] }] };
    expect(flagsText(gone, 1000).slice(1)).toEqual(["- `C6h/W9` step `405389.11`, check `4` flagged on the base 2 more times than on the head: " + said]);
    const twice = { flags: [{ run: "C6h/W9", new: [same, { ...same }], gone: [] }] };
    expect(flagsText(twice, 1000).slice(1)).toEqual(["- `C6h/W9` step `405389.11`, check `4` flagged on the head 2 more times than on the base: " + said]);
    expect(flagsLine(view, 9).startsWith("Separately, 9 of the checks' flags differ between the base and the head, in 2 runs;")).toBe(true);
  });

  test("a flag too long for a comment shows its first characters and says how many of how many", async () => {
    const flags = { new: [{ check: 11, step: 3, what: "a pin moved", detail: "z".repeat(100_000) }], gone: [], kept: [] };
    const d = t.runDir([[[result("H1/W1", { flags }), result("H1/W2"), result("C6h/W11")], []]]);
    await t.facts(d);
    expect((await t.post(d)).action).toBe("posted");
    expect(t.bodies().every((b) => cpLength(b) <= COMMENT_MAX)).toBe(true);
    const shown = /- `H1\/W1` step `3`, check `11` flagged on the head 1 more time than on the base: a pin moved\\: (z+) \(the flag's first ([0-9,]+) of 100,013 characters\)/.exec(
      t.bodies().join(""),
    );
    expect(shown).not.toBeNull();
    expect(cpLength("a pin moved: " + shown![1])).toBe(Number(shown![2]!.replaceAll(",", "")));
  });

  test("a run the base couldnt run whose read failed says both", async () => {
    const r = { ...result("H1/W1", { record: "missing" }), readsFailed: ["summaries"] };
    const text = await t.comment(t.runDir([[[r, result("H1/W2"), result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the base couldn't run it, and the head's read of summaries failed.");
  });

  test("a run that didnt measure on either arm is left out of the comparison naming the arm and what", async () => {
    const failed = result("H1/W1");
    const judged = result("H1/W2");
    failed.unmeasured = ["the run failed"];
    judged.baseUnmeasured = ["check 4 (coverage) judged nothing"];
    const text = await t.comment(t.runDir([[[failed, judged, result("C6h/W11")], []]]));
    expect(text).toContain("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed).");
    expect(text).toContain("couldn't be compared at `H1/W2`: the run didn't measure (on the base, check 4 \\(coverage\\) judged nothing).");
    expect(text).toContain("The records of the 1 run it could compare don't differ between the base and this head.");
  });

  test("a log line or reason too long for a comment is cut to fit and says how much of it shows", async () => {
    const long = "boot failed ".repeat(10_000);
    const missing = t.runDir(
      [
        [[], []],
        [[], []],
      ],
      { outcome: "arm-missing", detail: { share: 1, arm: "after", log: long } },
    );
    const reasoned = t.runDir([[[result("H1/W1", { outcome: "couldnt-run", reason: long }), result("H1/W2"), result("C6h/W11")], []]]);
    const total = cpLength(long.trim());
    for (const [d, said] of [
      [missing, "(its last log line's first "],
      [reasoned, ", the reason's first "],
    ] as const) {
      await t.facts(d);
      const parts = (await t.post(d, null, { post: false })).parts as number;
      const texts = Array.from({ length: parts }, (_, i) => readFile(join(d, i === 0 ? "comment.md" : `comment-${i + 1}.md`)));
      expect(texts.every((x) => cpLength(x) <= COMMENT_MAX)).toBe(true);
      expect(texts.join("")).toContain(said);
      expect(texts.join("")).toContain(` of ${grouped(total)} characters`);
    }
  });

  test("a cut reason counts what shows of its code spans", () => {
    for (const [reason, shown, k, n] of [
      ["see ` a ` here " + "w".repeat(300), "see ` a ` here www", 14, 311],
      ["the store `could not` be opened: " + "y".repeat(300), "the store `could not` be opened\\: yy", 33, 331],
    ] as const) {
      const line = REASON_LEAD + `${shown}, the reason's first ${k} of ${n} characters).`;
      expect(reasonLine(reason, line)).toEqual([line]);
    }
  });

  test("a cut never ends inside a code span or a run of backticks", () => {
    const span = "x " + "`".repeat(30) + "y" + "`".repeat(30) + " z".repeat(200);
    let line = REASON_LEAD + "x, the reason's first 1 of 403 characters).";
    expect(reasonLine(span, line + "abc")).toEqual([line]);
    const unpaired = "a `` b `````" + " q".repeat(200);
    line = REASON_LEAD + "a \\`\\` b, the reason's first 6 of 412 characters).";
    expect(reasonLine(unpaired, line + "abcde")).toEqual([line]);
    const ends = REASON_LEAD + "x `y`, the reason's first 3 of 303 characters).";
    expect(reasonLine("x `y`" + "z".repeat(300), ends)).toEqual([ends]);
  });

  test("a cut flag counts what shows of its code spans and never ends inside one", () => {
    for (const [what, detail, shown, k, n, spare] of [
      ["a pin moved", "the `kv` store said `no` " + "z".repeat(300), ": a pin moved\\: the `kv` store said `no` zz", 36, 334, 0],
      ["a pin moved", "`" + "k".repeat(40) + "`" + " z".repeat(100), ": a pin moved\\:", 12, 253, 10],
      ["a `" + "p".repeat(40) + "` moved", "z".repeat(300), ": a", 1, 350, 10],
      [":smile", "x".repeat(300), ": `:smile:` xx", 10, 308, 0],
    ] as const) {
      const said = FLAG_LINE + `${shown} (the flag's first ${k} of ${n} characters)`;
      const view = { flags: [{ run: "H1/W1", new: [{ check: "kv", step: 3, what, detail }], gone: [] }] };
      expect(flagsText(view, cpLength(said) + spare)[1]).toBe(said);
    }
  });

  test("a cut log line counts what shows of its code spans", () => {
    const view = (log: string) => ({ outcome: "arm-missing", jobs: 2, detail: { share: 1, arm: "after", log } });
    const whole = couldNot(view("q"), 1000)[0]!;
    const lead = whole.slice(0, -" (its last log line: q).".length);
    const line = lead + " (its last log line's first 14 of 311 characters: see ` a ` here www).";
    expect(couldNot(view("see ` a ` here " + "w".repeat(300)), cpLength(line))).toEqual([line]);
  });

  test("a cut quote counts its control characters as they show", () => {
    const change = {
      title: "t",
      where: "w",
      base: "b0",
      head: "h0",
      refs: ["aaaaaaaaaaaa"],
      before: "ab\x07cd\x1b[0m" + "e".repeat(400),
      after: "",
      place: { run: "H1/W1", step: 1 },
    };
    const text = changeBlock(change, new Map<string, Json>([["aaaaaaaaaaaa", { places: [{ run: "H1/W1", step: 1 }] }]]), "H1/W1", "H1/W1", 300);
    const cut = /Before, its first ([0-9,]+) of ([0-9,]+) characters:\n\n```text\n(.*?)\n```/s.exec(text)!;
    expect([Number(cut[1]!.replaceAll(",", "")), Number(cut[2]!.replaceAll(",", ""))]).toEqual([cpLength(cut[3]!), 415]);
    expect(cut[3]!.startsWith("ab\\x07cd\\x1b[0m")).toBe(true);
    expect(cpLength(text)).toBeLessThanOrEqual(300);
  });

  test("a reason with room for none of its characters still says it was cut", () => {
    const view = { outcome: "ran", broken: [{ run: "H1/W1", what: "head", reason: "x".repeat(100) }] };
    const zero = "This head couldn't be compared at `H1/W1`: the head couldn't run it (the reason's first 0 of 100 characters).";
    expect(couldNot(view, cpLength(zero) + 2)).toEqual([zero]);
  });

  test("differing records show the readers account and each change under each run counted from its entries places", async () => {
    const text = await t.comment(t.changedRun(), t.reader());
    expect(text).toContain(
      "The records of 2 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n*A model's account of those records:*",
    );
    expect(text).toContain("- base (`main`): It changes the order of requests `@maintainer`\\, `#3`.\n- head (`aaaaaaaaaaaa`): The summariser gets " + "merge requests first.\n\n<details>");
    expect(text).toContain(
      "<details><summary><code>H1/W1</code>: 1 change</summary>\n\n*Merges go first*\n\n" +
        "At 2 steps; the quotes are from step `7`.\n\nBefore:\n\n" +
        "````text\ncall 1 ```x``` </details>\n````\n\nAfter: none.\n\n</details>",
    );
    expect(text).toContain(
      "<details><summary><code>H1/W2</code>: 1 change</summary>\n\n*Merges go first*\n\n" + "At step `4`. Its before and after are quoted under `H1/W1`, at step `7`." + "\n\n</details>",
    );
  });

  test("where records differ the forced line still says what the view laid and that a difference may come from it", async () => {
    const e1 = [entry("aaaaaaaaaaaa", [["H1/W2", 4]])];
    const e2 = [entry("aaaaaaaaaaaa", [["H1/W1", 7]], { before: "first old", after: "new text" }), entry("bbbbbbbbbbbb", [["H1/W1", 9]])];
    const d = t.runDir(
      [
        [[result("H1/W2", { record: "differs" })], e1],
        [[result("H1/W1", { record: "differs" }), result("C6h/W11")], e2],
      ],
      { forced: { base: [], head: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" }] } },
    );
    expect(await t.comment(d, t.reader())).toContain(
      "The records of 2 of the 3 runs differ between the base and this head.\n\nIn the head, the view laid context\\-manager `0.26.0` over " +
        "`^0.25.0` from agent\\-framework, a range that version doesn't meet: it could choose no release of agent\\-framework that admits it. " +
        "So any difference this view shows, or any failure in the head, may come from that range, and the view can't tell whether it does.\n\n",
    );
  });

  test("a change title is escaped with references in code and reaches github inert", async () => {
    let text = await t.comment(t.changedRun(), t.reader([], { title: "Old </summary><img src=x> by @antra-tess in #12" }));
    expect(text).toContain("\n\n*Old \\<\\/summary\\>\\<img src\\=x\\> by `@antra-tess` in `#12`*\n\n");
    expect(text).not.toContain("<img src=x>");
    text = await t.comment(t.changedRun(), t.reader([], { title: "Says :smile: at $x$" }));
    expect(text).toContain("\n\n*Says `:smile:` at `$`x`$`*\n\n");
  });

  test("a change naming an entry the view doesnt have fails rather than posting", async () => {
    const d = t.changedRun();
    await raises(() => t.comment(d, t.reader(["aaaaaaaaaaaa", "cccccccccccc"])), Failed, /entries the view doesn.t have/);
    await raises(() => t.post(d, t.reader(["aaaaaaaaaaaa", "cccccccccccc"])), Failed, /entries the view doesn.t have/);
    expect(t.gh.calls.filter((c) => c[0] !== "GET")).toEqual([]);
    expect(t.gh.comments).toEqual([]);
  });

  test("a change naming no entry fails saying so", async () => {
    const d = t.changedRun();
    const reader = t.reader();
    reader.changes[0]!.refs = [];
    await raises(() => t.comment(d, reader), Failed, "names no entry");
  });

  test("differing records without a reader account say which runs differ and how an account is asked for and no account", async () => {
    const text = await t.comment(t.changedRun());
    expect(text).toContain(
      "The records of 2 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map " +
        `to code ran in at least one profiled drive.\n\n${UNREAD}\n\n<details><summary>Runs whose records differ: 2 of 3</summary>\n\n` +
        "`H1/W1` and `H1/W2`.\n\n</details>",
    );
    for (const account of ["A model's account of those records", "Delta 1", "<code>H1/W1</code>: "]) expect(text).not.toContain(account);
    expect(UNREAD).toContain("`/context-deltas`");
    expect(UNREAD).toContain("`nissa-seru`");
  });

  test("the comment with no reader names what asks for a view and who may as the poll serves them", () => {
    expect(poll.COMMAND).toBe(COMMAND);
    expect(poll.ASKERS).toBe(ASKERS);
    expect(UNREAD).toContain(`with a \`${COMMAND}\` comment by `);
    for (const asker of ASKERS) expect(UNREAD).toContain(`\`${asker}\``);
  });

  test("a reader account without differing records fails", async () => {
    await raises(() => t.comment(t.unchangedRun(), t.reader()), Failed, "has no reader account");
    const broken = t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2"), result("C6h/W11")], []]]);
    await raises(() => t.comment(broken, t.reader(["aaaaaaaaaaaa"])), Failed, "could compare don't differ has no reader account");
  });

  test("a flag new on the head or gone from it is listed", async () => {
    const flags = {
      new: [{ check: 11, step: "232330.9", what: "a pin @x moved", detail: "" }],
      gone: [{ check: 1, step: "the run", detail: "judged none of coverage" }],
      kept: [{ check: 4, step: "kk", detail: "kept alike" }],
    };
    const d = t.runDir([[[result("H1/W1", { flags }), result("H1/W2"), result("C6h/W11")], []]]);
    const text = await t.comment(d);
    expect(text).toContain(
      "The checks' flags that differ between base and head:\n\n- `H1/W1` step `232330.9`, check `11` flagged on the head 1 more time than " +
        "on the base: a pin `@x` moved\n\n- `H1/W1`, check `1` flagged on the base 1 more time than on the head: judged none of coverage",
    );
    expect(text).not.toContain("kept alike");
  });

  test("a change too long for a comment with no quote to cut fails saying so", async () => {
    const d = t.changedRun();
    await t.facts(d);
    const reader = { changes: [{ title: "ab ".repeat(24_000), where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "", after: "" }] };
    await raises(() => t.post(d, reader, { post: false }), Failed, "has no quote to cut");
  });

  test("a key or an index the words look for and dont find raises the error pythons lookup raises", () => {
    expect(raised(() => couldNot({ outcome: "arm-missing", jobs: 2, detail: { share: 1, arm: "middle", log: "q" } }, 1000))).toBe("KeyError: 'middle'");
    expect(raised(() => listed([]))).toBe("IndexError: list index out of range");
    expect(raised(() => changeBlock({ title: "T", refs: ["e9"], kind: "new" }, new Map(), "H1/W1", "", 1000))).toBe("KeyError: 'e9'");
    expect(raised(() => forcedLine({ forced: { head: [{ range: "^1", wantedBy: "node_modules/", has: "1.0.0" }] }, pack: "@animalabs/x" }))).toBe(
      "IndexError: list index out of range",
    );
  });

  test("a list or a dict where the words look one up as a key raises the error python raises for an unhashable key", () => {
    const missing = (arm: Json) => couldNot({ outcome: "arm-missing", jobs: 2, detail: { share: 1, arm, log: "q" } }, 1000);
    expect(raised(() => missing([]))).toBe("TypeError: cannot use 'list' as a dict key (unhashable type: 'list')");
    expect(raised(() => missing({}))).toBe("TypeError: cannot use 'dict' as a dict key (unhashable type: 'dict')");
    expect(raised(() => known({ title: "T", refs: [[]] }, new Map()))).toBe("TypeError: cannot use 'list' as a dict key (unhashable type: 'list')");
    expect(raised(() => known({ title: "T", refs: [{}] }, new Map()))).toBe("TypeError: cannot use 'dict' as a dict key (unhashable type: 'dict')");
    expect(raised(() => known({ title: "T", refs: [5] }, new Map()))).toBe("Failed: change 'T' names [5] entries the view doesn't have");
    expect(raised(() => changeBlock({ title: "T", refs: [{}], kind: "new" }, new Map(), "H1/W1", "", 1000))).toBe(
      "TypeError: cannot use 'dict' as a dict key (unhashable type: 'dict')",
    );
    expect(raised(() => changeBlock({ title: "T", refs: [5], kind: "new" }, new Map(), "H1/W1", "", 1000))).toBe("KeyError: 5");
    const flaggedIn = (runs: Json[]) => flagsLine({ flags: runs.map((run) => ({ run, new: [{ check: "kv" }], gone: [] })) }, runs.length);
    expect(raised(() => flaggedIn([[]]))).toBe("TypeError: cannot use 'list' as a set element (unhashable type: 'list')");
    expect(raised(() => flaggedIn([{}]))).toBe("TypeError: cannot use 'dict' as a set element (unhashable type: 'dict')");
    expect(raised(() => forcedLine({ forced: { head: [{ range: [], wantedBy: "node_modules/@animalabs/x", has: "1" }] }, pack: "@animalabs/x" }))).toBe(
      "TypeError: cannot use 'tuple' as a set element (unhashable type: 'list')",
    );
    const reader = { changes: [{ title: "T", refs: ["e1"], place: { run: "H1/W1", step: 1 }, where: "w", base: "b", head: "h" }] };
    expect(raised(() => runFolds({ order: ["H1/W1"] }, reader, new Map([["e1", { places: [{ run: [], step: 1 }], kind: "new" }]]), 10_000))).toBe(
      "TypeError: cannot use 'tuple' as a set element (unhashable type: 'list')",
    );
  });

  test("a job count that is a bool and runs python holds as one are counted as python counts them", () => {
    const missing = (jobs: Json) => couldNot({ outcome: "arm-missing", jobs, detail: { share: 1, arm: "after", log: "q" } }, 1000);
    expect(missing(true)).toEqual(["This head couldn't be compared: one of its 1 job came back without the head arm's results (its last log line: q)."]);
    expect(missing(false)).toEqual(["This head couldn't be compared: one of its 0 jobs came back without the head arm's results (its last log line: q)."]);
    const flaggedIn = (runs: Json[]) => flagsLine({ flags: runs.map((run) => ({ run, new: [{ check: "kv" }], gone: [] })) }, runs.length);
    expect(flaggedIn([true, 1])).toBe(
      "Separately, 2 of the checks' flags differ between the base and the head, in 1 run; they're listed under \"Checks' flags that differ\", below.",
    );
    expect(flaggedIn([1, 1.5, "a"])).toBe(
      "Separately, 3 of the checks' flags differ between the base and the head, in 3 runs; they're listed under \"Checks' flags that differ\", below.",
    );
  });
});
