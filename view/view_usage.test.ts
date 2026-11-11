import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Failed, inert, type Json } from "review-workflow/view";

import { ALL_RAN, entry, HARNESS, priced, raises, result, RUNS, Steps, usage, type UsageOptions } from "./testing.ts";
import { resultOf } from "./view.ts";
import { PRICE_MODEL, UPGRADED, USAGE_MODEL } from "./view_usage.ts";
import { UNREAD } from "./view_words.ts";

type Dict = { [key: string]: Json };

const CONTEXT_CHECKS = `https://github.com/anima-research/context-view/blob/${HARNESS}/CHECKS.md#what-the-context-figures-count`;

const count = (text: string, part: string): number => text.split(part).length - 1;

const ctx = (seams = 0, out = 0, largest = 0, peak = 10_000): Dict => ({ seams, out, largest, peak });

const used = (context: Json = null, kinds: UsageOptions = {}): Dict => ({ ...usage(kinds), ...(context !== null ? { context } : {}) });

const kindsOf = (u: Dict): Dict => u.kinds as Dict;

const differing = (differ: boolean, r: string): Dict => (differ ? { record: r === "H1/W1" ? "differs" : "same" } : {});

const AT_W1 = [entry("bbbbbbbbbbbb", [["H1/W1", 1]])];

const summariser = (n: number): Record<string, UsageOptions> => ({ "H1/W2": { summariser: { requests: n } } });

class Usage extends Steps {
  contextView(baseCtx: Json[], headCtx: Json[], differ = true, baseMore: Record<string, UsageOptions> | null = null, headMore: Record<string, UsageOptions> | null = null): string {
    const base = RUNS.map((r, i) => result(r, { usage: used(baseCtx[i]!, baseMore?.[r] ?? {}) }));
    const head = RUNS.map((r, i) => result(r, { record: differ && r === "H1/W1" ? "differs" : "same", usage: used(headCtx[i]!, headMore?.[r] ?? {}) }));
    return this.runDir([[head, differ ? AT_W1 : []]], { baseResults: base });
  }

  comparedText(head: Dict[], base: Dict[], entries: Dict[] = []): Promise<string> {
    return this.comment(this.runDir([[head, entries]], { baseResults: base }));
  }
}

describe("Usage", () => {
  let t: Usage;
  beforeEach(async () => {
    t = new Usage();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("the agents usage shows above the fold the same on both sides with its figures and what they model", async () => {
    const runs = [result("H1/W1", { usage: usage() }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    const text = await t.comparedText(runs, runs);
    expect(text).toContain(
      `between the base and this head.\n\n${ALL_RAN}\n\nUsage: the figures of the agents' requests, subagents' included, in the 3 runs are the same in the base and this head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output and 0 thinking blocks dropped. ${USAGE_MODEL}\n\nHeld the same in base and head:`,
    );
    expect(text).not.toContain("Usage that differs");
  });

  test("usage that moved gives the agents sums base to head and folds each moved runs kinds with the count of runs that didnt", async () => {
    const big = { requests: 30, input: 3000, cacheRead: 60000, cacheWrite: 1500, output: 600 };
    const base = [result("H1/W1", { usage: usage({ agent: big }) }), result("H1/W2", { usage: usage({ summariser: { requests: 4 } }) }), result("C6h/W11", { usage: usage() })];
    const head = [
      result("H1/W1", { usage: usage({ agent: big }) }),
      result("H1/W2", { usage: usage({ agent: { cacheRead: 8000, cacheWrite: 1500 }, summariser: { requests: 4 } }) }),
      result("C6h/W11", { usage: usage() }),
    ];
    let text = await t.comparedText(head, base);
    expect(text).toContain(
      `Usage: the agents' requests, subagents' included, in the 3 runs, base → head: 1,710 tokens sent a request, 91.2% → 90.1% of them read from the cache, 2,500 → 3,500 written to it, 1,000 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind of request; they're under "Usage that differs", below. ${USAGE_MODEL}\n\n`,
    );
    expect(text).toContain(
      "<details><summary>Usage that differs: 1 of 3 runs, base → head</summary>\n\n" +
        "| `H1/W2` | kind | requests | input | read from the cache | written to it | output | thinking dropped |\n" +
        "| --- | --- | --- | --- | --- | --- | --- | --- |\n" +
        "| | agent | 10 | 1,000 | 9,000 → 8,000 | 500 → 1,500 | 200 | 0 |\n" +
        "| | summariser | 4 | 1,000 | 9,000 | 500 | 200 | 0 |\n\n" +
        "The figures of the other 2 runs are the same in the base and this head.\n\n</details>",
    );
    const other = [result("H1/W1", { usage: usage({ agent: big }) }), result("H1/W2", { usage: usage({ summariser: { requests: 5 } }) }), result("C6h/W11", { usage: usage() })];
    text = await t.comparedText(other, base);
    expect(text).toContain(
      "are the same in the base and this head: 1,710 tokens sent a request, 91.2% of them read from the cache, 2,500 written to it, 1,000 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind of request;",
    );
    expect(text).toContain("| | summariser | 4 → 5 | 1,000 | 9,000 | 500 | 200 | 0 |");
  });

  test("where both arms priced the line gives the agents list price a request and the fold a price column", async () => {
    const base = RUNS.map((r) => result(r, { usage: priced(usage()) }));
    const head = [result("H1/W1", { usage: priced(usage()) }), result("H1/W2", { usage: priced(usage(), { agent: 0.8 }) }), result("C6h/W11", { usage: priced(usage()) })];
    let text = await t.comparedText(head, base);
    expect(text).toContain(
      `Usage: the agents' requests, subagents' included, in the 3 runs, base → head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output, 0 thinking blocks dropped and USD 0.0500 → USD 0.0600 at list price a priced request. The figures of 1 run moved, for any kind of request; they're under "Usage that differs", below. ${USAGE_MODEL} ${PRICE_MODEL}\n\n`,
    );
    expect(text).toContain(
      "| `H1/W2` | kind | requests | input | read from the cache | written to it | output | thinking dropped | list price, USD | unpriced |\n" +
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n" +
        "| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.8000 | 0 |\n",
    );
    const some = RUNS.map((r) => result(r, { usage: priced(usage(), { unpriced: 2 }) }));
    text = await t.comparedText(some, some);
    expect(text).toContain("0 thinking blocks dropped, USD 0.0625 at list price a priced request and 6 requests with no list price.");
  });

  test("the price a request weighs each run by its priced requests and each arm counts its own unpriced", async () => {
    const base = [
      result("H1/W1", { usage: priced(usage(), { unpriced: 9, agent: 0.5 }) }),
      result("H1/W2", { usage: priced(usage(), { unpriced: 1, agent: 0.9 }) }),
      result("C6h/W11", { usage: priced(usage(), { unpriced: 10, agent: 0 }) }),
    ];
    const head = [
      result("H1/W1", { usage: priced(usage(), { unpriced: 8, agent: 0.5 }) }),
      result("H1/W2", { usage: priced(usage(), { unpriced: 1, agent: 0.9 }) }),
      result("C6h/W11", { usage: priced(usage(), { unpriced: 10, agent: 0 }) }),
    ];
    expect(await t.comparedText(head, base)).toContain("USD 0.1400 → USD 0.1273 at list price a priced request and 20 requests → 19 requests with no list price.");
  });

  test("a price that differs only past the four places shown moves no run", async () => {
    const base = RUNS.map((r) => result(r, { usage: priced(usage(), { agent: 0.5 }) }));
    const head = [result("H1/W1", { usage: priced(usage(), { agent: 0.50001 }) }), ...base.slice(1)];
    let text = await t.comparedText(head, base);
    expect(text).toContain("in the 3 runs are the same in the base and this head: ");
    expect(text).not.toContain("Usage that differs");
    expect(text).not.toContain("The figures of 1 run moved");
    const moved = [result("H1/W1", { usage: priced(usage(), { agent: 0.5001 }) }), ...base.slice(1)];
    text = await t.comparedText(moved, base);
    expect(text).toContain("| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.5001 | 0 |");
    const of = async (runs: Dict[]): Promise<string> => resultOf(await t.facts(t.runDir([[runs, []]], { baseResults: base })));
    expect(await of(head)).toBe(await of(base));
    expect(await of(moved)).not.toBe(await of(base));
  });

  test("the sentence is the same exactly when every figure it shows is", async () => {
    const base = RUNS.map((r) => result(r, { usage: priced(usage(), { unpriced: 8, agent: 0.10006 }) }));
    const head = RUNS.map((r) => result(r, { usage: priced(usage(), { unpriced: 8, agent: 0.10014 }) }));
    const text = await t.comparedText(head, base);
    expect(text).toContain("in the 3 runs, base → head: ");
    expect(text).toContain("USD 0.0500 → USD 0.0501 at list price a priced request");
    expect(text).not.toContain("The figures of 1 run moved");
  });

  test("runs with no answered request on either arm carry no list price", async () => {
    const empty = { kinds: {}, lastDropped: null, calibration: null };
    const runs = RUNS.map((r) => result(r, { usage: empty }));
    const text = await t.comparedText(runs, runs);
    expect(text).toContain("Usage: the figures of the agents' requests");
    expect(text).not.toContain("list price");
    expect(text).not.toContain(PRICE_MODEL);
  });

  test("where one arm left a run unpriced the sentence compares only the figures it shows", async () => {
    const base = RUNS.map((r) => result(r, { usage: priced(usage()) }));
    const head = [result("H1/W1", { usage: { ...usage(), priceUnread: "bun exited 1" } }), result("H1/W2", { usage: priced(usage(), { agent: 0.8 }) }), result("C6h/W11", { usage: priced(usage()) })];
    const text = await t.comparedText(head, base);
    expect(text).toContain(
      "in the 3 runs are the same in the base and this head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind of request;",
    );
    expect(text).toContain("| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.8000 | 0 |");
    expect(text).toContain("No list price on the head in 1 run of 3: bun exited 1.");
  });

  test("why an arm went unpriced is shown inert and cut and the result rests only on what is shown", async () => {
    const why = "[x](https://example.com) @someone " + "y".repeat(400);
    const base = RUNS.map((r) => result(r, { usage: priced(usage()) }));
    const unpriced = (reason: (r: string) => string): Dict[] => RUNS.map((r) => result(r, { usage: { ...usage(), priceUnread: reason(r) } }));
    const head = unpriced(() => why);
    let text = await t.comparedText(head, base);
    expect(text).toContain(`No list price on the head: ${inert(why.slice(0, 300) + "…")}.`);
    expect(text).not.toContain("[x](https://example.com)");
    expect(text).not.toContain("y".repeat(301));
    const past = unpriced(() => why + " and more stderr");
    const within = unpriced(() => "other " + why);
    const of = async (runs: Dict[]): Promise<string> => resultOf(await t.facts(t.runDir([[runs, []]], { baseResults: base })));
    expect(await of(past)).toBe(await of(head));
    expect(await of(within)).not.toBe(await of(head));
    const split = unpriced((r) => why + (r === "H1/W2" ? " B" : " A"));
    text = await t.comparedText(split, base);
    expect(count(text, "No list price on the head")).toBe(1);
    expect(text).toContain(`No list price on the head: ${inert(why.slice(0, 300) + "…")}.`);
  });

  test("an arm whose host couldnt price shows no price and says why once however many runs", async () => {
    const why = "its src/call-pricing.ts exports no priceCall";
    const base = RUNS.map((r) => result(r, { usage: { ...usage(), priceUnread: why } }));
    const head = RUNS.map((r) => result(r, { usage: priced(usage()) }));
    let text = await t.comparedText(head, base);
    expect(text).toContain(
      `in the 3 runs are the same in the base and this head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output and 0 thinking blocks dropped. ${USAGE_MODEL}\n\nNo list price on the base: ${inert(why)}.\n\n`,
    );
    expect(count(text, "No list price")).toBe(1);
    expect(text).not.toContain(PRICE_MODEL);
    expect(text).not.toContain("Usage that differs");
    const failed = "the host couldn't price its calls (bun exited 1: `boom`)";
    const partly = [result("H1/W1", { usage: { ...usage(), priceUnread: failed } }), ...head.slice(1)];
    text = await t.comparedText(partly, head);
    expect(text).toContain(`No list price on the head in 1 run of 3: ${inert(failed)}.`);
  });

  test("usage prices are read only as a cost and an unpriced count together on every kind", async () => {
    const good = [result("H1/W1", { usage: usage() }), result("H1/W2"), result("C6h/W11")];
    const alone = usage();
    (kindsOf(alone).agent as Dict).cost = 0.5;
    const mixed = priced(usage({ summariser: {} }));
    delete (kindsOf(mixed).summariser as Dict).cost;
    delete (kindsOf(mixed).summariser as Dict).unpriced;
    const cases: [Dict, string][] = [
      [alone, "H1/W1: on the head, its usage's 'agent' figures have one of cost and unpriced without the other"],
      [priced(usage(), { agent: -0.1 }), "H1/W1: on the head, its usage's 'agent' cost isn't a number of 0 or more, -0.1"],
      [priced(usage(), { agent: NaN }), "H1/W1: on the head, its usage's 'agent' cost isn't a number of 0 or more"],
      [priced(usage(), { unpriced: 11 }), "H1/W1: on the head, its usage's 'agent' unpriced isn't a whole number from 0 to its requests, 11"],
      [mixed, "H1/W1: on the head, its usage prices some kinds of request and not others"],
      [{ ...priced(usage()), priceUnread: "no" }, "H1/W1: on the head, its usage's priceUnread isn't text beside unpriced figures"],
      [{ ...usage(), priceUnread: 7 }, "H1/W1: on the head, its usage's priceUnread isn't text beside unpriced figures, 7"],
    ];
    for (const [u, said] of cases) await raises(() => t.facts(t.runDir([[[result("H1/W1", { usage: u }), result("H1/W2"), result("C6h/W11")], []]], { baseResults: good })), Failed, said);
  });

  test("usage is read only where both arms give it and only as whole numbers", async () => {
    const head = [result("H1/W1", { usage: usage() }), result("H1/W2"), result("C6h/W11", { usage: usage() })];
    expect(await t.comparedText(head, [result("H1/W1"), result("H1/W2"), result("C6h/W11")])).not.toContain("Usage:");
    expect(await t.comparedText(head, head)).toContain("in the 2 runs are the same");
    const good = [result("H1/W1", { usage: usage() }), result("H1/W2"), result("C6h/W11")];
    const bad = [result("H1/W1", { usage: usage({ agent: { input: 1.5 } }) }), result("H1/W2"), result("C6h/W11")];
    const arms: [Dict[], Dict[], string][] = [
      [bad, good, "head"],
      [good, bad, "base"],
    ];
    for (const [h, b, arm] of arms) await raises(() => t.facts(t.runDir([[h, []]], { baseResults: b })), Failed, `H1/W1: on the ${arm}, its usage's 'agent' input isn't a whole number from 0 to 2**53, 1.5`);
    const huge = [result("H1/W1", { usage: usage({ agent: { input: 10n ** 400n } }) }), result("H1/W2"), result("C6h/W11")];
    await raises(() => t.facts(t.runDir([[huge, []]], { baseResults: good })), Failed, "H1/W1: on the head, its usage's 'agent' input isn't a whole number from 0 to 2**53");
    const lost = usage();
    delete lost.lastDropped;
    await raises(() => t.facts(t.runDir([[[result("H1/W1", { usage: lost }), result("H1/W2"), result("C6h/W11")], []]], { baseResults: good })), Failed, "H1/W1: on the head, its usage has no lastDropped");
  });

  test("usage whose history outweighs its run or whose multiplier isnt finite fails the step naming it", async () => {
    const good = [result("H1/W1", { usage: usage() }), result("H1/W2"), result("C6h/W11")];
    const over = usage();
    over.history = { agent: { ...(kindsOf(over).agent as Dict), requests: 11 } };
    const lone = usage();
    lone.history = { judge: { ...(kindsOf(lone).agent as Dict) } };
    const calibrated = (multiplier: Json): Dict => usage({ calibration: { multiplier, provisional: false, reset: false } });
    const cases: [Dict, string][] = [
      [over, "H1/W1: on the head, its usage's history figures are more than the run's"],
      [lone, "H1/W1: on the head, its usage's history figures are more than the run's"],
      [calibrated(NaN), "H1/W1: on the head, its usage's calibration isn't null"],
      [calibrated(Infinity), "H1/W1: on the head, its usage's calibration isn't null"],
      [calibrated(10n ** 400n), "H1/W1: on the head, its usage's calibration isn't null"],
    ];
    for (const [u, said] of cases) await raises(() => t.facts(t.runDir([[[result("H1/W1", { usage: u }), result("H1/W2"), result("C6h/W11")], []]], { baseResults: good })), Failed, said);
  });

  test("where records differ a context line follows the usage line each measure with the runs it rose and fell in then its figure", async () => {
    const base = [ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()];
    const head = [ctx(3, 500, 250, 50_000), ctx(1, 100, 100, 40_000), ctx()];
    const text = await t.comment(t.contextView(base, head));
    expect(text).toContain(
      `${USAGE_MODEL}\n\nContext in the 3 runs, base → head. Seams: more in 1 run; 3 → 4 in all. Tokens in the parts they changed or took out: more in 1 run; 400 → 600 in all. The most one agent request held: 50,000 tokens in both, moved in no run. The summariser's requests: 0 in both, moved in no run. [What these count](${CONTEXT_CHECKS}).\n\n${UNREAD}`,
    );
    const same = await t.comment(t.contextView(base, head, false));
    for (const said of ["Context in the", "Context:", "Context that differs"]) expect(same).not.toContain(said);
  });

  test("a measure is judged run by run so sums that cancel still say where it rose and fell and the most held is a maximum", async () => {
    let text = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()], [ctx(1, 100, 100, 50_000), ctx(2, 300, 200, 45_000), ctx()]));
    expect(text).toContain(
      "Seams: more in 1 run, fewer in 1; 3 in both. Tokens in the parts they changed or took out: more in 1 run, fewer in 1; 400 in both. The most one agent request held: higher in 1 run; 50,000 tokens at most in both.",
    );
    text = await t.comment(t.contextView([ctx(1, 100, 100, 50_000), ctx(), ctx()], [ctx(1, 100, 100, 49_000), ctx(), ctx(0, 0, 0, 51_000)]));
    expect(text).toContain("The most one agent request held: higher in 1 run, lower in 1; 50,000 → 51,000 tokens at most.");
    text = await t.comment(t.contextView([ctx(3, 300, 100), ctx(2, 200, 100), ctx()], [ctx(1, 100, 100), ctx(1, 100, 100), ctx()]));
    expect(text).toContain("Seams: fewer in 2 runs; 5 → 2 in all.");
    text = await t.comment(t.contextView([ctx(1, 100, 100), ctx(1, 100, 100), ctx(3, 300, 100)], [ctx(2, 200, 100), ctx(2, 200, 100), ctx(1, 100, 100)]));
    expect(text).toContain("Seams: more in 2 runs, fewer in 1; 5 in both. Tokens in the parts they changed or took out: more in 2 runs, fewer in 1; 500 in both.");
  });

  test("the summariser gives its requests and where every run is priced its list price each with its own split", async () => {
    let text = await t.comment(t.contextView([ctx(), ctx(), ctx()], [ctx(), ctx(), ctx()], true, summariser(4), summariser(5)));
    expect(text).toContain("The summariser's requests: more in 1 run; 4 → 5 in all. [What these count]");
    const sent = (r: string, n: number): UsageOptions => (r === "H1/W2" ? { summariser: { requests: n } } : {});
    const base = RUNS.map((r) => result(r, { usage: priced(used(ctx(), sent(r, 4)), { summariser: 1.0 }) }));
    const head = RUNS.map((r) => result(r, { ...differing(true, r), usage: priced(used(ctx(), sent(r, 4)), { unpriced: 1, summariser: 0.5 }) }));
    text = await t.comparedText(head, base, AT_W1);
    expect(text).toContain("The summariser's requests: 4 in both, moved in no run. Their list price, leaving out 0 → 1 request with no list price: lower in 1 run; USD 1.0000 → USD 0.5000 in all.");
    const unread = RUNS.map((r) => result(r, { usage: used(ctx(), sent(r, 3)) }));
    text = await t.comparedText(head, unread, AT_W1);
    expect(text).toContain("The summariser's requests: more in 1 run; 3 → 4 in all. [What these count]");
  });

  test("the unpriced requests show wherever the price does and either arm has any also where the price didnt move", async () => {
    const arm = (cost: number, unpriced = 0, differ = false, seams = 0): Dict[] =>
      RUNS.map((r) =>
        result(r, {
          ...differing(differ, r),
          usage: priced(used(r === "H1/W1" ? ctx(seams, 100 * seams, 100 * seams) : ctx(), r === "H1/W2" ? { summariser: { requests: 10 } } : {}), { unpriced, summariser: cost }),
        }),
      );
    let text = await t.comparedText(arm(2.0, 0, true), arm(1.0), AT_W1);
    expect(text).toContain("The summariser's requests: 10 in both, moved in no run. Their list price: higher in 1 run; USD 1.0000 → USD 2.0000 in all. [What");
    text = await t.comparedText(arm(1.0, 1, true, 1), arm(1.0, 1), AT_W1);
    expect(text).toContain("Seams: more in 1 run; 0 → 1 in all.");
    expect(text).toContain("Their list price, leaving out 1 request with no list price: USD 1.0000 in both, moved in no run.");
  });

  test("where every run is priced but none sent the summariser a request the line gives no list price", async () => {
    const arm = (differ = false): Dict[] => RUNS.map((r) => result(r, { ...differing(differ, r), usage: priced(used(differ && r === "H1/W1" ? ctx(1, 100, 100) : ctx())) }));
    const text = await t.comparedText(arm(true), arm(), AT_W1);
    expect(text).toContain("The summariser's requests: 0 in both, moved in no run. [What these count]");
    expect(text).not.toContain("Their list price");
  });

  test("a summariser unpriced count that changed alone shows the line with its change rather than saying nothing moved", async () => {
    const summarised = (unpriced: number): Dict => {
      const u = priced(used(ctx(), { summariser: { requests: 10 } }), { unpriced, summariser: 1.0 });
      (kindsOf(u).agent as Dict).unpriced = 1;
      return u;
    };
    const arm = (unpriced: number, differ = false): Dict[] => RUNS.map((r) => result(r, { ...differing(differ, r), usage: r === "H1/W2" ? summarised(unpriced) : priced(used(ctx()), { unpriced: 1 }) }));
    const text = await t.comparedText(arm(2, true), arm(1), AT_W1);
    expect(text).not.toContain("stayed the same");
    expect(text).toContain("Their list price, leaving out 1 → 2 requests with no list price: USD 1.0000 in both, moved in no run.");
  });

  test("the summariser price over the runs is their sum shown once to four places and each run is compared as shown", async () => {
    const arm = (cost: number, differ = false): Dict[] =>
      RUNS.map((r) => result(r, { ...differing(differ, r), usage: priced(used(differ && r === "H1/W1" ? ctx(1, 100, 100) : ctx(), { summariser: { requests: 1 } }), { summariser: cost }) }));
    let text = await t.comparedText(arm(0.00004, true), arm(0.00001), AT_W1);
    expect(text).toContain("Their list price: USD 0.0000 in both, moved in no run.");
    text = await t.comparedText(arm(0.000041, true), arm(0.00004), AT_W1);
    expect(text).toContain("Their list price: USD 0.0000 in both, moved in no run.");
    text = await t.comparedText(arm(0.50006, true), arm(0.5), AT_W1);
    expect(text).toContain("Their list price: higher in 3 runs; USD 1.5000 → USD 1.5003 in all.");
  });

  test("where no measure moved in any run one sentence says so", async () => {
    const same = [ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()];
    const text = await t.comment(t.contextView(same, same));
    expect(text).toContain(
      `Context in the 3 runs: in each run, the number of seams, the tokens in the parts they changed or took out, the most one agent request held and the number of summariser requests stayed the same. [What these count](${CONTEXT_CHECKS}).\n\n${UNREAD}`,
    );
    expect(text).not.toContain("Context that differs");
  });

  test("where only a runs largest seam moved the line says in how many runs and points at the fold which has them", async () => {
    const text = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(2, 300, 150, 50_000), ctx(), ctx()]));
    expect(text).not.toContain("stayed the same");
    expect(text).toContain("Context in the 3 runs, base → head. Seams: 2 in both, moved in no run.");
    expect(text).toContain(`The summariser's requests: 0 in both, moved in no run. The largest seam moved in 1 run, in the fold below. [What these count](${CONTEXT_CHECKS}).`);
    expect(text).toContain("Context that differs: 1 of 3 runs, base → head");
    const other = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 300, 150, 50_000), ctx(), ctx()]));
    expect(other).not.toContain("The largest seam moved");
    const summarised = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(2, 300, 150, 50_000), ctx(), ctx()], true, summariser(4), summariser(5)));
    expect(summarised).toContain("The summariser's requests: more in 1 run; 4 → 5 in all. The largest seam moved in 1 run, in the fold below.");
    const alone = await t.comment(t.contextView([ctx(), ctx(), ctx()], [ctx(), ctx(), ctx()], true, summariser(4), summariser(5)));
    expect(alone).not.toContain("The largest seam moved");
  });

  test("the runs whose context figures moved fold by how far their seams then tokens then most held moved then by name", async () => {
    const text = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(4, 600, 300, 40_000), ctx(0, 0, 0, 20_000)], [ctx(3, 500, 250, 50_000), ctx(3, 300, 300, 40_000), ctx(0, 0, 0, 20_500)]));
    expect(text).toContain(
      "<details><summary>Context that differs: 3 of 3 runs, base → head</summary>\n\n" +
        "| run | seams | tokens in parts changed or taken out | largest seam | most held |\n| --- | --- | --- | --- | --- |\n" +
        "| `H1/W2` | 4 → 3 | 600 → 300 | 300 | 40,000 |\n" +
        "| `H1/W1` | 2 → 3 | 300 → 500 | 200 → 250 | 50,000 |\n" +
        "| `C6h/W11` | 0 | 0 | 0 | 20,000 → 20,500 |\n\n</details>",
    );
    const seams = await t.comment(t.contextView([ctx(1, 100, 100), ctx(1, 100, 100), ctx()], [ctx(3, 200, 100), ctx(2, 600, 500), ctx()]));
    expect(seams).toContain("| `H1/W1` | 1 → 3 | 100 → 200 | 100 | 10,000 |\n| `H1/W2` | 1 → 2 |");
    const held = await t.comment(t.contextView([ctx(1, 100, 100), ctx(1, 100, 100, 20_000), ctx()], [ctx(2, 200, 100), ctx(2, 200, 100, 20_500), ctx()]));
    expect(held).toContain("| `H1/W2` | 1 → 2 | 100 → 200 | 100 | 20,000 → 20,500 |\n| `H1/W1` | 1 → 2 |");
    const tied = await t.comment(t.contextView([ctx(1, 100, 100), ctx(), ctx(1, 100, 100)], [ctx(2, 200, 100), ctx(), ctx(2, 200, 100)]));
    expect(tied).toContain("| `C6h/W11` | 1 → 2 | 100 → 200 | 100 | 10,000 |\n| `H1/W1` | 1 → 2 |");
  });

  test("a run with context figures on one arm or neither is counted apart in the opening and left out of every figure", async () => {
    let text = await t.comment(t.contextView([ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 90_000), null], [ctx(3, 500, 250, 50_000), null, null], true, summariser(4), summariser(5)));
    expect(text).toContain(
      `${USAGE_MODEL}\n\nContext in the 1 run that gave figures on both arms, not the 2 that didn't, base → head. Seams: more in 1 run; 2 → 3 in all. Tokens in the parts they changed or took out: more in 1 run; 300 → 500 in all. The most one agent request held: 50,000 tokens in both, moved in no run. The summariser's requests: 0 in both, moved in no run.`,
    );
    expect(text).toContain("Context that differs: 1 of 1 runs, base → head");
    text = await t.comment(t.contextView([ctx(2, 300, 200), ctx(), null], [ctx(2, 300, 200), ctx(), null]));
    expect(text).toContain("Context in the 2 runs that gave figures on both arms, not the 1 that didn't: in each run, the number of seams");
    text = await t.comment(t.contextView([ctx(), null, null], [null, ctx(), null]));
    expect(text).toContain(`${USAGE_MODEL}\n\nContext: none of the 3 runs gave figures on both arms. [What these count](${CONTEXT_CHECKS}).`);
    const old = await t.comment(t.contextView([null, null, null], [null, null, null]));
    expect(old).not.toContain("Context");
    const why = "request r3 went through another API, or another dialect of one, than its agent's previous request";
    const none = (differ: boolean): Dict[] => RUNS.map((r) => result(r, { ...differing(differ, r), usage: { ...usage(), contextNone: why } }));
    text = await t.comparedText(none(true), none(false), AT_W1);
    expect(text).toContain(`${USAGE_MODEL}\n\nContext: none of the 3 runs gave figures on both arms. [What these count](${CONTEXT_CHECKS}).`);
    const bad = [result("H1/W1", { usage: { ...usage(), contextNone: 7 } }), result("H1/W2"), result("C6h/W11")];
    const base = [result("H1/W1", { usage: used(ctx()) }), result("H1/W2"), result("C6h/W11")];
    await raises(() => t.facts(t.runDir([[bad, []]], { baseResults: base })), Failed, "H1/W1: on the head, its usage's contextNone isn't text");
  });

  test("a run without figures on both arms is left out of the summariser price and its unpriced count", async () => {
    const arm = (cost: number, unpriced: number, figures: boolean, differ = false): Dict[] =>
      RUNS.map((r) => {
        const w2 = r === "H1/W2";
        const c = differ && r === "H1/W1" ? ctx(1, 100, 100) : ctx();
        const u = priced(used(figures || !w2 ? c : null, { summariser: { requests: 2 } }), { unpriced: w2 ? unpriced : 0, summariser: w2 ? cost : 1.0 });
        return result(r, { ...differing(differ, r), usage: u });
      });
    const sides: [boolean, boolean][] = [
      [false, false],
      [true, false],
      [false, true],
    ];
    for (const [base, head] of sides) {
      const text = await t.comparedText(arm(2.0, 2, head, true), arm(1.0, 1, base), AT_W1);
      expect(text).toContain("Context in the 2 runs that gave figures on both arms, not the 1 that didn't, base → head.");
      expect(text).toContain("The summariser's requests: 4 in both, moved in no run. Their list price: USD 2.0000 in both, moved in no run. [What these count]");
    }
  });

  test("context figures are read only as four whole numbers whose seams are 0 exactly where their tokens are", async () => {
    const good = [result("H1/W1", { usage: used(ctx()) }), result("H1/W2"), result("C6h/W11")];
    const cases: [Json, string][] = [
      [ctx(1, 0, 0), "its usage's context isn't four whole numbers from 0 to 2**53, its seams 0 exactly where the tokens taken out are, and its largest no more than them"],
      [null, "its usage's context isn't four whole numbers"],
      [{ ...ctx(), peak: 2n ** 53n + 1n }, "its usage's context isn't four whole numbers from 0 to 2**53"],
      [ctx(0, 5, 5), "its usage's context isn't four whole numbers"],
      [ctx(1, 5, 9), "its usage's context isn't four whole numbers"],
      [{ ...ctx(), peak: 1.5 }, "its usage's context isn't four whole numbers"],
      [{ seams: 0, out: 0, largest: 0 }, "its usage's context isn't four whole numbers"],
    ];
    for (const [c, said] of cases)
      await raises(() => t.facts(t.runDir([[[result("H1/W1", { usage: { ...usage(), context: c } }), result("H1/W2"), result("C6h/W11")], []]], { baseResults: good })), Failed, `H1/W1: on the head, ${said}`);
    const both = [result("H1/W1", { usage: { ...used(ctx()), contextNone: "request r3's context couldn't be read" } }), result("H1/W2"), result("C6h/W11")];
    await raises(() => t.facts(t.runDir([[both, []]], { baseResults: good })), Failed, "H1/W1: on the head, its usage gives both context figures and why it gives none");
  });

  test("the context figures are part of the result so a comment showing them is never kept under another", async () => {
    const v = await t.facts(t.contextView([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 500, 250, 50_000), ctx(), ctx()]));
    const other = await t.facts(t.contextView([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 500, 250, 51_000), ctx(), ctx()]));
    expect(resultOf(v)).not.toBe(resultOf(other));
  });

  test("why a run gave no context figures moves the result only by whether it gave none as the comment shows", async () => {
    const base = RUNS.map((r) => result(r, { usage: used(ctx()) }));
    const none = (why: string): Dict[] => [result("H1/W1", { usage: { ...usage(), contextNone: why } }), ...RUNS.slice(1).map((r) => result(r, { usage: used(ctx()) }))];
    const of = async (runs: Dict[]): Promise<string> => resultOf(await t.facts(t.runDir([[runs, []]], { baseResults: base })));
    expect(await of(none("request r3 went through another API than its agent's previous request"))).toBe(await of(none("request r4 went through another API than its agent's previous request")));
    expect(await of(none("request r3 went through another API than its agent's previous request"))).not.toBe(await of(base));
  });
});

const LEAD = "From a store connectome-host `v0.9.0` wrote, `H1b/continuation/from-0.9.0` beside its fresh twin `H1b/continuation/fresh`: ";

const FINE: UsageOptions = { last: 0, calibration: { multiplier: 1.29, provisional: false, reset: false } };

describe("Upgrades", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("names the runner wrote into usage and flags are shown inert", async () => {
    const name = "[x](https://example.com) @someone|b";
    const base = [result("H1/W1", { usage: usage() }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    const head = [result("H1/W1", { usage: usage({ [name]: { requests: 2 } }) }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    let text = await t.comment(t.runDir([[head, []]], { baseResults: base }));
    expect(text).toContain(`| | ${inert(name)} | 0 → 2 |`);
    expect(text).not.toContain("[x](https://example.com)");
    const what = "[w](https://example.com) @who";
    const raised = { new: [{ check: 11, step: "c.debt", what, detail: "x" }], gone: [], kept: [] };
    text = await t.comment(t.upgraded(FINE, FINE, FINE, FINE, raised));
    expect(text).toContain(`it raises check 11's \`${what}\` where the fresh run doesn't`);
    expect(count(text, what)).toBe(count(text, `\`${what}\``));
  });

  test("an upgraded run whose end states differ from its fresh twins says what on which side and whether the change made or ended it", async () => {
    const stuck: UsageOptions = { last: 1, calibration: { multiplier: 1, provisional: true, reset: true }, agent: { dropped: 15 } };
    const kept = { new: [], gone: [], kept: [{ check: 11, step: "c.debt", what: "invariant", detail: "x" }] };
    const built = { new: [], gone: [], kept: [{ check: 4, step: "p.17", what: "not-reached", detail: "y" }] };
    const text = await t.comment(t.upgraded(stuck, stuck, FINE, FINE, kept, built));
    expect(text).toContain(
      LEAD +
        `the calibration ends unconfirmed after a reset, where the fresh run's ends confirmed, on both sides; its last request had 1 thinking block dropped, where the fresh run's had none dropped, on both sides; 1 flag differs from its twin's on both sides, named under "${UPGRADED}", below.\n\n`,
    );
    expect(text).toContain(
      `<details><summary>${UPGRADED}</summary>\n\n| On the base | requests | tokens sent a request | read from the cache | written to it | output | thinking dropped | last request dropped | calibration |\n` +
        "|" +
        " --- |".repeat(9) +
        "\n" +
        "| `H1b/continuation/from-0.9.0` | 10 | 1,050 | 85.7% | 500 | 200 | 15 | 1 | 1.00, unconfirmed after a reset |\n" +
        "| `H1b/continuation/fresh` | 10 | 954 | 84.9% | 540 | 210 | 0 | 0 | 1.29, confirmed |",
    );
    expect(text).toContain("A run that writes its own history first, as a fresh twin does, is shown without that history's requests");
    expect(text).toContain("On the head, `H1b/continuation/from-0.9.0` and its twin differ in flags: check 11's `invariant`, raised by the upgraded run only.");
    expect(text).not.toContain("not-reached");
    const fixed: UsageOptions = { last: 0, calibration: { multiplier: 1.3, provisional: false, reset: true } };
    const ended = await t.comment(t.upgraded(stuck, fixed, FINE, FINE));
    expect(ended).toContain(
      LEAD +
        "the calibration ends unconfirmed after a reset, where the fresh run's ends confirmed, on the base only, so the change ends that; its last request had 1 thinking block dropped, where the fresh run's had none dropped, on the base only, so the change ends that.",
    );
    expect(await t.comment(t.upgraded(fixed, fixed, FINE, FINE))).not.toContain("From a store");
    const made = await t.comment(t.upgraded(FINE, stuck, FINE, FINE));
    expect(made).toContain("ends confirmed, on the head only, so the change makes that;");
    const flag = { check: 11, step: "c.debt", what: "invariant", detail: "x" };
    const raised = { new: [flag], gone: [], kept: [] };
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE, raised))).toContain(LEAD + "it raises check 11's `invariant` where the fresh run doesn't, on the head only, so the change makes that.");
    const both = { new: [], gone: [], kept: [flag] };
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE, both, { new: [], gone: [flag], kept: [] }))).toContain(
      LEAD + "it raises check 11's `invariant` where the fresh run doesn't, on the head only, so the change makes that.",
    );
    const lowered = { new: [], gone: [flag], kept: [] };
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE, lowered))).toContain(LEAD + "it raises check 11's `invariant` where the fresh run doesn't, on the base only, so the change ends that.");
    const two = { new: [flag, { check: 6, step: "c.tool", detail: "z" }], gone: [], kept: [] };
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE, two))).toContain(
      LEAD + "it raises check 6 at step `c.tool` and check 11's `invariant` where the fresh run doesn't, on the head only, so the change makes that.",
    );
    const stepped = { new: [{ check: 6, step: "c.tool", detail: "z" }], gone: [], kept: [] };
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE, stepped))).toContain(LEAD + "it raises check 6 at step `c.tool` where the fresh run doesn't, on the head only, so the change makes that.");
    expect(await t.comment(t.upgraded(FINE, FINE, FINE, FINE))).not.toContain("From a store");
  });

  test("an upgraded run with no answered request or no calibration read says so and differs from a twin that has them", async () => {
    const unanswered: UsageOptions = { last: null, calibration: { multiplier: 1.29, provisional: false, reset: false } };
    const unread: UsageOptions = { last: 0, calibration: null };
    let text = await t.comment(t.upgraded(FINE, unanswered, FINE, FINE));
    expect(text).toContain(LEAD + "none of its agent's requests was answered, where the fresh run's had none dropped, on the head only, so the change makes that.");
    expect(text).toContain("| `H1b/continuation/from-0.9.0` | 10 | 1,050 | 85.7% | 500 | 200 | 0 | no request | 1.29, confirmed |");
    const twin = await t.comment(t.upgraded(FINE, FINE, FINE, unanswered));
    expect(twin).toContain(LEAD + "its last request had none dropped, where none of the fresh run's agent's requests was answered, on the head only, so the change makes that.");
    text = await t.comment(t.upgraded(unread, unread, FINE, FINE));
    expect(text).toContain(LEAD + "the calibration isn't reported, where the fresh run's ends confirmed, on both sides.");
    expect(text).toContain("| 0 | 0 | not reported |");
    expect(await t.comment(t.upgraded(unanswered, unanswered, unanswered, unanswered))).not.toContain("From a store");
  });
});

describe("Kinds", () => {
  let t: Steps;
  beforeEach(async () => {
    t = new Steps();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  test("a moved runs kinds are listed agent first and then by name", async () => {
    const kinds = (n: number): UsageOptions => ({ summariser: { requests: n }, Judge: { requests: 2 }, zeta: { requests: 1 } });
    const base = [result("H1/W1", { usage: usage(kinds(4)) }), result("H1/W2", { usage: usage() }), result("C6h/W11", { usage: usage() })];
    const head = [result("H1/W1", { usage: usage(kinds(5)) }), ...base.slice(1)];
    expect(await t.comment(t.runDir([[head, []]], { baseResults: base }))).toContain(
      "| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 |\n" +
        "| | Judge | 2 | 1,000 | 9,000 | 500 | 200 | 0 |\n" +
        "| | summariser | 4 → 5 | 1,000 | 9,000 | 500 | 200 | 0 |\n" +
        "| | zeta | 1 | 1,000 | 9,000 | 500 | 200 | 0 |\n",
    );
  });
});
