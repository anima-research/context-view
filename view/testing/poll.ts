import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNTS, type Json } from "review-workflow/view";
import { setTimeoutSeconds } from "review-workflow/testing";

import { instant, main, type Place, viewDir } from "../poll.ts";
import { captured, checkJwt, Fixture, type Reply, Server, writeApp } from "../testing.ts";
import { VIEWED } from "../view_read.ts";

export { captured };

export const APP_ID = 77;
export const ACCOUNT = [...ACCOUNTS.keys()][0]!;
const viewed = [...VIEWED];
export const [OR_ID, OR] = viewed[0]!;
export const [AT_ID, AT] = viewed[1]!;
export const XY = "x/y";
export const XY_ID = 1009;

export type Pull = { number: number; draft: boolean; head: { sha: string }; author_association: string; [k: string]: Json };
export type Repo = {
  id: number;
  pulls: Pull[];
  closed?: Json[];
  comments?: Json[];
  permissions?: Record<string, string>;
  installation?: number;
  archived?: boolean;
  disabled?: boolean;
  pullsFail?: Record<number, number>;
  permissionsFail?: number;
  reactFail?: number;
  reactions?: [number, string][];
};
export type Failure = { status: number } | "timeout" | "cut" | "garbled" | "misshapen";

export function pull(n: number, head = "a", draft = false, association = "MEMBER"): Pull {
  return { number: n, draft, head: { sha: head.repeat(40) }, author_association: association };
}

type Answer = [number, Json | undefined, string | null, string | null] | "timeout" | "cut" | "garbled" | "misshapen";

const reply = (a: Answer): Reply =>
  a === "timeout" || a === "cut" ? a : a === "garbled" ? { status: 200, text: "<html>" } : a === "misshapen" ? { status: 200, json: 5 } : { status: a[0], json: a[1] ?? undefined, etag: a[2], link: a[3] };

export class GitHub {
  repos: Record<string, Repo> = { [OR]: { id: OR_ID, pulls: [] } };
  calls: [string, string][] = [];
  installs: Record<number, { id: number; login: string }> = { 5: { id: ACCOUNT, login: "org" } };
  tokens: Record<string, number> = {};
  minted = 0;
  fail: [string, Failure] | null = null;
  afterPulls: [string, () => void] | null = null;
  readonly server = new Server((method, path, credential, ifNoneMatch, body) => reply(this.answer(method, path, credential, ifNoneMatch, body)));

  tag(value: unknown): string {
    return `W/"${createHash("sha1").update(sortedJson(value)).digest("hex").slice(0, 16)}"`;
  }

  private checkJwt(bearer: string | null): void {
    checkJwt(bearer, APP_ID);
  }

  answer(method: string, path: string, token: string | null, tag: string | null, body: Json): Answer {
    this.calls.push([method, path]);
    if (this.fail && path.includes(this.fail[0])) {
      const f = this.fail[1];
      return typeof f === "object" ? [f.status, { message: "Server Error" }, null, null] : f;
    }
    if (path.startsWith("/app/installations?")) {
      this.checkJwt(token);
      return [200, Object.entries(this.installs).map(([i, account]) => ({ id: Number(i), account })), null, null];
    }
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && minting && Object.hasOwn(this.installs, minting[1]!)) {
      this.checkJwt(token);
      this.minted += 1;
      this.tokens[`tok${this.minted}`] = Number(minting[1]);
      return [201, { token: `tok${this.minted}`, expires_at: "2999-01-01T00:00:00Z" }, null, null];
    }
    if (path.startsWith("/installation/repositories")) {
      const held = Object.entries(this.repos).filter(([, r]) => (r.installation ?? 5) === this.tokens[token!]);
      const shown = held.map(([n, r]) => ({ id: r.id, full_name: n, ...(r.archived !== undefined ? { archived: r.archived } : {}), ...(r.disabled !== undefined ? { disabled: r.disabled } : {}) }));
      return [200, { repositories: shown }, null, null];
    }
    for (const [name, repo] of Object.entries(this.repos)) {
      if (method === "GET" && path.startsWith(`/repos/${name}/pulls?`)) {
        if (this.tokens[token!] !== (repo.installation ?? 5)) throw new Error(`token ${token}`);
        let listed: Answer;
        if (path.includes("state=closed")) {
          if (!path.includes("sort=updated") || !path.includes("direction=desc")) throw new Error(path);
          const closed = [...((repo.closed ?? []) as { updated_at?: string }[])].sort((a, b) => cmp(b.updated_at ?? "", a.updated_at ?? ""));
          listed = this.listing(path, closed as Json[], tag);
        } else listed = this.listing(path, repo.pulls as Json[], tag);
        if (this.afterPulls && this.afterPulls[0] === name) this.afterPulls[1]();
        return listed;
      }
      if (!path.startsWith(`/repos/${name}/`)) continue;
      if (this.tokens[token!] !== (repo.installation ?? 5)) throw new Error(`token ${token}`);
      const since = /\/issues\/comments\?since=([^&]+)/.exec(path);
      if (method === "GET" && since) {
        const at = decodeURIComponent(since[1]!);
        return this.listing(path, ((repo.comments ?? []) as { updated_at: string }[]).filter((c) => c.updated_at >= at) as Json[], tag);
      }
      const asker = new RegExp(`^/repos/${escapeRe(name)}/collaborators/([^/]+)/permission$`).exec(path);
      if (method === "GET" && asker) {
        if (repo.permissionsFail) return [repo.permissionsFail, { message: "Server Error" }, null, null];
        const held = (repo.permissions ?? {})[decodeURIComponent(asker[1]!)];
        return held ? [200, { permission: held }, null, null] : [404, { message: "Not Found" }, null, null];
      }
      const one = new RegExp(`^/repos/${escapeRe(name)}/pulls/(\\d+)$`).exec(path);
      if (method === "GET" && one) {
        const n = Number(one[1]);
        if (repo.pullsFail && Object.hasOwn(repo.pullsFail, n)) return [repo.pullsFail[n]!, { message: "Server Error" }, null, null];
        const open = repo.pulls.find((p) => p.number === n);
        const closed = ((repo.closed ?? []) as { number: number }[]).find((p) => p.number === n);
        if (!open && !closed) return [404, { message: "Not Found" }, null, null];
        return [200, { ...((open ?? closed) as object), state: open ? "open" : "closed" } as Json, null, null];
      }
      const reacted = new RegExp(`^/repos/${escapeRe(name)}/issues/comments/(\\d+)/reactions$`).exec(path);
      if (method === "POST" && reacted) {
        if (repo.reactFail) return [repo.reactFail, { message: "Forbidden" }, null, null];
        const content = (body as { content: string }).content;
        const made: [number, string] = [Number(reacted[1]), content];
        if ((repo.reactions ?? []).some(([c, k]) => c === made[0] && k === made[1])) return [200, { content }, null, null];
        (repo.reactions ??= []).push(made);
        return [201, { content }, null, null];
      }
    }
    throw new Error(`unrouted ${method} ${path}`);
  }

  private listing(path: string, items: Json[], tag: string | null): Answer {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const chunk = items.slice((page - 1) * 100, page * 100);
    const etag = this.tag(chunk);
    if (page === 1 && tag === etag) return [304, undefined, tag, null];
    const following = items.length > page * 100 ? `${path.replace(/&page=\d+/, "")}&page=${page + 1}` : null;
    return [200, JSON.parse(JSON.stringify(chunk)) as Json, etag, following];
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRe = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const sortedJson = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(sortedJson).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

const SELECTIONS: [string, string][] = [
  ["--record", "script:context-view"],
  ["--record", "script:context-view-merged"],
  ["--key-prefix", "pr-review/open:"],
  ["--key-prefix", "pr-review/ask:"],
];
const stemOf = (rec: string) => rec.replace(/^(?:workflow|script):/, "");
const WORKFLOWS = (dir: string, log: string) => `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
[ "$#" -eq 3 ] && [ "$1" = runs ] || { echo "bad arguments: $*" >&2; exit 3; }
case "$2 $3" in
${SELECTIONS.map(([flag, value], i) => `  '${flag} ${value}') exec cat '${dir}/${i}' ;;`).join("\n")}
esac
echo "a selection the stand-in doesn't answer: $2 $3" >&2
exit 3
`;
const recordOf = (r: Run) => r.record ?? (r.key.startsWith("pr-review/") ? "script:pr-review" : r.key.includes("@merged:") ? "script:context-view-merged" : "script:context-view");

type Run = { run: string; key: string; state: string; createdAt: string; house?: boolean; record?: string; [k: string]: Json | undefined };

export class Polling extends Fixture {
  gh = new GitHub();
  clock = ["2026-10-31T04:00:00Z"];
  runsPath = join(this.tmp, "runs.json");
  workflowsLog = join(this.tmp, "workflows.log");
  listings = join(this.tmp, "listings");
  place: Place = { state: join(this.tmp, "state"), workflows: join(this.tmp, "astra-workflows") };
  cursor = join(this.tmp, "cursor");
  out = join(this.tmp, "cursor-out");
  said = "";

  constructor() {
    super("context-view-poll-");
  }

  async setUp(): Promise<void> {
    this.saveRuns([]);
    writeFileSync(this.place.workflows, WORKFLOWS(this.listings, this.workflowsLog));
    chmodSync(this.place.workflows, 0o755);
    const app = writeApp(this.tmp, APP_ID);
    await this.gh.server.start();
    this.env({ REVIEW_PR_API: this.gh.server.base, REVIEW_PR_APP: app, REVIEW_PR_POLL: join(this.tmp, "review-workflow-poll") });
    this.addCleanup(setTimeoutSeconds(1));
  }

  override async tearDown(): Promise<void> {
    await this.gh.server.stop();
    await super.tearDown();
    expect(this.gh.server.wrong).toEqual([]);
  }

  saveRuns(runs: Run[]): void {
    writeFileSync(this.runsPath, JSON.stringify(runs));
    mkdirSync(this.listings, { recursive: true });
    const newest = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    for (const [i, [flag, value]] of SELECTIONS.entries()) {
      const shown = newest.filter((r) => (flag === "--key-prefix" ? r.key.startsWith(value) && (r.house ?? true) : stemOf(recordOf(r)) === stemOf(value)));
      writeFileSync(join(this.listings, String(i)), shown.map(({ record: _, ...r }) => `${JSON.stringify({ ...r, house: r.house ?? true })}\n`).join(""));
    }
  }

  loadRuns(): Run[] {
    return JSON.parse(readFileSync(this.runsPath, "utf8")) as Run[];
  }

  statePath(): string {
    return join(this.place.state, "poll.json");
  }

  state(): Record<string, Json> {
    return JSON.parse(readFileSync(this.statePath(), "utf8")) as Record<string, Json>;
  }

  saveState(state: Record<string, Json>): void {
    writeFileSync(this.statePath(), JSON.stringify(state));
  }

  manifest(key: string, o: { before?: boolean; after?: number } = {}): void {
    const [rid, rest] = splitOnce(key.slice("context-view/".length), "#");
    const [number, head] = rest.split(":", 1)[0]!.split("@");
    const where = viewDir(this.place, VIEWED.get(Number(rid))!, Number(number), head!);
    mkdirSync(where, { recursive: true });
    const path = join(where, "manifest.json");
    writeFileSync(path, JSON.stringify({ outcome: "ran" }));
    const created = this.loadRuns().filter((r) => r.key === key).at(-1)!.createdAt;
    const at = instant(created) + (o.before ? -60 : (o.after ?? 60));
    utimesSync(path, at, at);
  }

  startRun(key: string, more: Partial<Run> = {}): void {
    const runs = this.loadRuns();
    const house = more.house ?? true;
    if (!runs.some((r) => r.key === key && (r.house ?? true) === house)) {
      runs.push({ run: `wf-${runs.length + 1}`, key, state: "running", createdAt: this.clock[0]!.replace("Z", ".000Z"), ...more } as Run);
      this.saveRuns(runs);
    }
  }

  review(repo: string, number: number, o: { head?: string; comment?: number; state?: string } = {}): string {
    const key = o.head ? `pr-review/open:${repo}#${number}@${o.head.repeat(40)}` : `pr-review/ask:${repo}#${number}:comment-${o.comment}`;
    this.startRun(key);
    this.saveRuns(this.loadRuns().map((r) => (r.key === key ? { ...r, state: o.state ?? "completed" } : r)));
    return key;
  }

  settle(key: string, state = "completed"): void {
    const runs = this.loadRuns();
    if (!runs.some((r) => r.key === key)) throw new Error(`no run under ${JSON.stringify(key)} to settle`);
    this.saveRuns(runs.map((r) => (r.key === key ? { ...r, state } : r)));
  }

  settleAll(): void {
    this.saveRuns(this.loadRuns().map((r) => ({ ...r, state: "completed" })));
  }

  at(t: string): void {
    this.clock[0] = t;
  }

  runOf(key: string): string {
    const found = this.loadRuns().filter((r) => r.key === key);
    expect(found.length).toBe(1);
    return found[0]!.run;
  }

  async pass(argv: string[], cursorName: string, take = true): Promise<[number, Record<string, Json>[]]> {
    const cursor = `${this.cursor}-${cursorName}`;
    const out = `${this.out}-${cursorName}`;
    rmSync(out, { force: true });
    const before = [process.env.ASTRA_JOB_CURSOR, process.env.ASTRA_JOB_CURSOR_OUT];
    process.env.ASTRA_JOB_CURSOR = cursor;
    process.env.ASTRA_JOB_CURSOR_OUT = out;
    let code: number;
    let printed: string;
    try {
      [code, printed, this.said] = await captured(() => main(argv, { place: this.place, now: () => this.clock[0]! }));
    } finally {
      for (const [k, v] of [["ASTRA_JOB_CURSOR", before[0]], ["ASTRA_JOB_CURSOR_OUT", before[1]]] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const lines = printed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, Json>);
    if (code === 0) {
      expect(existsSync(out)).toBe(true);
      if (take) copyFileSync(out, cursor);
    }
    return [code, lines];
  }
}

export function comment(
  n: number,
  body: string,
  o: { login?: string; at?: string; number?: number; repo?: string; app?: number; kind?: string } = {},
): Record<string, unknown> & { id: number; updated_at: string } {
  const at = o.at ?? "2026-11-05T01:00:00Z";
  return {
    id: n,
    body,
    user: { login: o.login ?? "nissa-seru" },
    created_at: at,
    updated_at: at,
    html_url: `https://github.com/${o.repo ?? OR}/${o.kind ?? "pull"}/${o.number ?? 2}#issuecomment-${n}`,
    ...(o.app ? { performed_via_github_app: { id: o.app } } : {}),
  };
}

export const splitOnce = (text: string, sep: string): [string, string] => {
  const i = text.indexOf(sep);
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + sep.length)];
};

