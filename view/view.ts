import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  api,
  basename,
  code,
  COMMENT_FILES,
  COMMENT_MAX,
  cpLength,
  cpSlice,
  dumps,
  encode,
  expanduser,
  Failed,
  get,
  grouped,
  item,
  join,
  loads,
  MORE,
  need,
  normpath,
  NotARequest,
  oneLine,
  posted,
  pyEquals,
  pyRepr,
  pyStr,
  readJson,
  realpath,
  rstrip,
  run,
  split,
  strip,
  truthy,
  unsaid,
  VIEW_MARK,
  type Json,
} from "review-workflow/view";

import { REACH_FOLD, REACH_WHY, reachItems, reachSaid } from "./view_reach.ts";
import { compared, facts, fullSha, PARTS, viewed } from "./view_read.ts";
import { contextFold, contextLine, upgradeLines, upgradesFold, usageFold, usageLine, usageShown } from "./view_usage.ts";
import {
  absentLine,
  pausedLine,
  CHECKED,
  counted,
  couldNot,
  deltas,
  differingLine,
  flagsLine,
  flagsText,
  folded,
  forcedLine,
  heldText,
  inside,
  known,
  linked,
  listed,
  lostLine,
  opening,
  runFolds,
  summaryText,
  UNREAD,
  widest,
} from "./view_words.ts";

type Dict = { [key: string]: Json };
type Marked = { stopped: string | null; first: string | null; head: string | null; result: string | null; part: string | null };
type Found = [Dict, Marked];
type Chain = { first: string; result: string; parts: Dict[]; whole: boolean; claims: string | null; id: Json };

const isDict = (v: Json): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

const dict = (v: Json): Dict => {
  if (!isDict(v)) throw new TypeError(`a dict is needed here, not ${pyRepr(v)}`);
  return v;
};

const list = (v: Json): Json[] => {
  if (!Array.isArray(v)) throw new TypeError(`a list is needed here, not ${pyRepr(v)}`);
  return v;
};

const str = (v: Json): string => {
  if (typeof v !== "string") throw new TypeError(`a str is needed here, not ${pyRepr(v)}`);
  return v;
};

const int = (v: Json): number | bigint => {
  if (typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v))) return v;
  throw new TypeError(`an int is needed here, not ${pyRepr(v)}`);
};

const or = (a: Json, b: Json): Json => (truthy(a) ? a : b);

const getOr = (v: Json, key: string, fallback: Json): Json => {
  const d = dict(v);
  return Object.hasOwn(d, key) ? d[key]! : fallback;
};

const has = (container: Json, key: string): boolean => Object.hasOwn(dict(container), key);

const lessThan = (a: Json, b: Json): boolean => {
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) return a < b;
  throw new TypeError(`'<' not supported between ${pyRepr(a)} and ${pyRepr(b)}`);
};

const say = (line: string): void => {
  process.stderr.write(encode(`${line}\n`, "backslashreplace"));
};

// Bun's `stack` starts with the error's own line, above its frames.
export function traceback(e: Error): string {
  const line = `${e.name}: ${e.message}`;
  const stack = e.stack ?? line;
  const frames = stack.startsWith(line) ? stack.slice(line.length).replace(/^\n/, "") : stack;
  return frames ? `${frames}\n${line}` : line;
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export const MARK = new RegExp(
  `${escaped(VIEW_MARK)}(?:stopped:(?<stopped>[0-9a-f]{40})|first:(?<first>[0-9a-f]{40})` +
    `(?: head:(?<head>[0-9a-f]{40}))? result:(?<result>[0-9a-f]{64})(?::(?<part>[0-9]+))?) -->$`,
);

export const marked = (text: string): Marked | null => {
  const m = MARK.exec(text);
  if (!m) return null;
  const g = m.groups!;
  return { stopped: g.stopped ?? null, first: g.first ?? null, head: g.head ?? null, result: g.result ?? null, part: g.part ?? null };
};

const unmarked = (text: string, by: string): string => text.replace(MARK, () => by);

export function wordsOf(files: readonly string[]): string {
  const h = createHash("sha256");
  for (const path of files) {
    const data = readFileSync(path);
    h.update(`${data.length}\n`);
    h.update(data);
  }
  return h.digest("hex");
}

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export const seams = {
  WORDS: wordsOf([
    here("./view.ts"),
    here("./view_numbers.ts"),
    here("./view_reach.ts"),
    here("./view_read.ts"),
    here("./view_usage.ts"),
    here("./view_words.ts"),
    ...COMMENT_FILES,
  ]),
  REVIEW_POLL: expanduser("~/.local/bin/review-poll"),
  CHECKOUT: "~/astra/context-view",
  onPull,
};

const KEEP = ["base", "baseRef", "host", "harness", "form", "outcome", "detail", "held", "runs", "broken", "flags", "reached", "absent", "usage", "forced", "upgrades", "stack", "differing", "reach"];

export function resultOf(view: Json, sources: Json = null): string {
  const said: Dict = Object.fromEntries(KEEP.map((k) => [k, get(view, k)]));
  if (truthy(said.usage)) {
    said.usage = list(said.usage!).map((u) => ({ ...dict(u), base: usageShown(item(u, "base") as Parameters<typeof usageShown>[0]) as Json, head: usageShown(item(u, "head") as Parameters<typeof usageShown>[0]) as Json }));
  }
  if (pyEquals(get(view, "outcome"), "arm-missing")) said.jobs = get(view, "jobs");
  if (has(view, "paused")) said.paused = get(view, "paused");
  said.entries = or(get(view, "entries"), []);
  said.words = seams.WORDS;
  if (pyEquals(get(view, "outcome"), "ran") && truthy(said.entries) && sources !== null) {
    said.pr = [get(view, "title"), get(view, "body")];
    said.reads = sources;
  }
  return createHash("sha256")
    .update(encode(dumps(said, { sortKeys: true, separators: [",", ":"] }), "strict"))
    .digest("hex");
}

export function mark(view: Json, first: string, digest: string, part = 1): string {
  if (part === 1) return `${VIEW_MARK}first:${first} head:${pyStr(item(view, "head"))} result:${digest} -->`;
  return `${VIEW_MARK}first:${first} result:${digest}:${part} -->`;
}

export function stoppedMark(head: string): string {
  return `${VIEW_MARK}stopped:${head} -->`;
}

export function units(view: Json, reader: Json, room: number): string[] {
  const held = [heldText(view)].filter((x): x is string => truthy(x));
  const used = view as Parameters<typeof usageLine>[0];
  if (!pyEquals(item(view, "outcome"), "ran")) {
    need(reader === null, "a head that couldn't be compared has no reader account");
    return [linked(view), ...couldNot(view, room)];
  }
  const some = item(item(view, "runs"), "compared");
  const partial = truthy(get(view, "broken"));
  if (!truthy(some)) {
    need(reader === null, "a head none of whose runs could be compared has no reader account");
    return [linked(view), ...couldNot(view, room), ...forcedLine(view), ...pausedLine(view), ...flagsText(view, room), ...held];
  }
  const runs = partial ? `the ${counted(int(some), "run", "runs")} it could compare` : `the ${counted(int(some), "run", "runs")}`;
  const lost = list(or(get(view, "broken"), [])).length;
  const [said, cut] = has(view, "reach") ? reachSaid(item(view, "reach")) : [null, false];
  const reach = truthy(said) ? [said!] : [];
  need(
    reach.every((x) => cpLength(x) <= room),
    `the reach paragraph doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters`,
  );
  const title = summaryText(has(getOr(view, "reach", {}), "couldnt") ? REACH_WHY : REACH_FOLD);
  const reachFold = cut ? folded(title, reachItems(item(view, "reach"), inside(room, title)), room) : [];
  const reasons = summaryText(`Runs that couldn't be compared (${grouped(lost)})`);
  const lostFold = lost ? folded(reasons, couldNot(view, inside(room, reasons)), room) : [];
  if (!truthy(item(view, "entries"))) {
    need(reader === null, "a head whose runs it could compare don't differ has no reader account");
    return [
      linked(view),
      `The records of ${runs} don't differ between the base and this head.`,
      ...differingLine(view),
      ...forcedLine(view),
      ...reach,
      ...absentLine(view),
      ...pausedLine(view),
      ...(lost ? [lostLine(lost)] : []),
      ...usageLine(used),
      ...upgradeLines(used),
      ...flagsText(view, room),
      ...lostFold,
      ...usageFold(used, room),
      ...upgradesFold(used, room),
      ...reachFold,
      ...held,
    ];
  }
  const places = new Set(list(item(view, "entries")).flatMap((e) => list(item(e, "places")).map((p) => str(item(p, "run")))));
  const changed = places.size;
  const flagged = list(or(get(view, "flags"), [])).reduce<number>((n, f) => n + list(item(f, "new")).length + list(item(f, "gone")).length, 0);
  const count = `The records of ${grouped(changed)} of ${runs} differ between the base and this head.`;
  const flags = summaryText(`Checks' flags that differ (${grouped(flagged)})`);
  const lines = [
    linked(view),
    count,
    ...differingLine(view),
    ...forcedLine(view),
    ...reach,
    ...absentLine(view),
    ...pausedLine(view),
    ...(lost ? [lostLine(lost)] : []),
    ...(flagged ? [flagsLine(view, flagged)] : []),
    ...usageLine(used),
    ...contextLine(used),
    ...upgradeLines(used),
  ];
  const folds = [
    ...lostFold,
    ...(flagged ? folded(flags, flagsText(view, inside(room, flags)).slice(1), room) : []),
    ...usageFold(used, room),
    ...contextFold(used, room),
    ...upgradesFold(used, room),
    ...reachFold,
    ...held,
  ];
  if (reader === null) {
    const differ = summaryText(`Runs whose records differ: ${grouped(changed)} of ${grouped(int(some))}`);
    const order = list(item(view, "order")).filter((r) => typeof r === "string" && places.has(r));
    return [...lines, UNREAD, ...folded(differ, [listed(order.map((r) => code(oneLine(r)))) + "."], room), ...folds];
  }
  const entries = new Map(list(item(view, "entries")).map((e) => [str(item(e, "id")), e] as const));
  const account = { ...dict(reader), changes: list(item(reader, "changes")).map((c) => known(c, entries)) };
  const differ = summaryText(`Runs whose records differ: ${grouped(changed)} of ${grouped(int(some))}, with ${counted(account.changes.length, "change", "changes")}`);
  return [...lines, "*A model's account of those records:*", ...deltas(view, account), ...folded(differ, runFolds(view, account, entries, inside(room, differ)), room), ...folds];
}

export function partsOf(view: Json, reader: Json, first: string, digest: string, headNow: string): string[] {
  const later = `**Automatic context view** of ${code(cpSlice(first, 0, 12))}, continued.`;
  const out: string[][] = [];
  let body: string[] = [];
  let n = 1;
  const room = (k: number) => COMMENT_MAX - (k === 1 ? widest(view) : cpLength(later)) - cpLength(`\n\n\n\n${MORE}\n\n`) - cpLength(mark(view, first, digest, k > 1 ? k : 1));
  for (const unit of units(view, reader, room(1))) {
    if (body.length && cpLength([...body, unit].join("\n\n")) > room(n)) {
      out.push(body);
      body = [];
      n += 1;
    }
    need(cpLength(unit) <= room(n), `one paragraph of the comment doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters: ${cpSlice(unit, 0, 200)}`);
    body.push(unit);
  }
  out.push(body);
  return out.map((items, i) => {
    const k = i + 1;
    const top = k === 1 ? opening(view, first, headNow) : later;
    return [top, ...items, ...(k < out.length ? [MORE] : []), mark(view, first, digest, k)].join("\n\n");
  });
}

async function onPull(repo: string, number: Json, token: string, appId: Json): Promise<Found[]> {
  const found: Found[] = [];
  for (let page = 1; ; page++) {
    const got = list(await api("GET", `/repos/${repo}/issues/${pyStr(number)}/comments?per_page=100&page=${page}`, { token }));
    for (const c of got) {
      const m = marked(rstrip(str(or(get(c, "body"), ""))));
      if (pyEquals(get(or(get(c, "performed_via_github_app"), {}), "id"), appId) && m) found.push([dict(c), m]);
    }
    if (got.length < 100) return found;
  }
}

const saysMore = (c: Dict): boolean => rstrip(unmarked(rstrip(str(item(c, "body"))), "")).endsWith(MORE);

export function chains(found: Found[]): Chain[] {
  const byKey = new Map<string, [bigint, Dict, Marked][]>();
  for (const [c, g] of found) {
    if (g.first === null) continue;
    const at = `${g.first} ${g.result}`;
    if (!byKey.has(at)) byKey.set(at, []);
    byKey.get(at)!.push([BigInt(g.part ?? 1), c, g]);
  }
  const order = (a: Json, b: Json) => (lessThan(a, b) ? -1 : lessThan(b, a) ? 1 : 0);
  const out: Chain[] = [];
  for (const all of byKey.values()) {
    all.sort((a, b) => order(item(a[1], "id"), item(b[1], "id")));
    const postings: [bigint, Dict, Marked][][] = [];
    for (const p of all) {
      const open = postings.at(-1)?.at(-1);
      const continues = open !== undefined && p[0] === open[0] + 1n && saysMore(open[1]);
      if (continues) postings.at(-1)!.push(p);
      else postings.push([p]);
    }
    for (const parts of postings) {
      const [k0, c0, g0] = parts[0]!;
      const whole = k0 === 1n && !saysMore(parts.at(-1)![1]);
      out.push({ first: g0.first!, result: g0.result!, parts: parts.map(([, c]) => c), whole, claims: k0 === 1n ? g0.head : null, id: item(c0, "id") });
    }
  }
  return out;
}

async function deleted(repo: string, token: string, comments: Dict[]): Promise<void> {
  const left: string[] = [];
  for (const c of comments) {
    try {
      await api("DELETE", `/repos/${repo}/issues/comments/${pyStr(item(c, "id"))}`, { token, missing: true, repeat: true });
    } catch (e) {
      if (!(e instanceof Failed)) throw e;
      left.push(`${pyStr(get(c, "html_url"))} may still be there, since deleting it failed: ${e.message}`);
    }
  }
  if (left.length) throw new Failed(left.join("; "));
}

function worded(e: unknown): string {
  if (e instanceof Failed) return e.message;
  if (!(e instanceof Error)) return `Error: ${String(e)}`;
  say(traceback(e));
  return `${e.name}: ${e.message}`;
}

const idOf = (c: Dict): string => pyStr(item(c, "id"));

async function unposted(repo: string, number: Json, token: string, appId: Json, head: string, digest: string, earlier: Set<string>): Promise<string> {
  try {
    const mine = chains(await seams.onPull(repo, number, token, appId)).filter((x) => x.first === head && x.result === digest);
    await deleted(repo, token, mine.flatMap((x) => x.parts).filter((c) => !earlier.has(idOf(c))));
  } catch (e) {
    return `deleting the parts of its comment that went up failed too: ${worded(e)}`;
  }
  return "the parts of its comment the pull request then listed are deleted";
}

export function contextOf(view: Json): string | null {
  if (!pyEquals(get(view, "outcome"), "ran") || has(view, "merge")) return null;
  if (truthy(get(view, "entries"))) return "Yes";
  return lessThan(0, item(item(view, "runs"), "compared")) && !truthy(get(view, "broken")) ? "No" : null;
}

function wanted(d: string, view: Json, value: string): void {
  if (!truthy(get(view, "ended"))) {
    say(`post: its Changes context, ${value}, wasn't wanted: its view.json has no ended, as one facts wrote before view.json carried it`);
    return;
  }
  const argv = [
    seams.REVIEW_POLL,
    "want",
    "--kind",
    "context",
    "--repo",
    str(item(view, "repo")),
    "--number",
    pyStr(item(view, "number")),
    "--label",
    basename(normpath(d)),
    "--value",
    value,
    "--started",
    str(item(view, "ended")),
  ];
  let ran;
  try {
    ran = run(argv, { errors: "replace", timeout: 120 });
  } catch (e) {
    say(`post: its Changes context, ${value}, wasn't wanted: ${(e as Error).message}`);
    return;
  }
  if (ran.code !== 0) say(`post: its Changes context, ${value}, wasn't wanted: ${seams.REVIEW_POLL} exited ${ran.code}: ${cpSlice(strip(ran.stderr || ran.stdout), 0, 500)}`);
}

const latestOf = (chains_: Chain[]): Chain | null => {
  let best: Chain | null = null;
  for (const x of chains_) if (truthy(x.claims) && (best === null || lessThan(best.id, x.id))) best = x;
  return best;
};

export async function post(args: Json): Promise<Dict> {
  const d = str(item(args, "dir"));
  const view = readJson(join(d, "view.json")) as Json;
  const [repo, number, head] = [item(view, "repo"), item(view, "number"), item(view, "head")];
  if (["moved", "closed"].some((o) => pyEquals(item(view, "outcome"), o))) return { action: item(view, "outcome") };
  need(!pyEquals(item(view, "outcome"), "couldnt-run"), "a run that couldn't run posts its stopped words, through stopped");
  const reader = truthy(get(args, "reader")) ? (readJson(str(item(args, "reader"))) as Json) : null;
  const sources = get(args, "reads");
  need((reader === null) === (sources === null), "post: reads, the sha256 of the reader's instructions and guide, goes with a reader account and only with one");
  need(
    sources === null ||
      (isDict(sources) &&
        Object.keys(sources).length === 2 &&
        has(sources, "instructions") &&
        has(sources, "guide") &&
        Object.values(sources).every((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x))),
    "post: reads is {instructions, guide}, each a sha256 in lowercase hex",
  );
  const digest = resultOf(view, sources);
  if (!truthy(getOr(args, "post", true))) {
    const texts = partsOf(view, reader, str(head), digest, str(head));
    for (const name of readdirSync(d)) if (PARTS.test(name)) rmSync(join(d, name));
    texts.forEach((text, i) => writeFileSync(join(d, i === 0 ? "comment.md" : `comment-${i + 1}.md`), text));
    return { action: "dry", parts: texts.length };
  }
  partsOf(view, reader, str(head), digest, str(head));
  const [token, appId] = await viewed(str(repo));
  const pr = await api("GET", `/repos/${str(repo)}/pulls/${pyStr(number)}`, { token });
  if (!pyEquals(get(pr, "state"), "open")) return { action: "closed", state: get(pr, "state") };
  const headNow = str(item(item(pr, "head"), "sha"));
  const found = await seams.onPull(str(repo), number, token, appId);
  const held = chains(found);
  const latest = latestOf(held);
  const keep = latest !== null && latest.whole && latest.result === digest ? latest : null;
  const earlier = held.filter((x) => x !== keep && x.first === head && x.result === digest);
  const earlierIds = new Set(earlier.flatMap((x) => x.parts).map(idOf));
  try {
    await deleted(str(repo), token, earlier.filter((x) => !x.whole).flatMap((x) => x.parts));
  } catch (e) {
    if (!(e instanceof Failed)) throw e;
    throw new Failed(`an earlier comment of this head and result that isn't whole couldn't be deleted, so nothing is posted or edited: ${e.message}`);
  }
  let action: string;
  let url: Json;
  if (keep !== null) {
    const c = keep.parts[0]!;
    const halves = split(str(item(c, "body")), "\n\n", 1);
    if (halves.length !== 2) throw Object.assign(new Error(`not enough values to unpack (expected 2, got ${halves.length})`), { name: "ValueError" });
    const text = [opening(view, keep.first, headNow), unmarked(rstrip(halves[1]!), mark(view, keep.first, digest))].join("\n\n");
    action = text === rstrip(str(item(c, "body"))) ? "unchanged" : "edited";
    if (action === "edited") await api("PATCH", `/repos/${str(repo)}/issues/comments/${pyStr(item(c, "id"))}`, { token, body: { body: text }, repeat: true });
    url = get(c, "html_url");
  } else {
    const texts = partsOf(view, reader, str(head), digest, headNow);
    const marks = texts.map((_, i) => mark(view, str(head), digest, i + 1));
    let done;
    try {
      done = await posted(str(repo), number, token, appId, marks, texts, new Map());
    } catch (e) {
      throw new Failed(`${worded(e)}; ${await unposted(str(repo), number, token, appId, str(head), digest, earlierIds)}`);
    }
    const parts = marks.map((m) => item(done, m) as Dict);
    if (parts.some((c) => earlierIds.has(idOf(c)))) {
      throw new Failed(
        `posting its comment met a failure GitHub may have recovered from, and the read after it found an earlier comment's part under the same marker, so what of the earlier comment is there stays as it was; ${await unposted(str(repo), number, token, appId, str(head), digest, earlierIds)}`,
      );
    }
    action = "posted";
    url = get(item(done, marks[0]!), "html_url");
  }
  const stale: string[] = [];
  try {
    await deleted(str(repo), token, earlier.filter((x) => x.whole).flatMap((x) => x.parts));
  } catch (e) {
    if (!(e instanceof Failed)) throw e;
    say(`post: an earlier comment of this head and result couldn't be deleted whole: ${e.message}`);
    stale.push(e.message);
  }
  for (const x of held) {
    if (x !== keep && !(x.first === head && x.result === digest) && (x.claims === head || !x.whole)) {
      try {
        await deleted(str(repo), token, x.parts);
      } catch (e) {
        if (!(e instanceof Failed)) throw e;
        stale.push(e.message);
      }
    }
  }
  const kept: string[] = [];
  for (const [c, g] of found) {
    if (g.stopped !== head) continue;
    const k = await unsaid(str(repo), token, c);
    if (truthy(k)) kept.push(k!);
  }
  const value = contextOf(view);
  if (value) wanted(d, view, value);
  return { action, url, ...(stale.length ? { staleKept: stale } : {}), ...(kept.length ? { stoppedKept: kept } : {}) };
}

export async function stopped(args: Json): Promise<Dict> {
  const [repo, number, head] = [item(args, "repo"), item(args, "number"), item(args, "head")];
  need(fullSha(head), `head isn't a full commit sha, ${pyRepr(head)}`);
  const said = stoppedMark(str(head));
  const text = [`**Automatic context view** of ${code(cpSlice(str(head), 0, 12))} stopped before it finished, so it has nothing to report.`, CHECKED, said].join("\n\n");
  if (!truthy(getOr(args, "post", true))) return { action: "dry", text };
  const [token, appId] = await viewed(str(repo));
  const found = await seams.onPull(str(repo), number, token, appId);
  const held = chains(found);
  const views = held.filter((x) => x.claims === head && x.whole).map((x): [string, Dict] => ["view", x.parts[0]!]);
  const there = views.length ? views : found.filter(([, g]) => g.stopped === head).map(([c]): [string, Dict] => ["stopped", c]);
  if (there.length) return { action: "unchanged", found: there[0]![0], url: get(there[0]![1], "html_url") };
  const pr = await api("GET", `/repos/${str(repo)}/pulls/${pyStr(number)}`, { token });
  if (!pyEquals(get(pr, "state"), "open")) return { action: "closed", state: get(pr, "state") };
  if (!pyEquals(item(item(pr, "head"), "sha"), head)) return { action: "moved", headNow: item(item(pr, "head"), "sha") };
  for (const x of held) if (!x.whole) await deleted(str(repo), token, x.parts);
  const done = await posted(str(repo), number, token, appId, [said], [text], new Map());
  return { action: "posted", url: get(item(done, said), "html_url") };
}

export const STEPS: Readonly<Record<string, (args: Json) => Promise<Json> | Json>> = { facts, compared, post, stopped };

export const KEPT = 1500;

export function keptWhole(line: string): string {
  return cpLength(line) <= KEPT ? line : cpSlice(line, 0, KEPT - 1) + "…";
}

function commonpath(a: string, b: string): string {
  const parts = (p: string) => p.split("/").filter((x) => x && x !== ".");
  const [x, y] = [parts(a), parts(b)];
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return "/" + x.slice(0, n).join("/");
}

export function refuseCheckout(module: string, command: string, code: number, checkout: string = seams.CHECKOUT): number | null {
  const home = realpath(expanduser(checkout));
  if (commonpath(realpath(module), home) !== home) return null;
  say(`${basename(module)}: the context view runs from its install, not from its main working copy ${checkout}: use \`${command}\`, or a worktree to run your own code`);
  return code;
}

const PROG = "view.ts";
const USAGE = `usage: ${PROG} [-h] {${Object.keys(STEPS).sort().join(",")}}`;
const ABOUT =
  "The context view's steps on the host, which the workflow running a view calls: each reads one JSON object on stdin and prints one on its last line of stdout, or exits 1 with why on stderr, or 2 when the run's repository is one the App is installed on that the context view doesn't cover, or when its command line names no step. facts and compared, which read a run, are view_read.ts's; post puts the comment together here from the words view_words.ts, view_usage.ts and view_reach.ts write.";

function stepOf(argv: string[]): string | number {
  if (argv.some((a) => a === "-h" || a === "--help")) {
    process.stdout.write(`${USAGE}\n\n${ABOUT}\n`);
    return 0;
  }
  const refused = (why: string): number => {
    say(`${USAGE}\n${PROG}: error: ${why}`);
    return 2;
  };
  if (argv.length === 0 || argv[0]!.startsWith("-")) return refused("the following arguments are required: step");
  if (!Object.hasOwn(STEPS, argv[0]!)) return refused(`argument step: invalid choice: ${pyRepr(argv[0])} (choose from ${Object.keys(STEPS).sort().join(", ")})`);
  if (argv.length > 1) return refused(`unrecognized arguments: ${argv.slice(1).join(" ")}`);
  return argv[0]!;
}

const READ_FAULTS = new Set(["KeyError", "IndexError", "TypeError", "AttributeError", "ValueError", "JSONDecodeError", "UnicodeDecodeError"]);

export async function main(argv: string[] | null = null, o: { stdin?: string } = {}): Promise<number> {
  const refused = argv === null ? refuseCheckout(fileURLToPath(import.meta.url), "~/.local/lib/context-view/current/view/step STEP", 1) : null;
  if (refused !== null) return refused;
  const step = stepOf(argv ?? process.argv.slice(2));
  if (typeof step === "number") return step;
  try {
    const given = loads(o.stdin ?? readFileSync(0, "utf8")) as Json;
    need(isDict(given), "stdin: one JSON object");
    process.stdout.write(`${dumps(await STEPS[step]!(given))}\n`);
  } catch (e) {
    if (e instanceof NotARequest) {
      say(keptWhole(`${PROG} ${step}: ${e.message}`));
      return 2;
    }
    if (e instanceof Failed) {
      say(keptWhole(`${PROG} ${step}: ${e.message}`));
      return 1;
    }
    if (e instanceof Error && READ_FAULTS.has(e.name)) {
      say(traceback(e));
      say(`${PROG} ${step}: a field it reads is missing or of another shape, or the step's own code failed; the traceback above says which`);
      return 1;
    }
    say(e instanceof Error ? traceback(e) : `Error: ${String(e)}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
