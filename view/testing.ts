import { expect } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMMENT_MAX, cpCompare, cpLength, dumps, readJson, truthy, type Json } from "review-workflow/view";
import { setSleep } from "review-workflow/testing";

import { post as viewPost, seams } from "./view.ts";
import { facts as viewFacts, VIEWED } from "./view_read.ts";

type Dict = { [key: string]: Json };

export const REPO = "anima-research/context-manager";
export const APP = 7;
export const [H1, H2, H3, BASE] = ["a", "b", "c", "d"].map((c) => c.repeat(40)) as [string, string, string, string];
export const HARNESS = "0123456789abcdef".repeat(2) + "01234567";
export const READS = { instructions: "1".repeat(64), guide: "2".repeat(64) };
export const RUNS = ["H1/W1", "H1/W2", "C6h/W11"];
export const VERSIONS: Record<string, string> = {
  "@animalabs/connectome-host": "0.21.0 (source 54321fd3af80)",
  "@animalabs/agent-framework": "0.32.0",
  "@animalabs/membrane": "0.8.0",
  "@animalabs/chronicle": "0.5.1",
  bun: "1.4.4",
};
export const M = "@animalabs/membrane";
export const AF = "@animalabs/agent-framework";

export function readFile(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

export function nesting(text: string): [string, string | null][] {
  const out: [string, string | null][] = [];
  const stack: string[] = [];
  for (const m of text.matchAll(/<details><summary>(.*?)<\/summary>|<\/details>/g)) {
    if (m[1] === undefined) {
      stack.pop();
      continue;
    }
    out.push([m[1], stack.at(-1) ?? null]);
    stack.push(m[1]);
  }
  expect(stack).toEqual([]);
  return out;
}

type Counts = { compiles?: Json; compressions?: Json; merges?: Json; quarantines?: Json };

export function counts({ compiles = 10, compressions = 2, merges = 1, quarantines = null }: Counts = {}): Dict {
  return { compiles, compressions, merges, quarantines };
}

export type ResultOptions = Counts & {
  record?: Json;
  outcome?: string;
  check?: Json;
  flags?: Json;
  reason?: Json;
  absent?: Json;
  baseAbsent?: Json;
  usage?: Json;
};

export function result(run: string, o: ResultOptions = {}): Dict {
  const { record = "same", outcome = "pass", check = "same", flags = null, reason = null, absent = null, baseAbsent = null, usage = null, ...more } = o;
  const r: Dict = {
    run,
    outcome,
    record,
    flags: truthy(flags) ? flags : { new: [], gone: [], kept: [] },
    counts: counts(more),
    ...(truthy(check) ? { selfCheck: { outcome: check } } : {}),
    ...(truthy(reason) ? { reason } : {}),
    ...(absent !== null ? { absent } : {}),
    ...(baseAbsent !== null ? { baseAbsent } : {}),
    ...(usage !== null ? { usage } : {}),
  };
  if (outcome === "couldnt-run") {
    r.record = null;
    delete r.counts;
    delete r.flags;
    delete r.selfCheck;
  }
  return r;
}

export type Figures = { requests?: Json; input?: Json; cacheRead?: Json; cacheWrite?: Json; output?: Json; dropped?: Json };
export type UsageOptions = { last?: Json; calibration?: Json; agent?: Figures | null } & { [kind: string]: Figures | Json | undefined };

function figures({ requests = 10, input = 1000, cacheRead = 9000, cacheWrite = 500, output = 200, dropped = 0 }: Figures = {}): Dict {
  return { requests, input, cacheRead, cacheWrite, output, dropped };
}

export function usage(o: UsageOptions = {}): Dict {
  const { last = 0, calibration = null, agent = null, ...kinds } = o;
  const named = Object.entries(kinds).map(([kind, f]) => [kind, figures(f as Figures)] as const);
  return { kinds: { agent: figures(agent ?? {}), ...Object.fromEntries(named) }, lastDropped: last, calibration };
}

export function priced(u: Dict, o: { unpriced?: Json } & { [kind: string]: Json | undefined } = {}): Dict {
  const { unpriced = 0, ...costs } = o;
  for (const where of ["kinds", "history"]) {
    const held = u[where];
    if (!truthy(held)) continue;
    for (const [kind, k] of Object.entries(held as Dict)) Object.assign(k as Dict, { cost: Object.hasOwn(costs, kind) ? costs[kind]! : 0.5, unpriced });
  }
  return u;
}

type Lists = Partial<Record<"ran" | "notRan" | "couldntTell" | "noCode" | "unloaded", number[]>>;

export function reachedFile(
  state = "read",
  { deletions = [], reason = null, ...lists }: Lists & { deletions?: [number, string, number | null][]; reason?: string | null } = {},
): { [key: string]: Json } {
  return {
    state,
    ...Object.fromEntries((["ran", "notRan", "couldntTell", "noCode", "unloaded"] as const).map((k) => [k, [...(lists[k] ?? [])]])),
    deletions: deletions.map(([after, s, by]) => ({ after, state: s, by })),
    ...(reason ? { reason } : {}),
  };
}

export const REACHED: Dict = {
  change: "anima-research/context-manager",
  files: { "src/a.ts": reachedFile("read", { ran: [1, 2] }) },
  notes: [],
  fallbacks: { fired: 0, notes: [] },
  drives: {},
  code: { wrote: ["9".repeat(64)], joined: "9".repeat(64) },
};

export const ALL_RAN = "All 2 of this change's changed source lines that map to code ran in at least one profiled drive.";

export function entry(eid: string, places: [string, Json][], { before = "old text", after = "new text" }: { before?: Json; after?: Json } = {}): Dict {
  const at = places.map(([run, step]) => ({ run, step }));
  const firsts = new Map<string, { run: string; step: Json }>();
  for (const p of at) if (!firsts.has(p.run)) firsts.set(p.run, p);
  return {
    id: eid,
    describe: `${eid} changed`,
    count: at.length,
    runs: [...firsts.keys()].sort(cpCompare),
    places: at,
    examples: [...firsts.values()].map((p) => ({ run: p.run, step: p.step, before, after })),
  };
}

function writeDump(path: string, value: unknown): void {
  writeFileSync(path, dumps(value));
}

export type Reply = { status: number; json?: Json; text?: string; etag?: string | null; link?: string | null } | "timeout" | "cut";
export type Routing = (method: string, path: string, credential: string | null, ifNoneMatch: string | null, body: Json) => Reply;

export class Server {
  base = "";
  wrong: string[] = [];
  private server: NetServer | null = null;
  private open = new Set<Socket>();

  constructor(private readonly routing: Routing) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    for (const s of this.open) s.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    this.open.add(socket);
    socket.on("close", () => this.open.delete(socket));
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [line, ...lines] = data.subarray(0, end).toString("latin1").split("\r\n");
      const headers = new Map(lines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      const length = Number(headers.get("content-length") ?? 0);
      if (data.length < end + 4 + length) return;
      socket.removeAllListeners("data");
      const [method, target] = line!.split(" ") as [string, string];
      const auth = headers.get("authorization") ?? "";
      const credential = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      let reply: Reply;
      try {
        const body = length ? (JSON.parse(data.subarray(end + 4, end + 4 + length).toString("utf8")) as Json) : null;
        reply = this.routing(method, target, credential, headers.get("if-none-match") ?? null, body);
      } catch (error) {
        this.wrong.push(`${method} ${target}: ${(error as Error).message}`);
        reply = { status: 599, json: { message: (error as Error).message } };
      }
      this.send(socket, reply);
    });
  }

  private send(socket: Socket, reply: Reply): void {
    if (reply === "timeout") return;
    const r = reply === "cut" ? { status: 200, text: '{"content": "eyes", "more": "' } : reply;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    const bytes = Buffer.from(text, "utf8");
    const head = [
      `HTTP/1.1 ${r.status} ${r.status === 304 ? "Not Modified" : "Answered"}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${reply === "cut" ? bytes.length + 40 : bytes.length}`,
      ...(r.etag ? [`ETag: ${r.etag}`] : []),
      ...(r.link ? [`Link: <${this.base}${r.link}>; rel="next"`] : []),
      "Connection: close",
    ];
    socket.end(Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "latin1"), r.status === 304 ? Buffer.alloc(0) : bytes]));
  }
}

const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

export function writeApp(dir: string, appId: number): string {
  const key = join(dir, "app-key.pem");
  writeFileSync(key, KEYS.privateKey, { mode: 0o600 });
  const path = join(dir, "app.json");
  writeFileSync(path, JSON.stringify({ appId, privateKey: key }));
  return path;
}

export function checkJwt(bearer: string | null, appId: number): void {
  const parts = (bearer ?? "").split(".");
  if (parts.length !== 3) throw new Error(`not the App's JWT: ${bearer}`);
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { iss?: string };
  const signed = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(KEYS.publicKey), Buffer.from(parts[2]!, "base64url"));
  if (!signed || claims.iss !== String(appId)) throw new Error(`a JWT not the App's: iss ${claims.iss}, signed ${signed}`);
}

export async function captured<T>(body: () => Promise<T> | T): Promise<[T, string, string]> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const keep = (into: Buffer[]) =>
    ((chunk: string | Uint8Array) => {
      into.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write;
  const [o, e] = [process.stdout.write, process.stderr.write];
  process.stdout.write = keep(out);
  process.stderr.write = keep(err);
  try {
    return [await body(), Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")];
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

export async function raises(body: () => unknown, kind: abstract new (...args: never[]) => Error, pattern: RegExp | string): Promise<Error> {
  let thrown: unknown = null;
  try {
    await body();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(kind);
  const message = (thrown as Error).message;
  if (typeof pattern === "string") expect(message).toContain(pattern);
  else expect(message).toMatch(pattern);
  return thrown as Error;
}

export class Fixture {
  readonly tmp: string;
  private cleanups: (() => void)[] = [];

  constructor(prefix = "context-view-") {
    this.tmp = mkdtempSync(join(tmpdir(), prefix));
  }

  addCleanup(undo: () => void): void {
    this.cleanups.push(undo);
  }

  env(given: Record<string, string>): void {
    for (const [k, v] of Object.entries(given)) {
      const before = process.env[k];
      process.env[k] = v;
      this.addCleanup(() => (before === undefined ? delete process.env[k] : (process.env[k] = before)));
    }
  }

  patch<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
    const had = Object.hasOwn(target, key);
    const before = target[key];
    target[key] = value;
    this.addCleanup(() => (had ? (target[key] = before) : delete target[key]));
  }

  async tearDown(): Promise<void> {
    const faults: unknown[] = [];
    for (const undo of this.cleanups.splice(0).reverse()) {
      try {
        undo();
      } catch (fault) {
        faults.push(fault);
      }
    }
    rmSync(this.tmp, { recursive: true, force: true });
    if (faults.length) throw faults[0];
  }
}

export class Answer extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class Raw {
  constructor(readonly text: string) {}
}

export const raw = (text: string): Raw => new Raw(text);

export type Comment = { id: number; body: string } & Dict;

export class GitHub {
  comments: Comment[] = [];
  calls: [string, string][] = [];
  tokens: string[] = [];
  state = "open";
  head = H1;
  undeletable = new Set<number>();
  nextId = 100;
  posts = 0;
  postsFailAfter: number | null = null;
  pull: Dict = { title: "fix: merges by relief @someone #12", body: "It changes <b>this</b>." };
  readonly server = new Server((method, path, credential, _tag, body) => this.routed(method, path, credential, body));

  api(method: string, path: string, body: Json): Json | Raw {
    this.calls.push([method, path.split("?")[0]!]);
    const named = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
    if (named) {
      const ids = new Map([...[...VIEWED].map(([id, name]) => [name, id] as const), ["anima-research/context-manager-renamed", 1126567876]]);
      return { id: ids.get(named[1]!) ?? 99, full_name: named[1]! };
    }
    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/5$/.test(path)) return { state: this.state, head: { sha: this.head }, ...this.pull };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/issues/5/comments`)) {
      const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
      return this.comments.slice((page - 1) * 100, page * 100).map((c) => ({ ...c }));
    }
    const text = () => (body as Dict).body as string;
    if (method === "POST" && path === `/repos/${REPO}/issues/5/comments`) {
      if (cpLength(text()) > COMMENT_MAX) throw new Answer(422, "Body is too long (maximum is 65536 characters)");
      if (this.postsFailAfter !== null && this.posts >= this.postsFailAfter) throw new Answer(502, "Bad Gateway");
      this.posts += 1;
      this.nextId += 1;
      const c: Comment = { id: this.nextId, body: text(), html_url: `https://github.com/${REPO}/pull/5#issuecomment-${this.nextId}`, performed_via_github_app: { id: APP } };
      this.comments.push(c);
      return { ...c };
    }
    const at = new RegExp(`^/repos/${REPO.replace("/", "\\/")}/issues/comments/(\\d+)$`).exec(path);
    if (at && (method === "PATCH" || method === "DELETE")) {
      const held = this.comments.find((c) => c.id === Number(at[1]));
      if (!held) throw new Answer(404, "Not Found");
      if (method === "DELETE") {
        if (this.undeletable.has(held.id)) throw new Answer(403, "Resource not accessible by integration");
        this.comments.splice(this.comments.indexOf(held), 1);
        return null;
      }
      if (cpLength(text()) > COMMENT_MAX) throw new Answer(422, "Body is too long (maximum is 65536 characters)");
      held.body = text();
      return { ...held };
    }
    throw new Error(`unrouted ${method} ${path}`);
  }

  private routed(method: string, path: string, credential: string | null, body: Json): Reply {
    const installation = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
    if (method === "GET" && installation) {
      checkJwt(credential, APP);
      this.tokens.push(installation[1]!);
      if (!["anima-research", "antra-tess"].includes(installation[1]!.split("/")[0]!)) return { status: 404, json: { message: "Not Found" } };
      return { status: 200, json: { id: 4242, account: { id: 1 } } };
    }
    if (method === "POST" && path === "/app/installations/4242/access_tokens") {
      checkJwt(credential, APP);
      return { status: 201, json: { token: "tok", expires_at: "2999-01-01T00:00:00Z" } };
    }
    if (credential !== "tok") throw new Error(`a call without the installation's token: ${credential}`);
    let got: Json | Raw;
    try {
      got = this.api(method, path, body);
    } catch (error) {
      if (error instanceof Answer) return { status: error.status, json: { message: error.message } };
      throw error;
    }
    if (got instanceof Raw) return { status: 200, text: got.text };
    if (got === null) return { status: 204 };
    return { status: method === "POST" ? 201 : 200, json: got };
  }
}

export type Share = [results: Dict[], entries: Json];
export type RunDirOptions = {
  head?: string;
  outcome?: Json;
  detail?: Json;
  form?: Json;
  repo?: string;
  baseVersions?: Record<string, Json> | null;
  headVersions?: Record<string, Json> | null;
  baseResults?: Dict[] | null;
  runs?: Json[] | null;
  stack?: Json;
  reach?: Json;
  forced?: Json;
};
export type Reader = { changes: Dict[] } & Dict;
export type Reads = { instructions: string; guide: string };

export class Steps extends Fixture {
  gh = new GitHub();

  async setUp(): Promise<void> {
    await this.gh.server.start();
    this.env({ REVIEW_PR_API: this.gh.server.base, REVIEW_PR_APP: writeApp(this.tmp, APP) });
    this.addCleanup(setSleep(() => {}));
    this.patch(seams, "REVIEW_POLL", Bun.which("true")!);
  }

  override async tearDown(): Promise<void> {
    await this.gh.server.stop();
    await super.tearDown();
    expect(this.gh.server.wrong).toEqual([]);
  }

  runDir(shares: Share[], o: RunDirOptions = {}): string {
    const { head = H1, outcome = "ran", detail = null, form = "overlay", repo = "context-manager", baseVersions = null, headVersions = null } = o;
    const { baseResults = null, runs = null, stack = undefined, reach = REACHED, forced = undefined } = o;
    const d = mkdtempSync(join(this.tmp, "tmp"));
    if (reach !== null) writeDump(join(d, "reach.json"), reach);
    const listed: Dict[] = [];
    const manifest: Dict = {
      repo,
      number: 5,
      head,
      form,
      base: { ref: "main", sha: BASE },
      host: { sha: "e".repeat(40) },
      harness: { repo: "anima-research/context-view", sha: HARNESS },
      ...(stack !== undefined && stack !== null ? { stack } : {}),
      ...(forced !== undefined && forced !== null ? { forced } : {}),
      outcome,
      detail,
      shares: listed,
    };
    shares.forEach(([results, entries], index) => {
      const i = index + 1;
      listed.push({ i, dir: `share-${i}`, onGh: `run-${i}`, setupExit: 0, commandExit: 0, seconds: { setup: 60, command: 120 }, kb: 900, viewsDropped: false, home: true });
      const ran = new Set(results.map((x) => x.run));
      for (const [arm, versions] of [
        ["before", truthy(baseVersions) ? baseVersions! : VERSIONS],
        ["after", truthy(headVersions) ? headVersions! : VERSIONS],
      ] as const) {
        mkdirSync(join(d, `share-${i}`, arm), { recursive: true });
        writeDump(join(d, `share-${i}`, arm, "run.json"), {
          runs: runs ?? RUNS,
          candidate: { versions: { ...versions, "@animalabs/context-manager": `0.24.2 (${arm})` } },
          results: arm === "after" ? results : (baseResults ?? []).filter((r) => ran.has(r.run)),
        });
      }
      writeDump(join(d, `share-${i}`, "after", "entries.json"), entries);
    });
    writeDump(join(d, "manifest.json"), manifest);
    return d;
  }

  async facts(d: string, repo: string = REPO): Promise<Dict> {
    await viewFacts({ dir: d, repo });
    return readJson(join(d, "view.json")) as Dict;
  }

  post(d: string, reader: Reader | null = null, { post = true, reads = null }: { post?: boolean; reads?: Reads | null } = {}): Promise<Dict> {
    const path = reader === null ? null : this.write(d, reader);
    return viewPost({ dir: d, reader: path, post, ...(reader !== null ? { reads: reads ?? READS } : {}) });
  }

  write(d: string, reader: Reader): string {
    const view = join(d, "view.json");
    let given = reader;
    try {
      const entries = new Map(((readJson(view) as Dict).entries as Dict[]).map((e) => [e.id as string, e]));
      given = {
        ...reader,
        changes: reader.changes.map((c) => {
          const refs = c.refs as string[];
          if (Object.hasOwn(c, "place") || !truthy(refs) || !entries.has(refs[0]!)) return c;
          return { ...c, place: ((entries.get(refs[0]!)!.example as Dict).place as Json) };
        }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const path = join(d, "reader.json");
    writeDump(path, given);
    return path;
  }

  chosenRun(base: Record<string, Json>, head: Record<string, Json>, stack: Json, reached: Dict | null = null): string {
    const versions = (v: Record<string, Json>) => ({ ...VERSIONS, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [`@animalabs/${k}`, x])) });
    const results = [result("H1/W1", { record: reached ? "differs" : "same" }), result("H1/W2"), result("C6h/W11")];
    return this.runDir([[results, reached ? [reached] : []]], { baseVersions: versions(base), headVersions: versions(head), stack });
  }

  unchangedRun({ head = H1, ...more }: { head?: string } & ResultOptions = {}): string {
    return this.runDir(
      [
        [[result("H1/W1", more), result("C6h/W11", more)], []],
        [[result("H1/W2", more)], []],
      ],
      { head },
    );
  }

  changedRun({ head = H1, after = "new text" }: { head?: string; after?: Json } = {}): string {
    const e1 = [entry("aaaaaaaaaaaa", [["H1/W2", 4]])];
    const e2 = [entry("aaaaaaaaaaaa", [["H1/W1", 7]], { before: "first old", after }), entry("bbbbbbbbbbbb", [["H1/W1", 9]])];
    return this.runDir(
      [
        [[result("H1/W2", { record: "differs" })], e1],
        [[result("H1/W1", { record: "differs" }), result("C6h/W11")], e2],
      ],
      { head },
    );
  }

  reader(refs: string[] = [], { title = "Merges go first", head = "The summariser gets merge requests first" }: { title?: Json; head?: Json } = {}): Reader {
    return {
      changes: [
        {
          title,
          where: "In every run compared, at its first compile",
          base: "It changes the order of requests @maintainer, #3",
          head,
          refs: refs.length ? [...refs] : ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
          before: "call 1 ```x``` </details>",
          after: "",
        },
      ],
    };
  }

  bodies(): string[] {
    return this.gh.comments.map((c) => c.body);
  }

  four(word: string): Reader {
    const long = "x".repeat(20_000);
    return { changes: [0, 1, 2, 3].map((i) => ({ title: `C${i}`, where: word, base: "b0", head: "h0", refs: ["aaaaaaaaaaaa"], before: long, after: long })) };
  }

  async comment(d: string, reader: Reader | null = null): Promise<string> {
    await this.facts(d);
    await viewPost({ dir: d, reader: reader ? this.write(d, reader) : null, post: false, ...(reader ? { reads: READS } : {}) });
    return readFile(join(d, "comment.md"));
  }

  upgraded(baseRun: UsageOptions, headRun: UsageOptions, baseTwin: UsageOptions, headTwin: UsageOptions, flags: Json = null, twinFlags: Json = null): string {
    const runs = ["H1b/continuation/from-0.9.0", "H1b/continuation/fresh"];
    const side = (end: UsageOptions, run: string, f: Json = null) => {
      const u = usage(end);
      if (run.endsWith("/fresh")) {
        const kinds = u.kinds as Dict;
        kinds.agent = { ...(kinds.agent as Dict), requests: 13, input: 1300, cacheRead: 9100, cacheWrite: 640, output: 260 };
        u.history = { agent: { requests: 3, input: 400, cacheRead: 1000, cacheWrite: 100, output: 50, dropped: 0 } };
      }
      return result(run, { usage: u, flags: f });
    };
    const head = [side(headRun, runs[0]!, flags), side(headTwin, runs[1]!, twinFlags)];
    const base = [side(baseRun, runs[0]!), side(baseTwin, runs[1]!)];
    return this.runDir([[head, []]], { baseResults: base, runs });
  }
}
