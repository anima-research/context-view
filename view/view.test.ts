import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMENT_FILES, COMMENT_MAX, cpLength, dumps, Failed, loads, MORE, NotARequest, readJson, rstrip, truthy, writeJson, type Json } from "review-workflow/view";

import { Answer, APP, BASE, captured, entry, Fixture, H1, H2, H3, M, raises, raw, READS, readFile, REPO, result, Steps, usage, type Reader } from "./testing.ts";
import { chains, contextOf, main, mark, marked, post as postStep, refuseCheckout, resultOf, seams, STEPS, stopped, units, wordsOf } from "./view.ts";
import { facts } from "./view_read.ts";
import { UNREAD } from "./view_words.ts";

type Dict = { [key: string]: Json };

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

const again = (v: Json): Json => loads(dumps(v)) as Json;

const count = (text: string, part: string): number => text.split(part).length - 1;

describe("Result", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("the result names the view code that writes the words so a release never keeps another releases comment", async () => {
    const v = await t.facts(t.changedRun());
    const words = seams.WORDS;
    seams.WORDS = "f".repeat(64);
    let other: string;
    try {
      other = resultOf(v);
    } finally {
      seams.WORDS = words;
    }
    expect(other).not.toBe(resultOf(v));
    const view = ["./view.ts", "./view_numbers.ts", "./view_reach.ts", "./view_read.ts", "./view_usage.ts", "./view_words.ts"].map(here);
    expect(seams.WORDS).toBe(wordsOf([...view, ...COMMENT_FILES]));
    const comment = COMMENT_FILES.find((f) => f.endsWith("/comment/comment.ts"))!;
    const changed = join(t.tmp, "comment.ts");
    copyFileSync(comment, changed);
    appendFileSync(changed, "\n");
    const files = [...view, ...COMMENT_FILES.map((f) => (f === comment ? changed : f))];
    expect(wordsOf(files)).not.toBe(seams.WORDS);
    const now = resultOf(v);
    t.patch(seams, "WORDS", wordsOf(files));
    expect(resultOf(v)).not.toBe(now);
  });

  test("the stretches an arm left out are part of the result so a comment naming them is never kept under another", async () => {
    const left = await t.facts(t.runDir([[[result("H1/W1", { baseAbsent: ["suppression"] }), result("H1/W2"), result("C6h/W11")], []]]));
    const ran = await t.facts(t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]]));
    expect(resultOf(left)).not.toBe(resultOf(ran));
    expect(resultOf(left)).not.toBe(resultOf({ ...left, absent: [{ ...((left.absent as Json[])[0] as Dict), base: ["onboarding"] }] }));
    expect(resultOf(left)).toBe(resultOf(again(left)));
  });

  test("a pause in a run the comment names is part of the result so a comment naming it is never kept under another, and one in a run it doesnt name moves nothing", async () => {
    const differs = (more: Dict): string =>
      t.runDir([[[{ ...result("H1/W1", { record: "differs" }), ...more }, result("H1/W2"), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 3]])]]]);
    const named = await t.facts(differs({ paused: { step: "w1.3", ms: 5000 } }));
    expect(resultOf(named)).not.toBe(resultOf(await t.facts(differs({}))));
    expect(resultOf(named)).not.toBe(resultOf({ ...named, paused: [{ run: "H1/W1", head: { step: "w1.3", ms: 10000 } }] }));
    expect(resultOf(named)).toBe(resultOf(again(named)));
    const quiet = await t.facts(t.runDir([[[{ ...result("H1/W1"), paused: { step: "w1.3", ms: 5000 } }, result("H1/W2"), result("C6h/W11")], []]]));
    expect(resultOf(quiet)).toBe(resultOf(await t.facts(t.runDir([[[result("H1/W1"), result("H1/W2"), result("C6h/W11")], []]]))));
  });

  test("the usage and the upgraded runs are part of the result so a comment showing them is never kept under another", async () => {
    const runs = [result("H1/W1", { usage: usage() }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    const same = await t.facts(t.runDir([[runs, []]], { baseResults: runs }));
    const moved = [result("H1/W1", { usage: usage({ agent: { cacheRead: 8000 } }) }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    expect(resultOf(same)).not.toBe(resultOf(await t.facts(t.runDir([[moved, []]], { baseResults: runs }))));
    const stuck = { last: 1, calibration: { multiplier: 1, provisional: true, reset: true } };
    const fine = { last: 0, calibration: { multiplier: 1.29, provisional: false, reset: false } };
    expect(resultOf(await t.facts(t.upgraded(fine, stuck, fine, fine)))).not.toBe(resultOf(await t.facts(t.upgraded(fine, fine, fine, fine))));
    const flagged = { new: [], gone: [], kept: [{ check: 11, step: "c.debt", what: "invariant", detail: "x" }] };
    expect(resultOf(await t.facts(t.upgraded(fine, fine, fine, fine, flagged)))).not.toBe(resultOf(await t.facts(t.upgraded(fine, fine, fine, fine))));
    expect(resultOf(same)).toBe(resultOf(again(same)));
  });

  test("the bases branch is part of the result so a comment naming it is never kept under another", async () => {
    const v = await t.facts(t.changedRun());
    expect(resultOf(v)).not.toBe(resultOf({ ...v, baseRef: "develop" }));
    expect(resultOf(v)).toBe(resultOf(again(v)));
  });

  test("the releases the plan chose are part of the result so a comment naming them is never kept under another", async () => {
    const chosen = { version: "0.9.0", host: "0.8.0", ranges: [{ range: "^0.9.0", wantedBy: null }] };
    const stack = { base: {}, head: { [M]: chosen } };
    const v = await t.facts(t.chosenRun({}, { membrane: "0.9.0 (sha512-m)" }, stack));
    const { stack: _s, differing: _d, ...rest } = v;
    for (const other of [
      { ...v, stack: { base: {}, head: { [M]: { ...chosen, host: "0.8.1" } } } },
      { ...v, differing: [{ package: "membrane", base: "0.8.1", head: "0.9.0" }] },
      rest,
    ])
      expect(resultOf(v)).not.toBe(resultOf(other));
    expect(resultOf(v)).toBe(resultOf(again(v)));
  });

  test("a view with no reader is never the result of one with a reader so an account stands only over the head its reader read", async () => {
    const a = t.changedRun();
    await t.facts(a);
    await t.post(a, t.reader());
    const asked = t.gh.comments.map((c) => ({ ...c }));
    const b = t.changedRun({ head: H2 });
    expect(resultOf(await t.facts(b))).not.toBe(resultOf(await t.facts(b), READS));
    expect((await t.post(b)).action).toBe("posted");
    expect(t.gh.comments.slice(0, asked.length)).toEqual(asked);
    expect(t.gh.comments.at(-1)!.body).toContain(UNREAD);
    const c = t.changedRun({ head: H3 });
    await t.facts(c);
    expect((await t.post(c)).action).toBe("edited");
    expect(t.gh.comments.slice(0, asked.length)).toEqual(asked);
  });

  test("a comment with no reader rests on no word of the description so an edited one keeps it at a later head", async () => {
    const a = t.changedRun();
    await t.facts(a);
    await t.post(a);
    t.gh.pull.body = "It changes <b>that</b> now.";
    const b = t.changedRun({ head: H2 });
    await t.facts(b);
    expect((await t.post(b)).action).toBe("edited");
    expect(t.gh.comments.length).toBe(1);
  });
});

class Posting extends Steps {
  claiming(head: string): string[] {
    return this.bodies().filter((b) => b.includes(` head:${head} result:`));
  }

  stoppedHeads(): string[] {
    return this.bodies()
      .map((b) => marked(b)?.stopped ?? null)
      .filter((h): h is string => h !== null);
  }
}

describe("Posting", () => {
  let t: Posting;
  beforeEach(async () => {
    t = new Posting();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("a head returned to through two others ends with one comment claiming it", async () => {
    for (const back of [H2, H1]) {
      t.gh.comments.length = 0;
      for (const [run, reader] of [
        [t.unchangedRun({ head: H1 }), null],
        [t.unchangedRun({ head: H2 }), null],
        [t.changedRun({ head: H3 }), t.reader()],
      ] as const) {
        await t.facts(run);
        await t.post(run, reader);
      }
      const revisit = t.unchangedRun({ head: back });
      await t.facts(revisit);
      await t.post(revisit);
      expect(t.claiming(back)).toEqual([t.bodies().at(-1)!]);
      const marks = t.bodies().map((b) => marked(b)!);
      const heads = marks.map((m) => m.head).filter((h) => h);
      expect(heads.length).toBe(new Set(heads).size);
      const parts = marks.map((m) => `${m.first} ${m.result} ${m.part}`);
      expect(parts.length).toBe(new Set(parts).size);
    }
  });

  test("a head run again behind a later comment posts its comment afresh at the bottom however many parts", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, t.reader());
    const other = t.unchangedRun({ head: H2 });
    await t.facts(other);
    await t.post(other);
    await t.facts(d);
    expect((await t.post(d, t.four("Omega"))).action).toBe("posted");
    const mine = t.bodies().filter((b) => b.includes(`first:${H1}`));
    expect(mine.length).toBeGreaterThan(1);
    expect(t.bodies().slice(-mine.length)).toEqual(mine);
    expect(mine.join("")).not.toContain("It changes the order of requests");
    expect(t.claiming(H1).length).toBe(1);
  });

  test("continuations whose first part is gone go when a view posts", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, t.four("Alpha"));
    t.gh.comments.splice(0, 1);
    const later = t.unchangedRun({ head: H2 });
    await t.facts(later);
    await t.post(later);
    expect(t.gh.comments.length).toBe(1);
    expect(t.bodies().some((b) => b.includes("Alpha"))).toBe(false);
  });

  test("a kept comments first line says where the head is now each time its kept", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    await t.post(d);
    t.gh.head = H3;
    expect((await t.post(d)).action).toBe("edited");
    expect(t.bodies()[0]!.split("\n\n")[0]).toContain(`The pull request's head has since moved to \`${H3.slice(0, 12)}\`.`);
    t.gh.head = H1;
    expect((await t.post(d)).action).toBe("edited");
    expect(t.bodies()[0]).not.toContain("has since moved");
    expect((await t.post(d)).action).toBe("unchanged");
    expect(t.gh.comments.length).toBe(1);
  });

  test("comments past the first page are found and cleaned up", async () => {
    t.gh.nextId = 1000;
    t.gh.comments.push(...Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: "chatter", performed_via_github_app: null })));
    expect((await stopped({ repo: REPO, number: 5, head: H1 })).action).toBe("posted");
    const d = t.unchangedRun();
    await t.facts(d);
    expect((await t.post(d)).action).toBe("posted");
    expect((await t.post(d)).action).toBe("unchanged");
    const ours = t.gh.comments.filter((c) => truthy(c.performed_via_github_app ?? null)).map((c) => c.body);
    expect(ours.length).toBe(1);
    expect(ours[0]).not.toContain("stopped before it finished");
  });

  test("a replacement that fails to post leaves the view it would replace", async () => {
    const a = t.unchangedRun();
    await t.facts(a);
    await t.post(a);
    const before = t.bodies();
    const b = t.changedRun();
    await t.facts(b);
    const api = t.gh.api.bind(t.gh);
    const posts: string[] = [];
    t.patch(t.gh, "api", (method: string, path: string, body: Json) => {
      if (method === "POST") {
        posts.push(path);
        throw new Answer(422, "Validation Failed");
      }
      return api(method, path, body);
    });
    await raises(() => t.post(b, t.reader()), Failed, "");
    expect(posts.length).toBe(1);
    expect(t.bodies()).toEqual(before);
  });

  test("a dry post leaves no part of an earlier longer one", async () => {
    const d = t.changedRun();
    await t.facts(d);
    expect((await t.post(d, t.four("Alpha"), { post: false })).parts).toBeGreaterThan(1);
    expect((await t.post(d, t.reader(), { post: false })).parts).toBe(1);
    expect(readdirSync(d).filter((n) => n.startsWith("comment")).sort()).toEqual(["comment.md"]);
  });

  test("a new result posts one comment that ends with its marker", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    const out = await t.post(d);
    expect(out.action).toBe("posted");
    const bodies = t.bodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toMatch(new RegExp(`<!-- context-view:first:${H1} head:${H1} result:[0-9a-f]{64} -->$`));
  });

  test("the same head again posts nothing new", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    await t.post(d);
    expect((await t.post(d)).action).toBe("unchanged");
    expect(t.gh.comments.length).toBe(1);
  });

  test("a later head with the same result edits the first line and marker and posts nothing", async () => {
    const first = t.unchangedRun();
    await t.facts(first);
    await t.post(first);
    t.gh.head = H2;
    const later = t.unchangedRun({ head: H2 });
    await t.facts(later);
    const out = await t.post(later);
    expect(out.action).toBe("edited");
    const bodies = t.bodies();
    expect(bodies.length).toBe(1);
    const top =
      `**Automatic context view** of \`${H2.slice(0, 12)}\` merged onto \`${BASE.slice(0, 12)}\`. Its runs show no ` +
      `difference from the base, as at \`${H1.slice(0, 12)}\`, where this comment was first posted.\n\n`;
    expect(bodies[0]!.slice(0, top.length)).toBe(top);
    expect(bodies[0]).toMatch(new RegExp(`first:${H1} head:${H2} result:`));
    expect(count(bodies[0]!, "don't differ between the base and this head")).toBe(1);
  });

  test("an edit says what held at the first head in the words of its kind", async () => {
    const cases: [(h: string) => string, Reader | null, string][] = [
      [(h) => t.changedRun({ head: h }), t.reader(), "Its runs show the same differences from the base as at"],
      [(h) => t.runDir([[[], []]], { head: h, outcome: "doesnt-merge" }), null, "It couldn't be compared for the same reasons as at"],
    ];
    for (const [make, reader, said] of cases) {
      t.gh.comments.length = 0;
      const first = make(H1);
      await t.facts(first);
      await t.post(first, reader);
      const later = make(H2);
      await t.facts(later);
      expect((await t.post(later, reader)).action).toBe("edited");
      expect(t.bodies()[0]!.split("\n\n")[0]).toContain(`${said} \`${H1.slice(0, 12)}\`, where this comment was first posted.`);
    }
  });

  test("a view with differences and runs it couldnt compare says both and its edit says both held", async () => {
    const run = (head: string) =>
      t.runDir([[[result("H1/W1", { record: "differs" }), result("H1/W2", { record: "missing" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W1", 7]])]]], { head });
    const a = run(H1);
    expect((await facts({ dir: a, repo: REPO })).changed).toBe(true);
    const reader = t.reader(["aaaaaaaaaaaa"]);
    await t.post(a, reader);
    const b = run(H2);
    await t.facts(b);
    expect((await t.post(b, reader)).action).toBe("edited");
    const bodies = t.bodies();
    expect(bodies.length).toBe(1);
    const body = bodies[0]!;
    expect(body).toContain(
      "The records of 1 of the 2 runs it could compare differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n1 run couldn't be " +
        "compared; its reason is below.\n\n*A model's account of those records:*",
    );
    const runs = body.indexOf("<summary>Runs whose records differ: 1 of 2, with 1 change</summary>");
    const lost = body.indexOf("<summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `H1/W2`: " + "the base couldn't run it.\n\n</details>");
    expect(runs).toBeGreaterThanOrEqual(0);
    expect(runs).toBeLessThan(lost);
    expect(body.split("\n\n")[0]).toContain(
      "Its runs show the same differences from the base, and couldn't be compared at the same runs for the same reasons, " +
        `as at \`${H1.slice(0, 12)}\`, where this comment was first posted.`,
    );
    expect(body).toContain("couldn't be compared at `H1/W2`: the base couldn't run it.");
    expect(body).toContain("The records of 1 of the 2 runs it could compare differ between the base and this head.");
  });

  test("an edit at a later head keeps the head lines of the head its first line says it was first posted at", async () => {
    const first = t.changedRun({ head: H1 });
    await t.facts(first);
    await t.post(first, t.reader());
    const later = t.changedRun({ head: H2 });
    await t.facts(later);
    expect((await t.post(later, t.reader())).action).toBe("edited");
    const bodies = t.bodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.split("\n\n")[0]).toContain(`as at \`${H1.slice(0, 12)}\`, where this comment was first posted.`);
    expect(bodies[0]).toContain(`- head (\`${H1.slice(0, 12)}\`): The summariser gets merge requests first.`);
    expect(bodies[0]).not.toContain(`\`${H2.slice(0, 12)}\`): `);
  });

  test("a later head with another result posts a new comment", async () => {
    const first = t.unchangedRun();
    await t.facts(first);
    await t.post(first);
    const later = t.changedRun({ head: H2 });
    await t.facts(later);
    expect((await t.post(later, t.reader())).action).toBe("posted");
    expect(t.gh.comments.length).toBe(2);
  });

  test("the same entries with the readers prose written again are the same result", async () => {
    const a = t.changedRun();
    await t.facts(a);
    await t.post(a, t.reader());
    const b = t.changedRun({ head: H2 });
    await t.facts(b);
    expect((await t.post(b, t.reader([], { head: "Worded otherwise" }))).action).toBe("edited");
  });

  test("an example that reads otherwise is another result so a comment never quotes another heads text", async () => {
    const a = t.changedRun();
    await t.facts(a);
    await t.post(a, t.reader());
    const b = t.changedRun({ head: H2, after: "other new text" });
    await t.facts(b);
    expect((await t.post(b, t.reader())).action).toBe("posted");
  });

  test("a difference at a later place of an entry is another result though its example reads the same", async () => {
    const run = (head: string, second: string) => {
      const e = entry("aaaaaaaaaaaa", [
        ["H1/W1", 7],
        ["H1/W2", 4],
      ]);
      const places = e.places as Dict[];
      e.places = [
        { ...places[0]!, digest: "111111111111" },
        { ...places[1]!, digest: second },
      ];
      return t.runDir([[[result("H1/W1", { record: "differs" }), result("H1/W2", { record: "differs" }), result("C6h/W11")], [e]]], { head });
    };
    const a = run(H1, "222222222222");
    await t.facts(a);
    await t.post(a, t.reader(["aaaaaaaaaaaa"]));
    const b = run(H2, "333333333333");
    await t.facts(b);
    expect((await t.post(b, t.reader(["aaaaaaaaaaaa"]))).action).toBe("posted");
  });

  test("an arm missing whose job count changed is another result", async () => {
    const detail = { share: 1, arm: "after", log: null };
    const a = t.runDir(
      [
        [[], []],
        [[], []],
      ],
      { outcome: "arm-missing", detail },
    );
    await t.facts(a);
    await t.post(a);
    const b = t.runDir(
      [
        [[], []],
        [[], []],
        [[], []],
      ],
      { head: H2, outcome: "arm-missing", detail },
    );
    await t.facts(b);
    expect((await t.post(b)).action).toBe("posted");
  });

  test("a description edited between heads gets a fresh account where the reader runs and an edit where it doesnt", async () => {
    const a = t.changedRun();
    await t.facts(a);
    await t.post(a, t.reader());
    t.gh.pull.body = "It changes <b>that</b> now.";
    const b = t.changedRun({ head: H2 });
    await t.facts(b);
    expect((await t.post(b, t.reader())).action).toBe("posted");
    t.gh.comments.length = 0;
    const c = t.unchangedRun({ head: H1 });
    await t.facts(c);
    await t.post(c);
    t.gh.pull.body = "Edited again.";
    const d = t.unchangedRun({ head: H2 });
    await t.facts(d);
    expect((await t.post(d)).action).toBe("edited");
  });

  test("a first comment full to its room still takes the longest first line an edit can give it", async () => {
    const longest =
      `**Automatic context view** of \`${"f".repeat(12)}\` merged onto \`${BASE.slice(0, 12)}\`. Its runs show the same differences from the ` +
      `base as at \`${"0".repeat(12)}\`, where this comment was first posted. The pull request's head has since moved to \`${"e".repeat(12)}\`.`;
    const d = t.changedRun();
    await t.facts(d);
    let filled = 0;
    for (let size = 63_000; size < 65_536; size += 37) {
      const reader = { changes: [{ title: "C", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "x".repeat(size), after: "" }] };
      try {
        await t.post(d, reader, { post: false });
      } catch (e) {
        if (e instanceof Failed) continue;
        throw e;
      }
      const first = readFile(join(d, "comment.md"));
      filled = Math.max(filled, cpLength(first));
      expect([size, cpLength(first) - cpLength(first.split("\n\n")[0]!) + cpLength(longest) <= COMMENT_MAX]).toEqual([size, true]);
    }
    expect(filled).toBeGreaterThan(COMMENT_MAX - 300);
  });

  test("a later head whose host or base moved posts afresh since the body names them", async () => {
    for (const [field, value] of [
      ["host", { sha: "1".repeat(40) }],
      ["base", { ref: "main", sha: "2".repeat(40) }],
      ["harness", { repo: "anima-research/context-view", sha: "3".repeat(40) }],
    ] as const) {
      t.gh.comments.length = 0;
      const first = t.unchangedRun();
      await t.facts(first);
      await t.post(first);
      const later = t.unchangedRun({ head: H2 });
      const m = readJson(join(later, "manifest.json")) as Dict;
      m[field] = value;
      writeJson(join(later, "manifest.json"), m);
      await t.facts(later);
      expect([field, (await t.post(later)).action]).toEqual([field, "posted"]);
      expect([field, t.gh.comments.length]).toEqual([field, 2]);
    }
  });

  test("a partial comment from an earlier head is posted again whole rather than edited", async () => {
    const long = "x".repeat(20_000);
    const reader = { changes: [0, 1, 2, 3].map((i) => ({ title: `C${i}`, where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: long, after: long })) };
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, reader);
    const parts = t.gh.comments.length;
    t.gh.comments.pop();
    const later = t.changedRun({ head: H2 });
    await t.facts(later);
    expect((await t.post(later, reader)).action).toBe("posted");
    expect(t.gh.comments.length).toBe(parts);
    expect(t.bodies().every((b) => b.includes(`first:${H2}`))).toBe(true);
  });

  test("another result at the same head replaces the comment so a head has one", async () => {
    const a = t.unchangedRun();
    await t.facts(a);
    await t.post(a);
    const b = t.changedRun();
    await t.facts(b);
    expect((await t.post(b, t.reader())).action).toBe("posted");
    expect(t.bodies().length).toBe(1);
    expect(t.bodies()[0]).toContain("runs differ between the base and this head.");
  });

  test("a comment the post couldnt delete after posting is named and the post still answers posted", async () => {
    const a = t.unchangedRun();
    await t.facts(a);
    await t.post(a);
    expect(t.gh.comments.length).toBe(1);
    const old = t.gh.comments[0]!;
    t.gh.undeletable.add(old.id);
    const b = t.changedRun();
    await t.facts(b);
    const answer = await t.post(b, t.reader());
    expect(answer.action).toBe("posted");
    expect(Object.hasOwn(answer, "staleKept")).toBe(true);
    const kept = answer.staleKept as string[];
    expect(kept.length).toBe(1);
    expect(kept[0]).toContain(old.html_url as string);
    expect(t.bodies().at(-1)).toContain("runs differ between the base and this head.");
  });

  test("a quote on one side too long for a comment is cut to fit", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, { changes: [{ title: "C", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b".repeat(70_000), after: "" }] });
    expect(t.bodies().every((b) => cpLength(b) <= COMMENT_MAX)).toBe(true);
    expect(t.bodies().join("")).toContain("Before, its first");
  });

  test("a pull request closed or merged gets nothing", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    t.gh.state = "closed";
    expect((await t.post(d)).action).toBe("closed");
    expect(t.gh.comments).toEqual([]);
  });

  test("a head that moved before its run posts nothing", async () => {
    const d = t.runDir([], { outcome: "moved", detail: { headNow: H2 } });
    await t.facts(d);
    expect((await t.post(d)).action).toBe("moved");
    expect(t.gh.comments).toEqual([]);
  });

  test("a head that moved after its run says so in its first line", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    t.gh.head = H3;
    await t.post(d);
    expect(t.bodies()[0]!.split("\n\n")[0]).toContain(`The pull request's head has since moved to \`${H3.slice(0, 12)}\`.`);
  });

  test("a heads stopped words are deleted once its view posts and once it edits", async () => {
    await stopped({ repo: REPO, number: 5, head: H1 });
    expect(t.stoppedHeads()).toEqual([H1]);
    const d = t.unchangedRun();
    await t.facts(d);
    expect((await t.post(d)).action).toBe("posted");
    expect(t.stoppedHeads()).toEqual([]);
    t.gh.head = H2;
    expect((await stopped({ repo: REPO, number: 5, head: H2 })).action).toBe("posted");
    expect(t.stoppedHeads()).toEqual([H2]);
    const later = t.unchangedRun({ head: H2 });
    await t.facts(later);
    expect((await t.post(later)).action).toBe("edited");
    expect(t.stoppedHeads()).toEqual([]);
    expect(t.gh.comments.length).toBe(1);
  });

  test("a view leaves another heads stopped words so a newer heads failure stays said", async () => {
    await stopped({ repo: REPO, number: 5, head: H1 });
    t.gh.head = H2;
    expect((await stopped({ repo: REPO, number: 5, head: H2 })).action).toBe("posted");
    const d = t.unchangedRun();
    await t.facts(d);
    expect((await t.post(d)).action).toBe("posted");
    expect(t.stoppedHeads()).toEqual([H2]);
  });

  test("a posting that fails partway deletes the parts that went up and fails the step", async () => {
    const d = t.changedRun();
    await t.facts(d);
    t.gh.postsFailAfter = 1;
    await raises(() => t.post(d, t.four("Alpha")), Failed, /502 .*; the parts of its comment the pull request then listed are deleted/);
    expect(t.gh.comments).toEqual([]);
  });

  test("a posting github answers with text that isnt json deletes the parts that went up too", async () => {
    const d = t.changedRun();
    await t.facts(d);
    const answer = t.gh.api.bind(t.gh);
    t.patch(t.gh, "api", (method: string, path: string, body: Json) => {
      const out = answer(method, path, body);
      return method === "POST" && t.gh.posts === 2 ? raw("<html>") : out;
    });
    const [raised] = await captured(() => raises(() => t.post(d, t.four("Alpha")), Failed, ""));
    expect(raised.message).toMatch(/^JSONDecodeError: Expecting value: .*; the parts of its comment the pull request then listed are deleted$/);
    expect(t.gh.comments).toEqual([]);
  });

  test("a cleanup whose listing isnt json says so beside the posting failure", async () => {
    const d = t.changedRun();
    await t.facts(d);
    t.gh.postsFailAfter = 1;
    const listing = seams.onPull;
    const calls: unknown[] = [];
    t.patch(seams, "onPull", (...args: Parameters<typeof listing>) => {
      calls.push(args);
      if (calls.length === 2) loads("<html>");
      return listing(...args);
    });
    const [raised] = await captured(() => raises(() => t.post(d, t.four("Alpha")), Failed, ""));
    expect(raised.message).toMatch(/^GitHub answered 502 .*; deleting the parts of its comment that went up failed too: JSONDecodeError: Expecting value/);
    expect(calls.length).toBe(2);
  });

  test("a fault of the steps own in the cleanup prints where it is and still ends with the verdict", async () => {
    const d = t.changedRun();
    await t.facts(d);
    t.gh.postsFailAfter = 1;
    const listing = seams.onPull;
    const calls: unknown[] = [];
    t.patch(seams, "onPull", function broken(...args: Parameters<typeof listing>) {
      calls.push(args);
      if (calls.length === 2) throw new TypeError("'NoneType' object is not subscriptable");
      return listing(...args);
    });
    const [raised, , err] = await captured(() => raises(() => t.post(d, t.four("Alpha")), Failed, ""));
    expect(raised.message).toMatch(/^GitHub answered 502 .*; deleting the parts of its comment that went up failed too: TypeError: 'NoneType' object is not subscriptable$/);
    expect(err).toMatch(/^\s+at broken .*\nTypeError: 'NoneType' object is not subscriptable\n$/s);
  });

  test("a cleanup tries every part and names each still there", async () => {
    const d = t.changedRun();
    await t.facts(d);
    t.gh.postsFailAfter = 3;
    const [first, third] = [t.gh.nextId + 1, t.gh.nextId + 3];
    t.gh.undeletable.add(first);
    t.gh.undeletable.add(third);
    const raised = await raises(() => t.post(d, t.four("Alpha")), Failed, "");
    expect(t.gh.comments.map((c) => c.id)).toEqual([first, third]);
    expect(raised.message).toContain(`#issuecomment-${first} may still be there`);
    expect(raised.message).toContain(`#issuecomment-${third} may still be there`);
  });

  test("a posting that fails partway and whose parts cant be deleted says which is still there", async () => {
    const d = t.changedRun();
    await t.facts(d);
    t.gh.postsFailAfter = 1;
    t.gh.undeletable.add(t.gh.nextId + 1);
    await raises(
      () => t.post(d, t.four("Alpha")),
      Failed,
      new RegExp(`deleting the parts of its comment that went up failed too: \\S+#issuecomment-${t.gh.nextId + 1} may still be there`),
    );
  });

  test("a chain left partly deleted is named by the first part still there", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, t.four("Alpha"));
    const [first, second] = [t.gh.comments[0]!, t.gh.comments[1]!];
    t.gh.undeletable.add(second.id);
    const other = t.unchangedRun();
    await t.facts(other);
    const answer = await t.post(other);
    expect(answer.action).toBe("posted");
    const kept = answer.staleKept as string[];
    expect(kept.length).toBe(1);
    expect(kept[0]!.startsWith(`${second.html_url} may still be there`)).toBe(true);
    expect(t.gh.comments).not.toContain(first);
  });

  test("a comment too long for one is posted as parts each under githubs limit", async () => {
    const long = "x".repeat(20_000);
    const changes = [0, 1, 2, 3].map((i) => ({ title: `Change ${i}`, where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: long, after: long }));
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, { changes });
    const bodies = t.bodies();
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((b) => cpLength(b) <= COMMENT_MAX)).toBe(true);
    expect(bodies.slice(1).every((b, i) => rstrip(b).endsWith(`:${i + 2} -->`))).toBe(true);
    expect(bodies[0]!.split("\n\n").at(-2) === MORE && bodies.at(-1)!.split("\n\n").at(-2) !== MORE).toBe(true);
  });

  test("a comment whose posting stopped partway is posted again whole from the run started again", async () => {
    const long = "x".repeat(20_000);
    const said = (word: string) => ({ changes: [0, 1, 2, 3].map((i) => ({ title: `C${i}`, where: word, base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: long, after: long })) });
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, said("Alpha"));
    const parts = t.gh.comments.length;
    t.gh.comments.splice(1);
    await t.post(d, said("Omega"));
    expect(t.gh.comments.length).toBe(parts);
    expect(t.bodies().some((b) => b.includes("Alpha"))).toBe(false);
  });

  test("a quote too long for a comment shows its first characters and says how many of how many", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, { changes: [{ title: "C", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "b".repeat(100_000), after: "a".repeat(30) }] });
    expect(t.bodies().every((b) => cpLength(b) <= COMMENT_MAX)).toBe(true);
    const text = t.bodies().join("");
    const shown = /Before, its first ([0-9,]+) of 100,000 characters:\n\n```text\n(b+)\n```/.exec(text);
    expect(shown).not.toBeNull();
    expect(Number(shown![1]!.replaceAll(",", ""))).toBe(shown![2]!.length);
    expect(text).toContain("After:\n\n```text\n" + "a".repeat(30) + "\n```");
  });

  test("a long quote full of backtick runs is cut until its longer fences fit", async () => {
    const d = t.changedRun();
    await t.facts(d);
    const quote = ("x" + "`".repeat(300)).repeat(300);
    await t.post(d, { changes: [{ title: "C", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: quote, after: quote }] });
    expect(t.bodies().length).toBeGreaterThan(0);
    expect(t.bodies().every((b) => cpLength(b) <= COMMENT_MAX)).toBe(true);
  });

  test("a comment edited to a head is unchanged at it and edited back at its first", async () => {
    const first = t.unchangedRun();
    await t.facts(first);
    await t.post(first);
    const later = t.unchangedRun({ head: H2 });
    await t.facts(later);
    await t.post(later);
    expect((await t.post(later)).action).toBe("unchanged");
    await t.facts(first);
    expect((await t.post(first)).action).toBe("edited");
    const bodies = t.bodies();
    expect(bodies.length).toBe(1);
    const top = `**Automatic context view** of \`${H1.slice(0, 12)}\` merged onto \`${BASE.slice(0, 12)}\`.\n\n`;
    expect(bodies[0]!.slice(0, top.length)).toBe(top);
    expect(bodies[0]).toMatch(new RegExp(`first:${H1} head:${H1} result:`));
  });

  test("a one part comment full to its room takes the longest first line and marker an edit can give it", async () => {
    const longest =
      `**Automatic context view** of \`${"f".repeat(12)}\` merged onto \`${BASE.slice(0, 12)}\`. Its runs show the same differences from the ` +
      `base as at \`${"0".repeat(12)}\`, where this comment was first posted. The pull request's head has since moved to \`${"e".repeat(12)}\`.`;
    const d = t.changedRun();
    await t.facts(d);
    const parts = async (size: number): Promise<number> => {
      const reader = { changes: [{ title: "C", where: "w", base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: "y".repeat(size), after: "" }] };
      await t.post(d, reader, { post: false });
      return 1 + [2, 3].filter((n) => existsSync(join(d, `comment-${n}.md`))).length;
    };
    let [lo, hi] = [1, 70_000];
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((await parts(mid)) === 1 && !readFile(join(d, "comment.md")).includes("its first")) lo = mid;
      else hi = mid - 1;
    }
    await parts(lo);
    const first = readFile(join(d, "comment.md"));
    expect(cpLength(first) - cpLength(first.split("\n\n")[0]!) + cpLength(longest)).toBeLessThanOrEqual(COMMENT_MAX);
  });

  test("an edit still holds the reader account to the view", async () => {
    const d = t.changedRun();
    await t.facts(d);
    expect((await t.post(d, t.reader())).action).toBe("posted");
    expect(t.gh.comments.length).toBe(1);
    const later = t.changedRun({ head: H2 });
    await t.facts(later);
    const [before, calls] = [t.bodies(), t.gh.calls.length];
    await raises(() => t.post(later, t.reader(["aaaaaaaaaaaa", "cccccccccccc"])), Failed, /entries the view doesn.t have/);
    expect(t.bodies()).toEqual(before);
    expect(t.gh.calls.slice(calls).filter((c) => c[0] !== "GET")).toEqual([]);
    expect((await t.post(later, t.reader())).action).toBe("edited");
  });

  test("a partial comment at this head behind a later one is posted again whole", async () => {
    const long = "x".repeat(20_000);
    const said = (word: string) => ({ changes: [0, 1, 2, 3].map((i) => ({ title: `C${i}`, where: word, base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: long, after: long })) });
    const reader = said("Omega");
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, said("Alpha"));
    const parts = t.gh.comments.length;
    const other = t.unchangedRun({ head: H2 });
    await t.facts(other);
    await t.post(other);
    t.gh.comments.splice(parts - 1, 1);
    await t.facts(d);
    await t.post(d, reader);
    const mine = t.bodies().filter((b) => b.includes(`first:${H1}`));
    expect(mine.length).toBe(parts);
    expect(mine.some((b) => b.includes("Alpha"))).toBe(false);
    expect(mine.at(-1)!.split("\n\n").at(-2) === MORE).toBe(false);
  });

  test("a dry run writes the comment and touches no pull request", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    const calls = t.gh.calls.length;
    expect((await t.post(d, null, { post: false })).action).toBe("dry");
    expect(t.gh.calls.slice(calls)).toEqual([]);
    expect(existsSync(join(d, "comment.md"))).toBe(true);
  });

  test("a comment that carries the views marker but isnt the apps is neither kept nor deleted", async () => {
    const d = t.unchangedRun();
    const view = await t.facts(d);
    const foreign = { id: 50, body: `copied\n\n${mark(view, H1, "9".repeat(64))}`, html_url: `https://github.com/${REPO}/pull/5#issuecomment-50`, performed_via_github_app: null };
    t.gh.comments.push({ ...foreign });
    expect((await t.post(d)).action).toBe("posted");
    expect(t.gh.comments[0]).toEqual(foreign);
    expect(t.gh.comments.length).toBe(2);
  });

  test("the latest comment is the one whose first part github made last though an earlier part of it is listed first", async () => {
    const d = t.unchangedRun();
    const view = await t.facts(d);
    const digest = resultOf(view);
    const app = { performed_via_github_app: { id: APP } };
    const url = (id: number) => `https://github.com/${REPO}/pull/5#issuecomment-${id}`;
    t.gh.comments.push(
      { id: 50, body: `left from an earlier posting\n\n${mark(view, H1, digest, 2)}`, html_url: url(50), ...app },
      { id: 100, body: `another head's\n\n${mark({ head: H2 }, H2, "8".repeat(64))}`, html_url: url(100), ...app },
      { id: 200, body: `top\n\nbody\n\n${MORE}\n\n${mark(view, H1, digest)}`, html_url: url(200), ...app },
    );
    t.gh.nextId = 300;
    expect((await t.post(d)).action).toBe("edited");
    expect(t.gh.comments.map((c) => c.id)).toEqual([50, 100, 200]);
  });

  test("a part of ten or more is read back by its number", () => {
    expect(marked(mark({ head: H1 }, H1, "1".repeat(64), 12))).toEqual({ stopped: null, first: H1, head: null, result: "1".repeat(64), part: "12" });
  });

  test("a chain whose first part isnt part 1 claims no head though its marker names one", () => {
    const body = `words\n\n${mark({ head: H1 }, H1, "1".repeat(64), 2).replace(" result:", ` head:${H2} result:`)}`;
    expect(chains([[{ id: 5, body }, marked(body)!]]).map((x) => [x.whole, x.claims])).toEqual([[false, null]]);
  });

  test("a part already gone when the post deletes it counts as deleted", async () => {
    const d = t.unchangedRun();
    const view = await t.facts(d);
    t.gh.comments.push({ id: 50, body: `left\n\n${mark(view, H2, "8".repeat(64), 2)}`, html_url: `https://github.com/${REPO}/pull/5#issuecomment-50`, performed_via_github_app: { id: APP } });
    const answer = t.gh.api.bind(t.gh);
    let gone = 0;
    t.patch(t.gh, "api", (method: string, path: string, body: Json) => {
      if (method === "DELETE" && path.endsWith("/comments/50")) {
        gone += 1;
        throw new Answer(404, "Not Found");
      }
      return answer(method, path, body);
    });
    const posted = await t.post(d);
    expect([posted.action, posted.staleKept, gone]).toEqual(["posted", undefined, 1]);
  });

  test("a reader account beside a head that couldnt be compared is refused", async () => {
    const view = await t.facts(t.runDir([[[], []]], { outcome: "arm-missing", detail: { share: 1, arm: "after", log: null } }));
    await raises(() => units(view, { changes: [] }, 65_000), Failed, "a head that couldn't be compared has no reader account");
  });

  test("reads with a key besides instructions and guide is refused", async () => {
    const d = t.changedRun();
    await t.facts(d);
    const reads = { ...READS, extra: "3".repeat(64) };
    await raises(() => postStep({ dir: d, reader: t.write(d, t.reader()), reads }), Failed, "post: reads is {instructions, guide}, each a sha256 in lowercase hex");
  });

  test("a reader account line longer than a comment is refused as a paragraph that doesnt fit", async () => {
    for (const [field, head] of [["where", H1], ["base", H2], ["head", H3]] as const) {
      const d = t.changedRun({ head });
      const reader = t.reader();
      reader.changes[0]![field] = "w ".repeat(40_000);
      await raises(() => t.comment(d, reader), Failed, "one paragraph of the comment doesn't fit in a comment of GitHub's 65,536 characters: **Delta 1: Merges go first**");
    }
  });
});

class Context extends Steps {
  callsPath = join(this.tmp, "review-poll.calls");
  exitPath = join(this.tmp, "review-poll.exit");

  override async setUp(): Promise<void> {
    await super.setUp();
    const command = join(this.tmp, "review-poll");
    writeFileSync(
      command,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(this.callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
let code = 0;
try {
  code = Number(readFileSync(${JSON.stringify(this.exitPath)}, "utf8"));
} catch {}
if (code) process.stderr.write(Buffer.concat([Buffer.from("review-poll: no such step, want "), Buffer.from([0xff, 0x0a])]));
process.exit(code);
`,
    );
    chmodSync(command, 0o755);
    this.patch(seams, "REVIEW_POLL", command);
  }

  wants(): string[][] {
    if (!existsSync(this.callsPath)) return [];
    return readFile(this.callsPath)
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l) as string[]);
  }

  ranAt(d: string, when: string): void {
    const at = Date.parse(when) / 1000;
    utimesSync(join(d, "manifest.json"), at, at);
  }
}

describe("Context", () => {
  let t: Context;
  beforeEach(async () => {
    t = new Context();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("a view wants yes where some run it compared differs no where every run compared and none does and nothing else", async () => {
    const cases: [string, string, string | null][] = [
      ["differs", t.changedRun(), "Yes"],
      ["same", t.unchangedRun(), "No"],
      [
        "some lost, the rest differ",
        t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2", { record: "differs" }), result("C6h/W11")], [entry("aaaaaaaaaaaa", [["H1/W2", 1]])]]]),
        "Yes",
      ],
      ["some lost, the rest the same", t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2"), result("C6h/W11")], []]]), null],
      [
        "none compared",
        t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2", { record: "missing" }), result("C6h/W11", { record: "missing" })], []]]),
        null,
      ],
      ["doesnt-merge", t.runDir([[[], []]], { outcome: "doesnt-merge" }), null],
      ["arm-missing", t.runDir([[[], []]], { outcome: "arm-missing", detail: { share: 1, arm: "after", log: null } }), null],
    ];
    for (const [name, d, value] of cases) expect([name, contextOf(await t.facts(d))]).toEqual([name, value]);
    expect(contextOf({ ...(await t.facts(t.changedRun())), merge: { commit: H1 } })).toBeNull();
  });

  test("a posted edited or kept comment wants its value timed when its run side finished as facts read it", async () => {
    const a = t.changedRun();
    t.ranAt(a, "2026-11-10T23:41:07.6+00:00");
    await t.facts(a);
    t.ranAt(a, "2026-11-11T02:00:00+00:00");
    expect((await t.post(a, t.reader())).action).toBe("posted");
    expect((await t.post(a, t.reader())).action).toBe("unchanged");
    const b = t.changedRun({ head: H2 });
    t.ranAt(b, "2026-11-11T00:02:59+00:00");
    await t.facts(b);
    expect((await t.post(b, t.reader())).action).toBe("edited");
    const c = t.unchangedRun({ head: H3 });
    t.ranAt(c, "2026-11-11T01:00:00+00:00");
    await t.facts(c);
    expect((await t.post(c)).action).toBe("posted");
    const want = (d: string, value: string, at: string) => ["want", "--kind", "context", "--repo", REPO, "--number", "5", "--label", basename(d), "--value", value, "--started", at];
    expect(t.wants()).toEqual([
      want(a, "Yes", "2026-11-10T23:41:07Z"),
      want(a, "Yes", "2026-11-10T23:41:07Z"),
      want(b, "Yes", "2026-11-11T00:02:59Z"),
      want(c, "No", "2026-11-11T01:00:00Z"),
    ]);
  });

  test("a dry view one whose pull request moved or closed and one that couldnt tell want nothing", async () => {
    const d = t.changedRun();
    await t.facts(d);
    expect((await t.post(d, t.reader(), { post: false })).action).toBe("dry");
    const lost = t.runDir([[[result("H1/W1", { record: "missing" }), result("H1/W2"), result("C6h/W11")], []]]);
    await t.facts(lost);
    expect((await t.post(lost)).action).toBe("posted");
    const moved = t.runDir([], { outcome: "moved", detail: { headNow: H2 } });
    await t.facts(moved);
    expect((await t.post(moved)).action).toBe("moved");
    t.gh.state = "closed";
    const e = t.changedRun({ head: H2 });
    await t.facts(e);
    expect((await t.post(e, t.reader())).action).toBe("closed");
    expect(t.wants()).toEqual([]);
  });

  test("a want that fails a command that isnt there or a view json without ended is said on stderr and the view still posts", async () => {
    writeFileSync(t.exitPath, "2");
    const d = t.changedRun();
    await t.facts(d);
    let [answer, , err] = await captured(() => t.post(d, t.reader()));
    expect(answer.action).toBe("posted");
    expect(err).toContain(`post: its Changes context, Yes, wasn't wanted: ${seams.REVIEW_POLL} exited 2: review-poll: no such step, want`);
    expect(t.wants().length).toBe(1);
    const e = t.changedRun({ head: H2, after: "other new text" });
    await t.facts(e);
    const command = seams.REVIEW_POLL;
    seams.REVIEW_POLL = join(t.tmp, "nowhere");
    try {
      [answer, , err] = await captured(() => t.post(e, t.reader()));
    } finally {
      seams.REVIEW_POLL = command;
    }
    expect(answer.action).toBe("posted");
    expect(err).toContain("post: its Changes context, Yes, wasn't wanted: ");
    expect(t.gh.comments.length).toBe(2);
    const f = t.changedRun({ head: H3, after: "a third new text" });
    await t.facts(f);
    const view = join(f, "view.json");
    const { ended: _, ...older } = readJson(view) as Dict;
    writeFileSync(view, dumps(older));
    [answer, , err] = await captured(() => t.post(f, t.reader()));
    expect(answer.action).toBe("posted");
    expect(err).toContain("post: its Changes context, Yes, wasn't wanted: its view.json has no ended");
    expect(t.wants().length).toBe(1);
    expect(t.gh.comments.length).toBe(3);
  });

  test("a view started beside this one in its directory moves neither its want nor its time", async () => {
    const d = t.changedRun();
    t.ranAt(d, "2026-11-11T01:10:00+00:00");
    await t.facts(d);
    rmSync(join(d, "manifest.json"));
    expect((await t.post(d, t.reader())).action).toBe("posted");
    writeFileSync(join(d, "manifest.json"), "{}");
    t.ranAt(d, "2026-11-11T01:30:00+00:00");
    expect((await t.post(d, t.reader())).action).toBe("unchanged");
    expect(t.wants().map((w) => w.at(-1))).toEqual(["2026-11-11T01:10:00Z", "2026-11-11T01:10:00Z"]);
  });

  test("a want whose command exits 1 is said on stderr and the view still posts", async () => {
    writeFileSync(t.exitPath, "1");
    const d = t.changedRun();
    await t.facts(d);
    const [answer, , err] = await captured(() => t.post(d, t.reader()));
    expect(answer.action).toBe("posted");
    expect(err).toContain(`post: its Changes context, Yes, wasn't wanted: ${seams.REVIEW_POLL} exited 1: review-poll: no such step, want`);
  });
});

describe("Stopped", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("the stopped words post once for a head and name it", async () => {
    const out = await stopped({ repo: REPO, number: 5, head: H1 });
    expect(out.action).toBe("posted");
    const twice = await stopped({ repo: REPO, number: 5, head: H1 });
    expect([twice.action, twice.found ?? null, twice.url]).toEqual(["unchanged", "stopped", out.url]);
    expect(t.bodies()).toEqual([
      `**Automatic context view** of \`${H1.slice(0, 12)}\` stopped before it finished, so it has nothing to ` +
        "report.\n\nWhat a context view runs and what its checks judge are in " +
        "[CHECKS.md](https://github.com/anima-research/context-view/blob/main/CHECKS.md).\n\n" +
        `<!-- context-view:stopped:${H1} -->`,
    ]);
  });

  test("a view whose parts didnt all post is replaced by the stopped words", async () => {
    const d = t.changedRun();
    await t.facts(d);
    await t.post(d, t.four("Alpha"));
    t.gh.comments.splice(1);
    expect((await stopped({ repo: REPO, number: 5, head: H1 })).action).toBe("posted");
    expect(t.bodies().length).toBe(1);
    expect(t.bodies()[0]).toContain("stopped before it finished");
  });

  test("a view already posted at the head gets no stopped words beside it and is named as a view", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    const posted = await t.post(d);
    const out = await stopped({ repo: REPO, number: 5, head: H1 });
    expect([out.action, out.found ?? null, out.url]).toEqual(["unchanged", "view", posted.url]);
    expect(t.gh.comments.length).toBe(1);
  });

  test("a pull request whose head moved gets no stopped words for the head it left", async () => {
    t.gh.head = H2;
    expect(await stopped({ repo: REPO, number: 5, head: H1 })).toEqual({ action: "moved", headNow: H2 });
    expect(t.gh.comments).toEqual([]);
  });

  test("a closed pull request gets no stopped words", async () => {
    t.gh.state = "closed";
    expect((await stopped({ repo: REPO, number: 5, head: H1 })).action).toBe("closed");
    expect(t.gh.comments).toEqual([]);
  });

  test("a repository outside the four is refused", async () => {
    await raises(() => stopped({ repo: "anima-research/lode", number: 5, head: H1 }), NotARequest, "");
    const d = t.unchangedRun();
    await t.facts(d);
    const view = readJson(join(d, "view.json")) as Dict;
    writeJson(join(d, "view.json"), { ...view, repo: "anima-research/lode" });
    await raises(() => t.post(d), NotARequest, "");
  });

  test("a refusal through the command line exits 2 and says why on stderr", async () => {
    const given = JSON.stringify({ repo: "anima-research/lode", number: 5, head: H1 });
    const [code, out, err] = await captured(() => main(["stopped"], { stdin: given }));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("view.ts stopped: anima-research/lode isn't one of the context view's repositories\n");
    expect(t.gh.comments).toEqual([]);
  });

  test("a head that isnt a full commit sha gets no stopped words", async () => {
    await raises(() => stopped({ repo: REPO, number: 5, head: "abc", post: false }), Failed, "head isn't a full commit sha, 'abc'");
  });

  test("a steps fault through the command line exits 1 and a field it reads that is missing prints its frames then the error then what it can be", async () => {
    let [code, out, err] = await captured(() => main(["post"], { stdin: "[]" }));
    expect([code, out, err]).toEqual([1, "", "view.ts post: stdin: one JSON object\n"]);
    [code, out, err] = await captured(() => main(["post"], { stdin: "{}" }));
    expect([code, out]).toEqual([1, ""]);
    const said = err.replace(/\n+$/, "").split("\n");
    expect(said.slice(-2)).toEqual(["KeyError: 'dir'", "view.ts post: a field it reads is missing or of another shape, or the step's own code failed; the traceback above says which"]);
    expect(said.slice(0, -2).length).toBeGreaterThan(0);
    expect(said.slice(0, -2).every((l) => /^\s+at /.test(l))).toBe(true);
  });

  test("an error the step doesnt know ends stderr with its own line and exits 1 rather than escaping the step", async () => {
    const d = t.unchangedRun();
    await t.facts(d);
    mkdirSync(join(d, "comment.md"));
    const [code, out, err] = await captured(() => main(["post"], { stdin: dumps({ dir: d, post: false }) }));
    expect([code, out]).toEqual([1, ""]);
    const said = err.replace(/\n+$/, "").split("\n");
    expect(said.at(-1)).toMatch(/^\w*Error: .*comment\.md/);
    expect(said.slice(0, -1).every((l) => /^\s+at /.test(l))).toBe(true);
  });
});

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const exits = (f: Fixture): void => f.patch(process, "exit", ((code?: number) => {
  throw new Exit(code ?? 0);
}) as typeof process.exit);

describe("StepNames", () => {
  let f: Fixture;
  beforeEach(() => {
    f = new Fixture();
  });
  afterEach(async () => {
    await f.tearDown();
  });

  test("the steps are compared facts post and stopped and rooms is refused as unknown", async () => {
    expect(Object.keys(STEPS).sort()).toEqual(["compared", "facts", "post", "stopped"]);
    exits(f);
    const [code, , err] = await captured(() => main(["rooms"]));
    expect(code).toBe(2);
    expect(err).toContain("invalid choice: 'rooms'");
  });

  test("a command line whose step is an option or is followed by a word is refused as argparse refuses it", async () => {
    exits(f);
    const usage = "usage: view.ts [-h] {compared,facts,post,stopped}\n";
    for (const [argv, why] of [
      [["-x"], "the following arguments are required: step"],
      [["post", "x"], "unrecognized arguments: x"],
    ] as const) {
      const [code, , err] = await captured(() => main([...argv]));
      expect([code, err]).toEqual([2, `${usage}view.ts: error: ${why}\n`]);
    }
  });
});

describe("Checkout", () => {
  let f: Fixture;
  beforeEach(() => {
    f = new Fixture();
  });
  afterEach(async () => {
    await f.tearDown();
  });

  test("a command line from the main working copy refuses naming the installed form and elsewhere runs", async () => {
    const copy = dirname(dirname(realpathSync(here("./view.ts"))));
    exits(f);
    f.patch(seams, "CHECKOUT", copy);
    f.patch(process, "argv", ["bun", "view.ts", "stopped"]);
    const [refused, , err] = await captured(() => main());
    expect(refused).toBe(1);
    expect(err).toContain(`not from its main working copy ${copy}: use ` + "`~/.local/lib/context-view/current/view/step STEP`");
    const given = JSON.stringify({ repo: "o/r", number: 1, head: "a".repeat(40), post: false });
    seams.CHECKOUT = mkdtempSync(join(f.tmp, "elsewhere-"));
    const [code, out] = await captured(() => main(null, { stdin: given }));
    expect(code).toBe(0);
    expect(JSON.parse(out).action).toBe("dry");
  });

  test("the copys own environment and a link to its module from elsewhere are the copy too", async () => {
    const copy = mkdtempSync(join(f.tmp, "copy-"));
    const elsewhere = mkdtempSync(join(f.tmp, "elsewhere-"));
    const installed = join(copy, "view", "node_modules", "review-workflow", "view.ts");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, "");
    const link = join(elsewhere, "view.ts");
    symlinkSync(installed, link);
    exits(f);
    f.patch(seams, "CHECKOUT", copy);
    for (const module of [installed, link]) {
      const [refused] = await captured(() => refuseCheckout(module, "the installed form", 1));
      expect([module, refused]).toEqual([module, 1]);
    }
    expect(refuseCheckout(join(elsewhere, "other.ts"), "the installed form", 1)).toBeNull();
  });
});
