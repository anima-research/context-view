import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  api,
  appToken,
  cpCompare,
  cpLength,
  cpSlice,
  digitsValue,
  Failed,
  get,
  item,
  join,
  JSONDecodeError,
  need,
  normpath,
  oneLine,
  ordered,
  pyEquals,
  pyRepr,
  pyStr,
  readJson,
  refuse,
  SPACE,
  split,
  truthy,
  UnicodeDecodeError,
  writeJson,
  type Json,
} from "review-workflow/view";
import { isWhole as isInt } from "./view_numbers.ts";
import { usageRead, type RunUsage } from "./view_usage.ts";
import { ARMS, CHOSEN, HARNESS } from "./view_words.ts";

// What a test replaces, since an ES module's own bindings can't be.
export const seams = { writeJson };

export const VIEWED: ReadonlyMap<number, string> = new Map([
  [1126567876, "anima-research/context-manager"],
  [1132522869, "anima-research/agent-framework"],
  [1123531033, "antra-tess/membrane"],
  [1170978461, "anima-research/connectome-host"],
]);
export const KEY = "context-view/";
export const OUTCOMES = ["ran", "moved", "closed", "couldnt-run", "doesnt-merge", "needs-companion", "arm-missing", "elsewhere", "unchanged"];
const UNRUN = ["moved", "closed", "elsewhere", "unchanged"];
const REACHED: Readonly<Record<string, readonly string[]>> = { ran: ["k", "src"], "arm-missing": ["k", "src"], "needs-companion": ["k", "src"], unchanged: ["k"] };
const CHECKS = ["same", "differs", "couldnt-run"];
const RESULTS = ["pass", "flags", "invalid", "couldnt-run"];
const FORMS = ["overlay", "host"];
const PACKS: ReadonlyMap<number, string> = new Map([
  [1126567876, "@animalabs/context-manager"],
  [1132522869, "@animalabs/agent-framework"],
  [1123531033, "@animalabs/membrane"],
]);
const SHA = /^[0-9a-f]{40}$/;
const ENTRIES = "entries.json";
export const PARTS = /^comment(-[0-9]+)?\.md$/;
const SHARE = /^share-([1-9][0-9]*)$/;

type Dict = Record<string, Json>;
const isDict = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const isList = (v: unknown): v is Json[] => Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isCount = (n: unknown): n is number | bigint => isInt(n) && BigInt(n) >= 0n;
const keyIn = (map: ReadonlyMap<number, string>, id: unknown) => (typeof id === "number" || typeof id === "bigint") && map.has(Number(id));
const among = (value: unknown, items: readonly unknown[]) => items.some((x) => pyEquals(value, x));
const INDEX = /^(?:0|[1-9][0-9]*)$/;
// A dict in Python's order: a Map where a key is one JavaScript would put first, since dumps refuses such an object.
function dict(pairs: Iterable<readonly [string, unknown]>): Dict {
  const map = new Map(pairs);
  return ([...map.keys()].some((k) => INDEX.test(k) && Number(k) < 4294967295) ? map : Object.fromEntries(map)) as unknown as Dict;
}

const entries = (d: Dict | ReadonlyMap<string, Json>): [string, Json][] => (d instanceof Map ? [...d] : (ordered(d) as [string, Json][]));

const raised = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const typeName = (v: unknown): string =>
  v === null ? "NoneType" : isStr(v) ? "str" : typeof v === "boolean" ? "bool" : isInt(v) ? "int" : typeof v === "number" ? "float" : isList(v) ? "list" : "dict";

function iter(v: Json): Json[] {
  if (isList(v)) return v;
  if (isStr(v)) return Array.from(v);
  if (isDict(v)) return entries(v).map(([k]) => k);
  throw new TypeError(`'${typeName(v)}' object is not iterable`);
}

function compare(a: unknown, b: unknown): number {
  if (isStr(a) && isStr(b)) return cpCompare(a, b);
  if ((typeof a === "number" || typeof a === "bigint" || typeof a === "boolean") && (typeof b === "number" || typeof b === "bigint" || typeof b === "boolean")) {
    const [x, y] = [typeof a === "boolean" ? Number(a) : a, typeof b === "boolean" ? Number(b) : b];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  throw new TypeError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

function compareTuples(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    const c = Array.isArray(x) && Array.isArray(y) ? compareTuples(x, y) : compare(x, y);
    if (c) return c;
  }
  return a.length - b.length;
}

function indexOf(items: readonly Json[], value: Json): number {
  const i = items.findIndex((x) => pyEquals(x, value));
  if (i < 0) throw raised("ValueError", "list.index(x): x not in list");
  return i;
}

// order.index as Python finds it on order's type: a list's, a str's substring search by code point, or none, which
// raises at the lookup, before any argument is read.
function method(order: Json): (value: Json) => number {
  if (isList(order)) return (value) => indexOf(order, value);
  if (!isStr(order)) throw raised("AttributeError", `'${typeName(order)}' object has no attribute 'index'`);
  const text = Array.from(order);
  return (value) => {
    if (!isStr(value)) throw new TypeError(`index() argument 1 must be str, not ${value === null ? "None" : typeName(value)}`);
    const sought = Array.from(value);
    for (let i = 0; i + sought.length <= text.length; i++) if (sought.every((c, j) => text[i + j] === c)) return i;
    throw raised("ValueError", "substring not found");
  };
}

function plus(a: Json, b: Json, op: "+" | "+=" = "+"): Json {
  const num = (v: unknown) => typeof v === "number" || typeof v === "bigint" || typeof v === "boolean";
  if (num(a) && num(b)) {
    const [x, y] = [typeof a === "boolean" ? Number(a) : (a as number | bigint), typeof b === "boolean" ? Number(b) : (b as number | bigint)];
    if (isInt(x) && isInt(y)) {
      const s = BigInt(x) + BigInt(y);
      return s >= -BigInt(Number.MAX_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
    }
    return Number(x) + Number(y);
  }
  if (isStr(a) && isStr(b)) return a + b;
  if (isList(a) && isList(b)) return [...a, ...b];
  if (op === "+=" && isList(a)) return [...a, ...iter(b)];
  if (isStr(a) || isList(a)) throw new TypeError(`can only concatenate ${typeName(a)} (not "${typeName(b)}") to ${typeName(a)}`);
  throw new TypeError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

export function fullSha(v: unknown): boolean {
  return isStr(v) && SHA.test(v);
}

export function keyOf(repoId: number | bigint, number: number | bigint, head: string): string {
  return `${KEY}${repoId}#${number}@${head}`;
}

/**
 * view.json, the one file the reader, its check and post read: the manifest's facts, the pull request's title and
 * description as GitHub gives them now, and each share's head arm read and merged.
 */
export async function facts(args: Json): Promise<{ path: string; changed: boolean }> {
  const [d, repo] = [item(args, "dir") as string, item(args, "repo") as string];
  const m = readJson(join(d, "manifest.json")) as Json;
  need(pyEquals(get(m, "repo"), split(repo, "/", 1)[1] ?? indexError()), `manifest.json names ${pyRepr(get(m, "repo"))}, not ${repo}`);
  const [token, , repoId] = await viewed(repo);
  const view = manifested(m, repo);
  if (!among(view.outcome, ["moved", "closed"])) {
    const pr = await api("GET", `/repos/${repo}/pulls/${pyStr(item(m, "number"))}`, { token });
    view.title = truthy(get(pr, "title")) ? get(pr, "title") : "";
    view.body = truthy(get(pr, "body")) ? get(pr, "body") : "";
  }
  if (Object.hasOwn(view, "forced")) view.pack = PACKS.get(Number(repoId)) ?? null;
  if (pyEquals(view.outcome, "ran")) {
    for (const [k, v] of entries(arms(d, m as Dict, PACKS.get(Number(repoId)) ?? null))) view[k] = v;
    view.reach = reachOf(d);
    view.ended = endedOf(d);
  }
  return answered(d, view);
}

function indexError(): never {
  throw raised("IndexError", "list index out of range");
}

function endedOf(d: string): string {
  // The manifest's mtime to the second in UTC, as review-poll takes it: os.stat's st_mtime is sec + 1e-9 * nsec as a double,
  // which datetime.fromtimestamp rounds to microseconds half to even before the seconds are taken.
  const ns = statSync(join(d, "manifest.json"), { bigint: true }).mtimeNs;
  const [sec, nsec] = [ns / 1_000_000_000n - (ns % 1_000_000_000n < 0n ? 1n : 0n), ((ns % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n];
  const at = Number(sec) + 1e-9 * Number(nsec);
  let whole = Math.trunc(at);
  let us = halfEven((at - whole) * 1e6);
  if (us >= 1e6) whole += 1;
  else if (us < 0) {
    us += 1e6;
    whole -= 1;
  }
  return `${new Date(whole * 1000).toISOString().slice(0, 19)}Z`;
}

// CPython's pytime_round_half_even: C's round, half away from zero, then to even where x was halfway.
function halfEven(x: number): number {
  const away = (v: number) => {
    const t = Math.trunc(v);
    return Math.abs(v - t) >= 0.5 ? t + Math.sign(v) : t;
  };
  const r = away(x);
  return Math.abs(x - r) === 0.5 ? 2 * away(x / 2) : r;
}

/**
 * view.json from a harness compare's two outputs rather than a view's run, for a dry view of a change no pull request
 * holds: DIR's share-<i>/{before,after}, laid out as a view's shares, are read as facts reads them, under a manifest.json
 * written from the fields given as the run side writes them, with the title and description given standing for the pull
 * request's. Where DIR holds a reach.json, as the harness's reachJoined writes from the shares' reach-digests.json, the
 * view reads it as facts does; without one, its comment has no reach paragraph. Nothing is asked of GitHub. Once DIR is
 * a directory, it removes view.json, manifest.json, reader.json and the comment's parts, as an earlier view writes them
 * there, before any other check, so whether it writes this view or refuses, none of those files predates it; it writes
 * view.json last, so a manifest that can't be written leaves none.
 */
export function compared(args: Json): { path: string; changed: boolean } {
  const d = item(args, "dir") as string;
  if (d === null || typeof d === "object" || (typeof d === "number" && !isInt(d)))
    throw new TypeError(`stat: path should be string, bytes, os.PathLike or integer, not ${typeName(d)}`);
  need(isDirectory(d), `${pyStr(d)} isn't a directory`);
  for (const name of readdirSync(d)) if (["view.json", "manifest.json", "reader.json"].includes(name) || PARTS.test(name)) rmSync(join(d, name));
  const repo = get(args, "repo");
  need([...VIEWED.values()].some((v) => pyEquals(repo, v)), `${pyStr(repo)} isn't one of the context view's repositories`);
  const shares = readdirSync(d)
    .map((name) => SHARE.exec(name))
    .filter((s) => s !== null)
    .map((s) => digitsValue(s[1]!))
    .sort((a, b) => compare(a, b));
  need(shares.length, `${d} holds no share-<i> directory`);
  need(isStr(get(args, "title")) && isStr(get(args, "body")), "compared: title and body are the pull request's, each a string");
  const a = args as Dict;
  const m = dict([
    ["repo", split(repo as string, "/", 1)[1] ?? indexError()],
    ...["number", "head", "form", "base", "host", "harness"].map((k) => [k, get(a, k)] as const),
    ...(Object.hasOwn(a, "stack") ? [["stack", a.stack] as const] : []),
    ...(Object.hasOwn(a, "forced") ? [["forced", a.forced] as const] : []),
    ["outcome", "ran"],
    ["detail", null],
    ["shares", shares.map((i) => dict([["i", i], ["dir", `share-${i}`]]))],
  ]);
  const pack = PACKS.get([...VIEWED].find(([, v]) => v === repo)![0]) ?? null;
  const view = dict([
    ...entries(manifested(m, repo as string)),
    ["title", a.title],
    ["body", a.body],
    ...(Object.hasOwn(m, "forced") ? [["pack", pack] as const] : []),
    ...entries(arms(d, m, pack)),
    ...(existsSync(join(d, REACH)) ? [["reach", reachOf(d)] as const] : []),
  ]);
  seams.writeJson(join(d, "manifest.json"), m);
  view.ended = endedOf(d);
  return answered(d, view);
}

const isDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function manifested(m: Json, repo: string): Dict {
  need(among(get(m, "outcome"), OUTCOMES), `manifest.json: an outcome the view doesn't know, ${pyRepr(get(m, "outcome"))}`);
  need(fullSha(get(m, "head")), `manifest.json: head isn't a full commit sha, ${pyRepr(get(m, "head"))}`);
  const number = get(m, "number");
  need(isInt(number) && BigInt(number) > 0n, "manifest.json: number");
  const outcome = item(m, "outcome") as string;
  const merge = get(m, "merge");
  need(merge !== null || !["elsewhere", "unchanged"].includes(outcome), `manifest.json: merge is missing from a merged pull request's ${outcome}`);
  need(
    merge === null ||
      (isDict(merge) &&
        pyEquals(get(merge, "commit"), item(m, "head")) &&
        ["k", "n"].every((k) => {
          const v = Object.hasOwn(merge, k) ? merge[k] : 0;
          return isInt(v) && BigInt(v) >= 0n;
        }) &&
        typeof (Object.hasOwn(merge, "src") ? merge.src : false) === "boolean" &&
        (REACHED[outcome] ?? []).every((k) => Object.hasOwn(merge, k))),
    `manifest.json: merge isn't the head's merge commit with the counts and src its outcome had reached, ${pyRepr(merge)}`,
  );
  const merged: [string, Json][] = merge === null ? [] : [["merge", merge]];
  if (UNRUN.includes(outcome))
    return dict([["repo", repo], ["number", number], ["head", item(m, "head")], ["outcome", outcome], ["detail", get(m, "detail")], ...merged]);
  const base = isDict(get(m, "base")) ? (get(m, "base") as Dict) : {};
  need(fullSha(get(base, "sha")), `manifest.json: base.sha isn't a full commit sha, ${pyRepr(get(base, "sha"))}`);
  need(isStr(get(base, "ref")) && oneLine(base.ref), `manifest.json: base.ref isn't a branch name, ${pyRepr(get(base, "ref"))}`);
  const host = isDict(get(m, "host")) ? (get(m, "host") as Dict) : {};
  need(fullSha(get(host, "sha")), `manifest.json: host.sha isn't a full commit sha, ${pyRepr(get(host, "sha"))}`);
  const harness = isDict(get(m, "harness")) ? (get(m, "harness") as Dict) : {};
  need(pyEquals(get(harness, "repo"), HARNESS), `manifest.json: harness.repo is ${pyRepr(get(harness, "repo"))}, not ${HARNESS}`);
  need(fullSha(get(harness, "sha")), `manifest.json: harness.sha isn't a full commit sha, ${pyRepr(get(harness, "sha"))}`);
  need(among(get(m, "form"), FORMS), `manifest.json: a form the view doesn't know, ${pyRepr(get(m, "form"))}`);
  const detail = isDict(get(m, "detail")) ? (get(m, "detail") as Dict) : {};
  if (Object.hasOwn(ARMS, outcome)) need(keyed(ARMS[outcome]!, get(detail, "arm")), `manifest.json: an arm the ${outcome} doesn't name, ${pyRepr(get(detail, "arm"))}`);
  need(outcome !== "ran" || truthy(get(m, "shares")), "manifest.json: a run with no shares");
  const d = m as Dict;
  if (Object.hasOwn(d, "stack")) {
    const stack = d.stack!;
    need(
      pyEquals(d.form, "overlay") && isDict(stack) && sameKeys(stack, ["base", "head"]) && entries(stack).every(([, side]) => isDict(side)),
      "manifest.json: stack is a base and a head of chosen releases, for an overlay",
    );
    for (const [side, chosen] of entries(stack as Dict))
      for (const [name, c] of entries(chosen as Dict)) {
        const missed = isDict(c) ? (Object.hasOwn(c, "missed") ? c.missed! : dict([["package", ""], ["range", ""], ["wantedBy", null], ["has", null]])) : null;
        need(
          isDict(c) &&
            isStr(get(c, "version")) &&
            isStr(get(c, "host")) &&
            isStr(Object.hasOwn(c, "asks") ? c.asks : "") &&
            isList(get(c, "ranges")) &&
            (c.ranges as Json[]).every(asked) &&
            asked(missed) &&
            isStr(get(missed, "package")) &&
            ((Object.hasOwn(missed as Dict, "has") ? (missed as Dict).has : "") === null || isStr(get(missed, "has"))),
          `manifest.json: stack's ${side} ${name} isn't a chosen release, ${pyRepr(c)}`,
        );
      }
  }
  if (Object.hasOwn(d, "forced")) {
    const forced = d.forced!;
    need(
      pyEquals(d.form, "overlay") && isDict(forced) && sameKeys(forced, ["base", "head"]) && entries(forced).every(([, side]) => isList(side)) && entries(forced).some(([, side]) => truthy(side)),
      "manifest.json: forced is a base and a head of forced ranges, one at least, for an overlay",
    );
    for (const [side, ranges] of entries(forced as Dict)) {
      for (const f of ranges as Json[])
        need(
          asked(f) && isStr(item(f, "wantedBy")) && (CHOSEN.test(item(f, "wantedBy") as string) || LOCKFILE_KEY.test(item(f, "wantedBy") as string)) && isStr(get(f, "has")),
          `manifest.json: forced's ${side} holds one that isn't a forced range, ${pyRepr(f)}`,
        );
      need(new Set((ranges as Dict[]).map((f) => item(f, "has") as string)).size <= 1, `manifest.json: forced's ${side} runs more than one version of the package, ${pyRepr(ranges)}`);
    }
  }
  return dict([
    ["repo", repo],
    ["number", number],
    ["head", item(m, "head")],
    ["base", item(item(m, "base"), "sha")],
    ["baseRef", base.ref!],
    ["form", d.form!],
    ["host", item(item(m, "host"), "sha")],
    ["harness", dict([["repo", HARNESS], ["sha", harness.sha!]])],
    ["outcome", outcome],
    ["detail", get(m, "detail")],
    ["jobs", pyLen(truthy(get(m, "shares")) ? get(m, "shares") : [])],
    ...(Object.hasOwn(d, "stack") ? [["stack", d.stack!] as const] : []),
    ...(Object.hasOwn(d, "forced") ? [["forced", d.forced!] as const] : []),
    ...merged,
  ]);
}

const sameKeys = (v: Dict, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

function asked(r: Json): boolean {
  return isDict(r) && isStr(get(r, "range")) && Object.hasOwn(r, "wantedBy") && (r.wantedBy === null || isStr(r.wantedBy));
}

function answered(d: string, view: Dict): { path: string; changed: boolean } {
  const path = join(d, "view.json");
  seams.writeJson(path, view);
  return { path, changed: pyEquals(view.outcome, "ran") && truthy(item(view, "entries")) };
}

export async function viewed(repo: string): Promise<[string, number | bigint, number | bigint]> {
  const [token, , appId] = await appToken(repo);
  const repoId = item(await api("GET", `/repos/${repo}`, { token }), "id");
  refuse(keyIn(VIEWED, repoId), `${repo} isn't one of the context view's repositories`);
  return [token, appId, repoId as number | bigint];
}

function parsed(d: string, path: string): Json {
  try {
    return readJson(path) as Json;
  } catch (e) {
    if (e instanceof JSONDecodeError || e instanceof UnicodeDecodeError) throw new Failed(`${relpath(path, d)} isn't JSON: ${e.message}`);
    throw e;
  }
}

// posixpath.relpath, for the path a refusal names.
function relpath(path: string, start: string): string {
  const parts = (p: string) => normpath(p.startsWith("/") ? p : join(process.cwd(), p)).split("/").filter((x) => x);
  const [to, from] = [parts(path), parts(start)];
  let i = 0;
  while (i < Math.min(to.length, from.length) && to[i] === from[i]) i++;
  const rel = [...Array(from.length - i).fill(".."), ...to.slice(i)];
  return rel.length ? rel.join("/") : ".";
}


function arms(d: string, m: Dict, pack: string | null): Dict {
  const results = new Map<string, Dict>();
  let order: Json[] | null = null;
  let [before, after]: [Dict | null, Dict | null] = [null, null];
  const merged = new Map<string, Map<string, Json>>();
  const based = new Map<string, Dict>();
  for (const share of iter(item(m, "shares"))) {
    const shareDir = item(share, "dir");
    const dir = pyStr(shareDir);
    if (!isStr(shareDir)) throw new TypeError(`join() argument must be str, bytes, or os.PathLike object, not '${typeName(shareDir)}'`);
    const paths = ["after", "before"].map((arm) => join(shareDir, arm, "run.json")).map((p) => join(d, p));
    need(paths.every((p) => existsSync(p)), `${dir}: an arm wrote no run.json, though the run's outcome is ran`);
    const [head, base] = paths.map((p) => parsed(d, p)) as [Dict, Dict];
    need(order === null || pyEquals(item(head, "runs"), order), `${dir}: its run.json orders the runs differently`);
    order = item(head, "runs") as Json[];
    const versions: [Dict, Dict] = [item(item(base, "candidate"), "versions") as Dict, item(item(head, "candidate"), "versions") as Dict];
    need(before === null || pyEquals(versions, [before, after]), `${dir}: its arms' versions differ from another share's`);
    [before, after] = versions;
    const ownBase = new Map<string, Dict>();
    for (const r of iter(truthy(get(base, "results")) ? base.results! : [])) {
      need(isDict(r) && isStr(get(r, "run")), `${dir}: the base arm's results hold one that isn't a run's result`);
      need(!ownBase.has(hashKey(r.run!)), `run ${r.run as string} is twice in ${dir}'s base arm`);
      pauseOf(r, "base");
      ownBase.set(hashKey(r.run!), r);
    }
    for (const r of iter(item(head, "results")) as Dict[]) {
      const run = hashKey(item(r, "run"));
      need(!results.has(run), `run ${pyStr(r.run)} is in two shares`);
      need(broken(r) !== null || (Object.hasOwn(r, "flags") && Object.hasOwn(r, "counts")), `${dir}: ${pyStr(r.run)}'s result has no flags or counts to compare`);
      for (const key of ["absent", "baseAbsent"]) stretches(r, key);
      pauseOf(r, "head");
      results.set(run, r);
      if (ownBase.has(run)) based.set(run, ownBase.get(run)!);
    }
    const entriesPath = join(d, join(shareDir, "after", ENTRIES));
    need(existsSync(entriesPath), `${dir}: the head arm wrote no ${ENTRIES}`);
    const own = new Set(iter(item(head, "results")).map((r) => hashKey(item(r, "run"), "set element")));
    for (const e of iter(parsed(d, entriesPath)) as Dict[]) {
      const id = pyStr(get(e, "id"));
      need(isList(get(e, "places")) && (e.places as Json[]).every(isDict), `${dir}: entry ${id}'s places aren't a list of places`);
      const places = e.places as Dict[];
      need(places.every((p) => own.has(hashKey(get(p, "run"), "set element"))), `${dir}: entry ${id} has a place in a run outside its share's results`);
      need(
        isList(get(e, "examples")) &&
          (e.examples as Json[]).every(isDict) &&
          sameSorted(
            (e.examples as Dict[]).map((x) => pyStr(get(x, "run"))),
            [...new Set((truthy(get(e, "places")) ? places : []).map((p) => pyStr(get(p, "run"))))],
          ),
        `${dir}: entry ${id}'s examples aren't one per run it occurs in`,
      );
      const firsts = new Map<string, Json>();
      for (const p of places) {
        const run = hashKey(item(p, "run"));
        if (!firsts.has(run)) firsts.set(run, get(p, "step"));
      }
      need(
        (e.examples as Dict[]).every((x) => {
          const run = hashKey(item(x, "run"));
          if (!firsts.has(run)) missingKey(x.run!);
          return pyEquals(get(x, "step"), firsts.get(run));
        }),
        `${dir}: entry ${id} has an example that isn't at its run's first place`,
      );
      const key = hashKey(item(e, "id"));
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, new Map([...entries(e), ["places", [...places]], ["runs", [...iter(item(e, "runs"))]], ["examples", [...(e.examples as Json[])]]]));
        continue;
      }
      const was = (k: string) => (held.has(k) ? held.get(k)! : missingKey(k));
      held.set("places", plus(was("places"), places.filter((p) => !among(p, held.get("places") as Json[])), "+="));
      held.set("runs", plus(was("runs"), iter(item(e, "runs")).filter((r) => !among(r, held.get("runs") as Json[])), "+="));
      held.set("examples", plus(was("examples"), item(e, "examples"), "+="));
      held.set("count", plus(was("count"), item(e, "count"), "+="));
    }
  }
  need(truthy(order) && new Set(iter(order as Json).map((v) => hashKey(v, "set element"))).size === pyLen(order as Json), "run.json's runs are empty or name a run twice");
  const runs = iter(order as Json);
  need(sameSet(new Set(results.keys()), new Set(runs.map((v) => hashKey(v, "set element")))), "the shares' results aren't every run once");
  for (const e of merged.values()) {
    sortBy(e.get("places") as Dict[], (p) => rank(order as Json, p)[0], (x, y) => x - y);
    sortBy(e.get("runs") as Json[], method(order as Json), (x, y) => x - y);
    sortBy(e.get("examples") as Dict[], (x) => method(order as Json)(item(x, "run")), (x, y) => x - y);
  }
  const [b, a] = [before as unknown as Dict, after as unknown as Dict];
  if (!isDict(a)) throw raised("AttributeError", `'${typeName(a)}' object has no attribute 'items'`);
  const held = new Map<string, string>();
  for (const [name, v] of entries(a))
    if (v !== null && pyEquals(get(b, name), v) && name.startsWith("@animalabs/") && name !== "@animalabs/connectome-host") held.set(name, firstWord(v));
  const differing: Dict[] = [];
  if (pyEquals(item(m, "form"), "overlay")) {
    const stack = (truthy(get(m, "stack")) ? m.stack : { base: {}, head: {} }) as Record<string, Dict>;
    const armsOf: Record<string, Dict> = { base: b, head: a };
    for (const [side, other] of [["base", "head"], ["head", "base"]] as const)
      for (const [name, c] of entries(item(stack, side) as Dict)) {
        need(
          firstWord(truthy(get(armsOf[side], name)) ? get(armsOf[side], name) : "") === item(c, "version"),
          `the ${side} arm ran ${name} ${pyRepr(get(armsOf[side], name))}, not the ${pyStr(item(c, "version"))} the plan chose`,
        );
        need(
          Object.hasOwn(item(stack, other) as Dict, name) || firstWord(truthy(get(armsOf[other], name)) ? get(armsOf[other], name) : "") === item(c, "host"),
          `the ${other} arm ran ${name} ${pyRepr(get(armsOf[other], name))}, not the lockfile's ${pyStr(item(c, "host"))}, though the plan chose ${name} for the ${side} alone`,
        );
      }
    for (const name of [...new Set([...entries(b).map(([k]) => k), ...entries(a).map(([k]) => k)])].sort(cpCompare))
      if (name.startsWith("@animalabs/") && name !== "@animalabs/connectome-host" && name !== pack && !pyEquals(get(b, name), get(a, name))) {
        need(
          Object.hasOwn(item(stack, "base") as Dict, name) || Object.hasOwn(item(stack, "head") as Dict, name),
          `the arms ran different ${name}, ${pyRepr(get(b, name))} in the base and ${pyRepr(get(a, name))} in the head, which the plan didn't choose`,
        );
        const [bv, hv] = [firstWord(item(b, name)), firstWord(item(a, name))];
        need(bv !== hv, `the arms ran ${name} ${bv} with different contents, ${pyRepr(b[name])} in the base and ${pyRepr(a[name])} in the head`);
        differing.push(dict([["package", split(name, "/", 1)[1]!], ["base", bv], ["head", hv]]));
      }
  }
  const ran = runs.map((r) => results.get(hashKey(r)) ?? missingKey(r));
  const comparable = ran.filter((r) => broken(r) === null);
  const placed = new Set([...merged.values()].flatMap((e) => (e.get("places") as Dict[]).map((p) => hashKey(item(p, "run"), "set element"))));
  for (const r of comparable) {
    const isPlaced = placed.has(hashKey(item(r, "run"), "set element"));
    need(pyEquals(item(r, "record"), isPlaced ? "differs" : "same"), `run ${pyStr(r.run)}: its record says ${pyRepr(item(r, "record"))}, but the entries have ${isPlaced ? "places" : "no place"} in it`);
  }
  for (const r of comparable) {
    const f = item(r, "flags");
    for (const flag of plus(plus(item(f, "new"), item(f, "gone")), truthy(get(f, "kept")) ? get(f, "kept") : []) as Json[]) {
      const check = get(flag, "check");
      need(isInt(check) && BigInt(check) >= 1n, `${pyStr(r.run)}: a flag's check isn't a whole number of 1 or more, ${pyRepr(check)}`);
    }
  }
  const kept = new Set(comparable.map((r) => hashKey(item(r, "run"), "set element")));
  const shown: [Dict, Dict, Json][] = [];
  for (const e of merged.values()) {
    const places = (e.get("places") as Dict[]).filter((p) => kept.has(hashKey(item(p, "run"), "set element")));
    if (places.length) {
      const x = (e.get("examples") as Dict[]).find((x) => kept.has(hashKey(item(x, "run"), "set element")));
      if (x === undefined) throw raised("StopIteration", "");
      const fields = new Map([...e].filter(([k]) => k !== "examples"));
      fields.set("places", places);
      fields.set("runs", iter(e.get("runs")!).filter((r) => kept.has(hashKey(r, "set element"))));
      fields.set("count", places.length);
      fields.set("example", { place: { run: item(x, "run"), step: item(x, "step") }, before: item(x, "before"), after: item(x, "after") });
      shown.push([dict(fields), places[0]!, e.get("id")!]);
    }
  }
  sortBy(shown, ([, first, id]) => [rank(order as Json, first), id] as const, ([ra, ia], [rb, ib]) => compareTuples(ra, rb) || compare(ia, ib));
  let usage: RunUsage[] = [];
  const paused = ran
    .filter((r) => broken(r) !== null || pyEquals(item(r, "record"), "differs"))
    .flatMap((r) => {
      const own = based.get(hashKey(item(r, "run")));
      const [base, head] = [own ? pauseOf(own, "base") : null, pauseOf(r, "head")];
      return base || head ? [dict([["run", item(r, "run")], ...(base ? [["base", base] as const] : []), ...(head ? [["head", head] as const] : [])])] : [];
    });
  return dict([
    ["held", dict([...held].sort(([x], [y]) => cpCompare(x, y)).map(([name, v]) => [split(name, "/", 1)[1] ?? indexError(), v] as const))],
    ...(differing.length ? [["differing", differing] as const] : []),
    ["runs", dict([["total", ran.length], ["compared", comparable.length]])],
    ["order", order],
    [
      "broken",
      ran
        .filter((r) => broken(r) !== null)
        .map((r) => {
          const what = broken(r)!;
          return dict([
            ["run", item(r, "run")],
            ["what", what],
            ["reason", whyNot(r)],
            ...(what === "read" || Object.values(reads(r)).some((x) => x.length) ? [["reads", dict(Object.entries(reads(r)))] as const] : []),
            ...(what === "unmeasured" ? [["unmeasured", dict(Object.entries(unmeasured(r)))] as const] : []),
            ...(unreadable(r) ? [["unreadable", true] as const] : []),
          ]);
        }),
    ],
    [
      "flags",
      comparable
        .filter((r) => truthy(item(item(r, "flags"), "new")) || truthy(item(item(r, "flags"), "gone")))
        .map((r) => dict([["run", item(r, "run")], ["new", item(item(r, "flags"), "new")], ["gone", item(item(r, "flags"), "gone")]])),
    ],
    ["reached", reached(comparable)],
    ["entries", shown.map(([e]) => e)],
    [
      "usage",
      (usage = comparable
        .filter((r) => Object.hasOwn(r, "usage") && Object.hasOwn(based.get(hashKey(item(r, "run"))) ?? {}, "usage"))
        .map((r) => dict([["run", r.run!], ["base", usageRead(based.get(hashKey(item(r, "run")))!, "base")], ["head", usageRead(r, "head")]]) as unknown as RunUsage)),
    ],
    ["upgrades", upgradesOf(runs as string[], usage, results)],
    [
      "absent",
      comparable
        .filter((r) => truthy(get(r, "absent")) || truthy(get(r, "baseAbsent")))
        .map((r) => dict([["run", item(r, "run")], ["head", stretches(r, "absent")], ["base", stretches(r, "baseAbsent")]])),
    ],
    ...(paused.length ? [["paused", paused] as const] : []),
  ]);
}

const firstWord = (v: Json): string => split(v as string, " ")[0]!;
const missingKey = (key: Json): never => {
  throw raised("KeyError", pyRepr(key));
};
// A value as a Python set or dict key holds it: an int, its float and its bool alike, and a list or dict unhashable.
const hashKey = (v: Json, as: "dict key" | "set element" = "dict key"): string => {
  if (isList(v) || isDict(v)) throw new TypeError(`cannot use '${typeName(v)}' as a ${as} (unhashable type: '${typeName(v)}')`);
  if (typeof v === "boolean") return `i:${Number(v)}`;
  if (typeof v === "bigint") return `i:${v}`;
  if (typeof v === "number") return Number.isInteger(v) ? `i:${BigInt(v)}` : `f:${v}`;
  return v === null ? "null" : `s:${v}`;
};

const keyed = (d: object, key: Json): boolean => {
  hashKey(key);
  return isStr(key) && Object.hasOwn(d, key);
};

const pyLen = (v: Json): number => (isList(v) ? v.length : isStr(v) ? cpLength(v) : isDict(v) ? entries(v).length : (() => { throw new TypeError(`object of type '${typeName(v)}' has no len()`); })());

// list.sort(key=...) works out every key first, so a key that raises does so even for a list of one, which a comparator doesn't.
function sortBy<T, K>(items: T[], key: (x: T) => K, cmp: (a: K, b: K) => number): void {
  const keys = items.map((x) => [key(x), x] as const);
  keys.sort((a, b) => cmp(a[0], b[0]));
  keys.forEach(([, x], i) => (items[i] = x));
}
const sameSet = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((k) => y.has(k));
const sameSorted = (a: string[], b: string[]) => {
  const [x, y] = [[...a].sort(cpCompare), [...b].sort(cpCompare)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function flagKinds(r: Dict, side: "base" | "head"): [Json, string, string][] {
  const f = item(r, "flags");
  const flags = plus(truthy(get(f, "kept")) ? get(f, "kept") : [], item(f, side === "head" ? "new" : "gone")) as Dict[];
  const kinds = new Map<string, [Json, string, string]>();
  for (const x of flags) {
    const step = pyStr(truthy(get(x, "step")) ? get(x, "step") : "");
    if (step.startsWith("p.") || pyEquals(get(x, "step"), "prefix")) continue;
    const k: [Json, string, string] = [item(x, "check"), pyStr(truthy(get(x, "what")) ? get(x, "what") : ""), truthy(get(x, "what")) ? "" : step];
    kinds.set(JSON.stringify([hashKey(k[0], "set element"), k[1], k[2]]), k);
  }
  return [...kinds.values()].sort((a, b) => compareTuples(a, b));
}

function upgradesOf(order: readonly string[], usage: readonly RunUsage[], results: ReadonlyMap<string, Dict>): Dict[] {
  const by = new Map(usage.map((u) => [u.run, u] as const));
  const out: Dict[] = [];
  for (const run of order) {
    const parts = split(run, "/");
    const twin = [...parts.slice(0, 2), "fresh"].join("/");
    if (parts.length !== 3 || !parts[2]!.startsWith("from-") || !by.has(run) || !by.has(twin)) continue;
    const end = (who: string, side: "base" | "head") =>
      dict([["calibration", by.get(who)![side].calibration], ["lastDropped", by.get(who)![side].lastDropped], ["flags", flagKinds(results.get(hashKey(who)) ?? missingKey(who), side)]]);
    out.push(
      dict([
        ["run", run],
        ["twin", twin],
        ["release", `v${cpSlice(parts[2]!, cpLength("from-"))}`],
        ...(["base", "head"] as const).map((side) => [side, dict([["run", end(run, side)], ["twin", end(twin, side)]])] as const),
      ]),
    );
  }
  return out;
}

function stretches(r: Dict, key: string): Json[] {
  const names = Object.hasOwn(r, key) ? r[key]! : [];
  need(isList(names) && names.every(isStr), `${pyStr(item(r, "run"))}: its ${key} isn't a list of names, ${pyRepr(names)}`);
  return names;
}

function pauseOf(r: Dict, arm: "base" | "head"): Dict | null {
  if (!Object.hasOwn(r, "paused")) return null;
  const p = r.paused!;
  const whole = isDict(p) && Object.hasOwn(p, "step") && (p.step === null || isStr(p.step)) && isInt(p.ms) && BigInt(p.ms) >= 1n;
  need(whole, `${pyStr(item(r, "run"))}: the ${arm} arm's paused isn't a step and a whole number of milliseconds, ${pyRepr(p)}`);
  return dict([["step", (p as Dict).step], ["ms", (p as Dict).ms]]);
}

type Broken = "outcome" | "head" | "base" | "unmeasured" | "read" | "unchecked" | "varies" | "drive";

function broken(r: Dict): Broken | null {
  if (!among(item(r, "outcome"), RESULTS)) return "outcome";
  if (pyEquals(r.outcome, "couldnt-run") || item(r, "record") === null) return "head";
  if (pyEquals(r.record, "missing")) return "base";
  if (truthy(get(r, "unmeasured")) || truthy(get(r, "baseUnmeasured"))) return "unmeasured";
  if (truthy(get(r, "readsFailed")) || truthy(get(r, "baseReadsFailed"))) return "read";
  if (unreadable(r)) return "read";
  if (!Object.hasOwn(r, "selfCheck")) return "unchecked";
  const check = isDict(r.selfCheck) ? get(r.selfCheck, "outcome") : null;
  need(among(check, CHECKS), `${pyStr(item(r, "run"))}: a self-check the view doesn't know, ${pyRepr(r.selfCheck)}`);
  return pyEquals(check, "same") ? null : pyEquals(check, "differs") ? "varies" : "drive";
}

function unreadable(r: Dict): boolean {
  const q = get(truthy(get(r, "counts")) ? get(r, "counts") : {}, "quarantines");
  return isDict(q) && among("unreadable", entries(q).map(([, v]) => v));
}

function whyNot(r: Dict): string {
  const said = (v: Json) => pyStr(truthy(v) ? v : "");
  switch (broken(r)) {
    case "varies":
      return said(get(r.selfCheck, "detail"));
    case "drive":
      return said(get(r.selfCheck, "reason"));
    case "base":
      return said(get(r, "baseReason"));
    case "outcome":
      return pyStr(r.outcome);
    case "unmeasured":
      return failedReasons(r);
    default:
      return said(get(r, "reason"));
  }
}

const FAILED = "the run failed: ";

function failedReasons(r: Dict): string {
  const sides = { head: ["new", "kept"], base: ["gone", "kept"] } as const;
  const named = unmeasured(r);
  const said = new Map<string, [string, Json]>();
  for (const [side, pools] of Object.entries(sides) as ["head" | "base", readonly string[]][]) {
    if (!named[side].includes("the run failed")) continue;
    const flags = truthy(get(r, "flags")) ? get(r, "flags") : {};
    find: for (const pool of pools)
      for (const f of iter(truthy(get(flags, pool)) ? get(flags, pool) : [])) {
        if (pyEquals(get(f, "check"), 1) && pyEquals(get(f, "step"), "the run") && pyStr(truthy(get(f, "detail")) ? get(f, "detail") : "").startsWith(FAILED)) {
          said.set(side, [cpSlice(pyStr(item(f, "detail")), cpLength(FAILED)), get(f, "whole")]);
          break find;
        }
      }
  }
  const shown = ([why, whole]: [string, Json]) => (truthy(whole) ? `${why} (cut by the harness)` : why);
  if (said.size === 2 && pyEquals(said.get("head"), said.get("base"))) return `both arms' runs failed: ${shown(said.get("head")!)}`;
  return [...said].map(([side, reason]) => `the ${side}'s run failed: ${shown(reason)}`).join("; ");
}

function reads(r: Dict): { head: string[]; base: string[] } {
  const named = (k: string) => (truthy(get(r, k)) ? iter(get(r, k)) : []).map(pyStr);
  return { head: named("readsFailed"), base: named("baseReadsFailed") };
}

function unmeasured(r: Dict): { head: string[]; base: string[] } {
  const named = (k: string) => (truthy(get(r, k)) ? iter(get(r, k)) : []).map(pyStr);
  return { head: named("unmeasured"), base: named("baseUnmeasured") };
}

function rank(order: Json, place: Dict): [number, [number, number | bigint, string][]] {
  const step = pyStr(item(place, "step"))
    .split(/(\p{Nd}+)/u)
    .filter((part) => part)
    .map((part): [number, number | bigint, string] => (/^\p{Nd}+$/u.test(part) ? [0, digitsValue(part), ""] : [1, 0, part]));
  return [method(order)(item(place, "run")), step];
}

function reached(results: readonly Dict[]): Dict {
  let [runs, requests] = [0, 0n];
  const out = { compressions: [0n, 0], merges: [0n, 0] } as Record<string, [bigint, number]>;
  const q = { compression: 0n, merge: 0n, runs: 0, "not-reported": 0, uncounted: 0 };
  for (const r of results) {
    const c = item(r, "counts");
    for (const kind of ["compiles", "compressions", "merges"]) need(isCount(get(c, kind)), `${pyStr(item(r, "run"))}: its ${kind.slice(0, -1)} count isn't a whole number of 0 or more, ${pyRepr(get(c, kind))}`);
    runs += 1;
    requests += BigInt(item(c, "compiles") as number | bigint);
    for (const kind of ["compressions", "merges"]) {
      const n = BigInt(item(c, kind) as number | bigint);
      out[kind]![0] += n;
      out[kind]![1] += n ? 1 : 0;
    }
    const quarantines = item(c, "quarantines");
    need(
      among(quarantines, ["not-reported", null]) || (isDict(quarantines) && ["compression", "merge"].every((k) => isCount(get(quarantines, k)))),
      `${pyStr(item(r, "run"))}: a quarantine count the view doesn't know, ${pyRepr(quarantines)}`,
    );
    if (!isDict(quarantines)) {
      q[pyEquals(quarantines, "not-reported") ? "not-reported" : "uncounted"] += 1;
      continue;
    }
    const [comp, merge] = [BigInt(quarantines.compression as number | bigint), BigInt(quarantines.merge as number | bigint)];
    q.compression += comp;
    q.merge += merge;
    q.runs += comp || merge ? 1 : 0;
  }
  const n = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  return dict([
    ["runs", runs],
    ["requests", n(requests)],
    ["compressions", [n(out.compressions![0]), out.compressions![1]]],
    ["merges", [n(out.merges![0]), out.merges![1]]],
    ["quarantines", dict([["compression", n(q.compression)], ["merge", n(q.merge)], ["runs", q.runs], ["not-reported", q["not-reported"]], ["uncounted", q.uncounted]])],
  ]);
}

// A package-lock.json key below its root: a node_modules path, nested or under a workspace, or a workspace's own path.
const NODE = `node_modules/(?:@[^/@${SPACE}]+/)?[^/@${SPACE}]+`;
const WORKSPACE = `[^/@${SPACE}]+(?:/[^/@${SPACE}]+)*`;
const LOCKFILE_KEY = new RegExp(`^(?:(?:${WORKSPACE}/)?${NODE}(?:/${NODE})*|${WORKSPACE})$`, "u");

const REACH = "reach.json";
export const HOLDS: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  read: [
    ["ran", "notRan", "couldntTell", "noCode"],
    ["reached", "not-reached", "couldnt-tell", "no-code"],
  ],
  "not-loaded": [
    ["notRan", "noCode", "unloaded"],
    ["not-reached", "no-code", "unloaded"],
  ],
  "couldnt-tell": [
    ["couldntTell", "noCode", "unloaded"],
    ["couldnt-tell", "no-code", "unloaded"],
  ],
};
export const LISTS = ["ran", "notRan", "couldntTell", "noCode", "unloaded"] as const;

function reachOf(d: string): Dict {
  const path = join(d, REACH);
  need(existsSync(path), `the run wrote no ${REACH}, though its outcome is ran`);
  const r = parsed(d, path);
  need(isDict(r), `${REACH} isn't an object`);
  if (Object.hasOwn(r, "couldnt")) {
    need(isStr(r.couldnt) && oneLine(r.couldnt), `${REACH}: couldnt isn't a line of text`);
    return dict([["couldnt", r.couldnt]]);
  }
  const [files, notes] = [get(r, "files"), get(r, "notes")];
  need(isDict(files), `${REACH}: files isn't an object`);
  need(isList(notes) && notes.every((n) => isStr(n) && oneLine(n)) && new Set(notes).size === notes.length, `${REACH}: notes aren't distinct lines of text`);
  const out: [string, Json][] = [];
  for (const [name, f] of entries(files).sort(([x], [y]) => cpCompare(x, y))) {
    need(name.startsWith("src/") && oneLine(name) === name, `${REACH}: ${pyRepr(name)} isn't a path under src/`);
    need(isDict(f) && keyed(HOLDS, get(f, "state")), `${REACH}: ${name}'s state isn't one reach knows, ${pyRepr(isDict(f) ? get(f, "state") : f)}`);
    const state = (f as Dict).state as string;
    const [lists, states] = HOLDS[state]!;
    const seen: Json[] = [];
    for (const k of LISTS) {
      const v = get(f, k);
      need(isList(v) && v.every((n) => isInt(n) && BigInt(n) >= 1n), `${REACH}: ${name}'s ${k} isn't a list of line numbers`);
      need(!v.length || lists.includes(k), `${REACH}: ${name}, a ${state} file, has ${k} lines`);
      for (const x of v) seen.push(x);
    }
    need(new Set(seen.map((v) => hashKey(v, "set element"))).size === seen.length, `${REACH}: ${name} has a line in two lists`);
    const dels = get(f, "deletions");
    need(
      isList(dels) &&
        dels.every((x) => {
          if (!isDict(x) || !isInt(get(x, "after")) || BigInt(x.after as number | bigint) < 0n || !among(get(x, "state"), states)) return false;
          const by = get(x, "by");
          return among(x.state, ["no-code", "unloaded"]) ? by === null : (by === null && pyEquals(x.state, "couldnt-tell")) || (isInt(by) && BigInt(by) >= 1n);
        }) &&
        new Set(dels.map((x) => hashKey(item(x, "after"), "set element"))).size === dels.length,
      `${REACH}: ${name}'s deletions aren't each one a ${state} file can have`,
    );
    const binary = get(f, "binary") === true;
    need(!Object.hasOwn(f as Dict, "binary") || (binary && state === "couldnt-tell" && !seen.length && !(dels as Json[]).length), `${REACH}: ${name} is marked binary, and a binary file is a couldnt-tell one with no line or deletion`);
    need(seen.length || (dels as Json[]).length || binary, `${REACH}: ${name} has no changed line or deletion`);
    const told = state === "couldnt-tell" || truthy(item(f, "couldntTell")) || (dels as Dict[]).some((x) => pyEquals(x.state, "couldnt-tell"));
    need(
      told === Object.hasOwn(f as Dict, "reason") && (!Object.hasOwn(f as Dict, "reason") || (isStr((f as Dict).reason) && oneLine((f as Dict).reason))),
      `${REACH}: ${name} ${told ? "names no reason for what it couldn't tell" : "names a reason for nothing it couldn't tell"}`,
    );
    need(!told || beyond((f as Dict).reason as string, notes as string[]) !== null, `${REACH}: ${name}'s reason doesn't hold the notes once, as the harness joins them`);
    const ints = (v: Json) => [...(v as (number | bigint)[])].sort((x, y) => compare(x, y));
    out.push([
      name,
      dict([
        ["state", state],
        ...LISTS.map((k) => [k, ints(item(f, k))] as const),
        ["deletions", (dels as Dict[]).map((x) => dict([["after", x.after!], ["state", x.state!], ["by", get(x, "by")]])).sort((x, y) => compare(x.after, y.after))],
        ...(binary ? [["binary", true] as const] : []),
        ...(told ? [["reason", (f as Dict).reason!] as const] : []),
      ]),
    ]);
  }
  return dict([["files", dict(out)], ["notes", notes]]);
}

export function beyond(reason: string, notes: readonly string[]): string | null {
  if (!notes.length) return reason;
  const text = Array.from(reason);
  const run = Array.from(notes.join("; "));
  const at = (i: number) => run.every((c, j) => text[i + j] === c);
  const rfind = (bound: number) => {
    for (let i = bound - run.length; i >= 0; i--) if (at(i)) return i;
    return -1;
  };
  const sep = Array.from("; ");
  const endsWithSep = (until: number) => until >= sep.length && sep.every((c, j) => text[until - sep.length + j] === c);
  const startsWithSep = (from: number) => sep.every((c, j) => text[from + j] === c);
  const found: number[] = [];
  let bound = text.length;
  for (let i = rfind(bound); i >= 0; i = rfind(bound)) {
    const end = i + run.length;
    if ((i === 0 || endsWithSep(i)) && (end === text.length || startsWithSep(end))) found.push(i);
    bound = end - 1;
  }
  if (found.length !== 1) return null;
  const [start, end] = [found[0]!, found[0]! + run.length];
  const head = text.slice(0, start).join("");
  const tail = text.slice(end).join("");
  return [head.endsWith("; ") ? head.slice(0, -2) : head, tail.startsWith("; ") ? tail.slice(2) : tail].filter((x) => x).join("; ");
}
