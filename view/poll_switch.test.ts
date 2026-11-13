import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Json } from "review-workflow/view";
import { AT, AT_ID, comment, OR, OR_ID, Polling, pull, XY, XY_ID } from "./testing/poll.ts";

const h = (c: string) => c.repeat(40);

const dir = (n: number, c: string) => `${OR.replaceAll("/", ".")}.${n}.${c.repeat(12)}`;

  function merge(n: number, at: string, commit: string, updated: string | null = null, base = "main") {
    return { number: n, merged_at: at, merge_commit_sha: h(commit), updated_at: updated ?? at, base: { ref: base }, head: { sha: h("e") }, draft: false, author_association: "MEMBER" };
  }

  function unmerged(n: number, updated: string) {
    return { number: n, merged_at: null, merge_commit_sha: h("f"), updated_at: updated, base: { ref: "main" }, head: { sha: h("e") }, draft: false, author_association: "MEMBER" };
  }

  const mergeKey = (rid: number, n: number, commit: string) => `context-view/${rid}#${n}@merged:${h(commit)}`;

let t: Polling;
beforeEach(async () => {
  t = new Polling();
  await t.setUp();
  Object.assign(t.gh.repos[OR]!, { permissions: { "nissa-seru": "admin" }, pulls: [pull(2, "b"), pull(3, "c")], closed: [] });
  t.gh.repos[AT] = { id: AT_ID, pulls: [], closed: [] };
  t.gh.repos[XY] = { id: XY_ID, pulls: [], closed: [merge(1, "2026-11-09T11:00:00Z", "d")] };
  t.at("2026-11-09T10:00:00Z");
  for (const [argv, cur] of [[[], "poll"], [["asks"], "asks"], [["merges"], "merges"]] as const)
    expect(await t.pass([...argv, "--job"], cur)).toEqual([1, []]);
  t.at("2026-11-09T12:00:00Z");
});
afterEach(async () => {
  await t.tearDown();
});

test("across promotion and rollback each step reprints an untaken .args line as params with the same seq cursor and stores .args on new lines", async () => {
  t.review(OR, 2, { head: "b" });
  const [vCode, vOut] = await t.pass(["--job"], "poll", false);
  const vStored = t.state().views_line as { seq: number; key: string; args: Json };
  expect(vCode).toBe(0);
  expect(Object.keys(vStored).sort()).toEqual(["args", "key", "seq"]);
  expect(vOut).toEqual([{ key: vStored.key, params: vStored.args }]);
  expect(readFileSync(`${t.out}-poll`, "utf8").trim()).toBe(String(vStored.seq));

  const s1 = t.state();
  s1.views_line = null;
  s1.views_waiting = 0;
  t.saveState(s1);
  t.gh.repos[OR]!.comments = [comment(51, "/context-deltas", { at: "2026-11-09T12:01:00Z" })];
  const [aCode, aOut] = await t.pass(["asks", "--job"], "asks", false);
  const aStored = (t.state().asks as Record<string, unknown>).line as { seq: number; key: string; args: Json; ask: Json };
  expect(aCode).toBe(0);
  expect("args" in aStored && !("params" in aStored)).toBe(true);
  expect(aOut).toEqual([{ key: aStored.key, params: aStored.args }]);
  expect(readFileSync(`${t.out}-asks`, "utf8").trim()).toBe(String(aStored.seq));

  const s2 = t.state();
  s2.asks = { ...(s2.asks as Record<string, unknown>), line: null, queue: [] };
  t.saveState(s2);
  (t.gh.repos[OR]!.closed ??= []).push(merge(5, "2026-11-09T11:00:00Z", "a") as never);
  const [mCode, mOut] = await t.pass(["merges", "--job"], "merges", false);
  const mStored = (t.state().merges as Record<string, unknown>).line as { seq: number; key: string; args: Json; merge: Json };
  expect(mCode).toBe(0);
  expect("args" in mStored && !("params" in mStored)).toBe(true);
  expect(mOut).toEqual([{ key: mStored.key, params: mStored.args }]);
  expect(readFileSync(`${t.out}-merges`, "utf8").trim()).toBe(String(mStored.seq));

  const baseViews = { seq: 41, key: `context-view/${OR_ID}#2@${h("b")}`, args: { repo: OR, number: 2, head: h("b"), auto: true } };
  const s3 = t.state();
  (s3.merges as Record<string, unknown>).line = null;
  s3.views_line = baseViews;
  t.saveState(s3);
  expect(await t.pass(["--job"], "poll", false)).toEqual([0, [{ key: baseViews.key, params: baseViews.args }]]);
  expect(readFileSync(`${t.out}-poll`, "utf8").trim()).toBe("41");
  expect(t.state().views_line).toEqual(baseViews);

  const baseAsks = { ...aStored, seq: 42 };
  const s4 = t.state();
  s4.views_line = null;
  s4.asks = { ...(s4.asks as Record<string, unknown>), line: baseAsks, queue: [aStored.ask] };
  t.saveState(s4);
  expect(await t.pass(["asks", "--job"], "asks", false)).toEqual([0, [{ key: baseAsks.key, params: baseAsks.args }]]);
  expect(readFileSync(`${t.out}-asks`, "utf8").trim()).toBe("42");
  expect((t.state().asks as Record<string, unknown>).line).toEqual(baseAsks);

  const baseMerges = {
    seq: 43,
    key: mergeKey(OR_ID, 5, "a"),
    args: { repo: OR, number: 5, merged: h("a") },
    merge: { rid: OR_ID, number: 5, at: "2026-11-09T11:00:00Z" },
  };
  const s5 = t.state();
  s5.asks = { ...(s5.asks as Record<string, unknown>), line: null, queue: [] };
  s5.merges = { ...(s5.merges as Record<string, unknown>), line: baseMerges };
  t.saveState(s5);
  expect(await t.pass(["merges", "--job"], "merges", false)).toEqual([0, [{ key: baseMerges.key, params: baseMerges.args }]]);
  expect(readFileSync(`${t.out}-merges`, "utf8").trim()).toBe("43");
  expect((t.state().merges as Record<string, unknown>).line).toEqual(baseMerges);
});
