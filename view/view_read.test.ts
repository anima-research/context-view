import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { cpCompare, dumps, Failed, loads, NotARequest, osError, readJson, writeJson, type Json } from "review-workflow/view";

import { AF, ALL_RAN, captured, entry, H1, H2, HARNESS, M, raises, READS, readFile, REPO, result, RUNS, Steps, usage, VERSIONS, type Share } from "./testing.ts";
import { main, post, resultOf, stopped, units } from "./view.ts";
import { compared, facts, seams } from "./view_read.ts";
import { usageRead } from "./view_usage.ts";

type Dict = { [key: string]: Json };

const again = (v: unknown): Json => loads(dumps(v)) as Json;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withRuns = (first: Dict): Dict[] => [first, result("H1/W2"), result("C6h/W11")];

const mtime = (path: string): number => {
  const ns = statSync(path, { bigint: true }).mtimeNs;
  return Number(ns / 1_000_000_000n) + 1e-9 * Number(ns % 1_000_000_000n);
};

const scratch = (t: Steps): string => mkdtempSync(join(t.tmp, "tmp"));

const viewOf = (d: string): Dict => readJson(join(d, "view.json")) as Dict;

const manifestOf = (d: string): Dict => readJson(join(d, "manifest.json")) as Dict;

describe("Facts", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("entries from every share merge by id in run order with the earliest places example", async () => {
    const view = await t.facts(t.changedRun());
    const entries = view.entries as Dict[];
    expect(entries.map((e) => e.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    const merged = entries[0]!;
    expect(merged.places).toEqual([
      { run: "H1/W1", step: 7 },
      { run: "H1/W2", step: 4 },
    ]);
    expect((merged.example as Dict).before).toBe("first old");
    expect([merged.count, [...(merged.runs as string[])].sort(cpCompare)]).toEqual([2, ["H1/W1", "H1/W2"]]);
  });

  test("a view is changed for the reader whenever it ran and the runs it could compare differ", async () => {
    expect((await facts({ dir: t.changedRun(), repo: REPO })).changed).toBe(true);
    expect((await facts({ dir: t.unchangedRun(), repo: REPO })).changed).toBe(false);
    const some = t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 1]])]]]);
    expect((await facts({ dir: some, repo: REPO })).changed).toBe(true);
    const onlyUncompared = t.runDir([[withRuns(result("H1/W1", { record: "missing" })), [entry("aaaaaaaaaaaa", [["H1/W1", 1]])]]]);
    expect((await facts({ dir: onlyUncompared, repo: REPO })).changed).toBe(false);
    const outcomes: [string, Json][] = [
      ["doesnt-merge", null],
      ["arm-missing", { share: 1, arm: "after", log: null }],
      ["moved", null],
    ];
    for (const [outcome, detail] of outcomes) expect((await facts({ dir: t.runDir([[[], []]], { outcome, detail }), repo: REPO })).changed).toBe(false);
  });

  test("where the runs it could compare differ the reader runs and reads the pull request whatever couldnt be compared", async () => {
    const some = t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 1]])]]]);
    const none = t.runDir([[withRuns(result("H1/W1", { record: "missing" })), []]]);
    const someView = await t.facts(some);
    const noneView = await t.facts(none);
    expect(await t.post(some, null, { post: false })).toEqual({ action: "dry", parts: 1 });
    for (const other of [{ title: "Another title" }, { body: "Another description" }] as Dict[]) {
      expect(resultOf({ ...someView, ...other }, READS)).not.toBe(resultOf(someView, READS));
      expect(resultOf({ ...noneView, ...other })).toBe(resultOf(noneView));
    }
    for (const other of [
      { ...READS, instructions: "3".repeat(64) },
      { ...READS, guide: "3".repeat(64) },
    ])
      expect(resultOf(someView, other)).not.toBe(resultOf(someView, READS));
  });

  test("where the reader runs its instructions and guide are part of the result and post takes their hashes only with it", async () => {
    const view = await t.facts(t.changedRun());
    for (const other of [
      { ...READS, instructions: "3".repeat(64) },
      { ...READS, guide: "3".repeat(64) },
    ])
      expect(resultOf(view, other)).not.toBe(resultOf(view, READS));
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, t.reader());
    expect((await t.post(d, t.reader())).action).toBe("unchanged");
    expect((await t.post(d, t.reader(), { reads: { ...READS, guide: "3".repeat(64) } })).action).toBe("posted");
    const calls = t.gh.calls.length;
    const path = join(d, "reader.json");
    for (const args of [{ reader: path }, { reader: null, reads: READS }, { reader: path, reads: { ...READS, guide: "G".repeat(64) } }, { reader: path, reads: { instructions: "1".repeat(64) } }] as Dict[])
      await raises(() => post({ dir: d, post: true, ...args }), Failed, "post: reads");
    expect(t.gh.calls.slice(calls)).toEqual([]);
  });

  test("merged entries are the same however the runs fall into shares", async () => {
    const one = t.runDir([
      [[result("H1/W2", { record: "differs" })], [entry("aaaaaaaaaaaa", [["H1/W2", 4]])]],
      [[result("H1/W1", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 7]])]],
    ]);
    const two = t.runDir([
      [[result("H1/W1", { record: "differs" })], [entry("aaaaaaaaaaaa", [["H1/W1", 7]])]],
      [[result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 4]])]],
    ]);
    const [a, b] = [await t.facts(one), await t.facts(two)];
    expect(a.entries).toEqual(b.entries);
    expect((a.entries as Dict[])[0]!.runs).toEqual(["H1/W1", "H1/W2"]);
    expect(resultOf(a)).toBe(resultOf(b));
  });

  test("a manifest with an unknown outcome or a run with no shares or a place outside the runs fails", async () => {
    await raises(() => t.facts(t.runDir([], { outcome: "exploded" })), Failed, "an outcome the view doesn't know");
    await raises(() => t.facts(t.runDir([])), Failed, "a run with no shares");
    await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1")), [entry("aaaaaaaaaaaa", [["W99", 1]])]]])), Failed, "entry aaaaaaaaaaaa has a place in a run outside its share's results");
    for (const places of [null, "H1/W1", ["H1/W1"]]) {
      const e = { ...entry("aaaaaaaaaaaa", [["H1/W1", 1]]), places };
      await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1")), [e]]])), Failed, "entry aaaaaaaaaaaa's places aren't a list of places");
    }
    await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1", { quarantines: "odd" })), []]])), Failed, "a quarantine count the view doesn't know");
  });

  test("a count that isnt a whole number of 0 or more fails the step naming it", async () => {
    const cases: [string, Json, string][] = [
      ["compiles", 1.5, "1.5"],
      ["compiles", -1, "-1"],
      ["compiles", "3", "'3'"],
      ["compiles", true, "True"],
      ["compiles", null, "None"],
      ["compressions", -2, "-2"],
      ["merges", -1, "-1"],
      ["merges", false, "False"],
      ["quarantines", { compression: -1, merge: 0 }, "{'compression': -1, 'merge': 0}"],
      ["quarantines", { compression: 0, merge: 0.5 }, "{'compression': 0, 'merge': 0.5}"],
      ["quarantines", { compression: true, merge: 0 }, "{'compression': True, 'merge': 0}"],
    ];
    for (const [field, value, shown] of cases)
      await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1", { [field]: value })), []]])), Failed, new RegExp(`H1/W1: .*${field.slice(0, -1)}.* count .*${escaped(shown)}`));
    const d = t.runDir([[withRuns(result("H1/W1", { compiles: 0, compressions: 0, merges: 0, quarantines: { compression: 0, merge: 0 } })), []]]);
    await t.facts(d);
    expect((viewOf(d).reached as Dict).requests).toBe(20);
  });

  test("a flag whose check isnt a whole number of 1 or more fails the step naming it", async () => {
    const cases: [Json, string, string][] = [
      [0, "gone", "0"],
      [-1, "gone", "-1"],
      ["11", "gone", "'11'"],
      [true, "gone", "True"],
      [null, "gone", "None"],
      ["11", "kept", "'11'"],
      [null, "kept", "None"],
      ["[x](https://example.com)", "kept", "'[x](https://example.com)'"],
    ];
    for (const [check, where, shown] of cases) {
      const flags = { new: [], gone: [], kept: [], [where]: [{ check, step: "the run", detail: "d" }] };
      await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1", { flags })), []]])), Failed, `H1/W1: a flag's check isn't a whole number of 1 or more, ${shown}`);
    }
    const flags = { new: [{ check: 16, step: "the run", detail: "d" }], gone: [], kept: [] };
    await t.facts(t.runDir([[withRuns(result("H1/W1", { flags })), []]]));
  });

  test("entries first at steps of one run are ordered by their steps runs of digits by number", async () => {
    const steps = ["h5", "232330.10", "16g", "232330.9", "7f"];
    const entries = steps.map((step, i) => entry((i + 1).toString(16).padStart(12, "0"), [["H1/W2", step]]));
    const d = t.runDir([[[result("H1/W1"), result("H1/W2", { record: "differs" }), result("C6h/W11")], entries]]);
    await t.facts(d);
    expect((viewOf(d).entries as Dict[]).map((e) => (e.places as Dict[])[0]!.step)).toEqual(["7f", "16g", "232330.9", "232330.10", "h5"]);
  });

  test("an entry with a place in another shares run fails the step", async () => {
    const d = t.runDir([
      [[result("H1/W1", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 4]])]],
      [[result("H1/W2", { record: "differs" })], [entry("bbbbbbbbbbbb", [["H1/W2", 2]])]],
    ]);
    await raises(() => t.facts(d), Failed, "share-1: entry aaaaaaaaaaaa has a place in a run outside its share's results");
  });

  test("an example not at its runs first place in the entry fails the step", async () => {
    const e = entry("aaaaaaaaaaaa", [
      ["H1/W1", 2],
      ["H1/W1", 9],
    ]);
    (e.examples as Dict[])[0]!.step = 9;
    const d = t.runDir([[withRuns(result("H1/W1", { record: "differs" })), [e]]]);
    await raises(() => t.facts(d), Failed, "entry aaaaaaaaaaaa has an example that isn't at its run's first place");
  });

  test("a compared runs record result and its entry places agree or the step fails", async () => {
    const differsBare = t.runDir([[withRuns(result("H1/W1", { record: "differs" })), []]]);
    await raises(() => t.facts(differsBare), Failed, "run H1/W1: its record says 'differs', but the entries have no place in it");
    const samePlaced = t.runDir([[withRuns(result("H1/W1")), [entry("aaaaaaaaaaaa", [["H1/W1", 2]])]]]);
    await raises(() => t.facts(samePlaced), Failed, "run H1/W1: its record says 'same', but the entries have places in it");
    const brokenPlaced = t.runDir([
      [
        [result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")],
        [
          entry("aaaaaaaaaaaa", [
            ["H1/W1", 2],
            ["H1/W2", 3],
          ]),
        ],
      ],
    ]);
    expect(((await t.facts(brokenPlaced)).entries as Dict[]).map((e) => e.id)).toEqual(["aaaaaaaaaaaa"]);
  });

  test("a share file that isnt json fails naming it", async () => {
    for (const name of ["after/run.json", "before/run.json", "after/entries.json"]) {
      const d = t.unchangedRun();
      writeFileSync(join(d, "share-2", name), '{"runs": [');
      await raises(() => t.facts(d), Failed, `share-2/${name} isn't JSON`);
    }
  });

  test("the pull requests title and description are read into the view", async () => {
    const view = await t.facts(t.unchangedRun());
    expect([view.title, view.body]).toEqual([t.gh.pull.title, t.gh.pull.body]);
  });

  test("a run in two shares or a run in none fails the step", async () => {
    const twice = t.runDir([
      [withRuns(result("H1/W1")), []],
      [[result("H1/W1")], []],
    ]);
    await raises(() => t.facts(twice), Failed, "two shares");
    const missing = t.runDir([
      [[result("H1/W1")], []],
      [[result("H1/W2")], []],
    ]);
    await raises(() => t.facts(missing), Failed, "every run once");
  });

  test("runs that are empty or name a run twice fail the step", async () => {
    const cases: [Json[], Dict[]][] = [
      [[], []],
      [["H1/W1", "H1/W1"], [result("H1/W1")]],
    ];
    for (const [runs, results] of cases) {
      const d = t.runDir([[results, []]], { runs });
      await raises(() => t.facts(d), Failed, "empty or name a run twice");
    }
  });

  test("a run that couldnt be compared contributes no differences", async () => {
    const unmeasured = { ...result("H1/W2", { record: "differs" }), unmeasured: ["the run failed"] };
    const both = entry("aaaaaaaaaaaa", [
      ["H1/W2", 4],
      ["H1/W1", 7],
    ]);
    const brokenOnly = entry("bbbbbbbbbbbb", [["H1/W2", 9]]);
    const shares = (): Share[] => [[[result("H1/W1", { record: "differs" }), unmeasured, result("C6h/W11")], [both, brokenOnly]]];
    const view = await t.facts(t.runDir(shares()));
    const entries = view.entries as Dict[];
    expect(entries.map((e) => [e.id, (e.places as Dict[]).map((p) => p.run), e.runs, e.count])).toEqual([["aaaaaaaaaaaa", ["H1/W1"], ["H1/W1"], 1]]);
    expect(entries[0]!.example).toEqual({ place: { run: "H1/W1", step: 7 }, before: "old text", after: "new text" });
    const d = t.runDir(shares());
    await t.facts(d);
    await t.post(d, t.reader(["aaaaaaaaaaaa"]), { post: false });
    expect(readFile(join(d, "comment.md"))).toContain("The records of 1 of the 2 runs it could compare differ between the base and this head.");
  });

  test("entries are ordered by their first compared place whatever a run that couldnt be compared held", async () => {
    const later = entry("bbbbbbbbbbbb", [
      ["H1/W1", 9],
      ["H1/W2", 1],
    ]);
    const earlier = entry("aaaaaaaaaaaa", [
      ["H1/W1", 2],
      ["H1/W2", 5],
    ]);
    const view = await t.facts(t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")], [later, earlier]]]));
    expect((view.entries as Dict[]).map((e) => e.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
  });

  test("an entry whose examples arent one per run it occurs in fails the step so every shown entry has one", async () => {
    const unmeasured = { ...result("H1/W2", { record: "differs" }), unmeasured: ["the run failed"] };
    const e = entry("aaaaaaaaaaaa", [
      ["H1/W2", 4],
      ["H1/W1", 7],
    ]);
    e.examples = (e.examples as Dict[]).filter((x) => x.run === "H1/W2");
    await raises(() => t.facts(t.runDir([[[result("H1/W1", { record: "differs" }), unmeasured, result("C6h/W11")], [e]]])), Failed, "entry aaaaaaaaaaaa's examples aren't one per run it occurs in");
    const at7 = { run: "H1/W1", step: 7, before: "", after: "" };
    for (const examples of [null, [{ run: "H9/W9", step: 1, before: "", after: "" }], [{ run: "H1/W2", step: 1, before: "", after: "" }], [at7, at7], []]) {
      const bad = { ...entry("aaaaaaaaaaaa", [["H1/W1", 7]]), examples };
      await raises(() => t.facts(t.runDir([[withRuns(result("H1/W1", { record: "differs" })), [bad]]])), Failed, "examples");
    }
  });

  test("the same records split any way give one view and one result each example at its first place", async () => {
    const whole: [string, [string, string][]][] = [
      [
        "bbbbbbbbbbbb",
        [
          ["H1/W1", "p.2"],
          ["H1/W1", "p.10"],
          ["C6h/W11", "end"],
          ["C6h/W11", "header"],
        ],
      ],
      [
        "aaaaaaaaaaaa",
        [
          ["H1/W1", "p.2"],
          ["H1/W2", "header"],
        ],
      ],
      [
        "cccccccccccc",
        [
          ["H1/W2", "p.3"],
          ["C6h/W11", "p.1"],
        ],
      ],
    ];
    const held = (runs: string[]): Dict[] => {
      const out: Dict[] = [];
      for (const [eid, places] of whole) {
        const mine = places.filter(([r]) => runs.includes(r)).map(([r, s]) => ({ run: r, step: s, digest: `${r}:${s}` }));
        if (!mine.length) continue;
        const firsts = new Map<string, { run: string; step: string }>();
        for (const p of mine) if (!firsts.has(p.run)) firsts.set(p.run, p);
        out.push({
          id: eid,
          describe: `${eid} changed`,
          count: mine.length,
          runs: [...firsts.keys()].sort(cpCompare),
          places: mine,
          examples: [...firsts].map(([r, p]) => ({ run: r, step: p.step, before: `old ${r} ${p.step}`, after: `new ${r} ${p.step}` })),
        });
      }
      return out;
    };
    const splits = [[RUNS], [["H1/W1", "C6h/W11"], ["H1/W2"]], [["H1/W2"], ["H1/W1", "C6h/W11"]], [["C6h/W11"], ["H1/W2"], ["H1/W1"]]];
    for (const uncompared of [null, "H1/W1"]) {
      const seen: [Json, string][] = [];
      for (const split of splits) {
        const shares = split.map((runs): Share => [runs.map((r) => result(r, { record: r === uncompared ? "missing" : "differs" })), held(runs)]);
        const view = await t.facts(t.runDir(shares));
        seen.push([view.entries!, resultOf(view)]);
      }
      for (const s of seen) expect(s).toEqual(seen[0]!);
      const entries = seen[0]![0] as Dict[];
      const first = (e: Dict): Dict => (e.places as Dict[])[0]!;
      expect(entries.map((e) => (e.example as Dict).place)).toEqual(entries.map((e) => ({ run: first(e).run!, step: first(e).step! })));
      if (uncompared === null) {
        expect(entries.map((e) => e.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
        expect((entries[1]!.places as Dict[]).map((p) => [p.run, p.step])).toEqual(whole[0]![1]);
      } else {
        expect(Object.fromEntries(entries.map((e) => [e.id, ((e.example as Dict).place as Dict).run]))).toEqual({ aaaaaaaaaaaa: "H1/W2", bbbbbbbbbbbb: "C6h/W11", cccccccccccc: "H1/W2" });
      }
    }
  });

  test("what the runs reached is summed from the compared runs counts", async () => {
    const d = t.runDir([
      [[result("H1/W1", { compressions: 0, merges: 0 }), result("C6h/W11", { quarantines: { compression: 1, merge: 2 } })], []],
      [[result("H1/W2")], []],
    ]);
    const r = (await t.facts(d)).reached as Dict;
    expect([r.runs, r.requests, r.compressions, r.merges]).toEqual([3, 30, [4, 2], [2, 2]]);
    expect(r.quarantines).toEqual({ compression: 1, merge: 2, runs: 1, "not-reported": 0, uncounted: 2 });
  });

  test("only versions the same in both arms are held and the host is named by its commit for an overlay", async () => {
    const d = t.chosenRun({ membrane: "0.7.9" }, { membrane: "0.8.0" }, { base: { [M]: { version: "0.7.9", host: "0.8.0", ranges: [{ range: "~0.7.9", wantedBy: null }] } }, head: {} });
    expect((await t.facts(d)).held).toEqual({ "agent-framework": "0.32.0", chronicle: "0.5.1" });
    await post({ dir: d, reader: null, post: false });
    expect(readFile(join(d, "comment.md"))).toContain("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`.");
  });

  test("a key package installed in neither arm is not held and the view still runs", async () => {
    const absent = { ...VERSIONS, "@animalabs/chronicle": null, "@animalabs/membrane": null };
    const d = t.runDir([[withRuns(result("H1/W1")), []]], { baseVersions: absent, headVersions: absent });
    expect((await t.facts(d)).held).toEqual({ "agent-framework": "0.32.0" });
    await post({ dir: d, reader: null, post: false });
    expect(readFile(join(d, "comment.md"))).toContain("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`.");
  });

  test("a key package the arms ran differently that the plan didnt choose fails the view unless the pull request is the hosts", async () => {
    const ran: [Json, string][] = [
      ["0.7.9", "'0.7.9'"],
      [null, "None"],
      ["0.8.0 (sha512-other)", "'0.8.0 (sha512-other)'"],
    ];
    for (const [v, shown] of ran) {
      const d = t.runDir([[withRuns(result("H1/W1")), []]], { baseVersions: { ...VERSIONS, [M]: v } });
      await raises(() => t.facts(d), Failed, `the arms ran different ${M}, ${shown} in the base and '0.8.0' in the head, which the plan didn't choose`);
    }
    const chosenElsewhere = t.chosenRun({ membrane: "0.7.9", "agent-framework": "0.31.0" }, {}, { base: { [M]: { version: "0.7.9", host: "0.8.0", ranges: [] } }, head: {} });
    await raises(() => t.facts(chosenElsewhere), Failed, "the arms ran different @animalabs/agent-framework, '0.31.0' in the base");
    const host = t.runDir([[withRuns(result("H1/W1")), []]], { form: "host", repo: "connectome-host", baseVersions: { ...VERSIONS, [M]: "0.7.9" } });
    expect(await t.facts(host, "anima-research/connectome-host")).not.toHaveProperty("differing");
  });

  test("a release the plan chose that its arm didnt run fails the view", async () => {
    const ran: [Json, string][] = [
      ["0.8.0", "'0.8.0'"],
      [null, "None"],
      ["0.9.1 (sha512-m)", "'0.9.1 (sha512-m)'"],
    ];
    for (const [v, shown] of ran) {
      const d = t.chosenRun({}, { membrane: v }, { base: {}, head: { [M]: { version: "0.9.0", host: "0.8.0", ranges: [] } } });
      await raises(() => t.facts(d), Failed, `the head arm ran ${M} ${shown}, not the 0.9.0 the plan chose`);
    }
  });

  test("the arm a release wasnt chosen for ran the lockfiles and a version run with different contents fails the view", async () => {
    const ran: [Json, string][] = [
      ["0.7.9", "'0.7.9'"],
      [null, "None"],
    ];
    for (const [v, shown] of ran) {
      const d = t.chosenRun({ membrane: v }, { membrane: "0.9.0 (sha512-m)" }, { base: {}, head: { [M]: { version: "0.9.0", host: "0.8.0", ranges: [] } } });
      await raises(() => t.facts(d), Failed, `the base arm ran ${M} ${shown}, not the lockfile's 0.8.0, though the plan chose ${M} for the head alone`);
    }
    const chosen = { version: "0.9.0", host: "0.8.0", ranges: [] };
    const d = t.chosenRun({ membrane: "0.9.0 (sha512-b)" }, { membrane: "0.9.0 (sha512-h)" }, { base: { [M]: chosen }, head: { [M]: chosen } });
    await raises(() => t.facts(d), Failed, `the arms ran ${M} 0.9.0 with different contents, '0.9.0 (sha512-b)' in the base and '0.9.0 (sha512-h)' in the head`);
  });

  test("forced of another shape or in a host view fails the step", async () => {
    const ask = { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" };
    const cases: [Json, string][] = [
      [{ head: [ask] }, "overlay"],
      [{ base: [], head: [] }, "overlay"],
      [{ base: [], head: [{ ...ask, wantedBy: null }] }, "overlay"],
      [{ base: [], head: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}` }] }, "overlay"],
      [{ base: "", head: [ask] }, "overlay"],
      [{ base: [], head: [{ ...ask, range: 25 }] }, "overlay"],
      [{ base: [], head: [{ ...ask, wantedBy: "" }] }, "overlay"],
      [{ base: [], head: [{ ...ask, wantedBy: "node_modules/" }] }, "overlay"],
      [{ base: [], head: [{ ...ask, wantedBy: AF }] }, "overlay"],
      [{ base: [], head: [{ ...ask, wantedBy: "x@1" }] }, "overlay"],
      [{ base: [], head: [ask, { ...ask, range: "^0.24.0", has: "0.27.0" }] }, "overlay"],
      [{ base: [], head: [ask] }, "host"],
    ];
    for (const [forced, form] of cases) {
      const d = t.runDir([[withRuns(result("H1/W1")), []]], { forced, form, repo: form === "host" ? "connectome-host" : "context-manager" });
      await raises(() => t.facts(d, form === "host" ? "anima-research/connectome-host" : REPO), Failed, "manifest.json: forced");
    }
  });

  test("a stack of another shape or in a host view fails the step", async () => {
    const good = { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }] };
    const cases: [Json, string][] = [
      [{ head: { [M]: good } }, "overlay"],
      [[], "overlay"],
      [{ base: {}, head: { [M]: { ...good, ranges: [{ range: "^0.9.0" }] } } }, "overlay"],
      [{ base: {}, head: { [M]: { ...good, missed: { range: "^0.9.0", wantedBy: null, has: "0.8.0" } } } }, "overlay"],
      [{ base: {}, head: { [M]: { ...good, missed: { package: M, range: "^0.9.0", wantedBy: null, has: 8 } } } }, "overlay"],
      [{ base: {}, head: { [M]: { ...good, host: null } } }, "overlay"],
      [{ base: {}, head: { [M]: { ...good, ranges: [{ range: 9, wantedBy: null }] } } }, "overlay"],
      [{ base: {}, head: { [M]: { ...good, asks: null } } }, "overlay"],
      [{ base: {}, head: {} }, "host"],
    ];
    for (const [stack, form] of cases) {
      const d = t.runDir([[withRuns(result("H1/W1")), []]], { stack, form, repo: form === "host" ? "connectome-host" : "context-manager" });
      await raises(() => t.facts(d, form === "host" ? "anima-research/connectome-host" : REPO), Failed, "manifest.json: stack");
    }
  });

  test("a host pull request holds the packages and not the host", async () => {
    const d = t.runDir([[withRuns(result("H1/W1")), []]], { form: "host", repo: "connectome-host" });
    await t.facts(d, "anima-research/connectome-host");
    await post({ dir: d, reader: null, post: false });
    expect(readFile(join(d, "comment.md"))).toContain("Held the same in base and head: agent\\-framework `0.32.0`, chronicle `0.5.1`, membrane `0.8.0`.");
  });

  test("a repository outside the four is refused by its id whatever its name", async () => {
    await raises(() => t.facts(t.runDir([], { repo: "lode" }), "anima-research/lode"), NotARequest, "");
    const raised = await raises(() => t.facts(t.runDir([], { repo: "elsewhere" }), "someone/elsewhere"), Failed, "GitHub answered 404 to GET /repos/someone/elsewhere/installation");
    expect(raised).not.toBeInstanceOf(NotARequest);
    const moved = t.runDir([[withRuns(result("H1/W1")), []]], { repo: "context-manager-renamed" });
    t.gh.pull.title = "renamed";
    expect((await t.facts(moved, "anima-research/context-manager-renamed")).title).toBe("renamed");
  });

  test("an early moved or closed manifest without a base makes a short view and post answers its name", async () => {
    const cases: [string, Dict][] = [
      ["moved", { headNow: H2 }],
      ["closed", { state: "merged" }],
    ];
    for (const [outcome, detail] of cases) {
      const d = scratch(t);
      writeJson(join(d, "manifest.json"), { repo: "context-manager", number: 5, head: H1, form: "overlay", outcome, detail, shares: [] });
      const { changed } = await facts({ dir: d, repo: REPO });
      const view = viewOf(d);
      const calls = t.gh.calls.length;
      const answers = [await t.post(d, null, { post: true }), await t.post(d, null, { post: false })];
      expect(changed).toBe(false);
      expect(view).toEqual({ repo: REPO, number: 5, head: H1, outcome, detail });
      expect(answers).toEqual([{ action: outcome }, { action: outcome }]);
      expect(t.gh.calls.slice(calls)).toEqual([]);
      expect(existsSync(join(d, "comment.md"))).toBe(false);
      expect(t.gh.comments).toEqual([]);
    }
  });

  test("an arm the run side doesnt name or a self check the view doesnt know fails the step", async () => {
    const outcomes: [string, Dict][] = [
      ["arm-missing", { share: 1, arm: "head", log: null }],
      ["arm-missing", { share: 1, log: null }],
      ["needs-companion", { package: "p", version: "1", arm: "after", wantedBy: "w", range: "^1" }],
      ["needs-companion", { package: "p", range: "^1", hostHas: "0.1", arm: "after" }],
      ["needs-companion", { package: "p", range: "^1", hostHas: "0.1" }],
    ];
    for (const [outcome, detail] of outcomes) await raises(() => t.facts(t.runDir([[[], []]], { outcome, detail })), Failed, "an arm the");
    for (const check of [null, { outcome: "odd" }, "same"]) {
      const r = { ...result("H1/W1"), selfCheck: check };
      await raises(() => t.facts(t.runDir([[withRuns(r), []]])), Failed, "a self-check the view doesn't know");
    }
  });

  test("the manifests number host and form of another shape fail the step naming the field", async () => {
    const cases: [string, Json, string][] = [
      ["number", "5", "number"],
      ["number", null, "number"],
      ["host", { sha: 42 }, "host.sha"],
      ["host", null, "host.sha"],
      ["form", "whole", "a form the view doesn't know"],
      ["form", null, "form"],
      ["harness", null, "harness.repo"],
      ["harness", "anima-research/context-view", "harness.repo"],
      ["harness", { repo: "nissa-seru/connectome-smoke", sha: HARNESS }, "harness.repo"],
      ["harness", { repo: "nissa-seru/context-view", sha: HARNESS }, "harness.repo"],
      ["harness", { repo: "anima-research/context-view", sha: HARNESS.slice(0, 12) }, "harness.sha"],
      ["harness", { repo: "anima-research/context-view", sha: HARNESS.toUpperCase() }, "harness.sha"],
      ["harness", { repo: "anima-research/context-view" }, "harness.sha"],
      ["harness", { repo: "anima-research/context-view", sha: BigInt("1".repeat(40)) }, "harness.sha"],
      ["host", { sha: BigInt("2".repeat(40)) }, "host.sha"],
      ["base", { ref: "main", sha: BigInt("3".repeat(40)) }, "base.sha"],
      ["head", BigInt("4".repeat(40)), "head"],
    ];
    for (const [field, value, said] of cases) {
      const d = t.unchangedRun();
      writeJson(join(d, "manifest.json"), { ...manifestOf(d), [field]: value });
      await raises(() => t.facts(d), Failed, new RegExp(`manifest.json: .*${said}`));
    }
  });

  test("a sha of another shape is refused naming its field and value and stopped checks its own head", async () => {
    const cases: [string, Json, string, string][] = [
      ["head", H1.slice(0, 12), "head", `'${H1.slice(0, 12)}'`],
      ["base", { ref: "main", sha: 42 }, "base.sha", "42"],
      ["host", { sha: H1.toUpperCase() }, "host.sha", `'${H1.toUpperCase()}'`],
      ["harness", { repo: "anima-research/context-view", sha: null }, "harness.sha", "None"],
    ];
    for (const [field, value, said, shown] of cases) {
      const d = t.unchangedRun();
      writeJson(join(d, "manifest.json"), { ...manifestOf(d), [field]: value });
      const raised = await raises(() => t.facts(d), Failed, said);
      expect(raised.message).toBe(`manifest.json: ${said} isn't a full commit sha, ${shown}`);
    }
    const heads: [Json, string][] = [
      [BigInt("4".repeat(40)), "4".repeat(40)],
      [H1.slice(0, 12), `'${H1.slice(0, 12)}'`],
    ];
    for (const [head, shown] of heads) {
      const raised = await raises(() => stopped({ repo: REPO, number: 5, head, post: false }), Failed, "head");
      expect(raised.message).toBe(`head isn't a full commit sha, ${shown}`);
    }
  });

  test("a merge that ran no job makes a short view with its merge and the pull requests words", async () => {
    const cases: [string, Json, Dict][] = [
      ["elsewhere", { branch: "release" }, { merge: { commit: H1 } }],
      ["unchanged", null, { base: { ref: "main", sha: H2 }, merge: { commit: H1, k: 0 } }],
    ];
    for (const [outcome, detail, extra] of cases) {
      const d = scratch(t);
      writeJson(join(d, "manifest.json"), { repo: "context-manager", number: 5, head: H1, form: "overlay", outcome, detail, shares: [], ...extra });
      expect((await facts({ dir: d, repo: REPO })).changed).toBe(false);
      expect(viewOf(d)).toEqual({ repo: REPO, number: 5, head: H1, outcome, detail, merge: extra.merge!, title: t.gh.pull.title!, body: t.gh.pull.body! });
    }
  });

  test("a merges view json carries its merge as the run side wrote it and a heads has none", async () => {
    const d = t.unchangedRun();
    expect(await t.facts(d)).not.toHaveProperty("merge");
    for (const merge of [
      { commit: H1, k: 0, src: true },
      { commit: H1, k: 2, n: 2, src: false },
    ] as Dict[]) {
      writeJson(join(d, "manifest.json"), { ...manifestOf(d), merge });
      expect((await t.facts(d)).merge).toEqual(merge);
    }
    for (const merge of [{ commit: H1.slice(0, 12), k: 0, src: true }, { commit: H1, k: -1 }, { commit: H1, k: 0, src: "yes" }, [H1]]) {
      writeJson(join(d, "manifest.json"), { ...manifestOf(d), merge });
      await raises(() => t.facts(d), Failed, "manifest.json: merge");
    }
  });

  test("a merge naming another commit than the head or lacking what its outcome had reached is refused", async () => {
    const d = t.unchangedRun();
    const m = manifestOf(d);
    for (const merge of [{ commit: H2, k: 0, src: true }, { commit: H1, src: true }, { commit: H1, k: 0 }]) {
      writeJson(join(d, "manifest.json"), { ...m, merge });
      await raises(() => t.facts(d), Failed, "manifest.json: merge");
    }
    const early = (outcome: string, merge: Json | undefined): string => {
      const s = scratch(t);
      writeJson(join(s, "manifest.json"), { repo: "context-manager", number: 5, head: H1, form: "overlay", outcome, detail: null, shares: [], ...(merge === undefined ? {} : { merge }) });
      return s;
    };
    const cases: [string, Dict, boolean][] = [
      ["unchanged", { commit: H1 }, true],
      ["unchanged", { commit: H2, k: 0 }, true],
      ["elsewhere", { commit: H2 }, true],
      ["elsewhere", { commit: H1 }, false],
    ];
    for (const [outcome, merge, refused] of cases) {
      const s = early(outcome, merge);
      if (refused) await raises(() => facts({ dir: s, repo: REPO }), Failed, "manifest.json: merge");
      else expect((await facts({ dir: s, repo: REPO })).changed).toBe(false);
    }
    for (const outcome of ["elsewhere", "unchanged"])
      for (const merge of [null, undefined]) {
        const s = early(outcome, merge);
        await raises(() => facts({ dir: s, repo: REPO }), Failed, "manifest.json: merge");
      }
  });

  test("view json carries the harness commit and a moved or closed manifest needs none", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    expect(viewOf(d).harness).toEqual({ repo: "anima-research/context-view", sha: HARNESS });
    for (const outcome of ["moved", "closed"]) {
      const e = t.runDir([], { outcome, detail: {} });
      const { harness: _h, host: _o, base: _b, ...m } = manifestOf(e);
      writeJson(join(e, "manifest.json"), m);
      await t.facts(e);
      expect(viewOf(e).outcome).toBe(outcome);
    }
  });

  test("a manifest missing a field fails the step with its traceback then a line saying what it can be", async () => {
    const d = t.unchangedRun();
    const m = manifestOf(d);
    delete (m.shares as Dict[])[0]!.dir;
    writeJson(join(d, "manifest.json"), m);
    const [code, , err] = await captured(() => main(["facts"], { stdin: dumps({ dir: d, repo: REPO }) }));
    expect(code).toBe(1);
    const said = err.replace(/\n+$/, "").split("\n");
    expect(said.at(-1)).toBe("view.ts facts: a field it reads is missing or of another shape, or the step's own code failed; the traceback above says which");
    expect(err).toContain("KeyError: 'dir'");
  });

  test("a refusal longer than the workflow keeps is cut at its end so what was refused is kept", async () => {
    const d = t.unchangedRun();
    writeJson(join(d, "manifest.json"), { ...manifestOf(d), outcome: "x".repeat(5_000) });
    const [code, , err] = await captured(() => main(["facts"], { stdin: dumps({ dir: d, repo: REPO }) }));
    expect(code).toBe(1);
    const kept = err.trim().slice(-1500);
    expect(kept).toStartWith("view.ts facts: manifest.json: an outcome the view doesn't know, 'xxx");
    expect(kept).toEndWith("…");
  });

  test("the views repositories are its own whatever pr review reviews", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    expect((await t.post(d)).action).toBe("posted");
    t.gh.head = H2;
    expect((await stopped({ repo: REPO, number: 5, head: H2 })).action).toBe("posted");
  });
});

const EARLIER = ["view.json", "manifest.json", "reader.json", "comment.md", "comment-2.md"];

class Compared extends Steps {
  plant(d: string): void {
    for (const name of EARLIER) writeFileSync(join(d, name), '{"from": "an earlier view"}');
  }

  fields(d: string): Dict {
    const m = manifestOf(d);
    return Object.fromEntries(["number", "head", "form", "base", "host", "harness", "stack", "forced"].filter((k) => Object.hasOwn(m, k)).map((k) => [k, m[k]!]));
  }

  sharesOf(d: string, reach = true): string {
    const e = scratch(this);
    for (const name of readdirSync(d)) if (name.startsWith("share-")) cpSync(join(d, name), join(e, name), { recursive: true });
    if (reach) copyFileSync(join(d, "reach.json"), join(e, "reach.json"));
    return e;
  }

  earlier(d: string): string[] {
    return EARLIER.filter((n) => existsSync(join(d, n)));
  }
}

describe("Compared", () => {
  let t: Compared;
  beforeEach(async () => {
    t = new Compared();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("a compare without a reach json gets a view with no reach and a comment with no reach paragraph", async () => {
    const d = t.unchangedRun();
    const without = t.sharesOf(d, false);
    compared({ dir: without, repo: REPO, ...t.fields(d), title: "t", body: "b" });
    const view = viewOf(without);
    expect(view).not.toHaveProperty("reach");
    expect(units(view, null, 60_000).join("\n\n")).not.toContain("profiled drive");
    const e = t.sharesOf(d);
    compared({ dir: e, repo: REPO, ...t.fields(d), title: "t", body: "b" });
    expect(units(viewOf(e), null, 60_000)).toContain(ALL_RAN);
  });

  test("a compares shares get the view facts would write with the given title and description and the run sides manifest with each share by its i and dir asking github nothing", async () => {
    const broken = [result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")];
    const apart: Share[] = [
      [[result("H1/W1", { record: "differs" })], [entry("aaaaaaaaaaaa", [["H1/W1", 7]])]],
      ...Array.from({ length: 9 }, (): Share => [[], []]),
      [[result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 4]])]],
    ];
    const forced = { base: [], head: [{ range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" }] };
    const cases: [string, string][] = [
      ["changed", t.changedRun()],
      ["unchanged", t.unchangedRun()],
      ["some not compared", t.runDir([[broken, [entry("bbbbbbbbbbbb", [["H1/W2", 1]])]]])],
      ["eleven shares", t.runDir(apart)],
      ["forced", t.runDir([[withRuns(result("H1/W1")), []]], { forced })],
      ["releases the plan chose", t.chosenRun({}, { membrane: "0.9.0 (sha512-m)" }, { base: {}, head: { [M]: { version: "0.9.0", host: "0.8.0", ranges: [] } } })],
    ];
    for (const [, d] of cases) {
      const manifest = join(d, "manifest.json");
      const earlier = mtime(manifest) - 5;
      utimesSync(manifest, earlier, earlier);
      const e = t.sharesOf(d);
      t.plant(e);
      const [calls, tokens] = [t.gh.calls.length, t.gh.tokens.length];
      const given = { dir: e, repo: REPO, ...t.fields(d), title: t.gh.pull.title, body: t.gh.pull.body };
      const [code, out] = await captured(() => main(["compared"], { stdin: dumps(given) }));
      expect(code).toBe(0);
      expect([t.gh.calls.slice(calls), t.gh.tokens.slice(tokens)]).toEqual([[], []]);
      const written = mtime(join(e, "manifest.json"));
      utimesSync(manifest, written, written);
      const theirs = await facts({ dir: d, repo: REPO });
      expect(loads(out.trim().split("\n").at(-1)!)).toEqual({ ...theirs, path: join(e, "view.json") });
      expect(readFileSync(join(e, "view.json"))).toEqual(readFileSync(join(d, "view.json")));
      const runSide = manifestOf(d);
      expect(manifestOf(e)).toEqual({ ...runSide, shares: (runSide.shares as Dict[]).map((s) => ({ i: s.i!, dir: s.dir! })) });
      expect(t.earlier(e)).toEqual(["view.json", "manifest.json"]);
    }
  });

  test("each refusal says why in a line and leaves none of an earlier views files", async () => {
    const d = t.changedRun();
    const e = t.sharesOf(d);
    const good: Dict = { dir: e, repo: REPO, ...t.fields(d), title: "t", body: "b" };
    const empty = scratch(t);
    const unread = t.sharesOf(d);
    rmSync(join(unread, "share-2", "after", "entries.json"));
    const nowhere = join(t.tmp, "nowhere");
    const { repo: _, ...unnamed } = good;
    const cases: [Dict, string][] = [
      [{ ...good, repo: "anima-research/lode" }, "anima-research/lode isn't one of the context view's repositories"],
      [unnamed, "None isn't one of the context view's repositories"],
      [{ ...good, dir: nowhere }, `${nowhere} isn't a directory`],
      [{ ...good, dir: empty }, "holds no share-"],
      [{ ...good, dir: unread }, "share-2: the head arm wrote no entries.json"],
      [{ ...good, title: null }, "title"],
      [{ ...good, body: 3 }, "body"],
      [{ ...good, head: H1.slice(0, 12) }, "manifest.json: head isn't a full commit sha"],
      [{ ...good, number: 0 }, "manifest.json: number"],
      [{ ...good, harness: { repo: "nissa-seru/context-view", sha: HARNESS } }, "manifest.json: harness.repo"],
    ];
    for (const [args, said] of cases) {
      for (const at of [e, empty, unread]) t.plant(at);
      const [calls, tokens] = [t.gh.calls.length, t.gh.tokens.length];
      await raises(() => compared(args), Failed, said);
      expect([t.gh.calls.slice(calls), t.gh.tokens.slice(tokens)]).toEqual([[], []]);
      expect(t.earlier(args.dir as string)).toEqual([]);
    }
  });

  test("a manifest that cant be written leaves no view", async () => {
    const d = t.changedRun();
    const e = t.sharesOf(d);
    const real = seams.writeJson;
    const full = osError(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28 }));
    t.patch(seams, "writeJson", (path: string, value: unknown) => {
      if (basename(path) === "manifest.json") throw full;
      real(path, value);
    });
    expect(await raises(() => compared({ dir: e, repo: REPO, ...t.fields(d), title: "t", body: "b" }), Error, "No space left on device")).toBe(full);
    expect(existsSync(join(e, "view.json"))).toBe(false);
  });
});

describe("Arms", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("an absent or base absent that isnt a list of names stops the view on any result", async () => {
    for (const key of ["absent", "baseAbsent"]) {
      for (const bad of [false, {}, "", 0, null, "suppression", ["suppression", 3]]) {
        const d = t.runDir([[withRuns({ ...result("H1/W1"), [key]: bad }), []]]);
        await raises(() => t.facts(d), Failed, `H1/W1: its ${key} isn't a list of names`);
      }
      const lost = { ...result("H1/W1", { outcome: "flags" }), [key]: false, unmeasured: ["the run failed"] };
      const d = t.runDir([[withRuns(lost), []]]);
      await raises(() => t.facts(d), Failed, `H1/W1: its ${key} isn't a list of names`);
    }
    await t.facts(t.runDir([[withRuns(result("H1/W1", { absent: [], baseAbsent: ["onboarding"] })), []]]));
  });

  test("facts keeps the bases branch and refuses a manifest without one", async () => {
    const d = t.changedRun();
    expect((await t.facts(d)).baseRef).toBe("main");
    const path = join(d, "manifest.json");
    const m = manifestOf(d);
    for (const ref of [null, "", " \n", 7]) {
      writeFileSync(path, dumps({ ...m, base: { ...(m.base as Dict), ref } }));
      await raises(() => t.facts(d), Failed, "base.ref isn't a branch name");
    }
  });

  test("a view whose arm came back missing carries the forced ranges with the package they were forced on", async () => {
    const ask = { range: "^0.25.0", wantedBy: `node_modules/${AF}`, has: "0.26.0" };
    const d = t.runDir(
      [
        [[], []],
        [[], []],
      ],
      { outcome: "arm-missing", detail: { share: 1, arm: "after", log: null }, forced: { base: [ask], head: [ask] } },
    );
    const view = await t.facts(d);
    expect([view.forced, view.pack]).toEqual([{ base: [ask], head: [ask] }, "@animalabs/context-manager"]);
  });

  test("a base arms results are held to the head arms rules and read within their own share", async () => {
    const runs = [result("H1/W1", { usage: usage() }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    const d = t.runDir(
      [
        [runs.slice(0, 2), []],
        [runs.slice(2), []],
      ],
      { baseResults: runs },
    );
    const path = join(d, "share-2", "before", "run.json");
    const arm = readJson(path) as Dict;
    const cases: [Json[], string | null][] = [
      [[null], "share-2: the base arm's results hold one that isn't a run's result"],
      [[{ usage: usage() }], "share-2: the base arm's results hold one that isn't a run's result"],
      [[runs[2]!, runs[2]!], "run C6h/W11 is twice in share-2's base arm"],
      [[runs[2]!, { ...runs[0]!, usage: usage({ agent: { cacheRead: 1 } }) }], null],
    ];
    for (const [results, said] of cases) {
      writeFileSync(path, dumps({ ...arm, results }));
      if (said !== null) {
        await raises(() => t.facts(d), Failed, said);
        continue;
      }
      const view = await t.facts(d);
      expect((view.usage as Dict[]).filter((u) => u.run === "H1/W1").map((u) => u.base)).toEqual([again(usageRead(runs[0]!, "base"))]);
    }
  });

  test("a head arm without entries or a compared result without flags or counts fails rather than reading as a run", async () => {
    const d = t.unchangedRun();
    rmSync(join(d, "share-1", "after", "entries.json"));
    await raises(() => t.facts(d), Failed, "wrote no entries.json");
    for (const field of ["counts", "flags"]) {
      const bare = result("H1/W1");
      delete bare[field];
      await raises(() => t.facts(t.runDir([[withRuns(bare), []]])), Failed, "H1/W1's result has no flags or counts");
    }
  });

  test("an arm that wrote no run json fails the step rather than reading as a run", async () => {
    for (const arm of ["after", "before"]) {
      const d = t.unchangedRun();
      rmSync(join(d, "share-2", arm, "run.json"));
      await raises(() => t.facts(d), Failed, "wrote no run.json");
    }
  });
});
