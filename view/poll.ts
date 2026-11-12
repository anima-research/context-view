import { closeSync, mkdirSync, openSync, statSync } from "node:fs";

import {
  ACCOUNTS,
  app,
  appJwt,
  cpCompare,
  cpSlice,
  cursor,
  digitsValue,
  dumps,
  encode,
  ENDED,
  every,
  exists,
  expanduser,
  Failed,
  flockExclusive,
  fromisoformat,
  get,
  giveCursor,
  item,
  join,
  type Json,
  loads,
  need,
  now,
  ordered,
  osError,
  PER_PAGE,
  pyEquals,
  pyRepr,
  pyStr,
  quote,
  readJson,
  request,
  run,
  said,
  split,
  splitlines,
  splitWhitespace,
  strip,
  tokenOf,
  truthy,
  WRITE,
  writeJson,
} from "review-workflow/view";

import { refuseCheckout, traceback } from "./view.ts";
import { KEY, keyOf, VIEWED } from "./view_read.ts";
import { ASKERS, COMMAND } from "./view_words.ts";

export { ASKERS, COMMAND };

export type Place = { state: string; workflows: string };
export const PLACE: Place = { state: expanduser("~/.local/state/context-view"), workflows: expanduser("~/.local/bin/astra-workflows") };

export const REVIEWS = ["pr-review/open:", "pr-review/ask:"] as const;
export const RECORDS = ["workflow:context-view", "workflow:context-view-merged"] as const;
export const VIEW_KEY = /^context-view\/([1-9][0-9]*)#([1-9][0-9]*)@([0-9a-f]{40})(?::ask-[0-9]+|:review-[A-Za-z0-9-]+|:again-[1-9][0-9]*)?$/;
export const REVIEWED = /^pr-review\/(?:open|ask):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)(?:@[0-9a-f]{40}|:comment-[0-9]+)$/;
export const MERGE_KEY = /^context-view\/([1-9][0-9]*)#([1-9][0-9]*)@merged:([0-9a-f]{40})(?::again-[1-9][0-9]*)?$/;
export const SINCE = "2026-11-09T10:57:53Z";

type Dict = Record<string, Json>;
// Maps, since a JavaScript object puts integer-like keys in numeric order where the file's order has to hold.
type Repos = Map<string, Dict>;
type State = Dict & { tokens: Map<string, { token: string; expires: string }> };
type Run = Dict;
type Opened = { number: Json; head: string; draft: boolean; association: Json; repo: string; rid: number };

const say = (line: string): void => void process.stderr.write(encode(`${line}\n`, "backslashreplace"));
const orDict = (v: Json | undefined): Json => (truthy(v) ? v! : {});
const asDict = (v: Json): Dict => v as Dict;
const gt = (a: string, b: string): boolean => cpCompare(a, b) > 0;
const typeName = (v: unknown): string =>
  v === null || v === undefined
    ? "NoneType"
    : typeof v === "boolean"
      ? "bool"
      : typeof v === "string"
        ? "str"
        : typeof v === "bigint" || Number.isInteger(v)
          ? "int"
          : typeof v === "number"
            ? "float"
            : Array.isArray(v)
              ? "list"
              : "dict";
const fault = (name: string, words: string): never => {
  throw Object.assign(new Error(words), { name });
};
const matchable = (v: Json): string => (typeof v === "string" ? v : fault("TypeError", `expected string or bytes-like object, got '${typeName(v)}'`));
const hashable = (v: Json, as: string): Json =>
  v !== null && typeof v === "object" ? fault("TypeError", `cannot use '${typeName(v)}' as a ${as} (unhashable type: '${typeName(v)}')`) : v;
const compared = (a: Json, op: string, b: Json): string =>
  typeof a === "string" && typeof b === "string" ? a : fault("TypeError", `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
const numeric = (v: Json): v is number | boolean => typeof v === "number" || typeof v === "boolean";
const byKeys = <T>(...keys: ((x: T) => Json)[]) => (a: T, b: T): number => {
  for (const k of keys) {
    const x = k(a);
    const y = k(b);
    if (pyEquals(x, y)) continue;
    if (typeof x === "string" && typeof y === "string") return cpCompare(x, y);
    if (numeric(x) && numeric(y)) return Number(x) - Number(y);
    compared(y, "<", x);
  }
  return 0;
};
const sortedTexts = (texts: Iterable<string>): string[] => [...texts].sort(cpCompare);
const str = (v: Json): string => pyStr(v);
const beforeLast = (text: string, sep: string): string => (text.includes(sep) ? text.slice(0, text.lastIndexOf(sep)) : text);
const beforeFirst = (text: string, sep: string): string => (text.includes(sep) ? text.slice(0, text.indexOf(sep)) : text);
// re.escape for a name inside a pattern: the characters JavaScript's patterns treat as syntax, which is all a unicode
// pattern lets one escape.
const escaped = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

export function statePath(place: Place): string {
  return join(place.state, "poll.json");
}

async function locked<T>(place: Place, keep: boolean, body: (state: State) => Promise<T>): Promise<T> {
  mkdirSync(place.state, { recursive: true });
  const lock = openSync(join(place.state, "poll.lock"), "a");
  try {
    await flockExclusive(lock);
    const path = statePath(place);
    const state = held(
      exists(path) ? (readJson(path) as Json) : { seq: 0, line: null, views_line: null, queue: {}, seen: [], repos: {}, tokens: {}, known: [], waiting: {} },
    );
    const out = await body(state);
    if (keep) writeJson(path, state);
    return out;
  } finally {
    closeSync(lock);
  }
}

function held(raw: Json): State {
  const state = raw as State;
  const asMap = (v: Json | undefined): Json | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) ? (new Map(ordered(v)) as unknown as Json) : v;
  for (const key of ["repos", "tokens"]) if (Object.hasOwn(state, key)) state[key] = asMap(state[key])!;
  for (const step of ["asks", "merges"]) {
    const part = state[step];
    if (part && typeof part === "object" && !Array.isArray(part) && Object.hasOwn(part, "repos")) asDict(part).repos = asMap(asDict(part).repos)!;
  }
  return state;
}

const repos = (part: Json): Repos => item(part, "repos") as unknown as Repos;
const setdefault = (map: Repos, key: string, made: () => Dict): Dict => {
  if (!map.has(key)) map.set(key, made());
  return map.get(key)!;
};
const setdefaultIn = (d: Dict, key: string, made: () => Json): Json => {
  if (!Object.hasOwn(d, key)) d[key] = made();
  return d[key]!;
};

async function heads(name: string, token: string, seen: Dict): Promise<Json[]> {
  const [pulls, tag] = await every(`/repos/${name}/pulls?state=open&per_page=${PER_PAGE}`, { token, tag: (get(seen, "pullsTag") as string | null) ?? null });
  if (pulls !== null) {
    seen.pulls = pulls.map((p) => ({
      number: item(p, "number"),
      head: headOf(name, item(p, "number"), item(item(p, "head"), "sha")),
      draft: truthy(get(p, "draft")),
      association: get(p, "author_association") ?? null,
    }));
    seen.pullsTag = tag;
  }
  return (get(seen, "pulls") ?? []) as Json[];
}

function listed(place: Place, selection: string[], what: string): Run[] {
  const p = run([place.workflows, "runs", ...selection]);
  need(p.code === 0, `astra-workflows runs couldn't list ${what}: ${cpSlice(strip(p.stderr || p.stdout), 0, 300)}`);
  return splitlines(p.stdout)
    .filter((l) => strip(l))
    .map((l) => loads(l) as Run);
}

function runs(place: Place): Run[] {
  return RECORDS.flatMap((record) =>
    listed(place, ["--record", record], "the views' runs").map((r) => (truthy(item(r, "house")) ? r : { ...r, key: "", session: item(r, "key") })),
  );
}

function shown(run: Run): string {
  const key = Object.hasOwn(run, "session") ? `a session's start under ${str(item(run, "session"))}` : str(item(run, "key"));
  return `${str(item(run, "run"))} (${str(item(run, "state"))}, ${key})`;
}

function reviews(place: Place): Run[] {
  return REVIEWS.flatMap((prefix) => listed(place, ["--key-prefix", prefix], "the reviews"));
}

export function reviewed(key: Json): [string, number] | null {
  const m = REVIEWED.exec(matchable(key));
  return m ? [m[1]!, Number(m[2])] : null;
}

export function viewDir(place: Place, repo: string, number: number, head: string): string {
  return join(place.state, "views", `${repo.replaceAll("/", ".")}.${number}.${head.slice(0, 12)}`);
}

export function mergeDir(place: Place, repo: string, number: number, commit: string): string {
  return join(place.state, "views", `merged.${repo.replaceAll("/", ".")}.${number}.${commit.slice(0, 12)}`);
}

export function mergeKey(repoId: Json, number: Json, commit: Json): string {
  return `${KEY}${str(repoId)}#${str(number)}@merged:${str(commit)}`;
}

export function instant(at: string): number {
  const t = fromisoformat(at.replaceAll("Z", "+00:00"));
  if (t.aware) return Number(t.us) / 1e6;
  const wall = new Date(Number(t.us / 1000n));
  const local = new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds());
  return local.getTime() / 1000 + Number(t.us % 1_000_000n) / 1e6;
}

function mtime(path: string): number {
  const ns = statSync(path, { bigint: true }).mtimeNs;
  return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) * 1e-9;
}

export function holds(place: Place, run: { readonly [k: string]: unknown }): boolean {
  if (ENDED.includes(item(run, "state") as string)) return false;
  const key = matchable(item(run, "key"));
  const view = VIEW_KEY.exec(key);
  const m = view ?? MERGE_KEY.exec(key);
  if (!m || !VIEWED.has(Number(m[1]))) return true;
  const named = view ? viewDir : mergeDir;
  let written: number;
  try {
    written = mtime(join(named(place, VIEWED.get(Number(m[1]))!, Number(m[2]), m[3]!), "manifest.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).errno === undefined) throw error;
    return true;
  }
  return written < instant(item(run, "createdAt") as string);
}

export function companionStopped(place: Place, repo: string, number: number, head: string): boolean {
  const path = join(viewDir(place, repo, number, head), "view.json");
  let why: string;
  try {
    return pyEquals(get(readJson(path) as Json, "outcome"), "needs-companion");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    why = error instanceof TypeError ? error.message : (error as NodeJS.ErrnoException).errno !== undefined ? osError(error, path).message : said(error);
  }
  say(`poll.ts: ${path} can't be read (${why}), so its head is viewed again at its next review`);
  return true;
}

const pullOf = (key: string): string => beforeLast(key, "@");
const repoOf = (key: string): string => beforeFirst(key.slice(KEY.length), "#");
export const headKey = (key: Json): string =>
  beforeFirst(typeof key === "string" ? key : fault("AttributeError", `'${typeName(key)}' object has no attribute 'split'`), ":");
const headOf = (name: string, number: Json, sha: Json): string => {
  need(typeof sha === "string", `${name}#${str(number)}'s head isn't text, ${pyRepr(sha)}, so it names no commit to view`);
  return sha as string;
};

function asksFirst(asks: Dict, opened: Map<string, Opened>, unsettled: Set<string>): Json[] {
  return ((truthy(get(asks, "queue")) ? get(asks, "queue") : []) as Json[]).filter((q) => {
    const p = opened.get(`${KEY}${str(item(q, "rid"))}#${str(item(q, "number"))}`);
    return p && !unsettled.has(keyOf(p.rid, p.number as number, p.head));
  });
}

const viewedRepo = (repo: Dict, looked: { has(k: string): boolean }): boolean =>
  VIEWED.has(hashable(item(repo, "id"), "dict key") as number) && !truthy(get(repo, "archived")) && !truthy(get(repo, "disabled")) && !looked.has(str(item(repo, "id")));

export async function look(place: Place, state: State, taken: number, _at: string): Promise<[string[], number]> {
  const queue = asDict(setdefaultIn(state, "queue", () => ({})));
  setdefaultIn(state, "views_line", () => null);
  state.seq = Math.max(item(state, "seq") as number, taken);
  let viewsLine = state.views_line as Dict | null;
  if (truthy(viewsLine) && (item(viewsLine, "seq") as number) <= taken) {
    if (Object.hasOwn(queue, pullOf(str(item(viewsLine, "key"))))) asDict(queue[pullOf(str(item(viewsLine, "key")))]!).taken = item(item(viewsLine, "args"), "head");
    state.views_line = null;
  }
  const cfg = app();
  const jwt = appJwt(cfg);
  const [installations] = await every(`/app/installations?per_page=${PER_PAGE}`, { bearer: jwt });
  const started = reviews(place);
  const opened = new Map<string, Opened>();
  const looked = new Set<string>();
  const names = new Map<string, number>();
  const known = repos(state);
  for (const inst of installations!) {
    if (!ACCOUNTS.has(hashable(item(item(inst, "account"), "id"), "dict key") as number)) continue;
    const token = await tokenOf(state, item(inst, "id"), jwt);
    const [listing] = await every(`/installation/repositories?per_page=${PER_PAGE}`, { token, field: "repositories" });
    for (const raw of listing!) {
      const repo = asDict(raw);
      if (!viewedRepo(repo, looked)) continue;
      const rid = item(repo, "id") as number;
      looked.add(str(rid));
      names.set(item(repo, "full_name") as string, rid);
      for (const p of await heads(item(repo, "full_name") as string, token, setdefault(known, str(rid), () => ({}))))
        opened.set(`${KEY}${rid}#${str(item(p, "number"))}`, { ...(p as Opened), repo: item(repo, "full_name") as string, rid });
    }
  }
  state.repos = new Map([...known].filter(([rid]) => looked.has(rid))) as unknown as Json;
  if (!Object.hasOwn(state, "reviews")) state.reviews = sortedTexts(new Set(started.map((r) => item(r, "key") as string)));
  const counted = new Set((item(state, "reviews") as Json[]).map((k) => k as string));
  const covered = new Set(VIEWED.values());
  for (const r of [...started].sort(byKeys<Run>((r) => item(r, "createdAt") as string, (r) => item(r, "key") as string))) {
    const found = reviewed(item(r, "key"));
    if (counted.has(item(r, "key") as string) || !found) continue;
    const [name, number] = found;
    if (!names.has(name) && covered.has(name)) continue;
    counted.add(item(r, "key") as string);
    if (!names.has(name)) continue;
    const entry = asDict(setdefaultIn(queue, `${KEY}${names.get(name)}#${number}`, () => ({ since: item(r, "createdAt") })));
    delete entry.taken;
    entry.review = item(r, "run");
  }
  const startedKeys = new Set(started.map((r) => item(r, "key") as string));
  state.reviews = sortedTexts([...counted].filter((k) => startedKeys.has(k)));
  const held_ = runs(place);
  const unsettled = new Set(held_.filter((r) => !ENDED.includes(item(r, "state") as string)).map((r) => headKey(item(r, "key") as string)));
  state.seen = sortedTexts(
    [...new Set([...((item(state, "seen") as Json[]) as string[]), ...held_.map((r) => headKey(item(r, "key") as string))])].filter(
      (k) => VIEW_KEY.test(k) && (opened.has(pullOf(k)) || !looked.has(repoOf(k))),
    ),
  );
  const waiting = new Map<string, Dict>();
  for (const pk of Object.keys(queue)) {
    const p = opened.get(pk);
    if (p === undefined) {
      if (looked.has(repoOf(pk))) delete queue[pk];
      continue;
    }
    const key = keyOf(p.rid, p.number as number, p.head);
    if (unsettled.has(key)) continue;
    if (pyEquals(get(queue[pk]!, "taken") ?? null, p.head)) delete queue[pk];
    else if (!(state.seen as string[]).includes(key)) {
      if (!p.draft) waiting.set(key, { repo: p.repo, number: p.number, head: p.head, auto: true });
    } else if (companionStopped(place, p.repo, p.number as number, p.head)) {
      if (!p.draft) waiting.set(`${key}:review-${str(item(queue[pk]!, "review"))}`, { repo: p.repo, number: p.number, head: p.head, auto: true });
    } else delete queue[pk];
  }
  state.views_waiting = waiting.size;
  viewsLine = state.views_line as Dict | null;
  if (truthy(viewsLine) && !waiting.has(item(viewsLine, "key") as string)) {
    if (!looked.has(repoOf(item(viewsLine, "key") as string)))
      say(
        `poll.ts: ${str(item(viewsLine, "key"))}'s line is dropped, since its repository isn't in this pass's listing; its pull ` +
          "request waits as it was when the repository is listed again",
      );
    state.views_line = null;
  } else if (truthy(viewsLine)) viewsLine!.args = waiting.get(item(viewsLine, "key") as string)!;
  const busy = sortedTexts(held_.filter((r) => holds(place, r)).map(shown));
  if (busy.length) {
    say(`poll.ts: waiting for the runners, held by ${busy.join(", ")}`);
    return [[], taken];
  }
  const asks = orDict(get(state, "asks")) as Dict;
  if (pending((get(asks, "line") ?? null) as Dict | null, held_)) {
    say(`poll.ts: waiting for the asks' line ${str(item(item(asks, "line"), "key"))} to start`);
    return [[], taken];
  }
  if (mergesPending(state, held_)) return [[], taken];
  if (state.views_line === null) {
    const first = asksFirst(asks, opened, unsettled);
    if (first.length) {
      say(
        `poll.ts: waiting for the asks' queue, which holds ${first.length} on a pull request this pass lists open ` +
          "with no unsettled view of its head, since an ask goes first",
      );
      return [[], taken];
    }
    if (!waiting.size) return [[], taken];
    const key = [...waiting.keys()].reduce((a, b) => {
      const since = (k: string) => item(queue[pullOf(k)]!, "since") as string;
      const c = cpCompare(since(b), since(a)) || cpCompare(b, a);
      return c < 0 ? b : a;
    });
    state.seq = (state.seq as number) + 1;
    state.views_line = { seq: state.seq, key, args: waiting.get(key)! };
  }
  const line = asDict(item(state, "views_line"));
  return [[dumps({ key: line.key, args: line.args }, { separators: [",", ":"] })], line.seq as number];
}

export function asked(body: Json | undefined): boolean {
  const text = truthy(body) ? body! : "";
  if (typeof text !== "string") fault("AttributeError", `'${typeName(text)}' object has no attribute 'strip'`);
  const words = splitWhitespace(beforeFirst(strip(text as string), "\n"));
  return words.length === 1 && words[0] === COMMAND;
}

async function asksIn(name: string, token: string, seen: Dict, appId: Json, at: string): Promise<Dict[]> {
  if (!Object.hasOwn(seen, "since")) {
    seen.since = at;
    seen.handled = [];
    return [];
  }
  const since = item(seen, "since") as string;
  const [comments, tag] = await every(`/repos/${name}/issues/comments?since=${quote(since)}&per_page=${PER_PAGE}`, {
    token,
    tag: (get(seen, "commentsTag") as string | null) ?? null,
  });
  if (comments === null) return [];
  const found: Dict[] = [];
  const handled = ((truthy(get(seen, "handled")) ? get(seen, "handled") : []) as Json[]).slice();
  const isHandled = (id: Json) => (hashable(id, "set element"), handled.some((h) => pyEquals(h, id)));
  const latest = comments.map((c) => item(c, "updated_at")).reduce<string>((a, b) => (gt(compared(b, ">", a), a) ? (b as string) : a), since);
  const pattern = new RegExp(`^https://github\\.com/${escaped(name)}/pull/(\\p{Nd}+)#issuecomment-\\p{Nd}+$`, "iu");
  for (const c of comments) {
    if (isHandled(item(c, "id")) && item(c, "updated_at") === since) continue;
    const url = get(c, "html_url");
    const number = pattern.exec(matchable(truthy(url) ? url : ""));
    const login = (get(orDict(get(c, "user")), "login") || "") as string;
    const made = truthy(get(c, "created_at")) ? get(c, "created_at") : "";
    if (
      !number ||
      !asked(get(c, "body")) ||
      pyEquals(get(orDict(get(c, "performed_via_github_app")), "id") ?? null, appId) ||
      !ASKERS.includes(login) ||
      !(gt(compared(made, ">", since), since) || (made === since && !isHandled(item(c, "id"))))
    )
      continue;
    const path = `/repos/${name}/collaborators/${quote(login)}/permission`;
    const [status, value] = await request("GET", path, { token });
    if (status === 200 && WRITE.includes(get(value, "permission") as string))
      found.push({ number: Number(digitsValue(number[1]!)), comment: item(c, "id"), made });
  }
  seen.handled = comments.filter((c) => item(c, "updated_at") === latest).map((c) => item(c, "id"));
  seen.commentsTag = latest === since ? tag : null;
  seen.since = latest;
  return found;
}

async function take(asks: [string, number, string, Dict[]][], state: Dict, react = true): Promise<void> {
  const queue = item(state, "queue") as Json[];
  const found = asks
    .flatMap(([name, rid, token, f]) => f.map((a) => [name, rid, token, a] as const))
    .sort(byKeys((x) => item(x[3], "made") as string, (x) => item(x[3], "comment") as number));
  for (const [name, rid, token, a] of found) {
    if ((await pull(name, token, a))[0] !== "open") continue;
    const kept = queue.filter((q) => !(pyEquals(item(q, "rid"), rid) && pyEquals(item(q, "number"), item(a, "number"))));
    queue.length = 0;
    for (const q of kept) queue.push(q);
    queue.push({ rid, number: item(a, "number"), comment: item(a, "comment"), made: item(a, "made") });
    const line = item(state, "line") as Dict | null;
    if (truthy(line) && pyEquals(item(item(line, "ask"), "rid"), rid) && pyEquals(item(item(line, "ask"), "number"), item(a, "number"))) state.line = null;
    if (!react) continue;
    try {
      const [status] = await request("POST", `/repos/${name}/issues/comments/${str(item(a, "comment"))}/reactions`, { token, body: { content: "eyes" } });
      need(status === 200 || status === 201, `GitHub answered ${status}`);
    } catch (error) {
      say(`poll.ts: no 👀 on ${name} comment ${str(item(a, "comment"))}: ${said(error)}`);
    }
  }
}

async function pull(name: string, token: string, a: Json, read = false): Promise<["open", string] | ["gone" | "unread", null]> {
  const path = `/repos/${name}/pulls/${str(item(a, "number"))}`;
  let status: number;
  let pr: Json;
  try {
    [status, pr] = await request("GET", path, { token });
  } catch (error) {
    if (!read) throw error;
    say(`poll.ts: GET ${path} failed (${said(error)}), so its ask in comment ${str(item(a, "comment"))} waits`);
    return ["unread", null];
  }
  if (status === 404 || !pyEquals(get(pr, "state") ?? null, "open")) {
    const what = status !== 404 ? "is closed" : "is no pull request GitHub gives";
    say(`poll.ts: ${name}#${str(item(a, "number"))} ${what}, so its ask in comment ${str(item(a, "comment"))} gets no view`);
    return ["gone", null];
  }
  return ["open", headOf(name, item(a, "number"), item(item(pr, "head"), "sha"))];
}

function pending(line: Dict | null | undefined, held_: Run[]): boolean {
  if (!truthy(line)) return false;
  const key = item(line, "key");
  return !new Set(held_.map((r) => hashable(item(r, "key"), "set element"))).has(key);
}

function mergesPending(whole: Dict, held_: Run[]): boolean {
  const line = (get(orDict(get(whole, "merges")), "line") ?? null) as Dict | null;
  if (!pending(line, held_)) return false;
  say(`poll.ts: waiting for the merges' line ${str(item(line, "key"))} to start`);
  return true;
}

export async function ask(place: Place, whole: State, taken: number, at: string, job = true): Promise<[string[], number]> {
  const state = asDict(setdefaultIn(whole, "asks", () => ({ seq: 0, line: null, queue: [], repos: new Map() as unknown as Json })));
  state.seq = Math.max(item(state, "seq") as number, taken);
  if (truthy(item(state, "line")) && (item(item(state, "line"), "seq") as number) <= taken) {
    const comment = item(item(item(state, "line"), "ask"), "comment");
    state.queue = (item(state, "queue") as Json[]).filter((q) => !pyEquals(item(q, "comment"), comment));
    state.line = null;
  }
  const cfg = app();
  const jwt = appJwt(cfg);
  const [installations] = await every(`/app/installations?per_page=${PER_PAGE}`, { bearer: jwt });
  const asks: [string, number, string, Dict[]][] = [];
  const looked = new Set<string>();
  const where = new Map<number, [string, string]>();
  for (const inst of installations!) {
    if (!ACCOUNTS.has(hashable(item(item(inst, "account"), "id"), "dict key") as number)) continue;
    const token = await tokenOf(whole, item(inst, "id"), jwt);
    const [listing] = await every(`/installation/repositories?per_page=${PER_PAGE}`, { token, field: "repositories" });
    for (const raw of listing!) {
      const repo = asDict(raw);
      if (!viewedRepo(repo, looked)) continue;
      const rid = item(repo, "id") as number;
      looked.add(str(rid));
      const seen = setdefault(repos(state), str(rid), () => ({}));
      where.set(rid, [item(repo, "full_name") as string, token]);
      asks.push([item(repo, "full_name") as string, rid, token, await asksIn(item(repo, "full_name") as string, token, seen, item(cfg as unknown as Json, "appId"), at)]);
    }
  }
  await take(asks, state, job);
  const held_ = runs(place);
  const busy = sortedTexts(held_.filter((r) => holds(place, r)).map(shown));
  if (busy.length) {
    say(`poll.ts: waiting for the runners, held by ${busy.join(", ")}`);
    return [[], taken];
  }
  if (pending((get(whole, "views_line") ?? null) as Dict | null, held_)) {
    say(`poll.ts: waiting for the views' line ${str(item(item(whole, "views_line"), "key"))} to start`);
    return [[], taken];
  }
  if (mergesPending(whole, held_)) return [[], taken];
  const ran = new Set(held_.map((r) => hashable(item(r, "key"), "set element") as string));
  const unsettled = new Map(held_.filter((r) => !ENDED.includes(item(r, "state") as string)).map((r) => [headKey(item(r, "key") as string), item(r, "run")]));
  const line = (item(state, "line") ?? null) as Dict | null;
  const order = [...(truthy(line) ? [item(line, "ask")] : []), ...(item(state, "queue") as Json[]).filter((q) => !truthy(line) || !pyEquals(item(q, "comment"), item(item(line, "ask"), "comment")))];
  for (const q of order) {
    const rid = item(q, "rid") as number;
    if (!where.has(rid)) {
      say(`poll.ts: the ask in comment ${str(item(q, "comment"))} waits, since its repository isn't in this pass's listing`);
      continue;
    }
    const [name, token] = where.get(rid)!;
    const [found, head] = await pull(name, token, q, true);
    if (found === "unread") continue;
    const key = found === "open" ? `${keyOf(rid, item(q, "number") as number, head!)}:ask-${str(item(q, "comment"))}` : null;
    if (found === "gone" || ran.has(key!)) {
      state.queue = (item(state, "queue") as Json[]).filter((x) => !pyEquals(item(x, "comment"), item(q, "comment")));
      state.line = null;
      continue;
    }
    if (unsettled.has(headKey(key!))) {
      say(
        `poll.ts: the ask in comment ${str(item(q, "comment"))} waits for ${str(unsettled.get(headKey(key!))!)}, a view of its head that hasn't ` +
          "settled, since both would use the head's one directory",
      );
      continue;
    }
    if (!truthy(item(state, "line")) || item(item(state, "line"), "key") !== key) {
      state.seq = (state.seq as number) + 1;
      state.line = { seq: state.seq, key, args: { repo: name, number: item(q, "number"), head }, ask: q };
    }
    const out = asDict(item(state, "line"));
    return [[dumps({ key, args: out.args }, { separators: [",", ":"] })], out.seq as number];
  }
  state.line = null;
  return [[], taken];
}

function mergeCommit(name: string, number: Json, sha: Json): string {
  if (sha !== null && typeof sha === "object") fault("TypeError", `cannot use 'tuple' as a set element (unhashable type: '${typeName(sha)}')`);
  if (typeof sha !== "string") fault("TypeError", `${name}#${str(number)}'s merge commit is ${pyRepr(sha)}, not a sha`);
  return sha as string;
}

// Paging can stop at a page that ends before `since` because GitHub lists closed pull requests last updated first, and
// a merge's last update is no earlier than the merge; a first page GitHub answers 304 to, by its ETag, has had no update
// since, so the merges the last listing found stand.
async function mergesIn(name: string, token: string, seen: Dict): Promise<Dict[]> {
  const since = item(seen, "since") as string;
  const handled = item(seen, "handled") as Json[];
  const path = `/repos/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}`;
  let [status, page, tag, following] = await request("GET", path, { token, tag: (get(seen, "tag") as string | null) ?? null });
  let found: Json[];
  if (status === 304) {
    found = (truthy(get(seen, "found")) ? get(seen, "found") : []) as Json[];
    for (const m of found) mergeCommit(name, hashable(item(m, "number"), "set element"), item(m, "merged"));
  } else {
    found = [];
    for (;;) {
      need(status === 200, `GitHub answered ${status} to GET /repos/${name}/pulls`);
      const pulls = page as Json[];
      for (const p of pulls)
        if (truthy(get(p, "merged_at")) && !gt(since, compared(item(p, "merged_at"), ">=", since)))
          found.push({ number: hashable(item(p, "number"), "set element"), merged: mergeCommit(name, item(p, "number"), item(p, "merge_commit_sha")), at: item(p, "merged_at") });
      if (!following || !pulls.length || gt(since, compared(item(pulls.at(-1)!, "updated_at"), "<", since))) break;
      [status, page, , following] = await request("GET", following, { token });
    }
    seen.tag = tag;
    seen.found = found;
  }
  return (found as Dict[]).filter(
    (m) => gt(item(m, "at") as string, since) || (item(m, "at") === since && !handled.some((h) => pyEquals(h, item(m, "number")))),
  );
}

function passed(rs: Repos, merge: Json): void {
  const seen = setdefault(rs, str(item(merge, "rid")), () => ({ since: SINCE, handled: [] }));
  if (gt(item(merge, "at") as string, item(seen, "since") as string)) {
    seen.since = item(merge, "at");
    seen.handled = [item(merge, "number")];
  } else if (item(merge, "at") === item(seen, "since") && !(item(seen, "handled") as Json[]).some((h) => pyEquals(h, item(merge, "number"))))
    (item(seen, "handled") as Json[]).push(item(merge, "number"));
}

export async function merged(place: Place, whole: State, taken: number): Promise<[string[], number]> {
  const state = asDict(setdefaultIn(whole, "merges", () => ({ seq: 0, line: null, repos: new Map() as unknown as Json })));
  state.seq = Math.max(item(state, "seq") as number, taken);
  if (truthy(item(state, "line")) && (item(item(state, "line"), "seq") as number) <= taken) {
    passed(repos(state), item(item(state, "line"), "merge"));
    state.line = null;
  }
  const cfg = app();
  const jwt = appJwt(cfg);
  const [installations] = await every(`/app/installations?per_page=${PER_PAGE}`, { bearer: jwt });
  const found: Dict[] = [];
  const opened = new Map<string, Opened>();
  const looked = new Map<string, string>();
  for (const inst of installations!) {
    if (!ACCOUNTS.has(hashable(item(item(inst, "account"), "id"), "dict key") as number)) continue;
    const token = await tokenOf(whole, item(inst, "id"), jwt);
    const [listing] = await every(`/installation/repositories?per_page=${PER_PAGE}`, { token, field: "repositories" });
    for (const raw of listing!) {
      const repo = asDict(raw);
      if (!viewedRepo(repo, looked)) continue;
      const rid = item(repo, "id") as number;
      const name = item(repo, "full_name") as string;
      looked.set(str(rid), name);
      const seen = setdefault(repos(state), str(rid), () => ({ since: SINCE, handled: [] }));
      for (const m of await mergesIn(name, token, seen)) found.push({ ...m, rid, repo: name });
      for (const p of await heads(name, token, asDict(setdefaultIn(seen, "open", () => ({})))))
        opened.set(`${KEY}${rid}#${str(item(p, "number"))}`, { ...(p as Opened), repo: name, rid });
    }
  }
  let line = (item(state, "line") ?? null) as Dict | null;
  if (truthy(line) && !looked.has(str(item(item(line, "merge"), "rid")))) {
    say(
      `poll.ts: ${str(item(line, "key"))}'s line is dropped, since its repository isn't in this pass's listing; its merge ` +
        "waits as it was when the repository is listed again",
    );
    state.line = null;
  } else if (truthy(line)) asDict(item(line, "args")).repo = looked.get(str(item(item(line, "merge"), "rid")))!;
  const held_ = runs(place);
  const busy = sortedTexts(held_.filter((r) => holds(place, r)).map(shown));
  if (busy.length) {
    say(`poll.ts: waiting for the runners, held by ${busy.join(", ")}`);
    return [[], taken];
  }
  for (const [step, other] of [
    ["views'", get(whole, "views_line") ?? null],
    ["asks'", get(orDict(get(whole, "asks")), "line") ?? null],
  ] as const) {
    if (pending(other as Dict | null, held_)) {
      say(`poll.ts: waiting for the ${step} line ${str(item(other, "key"))} to start`);
      return [[], taken];
    }
  }
  const ran = new Set(
    held_.flatMap((r) => {
      const m = MERGE_KEY.exec(matchable(item(r, "key")));
      return m ? [`${m[1]}#${m[2]}@${m[3]}`] : [];
    }),
  );
  const ranOf = (m: Dict) => ran.has(`${str(item(m, "rid"))}#${str(item(m, "number"))}@${item(m, "merged") as string}`);
  for (const rid of new Set(found.map((m) => item(m, "rid") as number))) {
    for (const m of found.filter((m) => item(m, "rid") === rid).sort(byKeys<Dict>((m) => item(m, "at") as string, (m) => item(m, "number") as number))) {
      if (!ranOf(m)) break;
      passed(repos(state), m);
    }
  }
  line = (item(state, "line") ?? null) as Dict | null;
  if (truthy(line)) {
    const m = MERGE_KEY.exec(item(line, "key") as string)!;
    if (!ran.has(`${m[1]}#${m[2]}@${m[3]}`)) return [[dumps({ key: item(line, "key"), args: item(line, "args") }, { separators: [",", ":"] })], item(line, "seq") as number];
  }
  state.line = null;
  const unsettled = new Set(held_.filter((r) => !ENDED.includes(item(r, "state") as string)).map((r) => headKey(item(r, "key") as string)));
  const first = asksFirst(orDict(get(whole, "asks")) as Dict, opened, unsettled);
  if (first.length) {
    say(
      `poll.ts: waiting for the asks' queue, which holds ${first.length} on a pull request this pass lists open ` +
        "with no unsettled view of its head, since an ask goes first",
    );
    return [[], taken];
  }
  const left = get(whole, "views_waiting") ?? null;
  if (left === null) {
    say(
      "poll.ts: waiting for the views step's first job pass, which counts the pull requests waiting for a view, " +
        "since a pull request's view goes before a merge's",
    );
    return [[], taken];
  }
  if (truthy(left)) {
    say(
      `poll.ts: waiting for the views, since the views step left ${str(left)} pull request${pyEquals(left, 1) ? "" : "s"} ` +
        "waiting at its last job pass, and a pull request's view goes before a merge's",
    );
    return [[], taken];
  }
  const todo = found
    .filter((m) => !ranOf(m))
    .sort(byKeys<Dict>((m) => item(m, "at") as string, (m) => item(m, "rid") as number, (m) => item(m, "number") as number));
  if (!todo.length) return [[], taken];
  const m = todo[0]!;
  state.seq = (state.seq as number) + 1;
  state.line = {
    seq: state.seq,
    key: mergeKey(item(m, "rid"), item(m, "number"), item(m, "merged")),
    args: { repo: item(m, "repo"), number: item(m, "number"), merged: item(m, "merged") },
    merge: { rid: item(m, "rid"), number: item(m, "number"), at: item(m, "at") },
  };
  const out = asDict(item(state, "line"));
  return [[dumps({ key: out.key, args: out.args }, { separators: [",", ":"] })], out.seq as number];
}

const STEPS = ["views", "asks", "merges"] as const;
const USAGE = "usage: poll.ts [-h] [--job] [{views,asks,merges}]";
const HELP = `${USAGE}

The context view's poll, a Jobs job's condition: it prints at most one line, {"key", "args"}, for the step it runs.

positional arguments:
  {views,asks,merges}  views (the default): a line for each pull request a review starts on; asks: one for each ask;
                       merges: one for each pull request merged in a covered repository

options:
  -h, --help           show this help message and exit
  --job                the pass is its job's condition; without it, the pass prints what it would and changes nothing
`;

function parse(argv: readonly string[]): { step: (typeof STEPS)[number]; job: boolean } | number {
  const refuse = (why: string): number => {
    process.stderr.write(`${USAGE}\npoll.ts: error: ${why}\n`);
    return 2;
  };
  let job = false;
  const positional: string[] = [];
  let options = true;
  for (const arg of argv) {
    if (options && arg === "--") options = false;
    else if (options && arg.startsWith("--") && arg.length > 2) {
      const named = ["--help", "--job"].filter((o) => o.startsWith(beforeFirst(arg, "=")));
      if (named.length !== 1) return refuse(named.length ? `ambiguous option: ${arg} could match ${named.join(", ")}` : `unrecognized arguments: ${arg}`);
      if (arg.includes("=")) return refuse(`argument ${named[0] === "--job" ? "--job" : "-h/--help"}: ignored explicit argument '${arg.slice(arg.indexOf("=") + 1)}'`);
      if (named[0] === "--help") {
        process.stdout.write(HELP);
        return 0;
      }
      job = true;
    } else if (options && arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (options && arg.startsWith("-") && arg !== "-") return refuse(`unrecognized arguments: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) return refuse(`unrecognized arguments: ${positional.slice(1).join(" ")}`);
  const step = positional[0] ?? "views";
  if (!(STEPS as readonly string[]).includes(step)) return refuse(`argument step: invalid choice: '${step}' (choose from views, asks, merges)`);
  return { step: step as (typeof STEPS)[number], job };
}

export async function main(argv: readonly string[] | null = null, o: { place?: Place; now?: () => string; checkout?: string } = {}): Promise<number> {
  const refused = argv === null ? refuseCheckout(import.meta.path, "~/.local/lib/context-view/current/view/poll", 2, o.checkout) : null;
  if (refused !== null) return refused;
  const given = parse(argv ?? process.argv.slice(2));
  if (typeof given === "number") return given;
  const place = o.place ?? PLACE;
  try {
    const taken = cursor();
    const [lines, last] = await locked(place, given.job, async (state) => {
      const at = (o.now ?? now)();
      return given.step === "views" ? look(place, state, taken, at) : given.step === "asks" ? ask(place, state, taken, at, given.job) : merged(place, state, taken);
    });
    if (!lines.length) return 1;
    if (given.job) giveCursor(last);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Failed) say(`poll.ts: ${error.message}`);
    else process.stderr.write(encode(`${error instanceof Error ? traceback(error) : String(error)}\n`, "backslashreplace"));
    return 2;
  }
}

// exitCode rather than exit(): Bun's exit() drops what a pipe hasn't yet taken.
if (import.meta.main) process.exitCode = await main();
