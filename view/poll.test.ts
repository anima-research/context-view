import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { KNOWN, requestKey } from "review-workflow/view";

import { headKey, holds, instant, main, reviewed, REVIEWS, viewDir } from "./poll.ts";
import { APP_ID, AT, AT_ID, captured, comment, OR, OR_ID, Polling, pull, type Pull, splitOnce, XY, XY_ID } from "./testing/poll.ts";
import { keyOf, VIEWED } from "./view_read.ts";

const h = (c: string) => c.repeat(40);
const one = <T>([, lines]: [number, T[]]): T => {
  expect(lines).toHaveLength(1);
  return lines[0]!;
};

describe("Views", () => {
  class Views extends Polling {
    override async setUp(): Promise<void> {
      await super.setUp();
      this.gh.repos[AT] = { id: AT_ID, pulls: [] };
      this.gh.repos[XY] = { id: XY_ID, pulls: [pull(1, "9")] };
      expect(await this.look()).toEqual([1, []]);
    }

    look(take = true) {
      return this.pass(["--job"], "poll", take);
    }

    async started(): Promise<string> {
      const [code, lines] = await this.look();
      if (code !== 0 || lines.length !== 1) throw new Error(`the pass started nothing: exit ${code}, ${JSON.stringify(lines)}`);
      const key = lines[0]!.key as string;
      this.startRun(key);
      return key;
    }

    opened(repo: string, n: number, head: string, o: { draft?: boolean; association?: string } = {}): string {
      const found = this.gh.repos[repo]!.pulls.filter((p) => p.number !== n);
      this.gh.repos[repo]!.pulls = [...found, pull(n, head, o.draft, o.association)];
      return this.review(repo, n, { head });
    }

    viewDir(repo: string, n: number, head: string): string {
      return join(this.place.state, "views", `${repo.replaceAll("/", ".")}.${n}.${h(head).slice(0, 12)}`);
    }

    companion(key: string): void {
      const [rid, rest] = splitOnce(key.slice("context-view/".length), "#");
      const [number, head] = rest.split("@");
      const where = viewDir(this.place, VIEWED.get(Number(rid))!, Number(number), head!);
      mkdirSync(where, { recursive: true });
      writeFileSync(join(where, "view.json"), JSON.stringify({ outcome: "needs-companion" }));
    }

    queueAsks(...asks: [number, number, number][]): void {
      const state = this.state();
      state.asks = { seq: 0, line: null, repos: {}, queue: asks.map(([rid, n, c]) => ({ rid, number: n, comment: c, made: "2026-10-31T04:00:00Z" })) };
      this.saveState(state);
    }
  }

  let t: Views;
  beforeEach(async () => {
    t = new Views();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  const pulls = (repo: string): Pull[] => t.gh.repos[repo]!.pulls;

  test("the review polls keys as the store holds them name the pull request and no other kind of review does", () => {
    expect(reviewed("pr-review/open:anima-research/agent-framework#997@19f9a89b642da49fc947bed81cedd927cdc91b52")).toEqual(["anima-research/agent-framework", 997]);
    expect(reviewed("pr-review/ask:nissa-seru/rookery-scratch#82:comment-6553164401")).toEqual(["nissa-seru/rookery-scratch", 82]);
    expect(reviewed("pr-review/ask:antra-tess/membrane#248:comment-6640000001")).toEqual(["antra-tess/membrane", 248]);
    for (const key of [
      "pr-review/release:harness.1988b2fcf0f0.3603a22fa7f3@20261109T100614Z",
      "pr-review/pull:anima-research/agent-framework.5b2eed3c75ea.0019be3c5b4c@20261109T093009Z",
      "pr-review/restart:pr-review/open:nissa-seru/rookery-scratch#99@1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      `context-view/${OR_ID}#2@${h("b")}`,
    ])
      expect(reviewed(key)).toBeNull();
  });

  test("the review polls own keys for an opening and an ask are the ones the poll reads", () => {
    expect(reviewed(requestKey({ repo: OR, number: 2, head: h("b") }))).toEqual([OR, 2]);
    expect(reviewed(requestKey({ repo: OR, number: 2, comment: 41 }))).toEqual([OR, 2]);
    expect(REVIEWS).toEqual(["pr-review/open:", "pr-review/ask:"]);
  });

  test("a review start gives its pull request one view at its head now marked automatic", async () => {
    t.opened(OR, 2, "b");
    const line = one(await t.look());
    expect(line).toEqual({ key: keyOf(OR_ID, 2, h("b")), params: { repo: OR, number: 2, head: h("b"), auto: true } });
  });

  test("the first pass counts the reviews already in the store and starts nothing for them", async () => {
    t.place = { ...t.place, state: mkdtempSync(join(t.tmp, "fresh-")) };
    t.opened(OR, 2, "b");
    pulls(OR).push(pull(3, "c"));
    t.review(OR, 3, { comment: 41 });
    expect(await t.look()).toEqual([1, []]);
    t.opened(OR, 4, "d");
    expect(await t.started()).toBe(keyOf(OR_ID, 4, h("d")));
  });

  test("an open pull request no review started on gets no view", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c")];
    expect(await t.look()).toEqual([1, []]);
  });

  test("an asks review names no head so the view takes the pull requests head when its line prints", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b")];
    t.review(OR, 2, { comment: 41 });
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("one view runs at a time for the pull request whose review started first", async () => {
    t.at("2026-11-05T01:00:00Z");
    const first = t.opened(OR, 2, "b");
    expect(first).toBe(`pr-review/open:${OR}#2@${h("b")}`);
    const running = await t.started();
    expect(running).toBe(keyOf(OR_ID, 2, h("b")));
    t.at("2026-11-05T01:01:00Z");
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    t.at("2026-11-05T01:02:00Z");
    t.opened(OR, 3, "d");
    expect(await t.look()).toEqual([1, []]);
    t.settle(running);
    expect(await t.started()).toBe(keyOf(AT_ID, 7, h("c")));
    t.settle(keyOf(AT_ID, 7, h("c")), "failed");
    expect(await t.started()).toBe(keyOf(OR_ID, 3, h("d")));
    t.settle(keyOf(OR_ID, 3, h("d")));
    expect(await t.look()).toEqual([1, []]);
  });

  test("a newcomers pull request gets its view as a known authors does", async () => {
    for (const [i, association] of ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", ...KNOWN].entries()) {
      const n = i + 2;
      t.opened(OR, n, "b", { association });
      const key = await t.started();
      expect(key).toBe(keyOf(OR_ID, n, h("b")));
      t.settle(key);
    }
  });

  test("a draft waits until it is marked ready", async () => {
    t.opened(OR, 2, "b", { draft: true });
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b")];
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a head that moves before its turn is viewed at the head it has then", async () => {
    const running = `context-view/${AT_ID}#8@${h("a")}`;
    t.startRun(running);
    t.opened(OR, 2, "b");
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    t.settle(running);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a review start at a head whose view ran starts nothing and one at a new head does", async () => {
    t.opened(OR, 2, "b");
    t.settle(await t.started());
    t.review(OR, 2, { comment: 41 });
    expect(await t.look()).toEqual([1, []]);
    t.opened(OR, 2, "c");
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a head whose view stopped at needs companion isnt viewed so the next review start views it again", async () => {
    t.opened(OR, 2, "b");
    const stopped = await t.started();
    t.settle(stopped);
    t.companion(stopped);
    expect(await t.look()).toEqual([1, []]);
    const again = t.runOf(t.review(OR, 2, { comment: 41 }));
    const retried = await t.started();
    expect(retried).toBe(`${stopped}:review-${again}`);
    expect(t.loadRuns().filter((r) => r.key.startsWith(stopped)).map((r) => r.key)).toEqual([stopped, retried]);
    t.settle(retried);
    writeFileSync(join(t.viewDir(OR, 2, "b"), "view.json"), JSON.stringify({ repo: OR, number: 2, head: h("b"), outcome: "ran" }));
    t.review(OR, 2, { comment: 42 });
    expect(await t.look()).toEqual([1, []]);
  });

  test("a view whose runners are done while its reader reads lets the next view start", async () => {
    t.opened(OR, 2, "b");
    const reading = await t.started();
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    t.manifest(reading);
    expect(await t.started()).toBe(keyOf(AT_ID, 7, h("c")));
  });

  test("a view with no manifest since it started holds the slot and one whose directory cant be named holds until it settles", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    t.manifest(running, { before: true });
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    t.settle(running, "failed");
    const dry = `context-view/dry:${OR}#9@${h("f")}`;
    t.startRun(dry);
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain(`(running, ${dry})`);
    t.settle(dry);
    expect(await t.started()).toBe(keyOf(AT_ID, 7, h("c")));
  });

  test("a heads views directory is its repository pull request and short head under the polls state", () => {
    expect(viewDir(t.place, "anima-research/context-manager", 7, h("b"))).toBe(join(t.place.state, "views", `anima-research.context-manager.7.${"b".repeat(12)}`));
  });

  test("an ask whose head has an unsettled view holds no automatic view while the runners are free", async () => {
    t.opened(OR, 2, "b");
    const reading = await t.started();
    t.manifest(reading);
    t.queueAsks([OR_ID, 2, 41]);
    t.opened(OR, 3, "c");
    const line = one(await t.look());
    expect(line!.key).toBe(keyOf(OR_ID, 3, h("c")));
  });

  test("the views line is kept apart from line where the release befores asks step waits", async () => {
    t.opened(OR, 2, "b");
    const line = one(await t.look(false));
    const state = t.state();
    expect([state.line, (state.views_line as { key: string }).key]).toEqual([null, line!.key as string]);
  });

  test("a state file the release before wrote with no views line gives a line at the first pass", async () => {
    const state = t.state();
    delete state.views_line;
    t.saveState(state);
    t.opened(OR, 2, "b");
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a dry views run puts nothing in seen and an entry that names no view leaves it", async () => {
    const state = t.state();
    state.seen = ["context-view/dry"];
    t.saveState(state);
    const dry = `context-view/dry:${OR}#9@${h("f")}`;
    t.startRun(dry);
    t.settle(dry);
    expect(await t.look()).toEqual([1, []]);
    expect(t.state().seen).toEqual([]);
  });

  test("a queued ask goes first and the views line waits until the asks queue is empty", async () => {
    t.opened(OR, 2, "b");
    pulls(OR).push(pull(3, "c"));
    t.queueAsks([OR_ID, 3, 41]);
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain("waiting for the asks' queue");
    t.queueAsks();
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("an ask whose pull request the pass doesnt list open holds no view", async () => {
    t.opened(OR, 2, "b");
    t.queueAsks([OR_ID, 9, 41], [1003, 1, 42]);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a views line out when an ask is queued prints again until jobs takes it", async () => {
    t.opened(OR, 2, "b");
    const line = one(await t.look(false));
    pulls(OR).push(pull(3, "c"));
    t.queueAsks([OR_ID, 3, 41]);
    expect((await t.look(false))[1]).toEqual([line!]);
    expect(await t.started()).toBe(line!.key as string);
  });

  test("a pull request opened and reviewed while a pass lists gets its view", async () => {
    t.gh.afterPulls = [
      OR,
      () => {
        t.gh.afterPulls = null;
        t.opened(OR, 2, "b");
      },
    ];
    expect(await t.look()).toEqual([1, []]);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a review start during a view keeps its pull request queued so a push then gets a view", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    expect(await t.look()).toEqual([1, []]);
    t.review(OR, 2, { comment: 41 });
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    t.manifest(running);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a review start during a view that ends needs companion views its head again", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    expect(await t.look()).toEqual([1, []]);
    const again = t.runOf(t.review(OR, 2, { comment: 41 }));
    expect(await t.look()).toEqual([1, []]);
    t.settle(running);
    t.companion(running);
    expect(await t.started()).toBe(`${running}:review-${again}`);
  });

  test("an asks view running at a waiting head keeps its pull request queued so a push then gets a view", async () => {
    t.opened(OR, 2, "b");
    const asked = `${keyOf(OR_ID, 2, h("b"))}:ask-41`;
    t.startRun(asked);
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect(await t.look()).toEqual([1, []]);
    t.manifest(asked);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a head an asks view ran at gets no automatic view when a review of it starts so the account it posted stays", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b")];
    const asked = `${keyOf(OR_ID, 2, h("b"))}:ask-41`;
    t.startRun(asked);
    t.manifest(asked);
    t.settle(asked);
    expect(await t.look()).toEqual([1, []]);
    t.review(OR, 2, { head: "b" });
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    t.review(OR, 2, { head: "c" });
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a head queued for an automatic view that an ask views first gets none after it so the account stays", async () => {
    t.opened(OR, 2, "b");
    t.queueAsks([OR_ID, 2, 41]);
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain("waiting for the asks' queue");
    const asked = `${keyOf(OR_ID, 2, h("b"))}:ask-41`;
    t.queueAsks();
    t.startRun(asked);
    expect(await t.look()).toEqual([1, []]);
    t.manifest(asked);
    t.settle(asked);
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    t.review(OR, 2, { head: "c" });
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a view json that cant be read is said and its head is viewed again at its next review", async () => {
    t.opened(OR, 2, "b");
    const ran = await t.started();
    t.settle(ran);
    mkdirSync(t.viewDir(OR, 2, "b"), { recursive: true });
    writeFileSync(join(t.viewDir(OR, 2, "b"), "view.json"), '{"outcome": "needs-comp');
    expect(await t.look()).toEqual([1, []]);
    const again = t.runOf(t.review(OR, 2, { comment: 41 }));
    expect(await t.started()).toBe(`${ran}:review-${again}`);
    expect(t.said).toContain("view.json can't be read");
  });

  test("a review in a repository the view doesnt cover and a release or a restarts review start no view", async () => {
    t.review(XY, 1, { head: "9" });
    t.startRun("pr-review/release:harness.1988b2fcf0f0.3603a22fa7f3@20261109T100614Z");
    t.startRun(`pr-review/restart:pr-review/open:${OR}#2@${h("b")}`);
    t.gh.repos[OR]!.pulls = [pull(2, "b")];
    expect(await t.look()).toEqual([1, []]);
    expect(t.gh.calls.some(([, path]) => path.startsWith(`/repos/${XY}/`))).toBe(false);
  });

  test("a pull request closed before its turn gets no view", async () => {
    const running = `context-view/${AT_ID}#8@${h("a")}`;
    t.startRun(running);
    t.opened(OR, 2, "b");
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [];
    t.settle(running);
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b")];
    expect(await t.look()).toEqual([1, []]);
  });

  test("a review start while its pull requests line is out gives its newer head a view after", async () => {
    t.opened(OR, 2, "b");
    one(await t.look(false));
    t.at("2026-10-31T04:05:00Z");
    t.opened(OR, 2, "c");
    expect((await t.look())[1].map((l) => l.key)).toEqual([keyOf(OR_ID, 2, h("c"))]);
    t.startRun(keyOf(OR_ID, 2, h("c")));
    t.settle(keyOf(OR_ID, 2, h("c")));
    expect(await t.look()).toEqual([1, []]);
    t.at("2026-10-31T04:06:00Z");
    t.opened(OR, 3, "d");
    const key = await t.started();
    expect(key).toBe(keyOf(OR_ID, 3, h("d")));
    t.at("2026-10-31T04:07:00Z");
    t.opened(OR, 3, "e");
    t.settle(key);
    expect(await t.started()).toBe(keyOf(OR_ID, 3, h("e")));
  });

  test("a push while its view runs gives the pull requests new head a view after it", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect(await t.look()).toEqual([1, []]);
    t.settle(running);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
    t.settle(keyOf(OR_ID, 2, h("c")));
    expect(await t.look()).toEqual([1, []]);
  });

  test("a push after a pass has seen its view running gives the new head a view once the runners are done", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    expect(await t.look()).toEqual([1, []]);
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect(await t.look()).toEqual([1, []]);
    t.manifest(running);
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a push after its view settled at an unchanged head gets no view until a review of it starts", async () => {
    t.opened(OR, 2, "b");
    const running = await t.started();
    expect(await t.look()).toEqual([1, []]);
    const other = `context-view/${AT_ID}#8@${h("a")}`;
    t.startRun(other);
    t.settle(running);
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect(await t.look()).toEqual([1, []]);
    t.settle(other);
    expect(await t.look()).toEqual([1, []]);
    t.review(OR, 2, { comment: 41 });
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("c")));
  });

  test("a line jobs didnt take prints again until its head is superseded", async () => {
    t.opened(OR, 2, "b");
    const [, first] = await t.look(false);
    expect(first.map((line) => line.key)).toEqual([keyOf(OR_ID, 2, h("b"))]);
    expect((await t.look(false))[1]).toEqual(first);
    t.gh.repos[OR]!.pulls = [pull(2, "c")];
    expect((await t.look(false))[1].map((line) => line.key)).toEqual([keyOf(OR_ID, 2, h("c"))]);
  });

  test("any view at its runners holds the slot whatever head its for and whoever started it", async () => {
    t.startRun(`context-view/${AT_ID}#8@${h("a")}`);
    t.opened(OR, 2, "b");
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain(`wf-1 (running, context-view/${AT_ID}#8@${h("a")})`);
    t.settle(`context-view/${AT_ID}#8@${h("a")}`, "stopped");
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a run of either record under a key the poll didnt make holds the slot until it settles a sessions named so", async () => {
    t.opened(OR, 2, "b");
    for (const [key, more, said] of [
      ["session-dryview-1", { house: false }, "a session's start under session-dryview-1"],
      ["merge-check-by-hand", { record: "workflow:context-view-merged", house: false }, "a session's start under merge-check-by-hand"],
      ["readback-1", {}, "readback-1"],
    ] as const) {
      t.startRun(key, more);
      expect(await t.look()).toEqual([1, []]);
      expect(t.said).toContain(`(running, ${said})`);
      t.settle(key);
    }
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a sessions start under a view key holds the slot until it settles whatever its manifest and isnt that heads view", async () => {
    t.opened(OR, 2, "b");
    const key = keyOf(OR_ID, 2, h("b"));
    t.startRun(key, { house: false });
    t.manifest(key);
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain(`(running, a session's start under ${key})`);
    t.settle(key);
    expect(t.state().seen).toEqual([]);
    expect(await t.started()).toBe(key);
  });

  test("a line printed before a view started by hand waits until that view settles", async () => {
    t.opened(OR, 2, "b");
    const [, first] = await t.look(false);
    expect(first.map((line) => line.key)).toEqual([keyOf(OR_ID, 2, h("b"))]);
    t.startRun(`context-view/${AT_ID}#8@${h("a")}`);
    expect(await t.look(false)).toEqual([1, []]);
    t.settle(`context-view/${AT_ID}#8@${h("a")}`);
    expect((await t.look(false))[1]).toEqual(first);
  });

  test("a line whose head got its view by another start is dropped", async () => {
    t.opened(OR, 2, "b");
    const line = one(await t.look(false));
    t.startRun(line!.key as string);
    t.settle(line!.key as string);
    expect(await t.look(false)).toEqual([1, []]);
  });

  test("a pass lists the views runs and each kind of review once however many wait", async () => {
    for (let n = 1; n < 31; n++) t.opened(OR, n, "b");
    const first = await t.started();
    rmSync(t.workflowsLog, { force: true });
    expect(await t.look()).toEqual([1, []]);
    const listings = readFileSync(t.workflowsLog, "utf8").trim().split("\n");
    expect(listings.sort()).toEqual(
      [
        "runs --record script:context-view",
        "runs --record script:context-view-merged",
        "runs --key-prefix pr-review/open:",
        "runs --key-prefix pr-review/ask:",
      ].sort(),
    );
    t.settle(first);
    expect(await t.started()).toBeTruthy();
  });

  test("a viewed head stays viewed after the store clears its run and is forgotten once its pull request closes", async () => {
    t.opened(OR, 2, "b");
    t.opened(OR, 3, "c");
    t.settle(await t.started());
    t.settle(await t.started());
    expect(await t.look()).toEqual([1, []]);
    t.saveRuns([]);
    t.review(OR, 2, { comment: 41 });
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = pulls(OR).filter((p) => p.number === 3);
    await t.look();
    expect(t.state().seen).toEqual([keyOf(OR_ID, 3, h("c"))]);
  });

  test("a repository out of view for a pass keeps its queued pull request and a line dropped for it is named", async () => {
    const busy = `context-view/${OR_ID}#9@${h("f")}`;
    t.startRun(busy);
    t.at("2026-11-05T01:00:00Z");
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    t.at("2026-11-05T01:01:00Z");
    t.opened(OR, 2, "b");
    expect(await t.look()).toEqual([1, []]);
    t.gh.repos[AT]!.archived = true;
    expect(await t.look()).toEqual([1, []]);
    delete t.gh.repos[AT]!.archived;
    expect(await t.look()).toEqual([1, []]);
    t.settle(busy);
    const line = one(await t.look(false));
    expect(line!.key).toBe(keyOf(AT_ID, 7, h("c")));
    t.gh.repos[AT]!.archived = true;
    expect((await t.look(false))[1].map((l) => l.key)).toEqual([keyOf(OR_ID, 2, h("b"))]);
    expect(t.said).toContain(`${keyOf(AT_ID, 7, h("c"))}'s line is dropped, since its repository isn't in this pass's listing`);
  });

  test("a review start in a covered repository this pass doesnt list waits for its listing", async () => {
    t.gh.repos[AT]!.archived = true;
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    delete t.gh.repos[AT]!.archived;
    expect(await t.started()).toBe(keyOf(AT_ID, 7, h("c")));
  });

  test("a renamed repositorys line names it as it is now and its viewed heads stay viewed", async () => {
    t.opened(OR, 2, "b");
    const [, [first]] = await t.look(false);
    expect((first!.params as { repo: string }).repo).toBe(OR);
    const renamed = `${OR}-renamed`;
    t.gh.repos[renamed] = t.gh.repos[OR]!;
    delete t.gh.repos[OR];
    const line = one(await t.look());
    expect(line).toEqual({ ...first!, params: { ...(first!.params as object), repo: renamed } });
    t.startRun(line!.key as string);
    t.settle(line!.key as string);
    t.review(renamed, 2, { comment: 41 });
    expect(await t.look()).toEqual([1, []]);
  });

  test("a taken line whose run never appeared leaves until a review starts again then prints past the cursor", async () => {
    t.opened(OR, 2, "b");
    const line = one(await t.look());
    const taken = Number(readFileSync(`${t.cursor}-poll`, "utf8"));
    expect(await t.look()).toEqual([1, []]);
    expect(await t.look()).toEqual([1, []]);
    t.review(OR, 2, { comment: 41 });
    expect((await t.look())[1]).toEqual([line!]);
    expect(Number(readFileSync(`${t.cursor}-poll`, "utf8"))).toBeGreaterThan(taken);
  });

  test("the poll keeps its state in its own file and writes none of review workflows", async () => {
    const theirs = join(t.tmp, "review-workflow-poll");
    t.env({ REVIEW_PR_POLL: theirs });
    t.opened(OR, 2, "b");
    await t.started();
    expect((t.state().views_line as { key: string }).key).toBe(keyOf(OR_ID, 2, h("b")));
    expect(existsSync(theirs)).toBe(false);
  });

  test("an installation on an account the app doesnt serve is never read", async () => {
    t.gh.calls.length = 0;
    t.gh.installs[6] = { id: 9999, login: "elsewhere" };
    t.gh.repos[AT]!.installation = 6;
    t.opened(AT, 7, "c");
    expect(await t.look()).toEqual([1, []]);
    expect(t.gh.calls).not.toContainEqual(["POST", "/app/installations/6/access_tokens"]);
    expect(t.gh.calls.some(([, path]) => path.startsWith(`/repos/${AT}/`))).toBe(false);
  });

  test("a failure exits 2 says why and keeps the state and cursor as they were", async () => {
    t.opened(OR, 2, "b");
    const [, [taken]] = await t.look();
    const before = readFileSync(t.statePath(), "utf8");
    expect((JSON.parse(before).views_line as { key: string }).key).toBe(taken!.key as string);
    for (const [failure, said] of [
      [{ status: 502 }, "poll.ts: GitHub answered 502 to GET /installation/repositories"],
      ["misshapen", "TypeError"],
    ] as const) {
      t.gh.fail = ["/installation/repositories", failure];
      expect(await t.look()).toEqual([2, []]);
      expect(t.said).toContain(said);
      expect(existsSync(`${t.out}-poll`)).toBe(false);
      expect(readFileSync(t.statePath(), "utf8")).toBe(before);
    }
    t.gh.fail = null;
    t.review(OR, 2, { comment: 41 });
    expect(await t.started()).toBe(keyOf(OR_ID, 2, h("b")));
  });

  test("a view running again under a key whose earlier run settled still holds the slot", async () => {
    const key = `context-view/${OR_ID}#2@${h("b")}`;
    t.saveRuns([
      { run: "wf-1", key, state: "completed", createdAt: "2026-10-31T03:00:00.000Z" },
      { run: "wf-2", key, state: "running", createdAt: "2026-10-31T03:30:00.000Z" },
    ]);
    t.opened(OR, 3, "c");
    expect(await t.look()).toEqual([1, []]);
    expect(t.said).toContain(`wf-2 (running, ${key})`);
  });

  test("a command line from the main working copy refuses as a failure naming the installed form", async () => {
    const asked = t.gh.calls.length;
    const poll = realpathSync(join(import.meta.dir, "poll.ts"));
    const copy = dirname(dirname(poll));
    const script = `import { main } from ${JSON.stringify(poll)}; process.exitCode = await main(null, { place: ${JSON.stringify(t.place)}, checkout: ${JSON.stringify(copy)} });`;
    const p = Bun.spawn(["bun", "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [code, said] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).toBe(2);
    expect(said).toContain("`~/.local/lib/context-view/current/view/poll`");
    expect(t.gh.calls.length).toBe(asked);
  });

  test("a manifest written at its runs start is its runs and one written a moment before is an earlier views", () => {
    const key = `context-view/${OR_ID}#3@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    const [run] = t.loadRuns();
    t.manifest(key, { after: 0 });
    expect(holds(t.place, run!)).toBe(false);
    t.manifest(key, { after: -0.001 });
    expect(holds(t.place, run!)).toBe(true);
  });

  test("a view run again by hand under again frees the runners at its manifest as the polls own do", () => {
    const key = `context-view/${OR_ID}#3@${h("c")}:again-1`;
    t.saveRuns([{ run: "wf-1", key, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    const [run] = t.loadRuns();
    expect(holds(t.place, run!)).toBe(true);
    t.manifest(key, { after: 0 });
    expect(holds(t.place, run!)).toBe(false);
    expect(headKey(key)).toBe(`context-view/${OR_ID}#3@${h("c")}`);
  });

  test("a first pass writes the earlier polls known and waiting so a rollback reads its state", async () => {
    expect(await t.look()).toEqual([1, []]);
    const state = t.state();
    expect([state.known, state.waiting]).toEqual([[], {}]);
  });

  test("a house run whose key isnt text fails the pass as the pythons split does", async () => {
    writeFileSync(join(t.listings, "0"), `${JSON.stringify({ run: "wf-1", key: 5, state: "running", createdAt: "2026-10-31T03:00:00.000Z", house: true })}\n`);
    expect(await t.look()).toEqual([2, []]);
    expect(t.said.replace(/\n+$/, "").split("\n").at(-1)).toBe("AttributeError: 'int' object has no attribute 'split'");
  });

  test("a review whose createdAt isnt text beside one whose is fails the pass as the pythons sort does", async () => {
    t.opened(OR, 2, "b");
    t.opened(OR, 3, "c");
    const path = join(t.listings, "2");
    const reviews = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    reviews[0]!.createdAt = 5;
    writeFileSync(path, reviews.map((r) => `${JSON.stringify(r)}\n`).join(""));
    expect(await t.look()).toEqual([2, []]);
    expect(t.said).toContain("not supported between instances of");
  });

  test("an installations account id that is a list fails the pass as the pythons lookup does", async () => {
    t.gh.installs[5]!.id = [] as never;
    expect(await t.look()).toEqual([2, []]);
    expect(t.said).toContain("cannot use 'list' as a dict key (unhashable type: 'list')");
  });

  test("a pull request whose head isnt text is refused where the pythons line would name no commit", async () => {
    t.opened(OR, 2, "b");
    (t.gh.repos[OR]!.pulls[0]!.head as { sha: unknown }).sha = true;
    expect(await t.look()).toEqual([2, []]);
    expect(t.said).toContain(`${OR}#2's head isn't text, True, so it names no commit to view`);
  });

  test("instant gives cpythons epoch seconds for each form the store writes a time in", () => {
    const times = ["2026-11-05T00:50:00.000Z", "2026-10-31T03:00:00Z", "2026-11-05T00:50:00.123456Z", "2026-11-05T01:50:00+01:00", "2026-11-05T00:50:00.5-00:30"];
    expect(times.map(instant)).toEqual([1793839800.0, 1793415600.0, 1793839800.123456, 1793839800.0, 1793841600.5]);
  });

  test("two reviews whose createdAt are unequal objects fail the pass as the pythons sort does", async () => {
    t.opened(OR, 2, "b");
    t.opened(OR, 3, "c");
    const path = join(t.listings, "2");
    const reviews = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    reviews[0]!.createdAt = { at: 1 };
    reviews[1]!.createdAt = { at: 2 };
    writeFileSync(path, reviews.map((r) => `${JSON.stringify(r)}\n`).join(""));
    expect(await t.look()).toEqual([2, []]);
    expect(t.said).toContain("'<' not supported between instances of 'dict' and 'dict'");
  });

  test("a view json nested past the runtimes depth fails the pass as the pythons recursion error does", async () => {
    t.opened(OR, 2, "b");
    const ran = await t.started();
    t.settle(ran);
    mkdirSync(t.viewDir(OR, 2, "b"), { recursive: true });
    writeFileSync(join(t.viewDir(OR, 2, "b"), "view.json"), `${"[".repeat(100000)}${"]".repeat(100000)}`);
    expect(await t.look()).toEqual([1, []]);
    t.review(OR, 2, { comment: 41 });
    expect(await t.look()).toEqual([2, []]);
    expect(t.said).not.toContain("can't be read");
  });

  test("a job pass keeps its installation token so the next pass mints none", async () => {
    t.opened(OR, 2, "b");
    await t.look();
    const minted = t.gh.minted;
    t.opened(OR, 3, "c");
    await t.look();
    expect(t.gh.minted).toBe(minted);
  });
});

describe("Asks", () => {
  class Asks extends Polling {
    override async setUp(): Promise<void> {
      await super.setUp();
      Object.assign(this.gh.repos[OR]!, { permissions: { "nissa-seru": "admin", maintainer: "write", reader: "read" }, pulls: [pull(2, "b"), pull(3, "c")] });
      this.gh.repos[XY] = { id: XY_ID, pulls: [pull(1, "q")], permissions: { "nissa-seru": "admin" } };
      this.at("2026-11-05T00:00:00Z");
      expect(await this.ask()).toEqual([1, []]);
    }

    ask(take = true) {
      return this.pass(["asks", "--job"], "asks", take);
    }

    passOf(argv: string[]) {
      return this.pass([...argv, "--job"], "poll");
    }

    comments(...made: ReturnType<typeof comment>[]): void {
      (this.gh.repos[OR]!.comments ??= []).push(...(made as never[]));
    }

    async second(): Promise<void> {
      this.gh.repos[AT] = { id: AT_ID, pulls: [pull(7, "e")], permissions: { "nissa-seru": "admin" } };
      expect(await this.ask()).toEqual([1, []]);
    }
  }

  let t: Asks;
  beforeEach(async () => {
    t = new Asks();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  const reactions = () => t.gh.repos[OR]!.reactions;
  const asksOf = (state: Record<string, unknown>) => state.asks as { line: { key: string } | null; queue: { comment: number }[] };

  test("an ask from the one account that may ask prints its pull requests head now under a key naming the comment", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.gh.repos[OR]!.pulls = [pull(2, "f"), pull(3, "c")];
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([0, [{ key: `context-view/${OR_ID}#2@${h("f")}:ask-41`, params: { repo: OR, number: 2, head: h("f") } }]]);
    expect(reactions()).toEqual([[41, "eyes"]]);
    t.startRun(`context-view/${OR_ID}#2@${h("f")}:ask-41`);
    expect(await t.ask()).toEqual([1, []]);
    t.settleAll();
    expect(await t.ask()).toEqual([1, []]);
    expect(reactions()).toEqual([[41, "eyes"]]);
  });

  test("the first pass asks from now so comments from before it are never asks", async () => {
    t.gh.repos[OR]!.comments = [];
    t.place = { ...t.place, state: mkdtempSync(join(t.tmp, "fresh-")) };
    t.comments(comment(40, "/context-deltas", { at: "2026-11-04T23:00:00Z" }));
    t.at("2026-11-05T00:30:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(await t.ask()).toEqual([1, []]);
    expect(reactions()).toBeUndefined();
  });

  test("only the command alone on a comments first line asks", async () => {
    t.comments(
      comment(41, "/context-deltas please", { number: 3 }),
      comment(42, "/review"),
      comment(43, "see /context-deltas"),
      comment(44, "  /context-deltas  \nfor this head"),
    );
    t.at("2026-11-05T01:01:00Z");
    const [, lines] = await t.ask();
    expect(lines.map((l) => l.key)).toEqual([`context-view/${OR_ID}#2@${h("b")}:ask-44`]);
    expect(reactions()).toEqual([[44, "eyes"]]);
    expect(asksOf(t.state()).queue.map((q) => q.comment)).toEqual([44]);
  });

  test("no one else may ask whatever their access and the one account may only with write", async () => {
    t.comments(
      comment(41, "/context-deltas", { login: "maintainer" }),
      comment(42, "/context-deltas", { login: "reader" }),
      comment(43, "/context-deltas", { login: "stranger" }),
      comment(40, "/context-deltas", { number: 3, at: "2026-11-05T01:00:30Z" }),
    );
    t.at("2026-11-05T01:01:00Z");
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-40`);
    expect(reactions()).toEqual([[40, "eyes"]]);
    t.startRun(line!.key as string);
    t.settleAll();
    t.gh.repos[OR]!.permissions!["nissa-seru"] = "read";
    t.comments(comment(44, "/context-deltas", { at: "2026-11-05T01:02:00Z" }));
    t.at("2026-11-05T01:03:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(reactions()).toEqual([[40, "eyes"]]);
  });

  test("the apps own comment and one on an issue are never asks", async () => {
    t.comments(comment(41, "/context-deltas", { app: APP_ID }), comment(42, "/context-deltas", { kind: "issues" }), comment(43, "/context-deltas", { number: 3 }));
    t.at("2026-11-05T01:01:00Z");
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-43`);
    expect(reactions()).toEqual([[43, "eyes"]]);
  });

  test("one views runners at a time and an ask waits for a view at its runners whatever started it", async () => {
    const held = `context-view/${OR_ID}#3@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key: held, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.said).toContain(`wf-1 (running, ${held})`);
    expect(reactions()).toEqual([[41, "eyes"]]);
    t.saveRuns([{ run: "wf-1", key: held, state: "completed", createdAt: "2026-11-05T00:50:00.000Z" }]);
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("an ask waits for a views runners not its reader", async () => {
    const held = `context-view/${OR_ID}#3@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key: held, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    t.manifest(held);
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("an ask waits while a view of its own head is unsettled and an ask on another head goes meanwhile", async () => {
    const reading = `context-view/${OR_ID}#2@${h("b")}`;
    t.saveRuns([{ run: "wf-1", key: reading, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.manifest(reading);
    t.comments(comment(41, "/context-deltas"), comment(42, "/context-deltas", { number: 3, at: "2026-11-05T01:00:30Z" }));
    t.at("2026-11-05T01:01:00Z");
    const [, [other]] = await t.ask();
    expect(other!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
    expect(t.said).toContain("the ask in comment 41 waits for wf-1, a view of its head that hasn't settled");
    t.settleAll();
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("a line jobs didnt take prints again and asks queued behind it print in turn once its view settles", async () => {
    t.comments(comment(41, "/context-deltas"), comment(42, "/context-deltas", { number: 3, at: "2026-11-05T01:00:30Z" }));
    t.at("2026-11-05T01:01:00Z");
    const [, [first]] = await t.ask(false);
    expect(await t.ask(false)).toEqual([0, [first!]]);
    const [, [again]] = await t.ask();
    expect(again).toEqual(first!);
    t.startRun(first!.key as string);
    expect(await t.ask()).toEqual([1, []]);
    t.settleAll();
    const [, [second]] = await t.ask();
    expect(second!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
  });

  test("a newer ask on a pull request with one queued takes its place at the head then", async () => {
    const held = `context-view/${OR_ID}#3@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key: held, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "g"), pull(3, "c")];
    t.comments(comment(45, "/context-deltas", { at: "2026-11-05T01:02:00Z" }));
    t.at("2026-11-05T01:03:00Z");
    expect(await t.ask()).toEqual([1, []]);
    t.settleAll();
    expect(await t.ask()).toEqual([0, [{ key: `context-view/${OR_ID}#2@${h("g")}:ask-45`, params: { repo: OR, number: 2, head: h("g") } }]]);
    expect(reactions()).toEqual([
      [41, "eyes"],
      [45, "eyes"],
    ]);
  });

  test("an ask on a closed pull request prints nothing and says so", async () => {
    t.gh.repos[OR]!.closed = [pull(5, "d")];
    t.comments(comment(41, "/context-deltas", { number: 5 }));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.said).toContain(`${OR}#5 is closed`);
    expect(reactions()).toBeUndefined();
  });

  test("a repository not in the views list is never read for asks", async () => {
    t.gh.repos[XY]!.comments = [comment(51, "/context-deltas", { repo: XY, number: 1 })] as never[];
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.gh.calls.some(([, path]) => path.startsWith(`/repos/${XY}/`))).toBe(false);
  });

  test("an ask already run under its key prints nothing again", async () => {
    t.comments(comment(41, "/context-deltas"), comment(42, "/context-deltas", { number: 3 }));
    t.saveRuns([{ run: "wf-1", key: `context-view/${OR_ID}#2@${h("b")}:ask-41`, state: "completed", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.at("2026-11-05T01:01:00Z");
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
  });

  test("an ask views its pull requests head as it is when its line is printed", async () => {
    const held = `context-view/${OR_ID}#3@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key: held, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "h"), pull(3, "c")];
    t.settleAll();
    const line = one(await t.ask(false));
    expect(line).toEqual({ key: `context-view/${OR_ID}#2@${h("h")}:ask-41`, params: { repo: OR, number: 2, head: h("h") } });
    t.gh.repos[OR]!.pulls = [pull(2, "i"), pull(3, "c")];
    const [, [again]] = await t.ask();
    expect((again!.params as { head: string }).head).toBe(h("i"));
    expect(again!.key).toBe(`context-view/${OR_ID}#2@${h("i")}:ask-41`);
  });

  test("an ask whose pull request closes while it waits gets no view and the next ask prints", async () => {
    const held = `context-view/${OR_ID}#9@${h("c")}`;
    t.saveRuns([{ run: "wf-1", key: held, state: "running", createdAt: "2026-11-05T00:50:00.000Z" }]);
    t.comments(comment(41, "/context-deltas"), comment(42, "/context-deltas", { number: 3, at: "2026-11-05T01:00:30Z" }));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    Object.assign(t.gh.repos[OR]!, { pulls: [pull(3, "c")], closed: [pull(2, "b")] });
    t.settleAll();
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
    expect(t.said).toContain(`${OR}#2 is closed`);
  });

  test("a line either step printed holds the other until its view shows in the store", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c")];
    const views = () => t.passOf([]);
    expect(await views()).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d")];
    t.review(OR, 4, { head: "d" });
    const [, [printed]] = await views();
    expect(printed!.key).toBe(`context-view/${OR_ID}#4@${h("d")}`);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.said).toContain(`the views' line ${printed!.key as string}`);
    t.startRun(printed!.key as string);
    expect(await t.ask()).toEqual([1, []]);
    t.settleAll();
    const [, [asked]] = await t.ask(false);
    expect(asked!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d"), pull(5, "e")];
    t.review(OR, 5, { head: "e" });
    expect(await views()).toEqual([1, []]);
    expect(t.said).toContain(`the asks' line ${asked!.key as string}`);
  });

  test("an asks view of a head counts as that head viewed for the views poll", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c")];
    expect(await t.passOf([])).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d")];
    t.comments(comment(41, "/context-deltas", { number: 4 }));
    t.at("2026-11-05T01:01:00Z");
    const [, [asked]] = await t.ask();
    expect(asked!.key).toBe(`context-view/${OR_ID}#4@${h("d")}:ask-41`);
    t.startRun(asked!.key as string);
    t.settleAll();
    t.review(OR, 4, { comment: 51 });
    expect(await t.passOf([])).toEqual([1, []]);
  });

  test("a pass no job made prints what it would and leaves the state and every comment as they were", async () => {
    expect(await t.passOf([])).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d")];
    t.review(OR, 4, { head: "d" });
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    const before = readFileSync(t.statePath(), "utf8");
    const [helpCode, helpText] = await captured(() => main(["--help"], { place: t.place, now: () => t.clock[0]! }));
    expect(helpCode).toBe(0);
    expect(helpText).toContain('{"key", "params"}');
    expect(helpText).not.toContain('{"key", "args"}');
    for (const argv of [["asks"], []]) {
      t.env({ ASTRA_JOB_ID: "70169" });
      const [code, printed] = await captured(() => main(argv, { place: t.place, now: () => t.clock[0]! }));
      expect([code, printed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).key)]).toEqual([
        0,
        [argv.length ? `context-view/${OR_ID}#2@${h("b")}:ask-41` : `context-view/${OR_ID}#4@${h("d")}`],
      ]);
      expect(readFileSync(t.statePath(), "utf8")).toBe(before);
    }
    expect(reactions()).toBeUndefined();
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
    expect(reactions()).toEqual([[41, "eyes"]]);
  });

  test("an asks line jobs didnt take prints again and one it took isnt viewed again at a later head", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    const [, [first]] = await t.ask(false);
    const [, [again]] = await t.ask();
    expect(again).toEqual(first!);
    t.startRun(again!.key as string);
    t.settleAll();
    t.gh.repos[OR]!.pulls = [pull(2, "j"), pull(3, "c")];
    expect(await t.ask()).toEqual([1, []]);
    expect(asksOf(t.state()).queue).toEqual([]);
  });

  test("a comment made in the second a look ended at is read at the next and none is taken in twice", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:00:00Z");
    const [, [first]] = await t.ask();
    t.startRun(first!.key as string);
    t.settleAll();
    t.comments(comment(42, "/context-deltas", { number: 3 }));
    const [, [second]] = await t.ask();
    expect(second!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
    t.startRun(second!.key as string);
    t.settleAll();
    expect(await t.ask()).toEqual([1, []]);
    const posted = t.gh.calls.filter(([method, path]) => method === "POST" && path.endsWith("/reactions")).map(([, path]) => path);
    expect(posted).toEqual([`/repos/${OR}/issues/comments/41/reactions`, `/repos/${OR}/issues/comments/42/reactions`]);
  });

  test("a comment made in the second a look ended at and edited later isnt taken in again", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:00:00Z");
    const [, [first]] = await t.ask();
    t.startRun(first!.key as string);
    t.settleAll();
    (t.gh.repos[OR]!.comments![0] as { updated_at: string }).updated_at = "2026-11-05T01:05:00Z";
    t.at("2026-11-05T01:06:00Z");
    t.saveRuns([]);
    expect(await t.ask()).toEqual([1, []]);
    const posted = t.gh.calls.filter(([method, path]) => method === "POST" && path.endsWith("/reactions")).map(([, path]) => path);
    expect(posted).toEqual([`/repos/${OR}/issues/comments/41/reactions`]);
  });

  test("a pull request read that fails as an ask is taken in fails the pass so the ask is read again", async () => {
    t.comments(comment(41, "/context-deltas", { number: 3 }));
    t.at("2026-11-05T01:01:00Z");
    for (const failure of [{ 3: 502 }, "timeout"] as const) {
      if (typeof failure === "object") t.gh.repos[OR]!.pullsFail = failure;
      else t.gh.fail = ["/pulls/3", failure];
      expect(await t.ask()).toEqual([2, []]);
      expect(t.gh.calls.at(-1)).toEqual(["GET", `/repos/${OR}/pulls/3`]);
      delete t.gh.repos[OR]!.pullsFail;
      t.gh.fail = null;
    }
    expect(reactions()).toBeUndefined();
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-41`);
  });

  test("eyes that fail are said on stderr and each ask still views", async () => {
    const failures = [403, 404, 502, "timeout", "garbled", "cut"] as const;
    for (const [n, failure] of failures.entries()) {
      const made = `2026-11-05T01:0${n}:30Z`;
      t.comments(comment(41 + n, "/context-deltas", { number: 2 + (n % 2), at: made }));
      t.at(`2026-11-05T01:0${n + 1}:00Z`);
      if (typeof failure === "number") t.gh.repos[OR]!.reactFail = failure;
      else t.gh.fail = ["/reactions", failure];
      const line = one(await t.ask());
      expect((line!.key as string).endsWith(`:ask-${41 + n}`)).toBe(true);
      expect(t.said).toContain(`no 👀 on ${OR} comment ${41 + n}: `);
      delete t.gh.repos[OR]!.reactFail;
      t.gh.fail = null;
      t.startRun(line!.key as string);
      t.settleAll();
    }
    expect(reactions()).toBeUndefined();
  });

  test("a permission lookup github fails fails the pass so the ask is read again", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    t.gh.repos[OR]!.permissionsFail = 502;
    expect(await t.ask()).toEqual([2, []]);
    expect(t.said).toContain("GitHub answered 502");
    delete t.gh.repos[OR]!.permissionsFail;
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("asks found in one pass queue in the order they were asked whatever their repositorys place", async () => {
    await t.second();
    t.comments(comment(41, "/context-deltas", { at: "2026-11-05T01:00:40Z" }));
    t.gh.repos[AT]!.comments = [comment(51, "/context-deltas", { repo: AT, number: 7, at: "2026-11-05T01:00:20Z" })] as never[];
    t.at("2026-11-05T01:01:00Z");
    const [, [first]] = await t.ask();
    expect(first!.key).toBe(`context-view/${AT_ID}#7@${h("e")}:ask-51`);
  });

  test("an ask whose repository isnt listed waits and the next listed ask prints in its place", async () => {
    await t.second();
    t.comments(comment(41, "/context-deltas", { at: "2026-11-05T01:00:20Z" }));
    t.gh.repos[AT]!.comments = [comment(51, "/context-deltas", { repo: AT, number: 7, at: "2026-11-05T01:00:40Z" })] as never[];
    t.at("2026-11-05T01:01:00Z");
    const [, [first]] = await t.ask(false);
    expect(first!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
    t.gh.repos[OR]!.archived = true;
    const [, [other]] = await t.ask(false);
    expect(other!.key).toBe(`context-view/${AT_ID}#7@${h("e")}:ask-51`);
    expect(t.said).toContain("comment 41 waits");
    delete t.gh.repos[OR]!.archived;
    t.startRun(other!.key as string);
    t.settleAll();
    const [, [back]] = await t.ask();
    expect(back!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("a newer ask on a pull request takes the place of its untaken line", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    const [, [old]] = await t.ask(false);
    expect(old!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
    t.comments(comment(45, "/context-deltas", { at: "2026-11-05T01:02:00Z" }));
    t.at("2026-11-05T01:03:00Z");
    const [, [made]] = await t.ask();
    expect(made!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-45`);
    t.startRun(made!.key as string);
    t.settleAll();
    expect(await t.ask()).toEqual([1, []]);
  });

  test("a views line jobs took holds the asks by its run until that settles", async () => {
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c")];
    expect(await t.passOf([])).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d")];
    t.review(OR, 4, { head: "d" });
    const [, [printed]] = await t.passOf([]);
    t.startRun(printed!.key as string);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c")];
    expect(await t.passOf([])).toEqual([1, []]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.said).toContain(`(running, ${printed!.key as string})`);
    t.settleAll();
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
  });

  test("an ask on a number github gives no pull request for is dropped and one it fails to read waits", async () => {
    t.comments(comment(41, "/context-deltas", { number: 99 }), comment(42, "/context-deltas", { number: 3, at: "2026-11-05T01:00:30Z" }));
    t.at("2026-11-05T01:01:00Z");
    const line = one(await t.ask(false));
    expect(line!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
    expect(t.said).toContain(`${OR}#99`);
    t.gh.repos[OR]!.pullsFail = { 3: 502 };
    t.comments(comment(43, "/context-deltas", { at: "2026-11-05T01:02:00Z" }));
    t.at("2026-11-05T01:03:00Z");
    const [, [other]] = await t.ask();
    expect(other!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-43`);
    expect(t.said).toContain(`GitHub answered 502 to GET /repos/${OR}/pulls/3`);
    expect(t.said).toContain("so its ask in comment 42 waits");
    delete t.gh.repos[OR]!.pullsFail;
    t.gh.fail = ["/pulls/3", "timeout"];
    t.comments(comment(44, "/context-deltas", { at: "2026-11-05T01:04:00Z" }));
    t.at("2026-11-05T01:05:00Z");
    t.startRun(other!.key as string);
    t.settleAll();
    const [, [timed]] = await t.ask(false);
    expect(timed!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-44`);
    expect(t.said).toContain(`poll.ts: GET /repos/${OR}/pulls/3 failed (timed out), so its ask in comment 42 waits`);
    t.gh.fail = null;
    const [, [again]] = await t.ask();
    expect(again).toEqual(timed!);
    t.startRun(again!.key as string);
    t.settleAll();
    const [, [back]] = await t.ask();
    expect(back!.key).toBe(`context-view/${OR_ID}#3@${h("c")}:ask-42`);
  });

  test("a pass that failed after its eyes reacts again and githubs 200 for one already made is no failure", async () => {
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    const broken = join(t.tmp, "broken-workflows");
    writeFileSync(broken, "#!/bin/sh\necho store down >&2\nexit 1\n");
    chmodSync(broken, 0o755);
    const place = t.place;
    t.place = { ...place, workflows: broken };
    expect(await t.ask()).toEqual([2, []]);
    t.place = place;
    expect(reactions()).toEqual([[41, "eyes"]]);
    const line = one(await t.ask());
    expect(line!.key).toBe(`context-view/${OR_ID}#2@${h("b")}:ask-41`);
    expect(t.said).not.toContain("no 👀");
  });

  test("the first asks pass on a state file the views step wrote keeps it and waits for its line", async () => {
    const fresh = mkdtempSync(join(t.tmp, "fresh-"));
    t.place = { ...t.place, state: fresh };
    const line = { seq: 3, key: `context-view/${OR_ID}#9@${h("z")}`, args: { repo: OR, number: 9, head: h("z"), auto: true } };
    const base = { seq: 3, line: null, views_line: line, queue: {}, reviews: [], seen: ["x"], repos: {}, tokens: {} };
    writeFileSync(join(fresh, "poll.json"), JSON.stringify(base));
    expect(await t.ask()).toEqual([1, []]);
    t.comments(comment(41, "/context-deltas"));
    t.at("2026-11-05T01:01:00Z");
    expect(await t.ask()).toEqual([1, []]);
    expect(t.said).toContain(`the views' line ${line.key}`);
    const state = JSON.parse(readFileSync(join(fresh, "poll.json"), "utf8"));
    expect([state.line, state.views_line, state.seen, state.reviews]).toEqual([null, line, ["x"], []]);
  });

  test("the asks and the views keep their own lines and cursors in one state file", async () => {
    expect(await t.passOf([])).toEqual([1, []]);
    t.gh.repos[OR]!.pulls = [pull(2, "b"), pull(3, "c"), pull(4, "d")];
    t.review(OR, 4, { head: "d" });
    const [, [views]] = await t.passOf([]);
    t.startRun(views!.key as string);
    t.settleAll();
    t.comments(comment(41, "/context-deltas", { number: 3 }));
    t.at("2026-11-05T01:01:00Z");
    const [, [asked]] = await t.ask();
    let state = t.state();
    expect([(state.views_line as { key: string }).key, asksOf(state).line!.key]).toEqual([views!.key as string, asked!.key as string]);
    t.startRun(asked!.key as string);
    t.settleAll();
    expect(await t.passOf([])).toEqual([1, []]);
    expect(await t.ask()).toEqual([1, []]);
    state = t.state();
    expect([state.views_line, asksOf(state).line, asksOf(state).queue]).toEqual([null, null, []]);
  });

  test("a comment whose updated_at id html_url body or created_at isnt what the pass reads fails it as the pythons does", async () => {
    for (const [field, value, words] of [
      ["updated_at", ["2026-11-05T01:00:00Z"], "'>' not supported between instances of 'list' and 'str'"],
      ["id", [], "cannot use 'list' as a set element (unhashable type: 'list')"],
      ["html_url", 5, "expected string or bytes-like object, got 'int'"],
      ["body", 5, "'int' object has no attribute 'strip'"],
      ["created_at", 5, "'>' not supported between instances of 'int' and 'str'"],
    ] as const) {
      t.gh.repos[OR]!.comments = [{ ...comment(11, "/context-deltas"), [field]: value } as never];
      expect([field, await t.ask()]).toEqual([field, [2, []]]);
      expect([field, t.said]).toEqual([field, expect.stringContaining(words)]);
    }
  });
});

describe("Merges", () => {
  const dir = (n: number, c: string) => `${OR.replaceAll("/", ".")}.${n}.${c.repeat(12)}`;

  function merge(n: number, at: string, commit: string, updated: string | null = null, base = "main") {
    return { number: n, merged_at: at, merge_commit_sha: h(commit), updated_at: updated ?? at, base: { ref: base }, head: { sha: h("e") }, draft: false, author_association: "MEMBER" };
  }

  function unmerged(n: number, updated: string) {
    return { number: n, merged_at: null, merge_commit_sha: h("f"), updated_at: updated, base: { ref: "main" }, head: { sha: h("e") }, draft: false, author_association: "MEMBER" };
  }

  const mergeKey = (rid: number, n: number, commit: string) => `context-view/${rid}#${n}@merged:${h(commit)}`;

  class Merges extends Polling {
    override async setUp(): Promise<void> {
      await super.setUp();
      Object.assign(this.gh.repos[OR]!, { permissions: { "nissa-seru": "admin" }, pulls: [pull(2, "b"), pull(3, "c")], closed: [] });
      this.gh.repos[AT] = { id: AT_ID, pulls: [], closed: [] };
      this.gh.repos[XY] = { id: XY_ID, pulls: [], closed: [merge(1, "2026-11-09T11:00:00Z", "d")] };
      this.at("2026-11-09T10:00:00Z");
      for (const argv of [[], ["asks"], ["merges"]]) expect(await this.step(argv)).toEqual([1, []]);
      this.at("2026-11-09T12:00:00Z");
    }

    async step(argv: string[], take = true, job = true): Promise<[number, Record<string, unknown>[]]> {
      if (job) return this.pass([...argv, "--job"], argv[0] ?? "poll", take);
      const [code, printed, said] = await captured(() => main(argv, { place: this.place, now: () => this.clock[0]! }));
      this.said = said;
      return [code, printed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)];
    }

    merges(take = true) {
      return this.step(["merges"], take);
    }

    views(take = true) {
      return this.step([], take);
    }

    asks(take = true) {
      return this.step(["asks"], take);
    }

    override settle(key: string): void {
      this.saveRuns(this.loadRuns().map((r) => (r.key === key ? { ...r, state: "completed" } : r)));
    }

    closed(repo: string, ...made: unknown[]): void {
      this.gh.repos[repo]!.closed!.push(...(made as never[]));
    }

    done(key: string): void {
      this.startRun(key);
      this.settle(key);
    }

    written(key: string, where: string, after = 60): void {
      const path = join(this.place.state, "views", where, "manifest.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ outcome: "ran" }));
      const at = instant(this.loadRuns().filter((r) => r.key === key).at(-1)!.createdAt) + after;
      utimesSync(path, at, at);
    }

    opened(repo: string, n: number, head: string): string {
      this.gh.repos[repo]!.pulls = [...this.gh.repos[repo]!.pulls.filter((p) => p.number !== n), pull(n, head)];
      return this.review(repo, n, { head });
    }

    askComment(n: number, number: number, at: string): void {
      (this.gh.repos[OR]!.comments ??= []).push(comment(n, "/context-deltas", { at, number }) as never);
    }
  }

  let t: Merges;
  beforeEach(async () => {
    t = new Merges();
    await t.setUp();
  });
  afterEach(async () => {
    await t.tearDown();
  });

  const keys = (lines: Record<string, unknown>[]) => lines.map((l) => l.key);

  test("each merge from the start prints oldest first across repositories under its merge key", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), merge(4, "2026-11-09T10:50:00Z", "b"));
    t.closed(AT, merge(7, "2026-11-09T10:58:00Z", "c"));
    expect(await t.merges()).toEqual([0, [{ key: mergeKey(AT_ID, 7, "c"), params: { repo: AT, number: 7, merged: h("c") } }]]);
    t.done(mergeKey(AT_ID, 7, "c"));
    expect(await t.merges()).toEqual([0, [{ key: mergeKey(OR_ID, 5, "a"), params: { repo: OR, number: 5, merged: h("a") } }]]);
    t.done(mergeKey(OR_ID, 5, "a"));
    expect(await t.merges()).toEqual([1, []]);
    expect(t.gh.calls.filter(([, path]) => path.startsWith(`/repos/${XY}/`))).toEqual([]);
  });

  test("the first pass takes merges from membrane 248s at 2026 11 09T10 57 53Z on", async () => {
    t.closed(OR, merge(3, "2026-11-09T10:57:52Z", "a"), merge(4, "2026-11-09T10:57:53Z", "b"));
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 4, "b")]);
    t.done(mergeKey(OR_ID, 4, "b"));
    expect(await t.merges()).toEqual([1, []]);
  });

  test("a pull request closed without merging is no merge", async () => {
    t.closed(OR, unmerged(9, "2026-11-09T11:30:00Z"), merge(8, "2026-11-09T11:00:00Z", "a"));
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 8, "a")]);
    t.done(mergeKey(OR_ID, 8, "a"));
    expect(await t.merges()).toEqual([1, []]);
  });

  test("a line jobs didnt take prints again and a taken merge isnt checked again once the store clears its run", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), merge(6, "2026-11-09T11:10:00Z", "b"));
    const [, first] = await t.merges(false);
    expect((await t.merges(false))[1]).toEqual(first);
    expect((await t.merges())[1]).toEqual(first);
    t.done(first[0]!.key as string);
    const [, second] = await t.merges();
    expect(keys(second)).toEqual([mergeKey(OR_ID, 6, "b")]);
    t.done(second[0]!.key as string);
    t.saveRuns([]);
    expect(await t.merges()).toEqual([1, []]);
  });

  test("a merge whose key the store holds with or without an again isnt printed", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), merge(6, "2026-11-09T11:10:00Z", "b"), merge(7, "2026-11-09T11:20:00Z", "c"));
    t.done(mergeKey(OR_ID, 5, "a"));
    t.done(`${mergeKey(OR_ID, 6, "b")}:again-1`);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 7, "c")]);
  });

  test("a merge another start ran moves its repositorys place once no earlier merge there waits so it isnt checked again", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const line = one(await t.merges(false));
    t.done(line!.key as string);
    expect(await t.merges(false)).toEqual([1, []]);
    t.saveRuns([]);
    expect(await t.merges(false)).toEqual([1, []]);
    t.closed(OR, merge(6, "2026-11-09T11:10:00Z", "b"), merge(7, "2026-11-09T11:20:00Z", "c"));
    t.done(`${mergeKey(OR_ID, 7, "c")}:again-1`);
    const busy = keyOf(OR_ID, 3, h("c"));
    t.startRun(busy);
    t.opened(OR, 2, "b");
    expect(await t.views()).toEqual([1, []]);
    t.written(busy, dir(3, "c"));
    expect(await t.merges()).toEqual([1, []]);
    const [, [viewed]] = await t.views();
    t.done(viewed!.key as string);
    expect(await t.views()).toEqual([1, []]);
    const [, [six]] = await t.merges();
    expect(six!.key).toBe(mergeKey(OR_ID, 6, "b"));
    t.done(six!.key as string);
    expect(await t.merges()).toEqual([1, []]);
    t.saveRuns([]);
    expect(await t.merges()).toEqual([1, []]);
  });

  test("two merges in one second print in number order and neither twice", async () => {
    t.closed(OR, merge(12, "2026-11-09T11:00:00Z", "a"), merge(11, "2026-11-09T11:00:00Z", "b"));
    for (const [n, c] of [
      [11, "b"],
      [12, "a"],
    ] as const) {
      expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, n, c)]);
      t.done(mergeKey(OR_ID, n, c));
    }
    t.saveRuns([]);
    expect(await t.merges()).toEqual([1, []]);
  });

  test("a merge waits while a views run holds the runners", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const held = keyOf(OR_ID, 3, h("c"));
    t.startRun(held);
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain("waiting for the runners");
    t.written(held, dir(3, "c"));
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
  });

  test("a merge check holds the runners until its manifest is written in the merges own directory", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    for (const key of [mergeKey(OR_ID, 5, "a"), `${mergeKey(OR_ID, 5, "a")}:again-1`]) {
      t.saveRuns([]);
      rmSync(join(t.place.state, "views"), { recursive: true, force: true });
      t.startRun(key);
      t.opened(OR, 2, "b");
      expect(await t.views(false)).toEqual([1, []]);
      expect(t.said).toContain(`held by wf-1 (running, ${key})`);
      t.written(key, dir(5, "a"));
      expect(await t.views(false)).toEqual([1, []]);
      t.written(key, `merged.${dir(5, "a")}`);
      expect(keys((await t.views(false))[1])).toEqual([keyOf(OR_ID, 2, h("b"))]);
    }
  });

  test("a merge waits while the views or the asks line is out and unstarted", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    t.opened(OR, 2, "b");
    const line = one(await t.views());
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain(`the views' line ${line!.key as string}`);
    t.done(line!.key as string);
    expect(await t.views()).toEqual([1, []]);
    t.askComment(41, 3, "2026-11-09T11:59:00Z");
    const [, [asked]] = await t.asks();
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain(`the asks' line ${asked!.key as string}`);
    t.done(asked!.key as string);
    expect(await t.asks()).toEqual([1, []]);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
  });

  test("the views and the asks steps wait while the merges line is out and unstarted", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const line = one(await t.merges());
    t.opened(OR, 2, "b");
    t.askComment(41, 3, "2026-11-09T11:59:00Z");
    for (const step of [() => t.views(), () => t.asks()]) {
      expect(await step()).toEqual([1, []]);
      expect(t.said).toContain(`the merges' line ${line!.key as string}`);
    }
    t.startRun(line!.key as string);
    t.written(line!.key as string, `merged.${dir(5, "a")}`);
    expect(keys((await t.asks())[1])).toEqual([`${keyOf(OR_ID, 3, h("c"))}:ask-41`]);
  });

  test("merges wait for an ask queued on an open head with no unsettled view and for no other", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const busy = keyOf(OR_ID, 3, h("c"));
    t.startRun(busy);
    t.askComment(41, 2, "2026-11-09T11:59:00Z");
    expect(await t.asks()).toEqual([1, []]);
    t.written(busy, dir(3, "c"));
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain("the asks' queue");
    t.gh.repos[OR]!.pulls = [pull(3, "c")];
    t.askComment(42, 3, "2026-11-09T11:59:30Z");
    t.at("2026-11-09T12:01:00Z");
    expect(await t.asks(false)).toEqual([1, []]);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
  });

  test("merges wait while the views steps last job pass left a pull request waiting", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const busy = keyOf(OR_ID, 9, h("f"));
    t.startRun(busy);
    t.opened(OR, 2, "b");
    expect(await t.views()).toEqual([1, []]);
    t.written(busy, dir(9, "f"));
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain("the views step left 1 pull request waiting");
    const line = one(await t.views());
    t.done(line!.key as string);
    expect(await t.views()).toEqual([1, []]);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
  });

  test("a merges line out prints again whatever waits since the other steps wait for its run", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const [, first] = await t.merges(false);
    expect(keys(first)).toEqual([mergeKey(OR_ID, 5, "a")]);
    t.opened(OR, 2, "b");
    expect(await t.views()).toEqual([1, []]);
    expect((await t.merges(false))[1]).toEqual(first);
  });

  test("a merges line out waits while a run that took the runners after it printed holds them", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const [, first] = await t.merges(false);
    expect(keys(first)).toEqual([mergeKey(OR_ID, 5, "a")]);
    const held = keyOf(OR_ID, 3, h("c"));
    t.startRun(held);
    expect(await t.merges(false)).toEqual([1, []]);
    expect(t.said).toContain("waiting for the runners");
    t.written(held, dir(3, "c"));
    expect((await t.merges(false))[1]).toEqual(first);
  });

  test("the views step prints once the merges line it waited on has started", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const line = one(await t.merges());
    t.opened(OR, 2, "b");
    expect(await t.views(false)).toEqual([1, []]);
    expect(t.said).toContain(`the merges' line ${line!.key as string}`);
    t.startRun(line!.key as string);
    t.written(line!.key as string, `merged.${dir(5, "a")}`);
    expect(keys((await t.views())[1])).toEqual([keyOf(OR_ID, 2, h("b"))]);
  });

  test("a merges line out whose repository a pass doesnt list is dropped and prints again once its listed", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const [, first] = await t.merges(false);
    expect(keys(first)).toEqual([mergeKey(OR_ID, 5, "a")]);
    t.gh.repos[OR]!.archived = true;
    expect(await t.merges(false)).toEqual([1, []]);
    expect(t.said).toContain(`${first[0]!.key as string}'s line is dropped`);
    delete t.gh.repos[OR]!.archived;
    expect((await t.merges(false))[1]).toEqual(first);
  });

  test("a merges line out prints again under its repositorys name now", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    expect((await t.merges(false))[1].map((l) => (l.params as { repo: string }).repo)).toEqual([OR]);
    const renamed = `${OR}-renamed`;
    t.gh.repos[renamed] = t.gh.repos[OR]!;
    delete t.gh.repos[OR];
    expect((await t.merges(false))[1]).toEqual([{ key: mergeKey(OR_ID, 5, "a"), params: { repo: renamed, number: 5, merged: h("a") } }]);
  });

  test("merges wait for the views steps first job pass where none has counted the pull requests waiting", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const state = t.state();
    delete state.views_waiting;
    t.saveState(state);
    expect(await t.merges()).toEqual([1, []]);
    expect(t.said).toContain("the views step's first job pass");
    expect(await t.views()).toEqual([1, []]);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
  });

  test("the listing pages until a page ends before the repositorys place", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), ...Array.from({ length: 150 }, (_, i) => unmerged(100 + i, "2026-11-09T11:30:00Z")));
    t.closed(AT, ...Array.from({ length: 150 }, (_, i) => unmerged(100 + i, "2026-11-08T00:00:00Z")));
    t.gh.calls.length = 0;
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
    const listed = (repo: string) => t.gh.calls.filter(([, path]) => path.startsWith(`/repos/${repo}/pulls?state=closed`));
    expect([listed(OR).length, listed(AT).length]).toEqual([2, 1]);
  });

  test("a pass no job made prints what it would and changes nothing", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const before = readFileSync(t.statePath(), "utf8");
    expect(keys((await t.step(["merges"], true, false))[1])).toEqual([mergeKey(OR_ID, 5, "a")]);
    expect(existsSync(`${t.out}-merges`)).toBe(false);
    expect(readFileSync(t.statePath(), "utf8")).toBe(before);
  });

  test("the merges line is kept apart from the views and asks lines so the release before reads none", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const line = one(await t.merges(false));
    const state = t.state();
    expect([state.line, state.views_line, (state.asks as { line: unknown }).line]).toEqual([null, null, null]);
    expect(JSON.stringify(Object.fromEntries(Object.entries(state).filter(([k]) => k !== "merges")))).not.toContain(line!.key as string);
  });

  test("a repository out of a passes listing keeps its place", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), merge(6, "2026-11-09T11:10:00Z", "b"));
    t.closed(AT, merge(7, "2026-11-09T11:20:00Z", "c"));
    t.done((await t.merges())[1][0]!.key as string);
    t.gh.repos[OR]!.archived = true;
    expect(keys((await t.merges())[1])).toEqual([mergeKey(AT_ID, 7, "c")]);
    t.done(mergeKey(AT_ID, 7, "c"));
    delete t.gh.repos[OR]!.archived;
    t.saveRuns([]);
    expect(keys((await t.merges())[1])).toEqual([mergeKey(OR_ID, 6, "b")]);
  });

  test("a renamed repositorys merge is named as it is now", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const renamed = `${OR}-renamed`;
    t.gh.repos[renamed] = t.gh.repos[OR]!;
    delete t.gh.repos[OR];
    expect((await t.merges())[1]).toEqual([{ key: mergeKey(OR_ID, 5, "a"), params: { repo: renamed, number: 5, merged: h("a") } }]);
  });

  test("a failure exits 2 says why and keeps the state and cursor as they were", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"));
    const line = one(await t.merges(false));
    const before = readFileSync(t.statePath(), "utf8");
    t.gh.fail = [`/repos/${OR}/pulls?state=closed`, { status: 502 }];
    expect(await t.merges()).toEqual([2, []]);
    expect(t.said).toContain(`poll.ts: GitHub answered 502 to GET /repos/${OR}/pulls`);
    expect(existsSync(`${t.out}-merges`)).toBe(false);
    expect(readFileSync(t.statePath(), "utf8")).toBe(before);
    t.gh.fail = null;
    expect((await t.merges(false))[1]).toEqual([{ key: line!.key, params: line!.params }]);
  });

  test("a closed pull whose merged_at or merge commit isnt text fails the pass where the python fails or would name no commit", async () => {
    for (const [field, value, words] of [
      ["merged_at", 5, "'>=' not supported between instances of 'int' and 'str'"],
      ["merge_commit_sha", [], "cannot use 'tuple' as a set element (unhashable type: 'list')"],
      ["merge_commit_sha", 5, `${OR}#5's merge commit is 5, not a sha`],
    ] as const) {
      t.gh.repos[OR]!.closed = [{ ...merge(5, "2026-11-09T11:00:00Z", "a"), [field]: value }];
      expect([field, await t.merges()]).toEqual([field, [2, []]]);
      expect([field, t.said]).toEqual([field, expect.stringContaining(words)]);
    }
  });

  test("a run in the store whose key is a list fails a pass with a line out as the pythons set of keys does", async () => {
    t.opened(OR, 2, "b");
    expect((await t.views())[0]).toBe(0);
    const path = join(t.listings, "0");
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({ run: "wf-1", key: [], state: "completed", createdAt: "2026-10-31T03:00:00.000Z", house: true })}\n`);
    expect(await t.merges()).toEqual([2, []]);
    expect(t.said).toContain("cannot use 'list' as a set element (unhashable type: 'list')");
  });

  test("a closed listings last updated_at that isnt text fails the pass before the next page is read", async () => {
    t.closed(OR, ...Array.from({ length: 102 }, (_, i) => unmerged(100 + i, "2026-11-09T11:30:00Z")));
    (t.gh.repos[OR]!.closed![99] as { updated_at: unknown }).updated_at = 5;
    t.gh.calls.length = 0;
    expect(await t.merges()).toEqual([2, []]);
    expect(t.said).toContain("'<' not supported between instances of 'int' and 'str'");
    expect(t.gh.calls.filter(([, path]) => path.startsWith(`/repos/${OR}/pulls?state=closed`)).map(([, path]) => path.includes("page=2"))).toEqual([false]);
  });

  test("a closed pulls merge commit that isnt text is refused where it is read so a busy pass keeps none", async () => {
    t.closed(OR, { ...merge(5, "2026-11-09T11:00:00Z", "a"), merge_commit_sha: 5 } as never);
    t.startRun(keyOf(OR_ID, 3, h("c")));
    const before = readFileSync(t.statePath(), "utf8");
    expect(await t.merges()).toEqual([2, []]);
    expect(t.said).toContain(`${OR}#5's merge commit is 5, not a sha`);
    expect(readFileSync(t.statePath(), "utf8")).toBe(before);
  });

  test("a merge an earlier listing kept whose commit or number is a list fails a pass github answers 304 to", async () => {
    t.closed(OR, merge(5, "2026-11-09T11:00:00Z", "a"), merge(6, "2026-11-09T11:10:00Z", "b"));
    t.done((await t.merges())[1][0]!.key as string);
    const kept = readFileSync(t.statePath(), "utf8");
    for (const [field, words] of [
      ["merged", "cannot use 'tuple' as a set element (unhashable type: 'list')"],
      ["number", "cannot use 'list' as a set element (unhashable type: 'list')"],
    ] as const) {
      writeFileSync(t.statePath(), kept);
      const state = t.state();
      const seen = (state.merges as { repos: Record<string, { tag: unknown; found: Record<string, unknown>[] }> }).repos[String(OR_ID)]!;
      expect([field, typeof seen.tag]).toEqual([field, "string"]);
      seen.found[0]![field] = [];
      t.saveState(state);
      expect([field, await t.merges()]).toEqual([field, [2, []]]);
      expect([field, t.said]).toEqual([field, expect.stringContaining(words)]);
    }
  });
});
