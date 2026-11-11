import { code, cpCompare, cpLength, cpSlice, get, grouped, inert, item, need, oneLine, ordered, pyRepr, pyStr, truthy, type Json } from "review-workflow/view";
import { divide, fixed, fromJson, isWhole, percent, round, sum, toFloat, type Py } from "./view_numbers.ts";
import { counted, folded, listed, summaryText } from "./view_words.ts";

const FIGURES = ["requests", "input", "cacheRead", "cacheWrite", "output", "dropped"] as const;
const PRICE = ["cost", "unpriced"] as const;
const CONTEXT = ["seams", "out", "largest", "peak"] as const;

type Figure = (typeof FIGURES)[number];
type Whole = number | bigint;
type Figures = { [F in Figure]: Whole } & { cost?: Whole; unpriced?: Whole };
type Context = { [F in (typeof CONTEXT)[number]]: Whole };
type Calibration = { multiplier: Whole; provisional: boolean; reset: boolean };
// A Map where this module builds them, since dumps refuses an object whose integer-like keys JavaScript would put first;
// an object as loads gives view.json back.
type ByKind = ReadonlyMap<string, Figures> | Readonly<Record<string, Figures>>;
export type Arm = {
  kinds: ByKind;
  context?: Context;
  contextNone?: string;
  history?: ByKind;
  lastDropped: Whole | null;
  calibration: Calibration | null;
  priceUnread?: string;
};
export type RunUsage = { run: string; base: Arm; head: Arm };
type View = { usage?: RunUsage[] | null; harness: { repo: string; sha: string }; upgrades?: Upgrade[] | null };
type Kind = [Whole, string, string];
type End = { calibration: Calibration | null; lastDropped: Whole | null; flags: Kind[] };
type Upgrade = { run: string; twin: string; release: string; base: { run: End; twin: End }; head: { run: End; twin: End } };

const big = (n: Whole): bigint => BigInt(n);
const isDict = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

const entries = <V>(d: ReadonlyMap<string, V> | Readonly<Record<string, V>>): [string, V][] => (d instanceof Map ? [...d] : (ordered(d) as [string, V][]));
const kind = (d: ByKind, name: string): Figures | undefined => (d instanceof Map ? d.get(name) : Object.hasOwn(d, name) ? (d as Record<string, Figures>)[name] : undefined);

function counting(n: unknown): n is Whole {
  return isWhole(n) && big(n) >= 0n && big(n) <= 2n ** 53n;
}

function money(n: unknown): n is Whole {
  return (typeof n === "number" || typeof n === "bigint") && Number.isFinite(toFloat(fromJson(n))) && n >= 0;
}

export function usageRead(r: Json, arm: string): Arm {
  const u = item(r, "usage");
  const run = `${pyStr(item(r, "run"))}: on the ${arm},`;
  need(isDict(u) && isDict(get(u, "kinds")), `${run} its usage has no kinds`);
  for (const [where, kinds] of [["", item(u, "kinds")], ["history ", get(u, "history")]] as const) {
    need(kinds === null || isDict(kinds), `${run} its usage's ${where}figures aren't by kind`);
    for (const [kind, k] of entries(kinds ?? {})) {
      need(isDict(k), `${run} its usage's ${where}${pyRepr(kind)} figures aren't by figure`);
      for (const f of FIGURES) need(counting(get(k, f)), `${run} its usage's ${where}${pyRepr(kind)} ${f} isn't a whole number from 0 to 2**53, ${pyRepr(get(k, f))}`);
      need(Object.hasOwn(k, "cost") === Object.hasOwn(k, "unpriced"), `${run} its usage's ${where}${pyRepr(kind)} figures have one of cost and unpriced without the other`);
      if (Object.hasOwn(k, "cost")) {
        need(money(k.cost), `${run} its usage's ${where}${pyRepr(kind)} cost isn't a number of 0 or more, ${pyRepr(k.cost)}`);
        need(counting(k.unpriced) && big(k.unpriced) <= big(k.requests as Whole), `${run} its usage's ${where}${pyRepr(kind)} unpriced isn't a whole number from 0 to its requests, ${pyRepr(k.unpriced)}`);
      }
    }
  }
  const kinds = item(u, "kinds") as Record<string, Record<string, Whole>>;
  const history = (get(u, "history") ?? {}) as Record<string, Record<string, Whole>>;
  need(
    entries(history).every(([kind, k]) => Object.hasOwn(kinds, kind) && FIGURES.every((f) => big(k[f]!) <= big(kinds[kind]![f]!))),
    `${run} its usage's history figures are more than the run's`,
  );
  const every = [...entries(kinds), ...entries(history)].map(([, k]) => k);
  need(every.every((k) => Object.hasOwn(k, "cost")) || !every.some((k) => Object.hasOwn(k, "cost")), `${run} its usage prices some kinds of request and not others`);
  need(
    !Object.hasOwn(u, "priceUnread") || (typeof u.priceUnread === "string" && !every.some((k) => Object.hasOwn(k, "cost"))),
    `${run} its usage's priceUnread isn't text beside unpriced figures, ${pyRepr(get(u, "priceUnread"))}`,
  );
  need(Object.hasOwn(u, "lastDropped"), `${run} its usage has no lastDropped`);
  const last = u.lastDropped;
  need(last === null || counting(last), `${run} its usage's lastDropped isn't null or a whole number from 0 to 2**53, ${pyRepr(last)}`);
  const c = get(u, "calibration");
  const m = isDict(c) ? get(c, "multiplier") : null;
  need(
    c === null ||
      (((typeof m === "number" && !isWhole(m) && Number.isFinite(m)) || (isWhole(m) && (big(m) < 0n ? -big(m) : big(m)) <= 2n ** 53n)) &&
        typeof get(c, "provisional") === "boolean" &&
        typeof get(c, "reset") === "boolean"),
    `${run} its usage's calibration isn't null or a multiplier with its marks`,
  );
  const x = get(u, "context");
  need(
    !Object.hasOwn(u, "context") ||
      (isDict(x) &&
        Object.keys(x).length === CONTEXT.length &&
        CONTEXT.every((f) => Object.hasOwn(x, f) && counting(x[f])) &&
        (big(x.seams as Whole) === 0n) === (big(x.out as Whole) === 0n) &&
        big(x.largest as Whole) <= big(x.out as Whole)),
    `${run} its usage's context isn't four whole numbers from 0 to 2**53, its seams 0 exactly where the tokens taken out are, and its largest no more than them, ${pyRepr(x)}`,
  );
  need(!Object.hasOwn(u, "contextNone") || typeof u.contextNone === "string", `${run} its usage's contextNone isn't text, ${pyRepr(get(u, "contextNone"))}`);
  need(!Object.hasOwn(u, "context") || !Object.hasOwn(u, "contextNone"), `${run} its usage gives both context figures and why it gives none`);
  const kept = (k: Record<string, Whole>) => Object.fromEntries([...FIGURES, ...(Object.hasOwn(k, "cost") ? PRICE : [])].map((f) => [f, k[f]!])) as Figures;
  return {
    kinds: new Map(entries(kinds).map(([name, k]) => [name, kept(k)])),
    ...(Object.hasOwn(u, "context") ? { context: x as Context } : {}),
    ...(Object.hasOwn(u, "contextNone") ? { contextNone: u.contextNone as string } : {}),
    ...(get(u, "history") !== null ? { history: new Map(entries(history).map(([name, k]) => [name, kept(k)])) } : {}),
    lastDropped: last as Whole | null,
    calibration: c as Calibration | null,
    ...(Object.hasOwn(u, "priceUnread") ? { priceUnread: u.priceUnread as string } : {}),
  };
}

export const USAGE_MODEL =
  "The figures are the stand-in's model of each provider's published caching and token rules, not a measurement; " +
  "the stand-in answers the same every time, so a difference between the arms comes from the change.";
export const PRICE_MODEL =
  "A list price is what each arm's host prices those figures at with its own table (connectome-host's `priceCall`), " +
  "where it gives one, so it rests on the same model, with the stand-in's token estimate in place of the provider's " +
  "own count, cache hits as the script's pacing gives them, and scripted replies.";

const ZERO: Figures = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, dropped: 0, cost: 0, unpriced: 0 };
const kindsOf = (side: Arm): Figures[] => [...entries(side.kinds), ...entries(side.history ?? {})].map(([, k]) => k);

function priced(side: Arm): boolean {
  return !Object.hasOwn(side, "priceUnread") && kindsOf(side).every((k) => Object.hasOwn(k, "cost"));
}

type Sums = { [F in Figure]: bigint } & { cost?: Py; unpriced?: bigint };

function agentSums(usage: readonly RunUsage[], side: "base" | "head"): Sums {
  const agent = (u: RunUsage) => kind(u[side].kinds, "agent") ?? ZERO;
  const sums = Object.fromEntries(FIGURES.map((f) => [f, usage.reduce((s, u) => s + big(agent(u)[f]), 0n)])) as unknown as Sums;
  if (usage.every((u) => priced(u[side])) && usage.some((u) => entries(u[side].kinds).some(([, k]) => Object.hasOwn(k, "cost")))) {
    sums.cost = sum(usage.map((u) => fromJson(agent(u).cost!)));
    sums.unpriced = usage.reduce((s, u) => s + big(agent(u).unpriced!), 0n);
  }
  return sums;
}

function listPrice(k: Sums): string {
  const n = k.requests - k.unpriced!;
  return n ? `USD ${fixed(divide(k.cost!, { int: n }), 4)}` : "none";
}

type Counts = { [F in Figure]: Whole | bigint };
const sent = (k: Counts): bigint => big(k.input) + big(k.cacheRead) + big(k.cacheWrite);
const perRequest = (k: Counts): string => (big(k.requests) ? grouped(round(divide({ int: sent(k) }, { int: big(k.requests) }))) : "none");
const cached = (k: Counts): string => (sent(k) ? percent(divide({ int: big(k.cacheRead) }, { int: sent(k) }), 1) : "none");

function asShown(f: string, k: Figures): string {
  const v = (k as Record<string, Whole>)[f]!;
  return f === "cost" ? fixed(fromJson(v), 4, true) : grouped(v);
}

function asCompared(u: RunUsage): [Map<string, string[]>, Map<string, string[]>] {
  const keep = [...FIGURES, ...(priced(u.base) && priced(u.head) ? PRICE : [])];
  const shown = (side: Arm) => new Map(entries(side.kinds).map(([kind, k]) => [kind, keep.map((f) => asShown(f, k))]));
  return [shown(u.base), shown(u.head)];
}

const sameShown = ([a, b]: [Map<string, string[]>, Map<string, string[]>]) =>
  a.size === b.size && [...a].every(([kind, v]) => b.has(kind) && b.get(kind)!.every((x, i) => x === v[i]));

const movedRuns = (usage: readonly RunUsage[]) => usage.filter((u) => !sameShown(asCompared(u)));

export function usageLine(view: View): string[] {
  const usage = view.usage ?? [];
  if (!usage.length) return [];
  const [base, head] = [agentSums(usage, "base"), agentSums(usage, "head")];
  const figures: [(k: Sums) => string, string][] = [
    [perRequest, "tokens sent a request"],
    [cached, "of them read from the cache"],
    [(k) => grouped(k.cacheWrite), "written to it"],
    [(k) => grouped(k.output), "output"],
    [(k) => grouped(k.dropped), "thinking blocks dropped"],
  ];
  const both = base.cost !== undefined && head.cost !== undefined;
  if (both) {
    figures.push([listPrice, "at list price a priced request"]);
    if (base.unpriced || head.unpriced) figures.push([(k) => counted(k.unpriced!, "request", "requests"), "with no list price"]);
  }
  const runs = counted(usage.length, "run", "runs");
  let said: string;
  if (figures.every(([show]) => show(base) === show(head)))
    said = `Usage: the figures of the agents' requests, subagents' included, in the ${runs} are the same in the base and this head: ${listed(figures.map(([show, what]) => `${show(head)} ${what}`))}.`;
  else
    said = `Usage: the agents' requests, subagents' included, in the ${runs}, base → head: ${listed(
      figures.map(([show, what]) => (show(base) === show(head) ? `${show(base)} ${what}` : `${show(base)} → ${show(head)} ${what}`)),
    )}.`;
  const moved = movedRuns(usage).length;
  if (moved) said += ` The figures of ${counted(moved, "run", "runs")} moved, for any kind of request; they're under "Usage that differs", below.`;
  return [`${said} ${USAGE_MODEL}${both ? ` ${PRICE_MODEL}` : ""}`, ...unpricedLines(usage)];
}

function unpricedLines(usage: readonly RunUsage[]): string[] {
  const why = new Map<string, { side: string; reason: string; runs: string[] }>();
  for (const u of usage)
    for (const side of ["base", "head"] as const)
      if (Object.hasOwn(u[side], "priceUnread")) {
        const reason = unreadShown(u[side].priceUnread!);
        const key = JSON.stringify([side, reason]);
        if (!why.has(key)) why.set(key, { side, reason, runs: [] });
        why.get(key)!.runs.push(item(u as unknown as Json, "run") as string);
      }
  return [...why.values()].map(({ side, reason, runs }) => {
    const where = runs.length === usage.length ? "" : ` in ${counted(runs.length, "run", "runs")} of ${grouped(usage.length)}`;
    return `No list price on the ${side}${where}: ${inert(reason)}.`;
  });
}

function unreadShown(reason: string): string {
  const said = oneLine(reason);
  return cpLength(said) <= 300 ? said : `${cpSlice(said, 0, 300)}…`;
}

export function usageShown(side: Arm): Record<string, unknown> {
  const shown = (by: ByKind) => new Map(entries(by).map(([name, f]) => [name, Object.fromEntries(entries(f as unknown as Record<string, Whole>).map(([n, x]) => [n, n === "cost" ? fixed(fromJson(x), 4, true) : x]))]));
  return Object.fromEntries(
    entries(side as unknown as Record<string, unknown>).map(([k, v]): [string, unknown] => {
      if (k === "contextNone") return [k, true];
      if ((k === "kinds" || k === "history") && v !== null) return [k, shown(v as ByKind)];
      if (k === "priceUnread") return [k, unreadShown(v as string)];
      return [k, v];
    }),
  );
}

export function usageFold(view: View, room: number): string[] {
  const usage = view.usage ?? [];
  const moved = movedRuns(usage);
  if (!moved.length) return [];
  const columns: [string, string][] = [
    ["requests", "requests"],
    ["input", "input"],
    ["cacheRead", "read from the cache"],
    ["cacheWrite", "written to it"],
    ["output", "output"],
    ["dropped", "thinking dropped"],
  ];
  const items: string[] = [];
  for (const u of moved) {
    const both = priced(u.base) && priced(u.head);
    const cols: [string, string][] = [...columns, ...(both ? ([["cost", "list price, USD"], ["unpriced", "unpriced"]] as [string, string][]) : [])];
    const kinds = [...new Set([...entries(u.base.kinds).map(([k]) => k), ...entries(u.head.kinds).map(([k]) => k)])];
    kinds.sort((a, b) => Number(a !== "agent") - Number(b !== "agent") || cpCompare(a, b));
    const rows = [`| ${code(u.run)} | kind | ${cols.map(([, name]) => name).join(" | ")} |`, `|${" --- |".repeat(cols.length + 2)}`];
    for (const name of kinds) {
      const [b, h] = (["base", "head"] as const).map((side) => kind(u[side].kinds, name) ?? ZERO) as [Figures, Figures];
      const cell = (f: string) => (asShown(f, b) === asShown(f, h) ? asShown(f, b) : `${asShown(f, b)} → ${asShown(f, h)}`);
      rows.push(`| | ${inert(name)} | ${cols.map(([f]) => cell(f)).join(" | ")} |`);
    }
    items.push(rows.join("\n"));
  }
  const still = usage.length - moved.length;
  if (still) items.push(`The figures of the other ${counted(still, "run", "runs")} are the same in the base and this head.`);
  return folded(summaryText(`Usage that differs: ${grouped(moved.length)} of ${grouped(usage.length)} runs, base → head`), items, room);
}

const CONTEXT_LINK = "[What these count]({checks}).";

const gaveContext = (u: RunUsage) => Object.hasOwn(u.base, "context") && Object.hasOwn(u.head, "context");
const summariser = (side: Arm): Figures => kind(side.kinds, "summariser") ?? ZERO;
const contextMoved = (u: RunUsage) => CONTEXT.some((f) => big(u.base.context![f]) !== big(u.head.context![f]));

export function contextLine(view: View): string[] {
  const usage = view.usage ?? [];
  if (!usage.some((u) => (["base", "head"] as const).some((side) => Object.hasOwn(u[side], "context") || Object.hasOwn(u[side], "contextNone")))) return [];
  const harness = item(view as unknown as Json, "harness");
  const link = CONTEXT_LINK.replace("{checks}", () => `https://github.com/${pyStr(item(harness, "repo"))}/blob/${pyStr(item(harness, "sha"))}/CHECKS.md#what-the-context-figures-count`);
  const runs = usage.filter(gaveContext);
  if (!runs.length) return [`Context: none of the ${counted(usage.length, "run", "runs")} gave figures on both arms. ${link}`];
  const none = usage.length - runs.length;
  const scope = !none
    ? `the ${counted(runs.length, "run", "runs")}`
    : `the ${counted(runs.length, "run that gave figures on both arms", "runs that gave figures on both arms")}, not the ${grouped(none)} that didn't`;

  function sentence<T extends Whole>(name: string, get: (s: Arm) => T, over: (xs: T[]) => string | bigint, total: (b: string | bigint, h: string | bigint, moved: boolean) => string, up: string, down: string): [boolean, string] {
    const rose = runs.filter((u) => get(u.head) > get(u.base)).length;
    const fell = runs.filter((u) => get(u.head) < get(u.base)).length;
    const [b, h] = [over(runs.map((u) => get(u.base))), over(runs.map((u) => get(u.head)))];
    if (!rose && !fell) return [false, `${name}: ${total(b, h, false)}, moved in no run.`];
    const split = rose && fell ? `${up} in ${counted(rose, "run", "runs")}, ${down} in ${grouped(fell)}` : rose ? `${up} in ${counted(rose, "run", "runs")}` : `${down} in ${counted(fell, "run", "runs")}`;
    return [true, `${name}: ${split}; ${total(b, h, true)}.`];
  }

  const of = (f: (typeof CONTEXT)[number]) => (s: Arm) => s.context![f];
  const total = (xs: Whole[]) => xs.reduce<bigint>((s, x) => s + big(x), 0n);
  const most = (xs: Whole[]) => xs.reduce<bigint>((m, x) => (big(x) > m ? big(x) : m), big(xs[0]!));
  const summed = (b: string | bigint, h: string | bigint) => (b === h ? `${grouped(b as bigint)} in both` : `${grouped(b as bigint)} → ${grouped(h as bigint)} in all`);
  const held = (b: string | bigint, h: string | bigint, moved: boolean) =>
    !moved ? `${grouped(b as bigint)} tokens in both` : b === h ? `${grouped(b as bigint)} tokens at most in both` : `${grouped(b as bigint)} → ${grouped(h as bigint)} tokens at most`;
  const said: [boolean, string][] = [
    sentence("Seams", of("seams"), total, summed, "more", "fewer"),
    sentence("Tokens in the parts they changed or took out", of("out"), total, summed, "more", "fewer"),
    sentence("The most one agent request held", of("peak"), most, held, "higher", "lower"),
    sentence("The summariser's requests", (s) => summariser(s).requests, total, summed, "more", "fewer"),
  ];
  const sides = ["base", "head"] as const;
  if (runs.every((u) => sides.every((side) => priced(u[side]))) && runs.some((u) => sides.some((side) => Object.hasOwn(kind(u[side].kinds, "summariser") ?? {}, "cost")))) {
    const unpricedOf = (s: Arm) => (Object.hasOwn(summariser(s), "unpriced") ? big(summariser(s).unpriced!) : 0n);
    const [b, h] = sides.map((side) => runs.reduce((s, u) => s + unpricedOf(u[side]), 0n)) as [bigint, bigint];
    const unpriced = b || h ? `, leaving out ${b === h ? counted(b, "request", "requests") : `${grouped(b)} → ${counted(h, "request", "requests")}`} with no list price` : "";
    const price = (s: Arm) => Number(fixed(fromJson(Object.hasOwn(summariser(s), "cost") ? summariser(s).cost! : 0), 4));
    said.push(
      sentence(
        `Their list price${unpriced}`,
        price,
        (xs) => `USD ${fixed(sum(xs.map((x) => ({ float: x }))), 4)}`,
        (b, h) => (b === h ? `${b} in both` : `${b} → ${h} in all`),
        "higher",
        "lower",
      ),
    );
    said.push([runs.some((u) => unpricedOf(u.base) !== unpricedOf(u.head)), ""]);
  }
  if (!said.some(([moved]) => moved) && !runs.some(contextMoved))
    return [
      `Context in ${scope}: in each run, the number of seams, the tokens in the parts they changed or took out, the most one agent request held and the number of summariser requests stayed the same. ${link}`,
    ];
  const largest = runs.filter((u) => big(u.base.context!.largest) !== big(u.head.context!.largest)).length;
  const only = largest && !said.slice(0, 3).some(([moved]) => moved) ? [`The largest seam moved in ${counted(largest, "run", "runs")}, in the fold below.`] : [];
  return [`Context in ${scope}, base → head. ${[...said.filter(([, text]) => text).map(([, text]) => text), ...only].join(" ")} ${link}`];
}

export function contextFold(view: View, room: number): string[] {
  const runs = (view.usage ?? []).filter(gaveContext);
  const moved = runs.filter(contextMoved);
  if (!moved.length) return [];
  const change = (u: RunUsage, f: (typeof CONTEXT)[number]) => {
    const d = big(u.head.context![f]) - big(u.base.context![f]);
    return d < 0n ? -d : d;
  };
  const by = (x: bigint, y: bigint) => (x > y ? -1 : x < y ? 1 : 0);
  moved.sort((a, b) => by(change(a, "seams"), change(b, "seams")) || by(change(a, "out"), change(b, "out")) || by(change(a, "peak"), change(b, "peak")) || cpCompare(a.run, b.run));
  const cell = (u: RunUsage, f: (typeof CONTEXT)[number]) =>
    big(u.base.context![f]) === big(u.head.context![f]) ? grouped(u.base.context![f]) : `${grouped(u.base.context![f])} → ${grouped(u.head.context![f])}`;
  const rows = [
    "| run | seams | tokens in parts changed or taken out | largest seam | most held |",
    "| --- | --- | --- | --- | --- |",
    ...moved.map((u) => `| ${code(u.run)} | ${CONTEXT.map((f) => cell(u, f)).join(" | ")} |`),
  ];
  return folded(summaryText(`Context that differs: ${grouped(moved.length)} of ${grouped(runs.length)} runs, base → head`), [rows.join("\n")], room);
}

export const UPGRADED = "Upgraded runs beside their fresh twins";

function calibrationSaid(c: Calibration | null): string {
  if (c === null) return "isn't reported";
  return (truthy(item(c, "provisional")) ? "ends unconfirmed" : "ends confirmed") + (truthy(item(c, "reset")) ? " after a reset" : "");
}

const droppedSaid = (n: Whole): string => (big(n) ? `had ${counted(n, "thinking block", "thinking blocks")} dropped` : "had none dropped");

function lastSaid(n: Whole | null, upgraded: boolean): string {
  if (n === null) return upgraded ? "none of its agent's requests was answered" : "none of the fresh run's agent's requests was answered";
  return upgraded ? `its last request ${droppedSaid(n)}` : `the fresh run's ${droppedSaid(n)}`;
}

const END_STATES: [(e: End) => boolean | null, (u: End, t: End) => string][] = [
  [(e) => (e.calibration === null ? null : (item(e.calibration, "provisional") as boolean)), (u, t) => `the calibration ${calibrationSaid(u.calibration)}, where the fresh run's ${calibrationSaid(t.calibration)}`],
  [(e) => (e.lastDropped === null ? null : big(e.lastDropped) > 0n), (u, t) => `${lastSaid(u.lastDropped, true)}, where ${lastSaid(t.lastDropped, false)}`],
];

function flagSaid([check, what, step]: Kind): string {
  return what ? `check ${pyStr(check)}'s ${code(what)}` : step ? `check ${pyStr(check)} at step ${code(step)}` : `check ${pyStr(check)}`;
}

type Who = "run" | "twin";
type Differing = [Who, Kind];

function flagDifferences(u: Upgrade, side: "base" | "head"): Differing[] {
  const keys = (who: Who) => new Map(u[side][who].flags.map((k) => [JSON.stringify(k.map((x) => (typeof x === "bigint" ? x.toString() : x))), k] as const));
  const [run, twin] = [keys("run"), keys("twin")];
  const out: Differing[] = [...[...run].filter(([key]) => !twin.has(key)).map(([, k]): Differing => ["run", k]), ...[...twin].filter(([key]) => !run.has(key)).map(([, k]): Differing => ["twin", k])];
  return out.sort(compareDiffering);
}

function compareDiffering([wa, [ca, xa, sa]]: Differing, [wb, [cb, xb, sb]]: Differing): number {
  return cpCompare(wa, wb) || (big(ca) < big(cb) ? -1 : big(ca) > big(cb) ? 1 : 0) || cpCompare(xa, xb) || cpCompare(sa, sb);
}

const keyOf = ([who, k]: Differing) => JSON.stringify([who, k.map((x) => (typeof x === "bigint" ? x.toString() : x))]);

export function upgradeLines(view: View): string[] {
  const out: string[] = [];
  for (const u of view.upgrades ?? []) {
    const parts: string[] = [];
    for (const [key, said] of END_STATES) {
      const differs = { base: key(u.base.run) !== key(u.base.twin), head: key(u.head.run) !== key(u.head.twin) };
      const texts = { base: said(u.base.run, u.base.twin), head: said(u.head.run, u.head.twin) };
      if (differs.base && differs.head) parts.push(texts.base === texts.head ? `${texts.head}, on both sides` : `on the base, ${texts.base}, and on the head, ${texts.head}`);
      else if (differs.head) parts.push(`${texts.head}, on the head only, so the change makes that`);
      else if (differs.base) parts.push(`${texts.base}, on the base only, so the change ends that`);
    }
    const [base, head] = [flagDifferences(u, "base"), flagDifferences(u, "head")];
    const [baseKeys, headKeys] = [new Set(base.map(keyOf)), new Set(head.map(keyOf))];
    for (const [differing, where] of [
      [head.filter((d) => !baseKeys.has(keyOf(d))), "on the head only, so the change makes that"],
      [base.filter((d) => !headKeys.has(keyOf(d))), "on the base only, so the change ends that"],
    ] as const)
      for (const whose of ["run", "twin"] as const) {
        const kinds = differing.filter(([who]) => who === whose).map(([, kind]) => flagSaid(kind));
        if (kinds.length) parts.push(`${whose === "run" ? "it raises" : "the fresh run raises"} ${listed(kinds)} where ${whose === "run" ? "the fresh run doesn" : "it doesn"}'t, ${where}`);
      }
    if (!parts.length) continue;
    const standing = base.filter((d) => headKeys.has(keyOf(d))).length;
    if (standing) parts.push(`${counted(standing, "flag differs", "flags differ")} from its twin's on both sides, named under "${UPGRADED}", below`);
    out.push(`From a store connectome-host ${code(u.release)} wrote, ${code(u.run)} beside its fresh twin ${code(u.twin)}: ${parts.join("; ")}.`);
  }
  return out;
}

export function upgradesFold(view: View, room: number): string[] {
  const upgrades = view.upgrades ?? [];
  if (!upgrades.length) return [];
  const usage = new Map((view.usage ?? []).map((u) => [item(u as unknown as Json, "run") as string, u] as const));
  const of = (run: string): RunUsage => {
    const u = usage.get(run);
    if (u === undefined) throw Object.assign(new Error(pyRepr(run)), { name: "KeyError" });
    return u;
  };
  const runs = [...new Set(upgrades.flatMap((u) => [u.run, u.twin]))];
  const items: string[] = [];
  for (const side of ["base", "head"] as const) {
    const rows = [
      `| On the ${side} | requests | tokens sent a request | read from the cache | written to it | output | thinking dropped | last request dropped | calibration |`,
      `|${" --- |".repeat(9)}`,
    ];
    for (const run of runs) {
      const arm = of(run)[side];
      const whole = kind(arm.kinds, "agent") ?? ZERO;
      const history = (arm.history && kind(arm.history, "agent")) ?? ZERO;
      const k = Object.fromEntries(FIGURES.map((f) => [f, big(whole[f]) - big(history[f])])) as Counts;
      const c = arm.calibration;
      const calibration = c === null ? "not reported" : `${fixed(fromJson(item(c, "multiplier") as Whole), 2)}, ${cpSlice(calibrationSaid(c), 5)}`;
      const last = arm.lastDropped;
      rows.push(
        `| ${code(run)} | ${grouped(k.requests)} | ${perRequest(k)} | ${cached(k)} | ${grouped(k.cacheWrite)} | ${grouped(k.output)} | ${grouped(k.dropped)} | ${last === null ? "no request" : grouped(last)} | ${calibration} |`,
      );
    }
    items.push(rows.join("\n"));
  }
  if (runs.some((run) => (["base", "head"] as const).some((side) => entries(of(run)[side].history ?? {}).length)))
    items.push(
      "A run that writes its own history first, as a fresh twin does, is shown without that history's requests, so its figures are its workload's alone, as the upgraded runs' are.",
    );
  for (const u of upgrades)
    for (const side of ["base", "head"] as const) {
      const differ = flagDifferences(u, side);
      if (differ.length)
        items.push(
          `On the ${side}, ${code(u.run)} and its twin differ in flags: ${listed(differ.map(([whose, kind]) => `${flagSaid(kind)}, raised by ${whose === "run" ? "the upgraded run" : "the fresh run"} only`))}.`,
        );
    }
  return folded(summaryText(UPGRADED), items, room);
}
