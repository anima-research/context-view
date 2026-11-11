import { describe, expect, test } from "bun:test";
import { cpLength, cpSlice, Failed, grouped, inert, type Json } from "review-workflow/view";
import { readable } from "review-workflow/testing";
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

describe("Words", () => {
  test("the flags line counts the flags with the runs they re in apart from the records", () => {
    const two = { flags: [{ run: "A", new: [{}, {}], gone: [] }, { run: "B", new: [], gone: [{}] }, { run: "C", new: [], gone: [] }] };
    expect(flagsLine(two, 3)).toBe(
      "Separately, 3 of the checks' flags differ between the base and the head, in 2 runs; " + 'they\'re listed under "Checks\' flags that differ", below.',
    );
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

  test("the comment with no reader names what asks for a view and who may as the poll serves them", () => {
    expect(UNREAD).toContain(`with a \`${COMMAND}\` comment by `);
    for (const asker of ASKERS) expect(UNREAD).toContain(`\`${asker}\``);
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
