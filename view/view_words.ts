import {
  ACTIVE,
  code,
  COMMENT_MAX,
  cpCompare,
  cpLength,
  cpSlice,
  dumps,
  ended,
  Failed,
  get,
  grouped,
  inert,
  item,
  need,
  oneLine,
  ordered,
  pyEquals,
  pyRepr,
  pyStr,
  rsplit,
  rstrip,
  runs,
  seen,
  SPACE,
  split,
  truthy,
  type Json,
} from "review-workflow/view";

type Dict = { [key: string]: Json };

const isDict = (v: Json): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

const unhashable = (v: Json): string | null => (Array.isArray(v) ? "list" : isDict(v) ? "dict" : null);

const scalarKey = (v: Json): string => {
  if (typeof v === "boolean") return `i:${Number(v)}`;
  if (typeof v === "bigint") return `i:${v}`;
  if (typeof v === "number") return Number.isInteger(v) ? `i:${BigInt(v)}` : `f:${v}`;
  return v === null ? "null" : `s:${String(v)}`;
};

const hashKey = (v: Json, as: "dict key" | "set element"): string => {
  const type = unhashable(v);
  if (type) throw new TypeError(`cannot use '${type}' as a ${as} (unhashable type: '${type}')`);
  return scalarKey(v);
};

const tupleKey = (items: readonly Json[], as: "dict key" | "set element"): string => {
  for (const v of items) {
    const type = unhashable(v);
    if (type) throw new TypeError(`cannot use 'tuple' as a ${as} (unhashable type: '${type}')`);
  }
  return JSON.stringify(items.map(scalarKey));
};

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
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v))) return v;
  throw new TypeError(`an int is needed here, not ${pyRepr(v)}`);
};

const or = (a: Json, b: Json): Json => (truthy(a) ? a : b);

const getOr = (v: Json, key: string, fallback: Json): Json => {
  const d = dict(v);
  return Object.hasOwn(d, key) ? d[key]! : fallback;
};

const has = (container: Json, key: Json): boolean => {
  if (isDict(container)) return typeof key === "string" && Object.hasOwn(container, key);
  if (Array.isArray(container)) return container.some((x) => pyEquals(x, key));
  if (typeof container === "string" && typeof key === "string") return container.includes(key);
  throw new TypeError(`${pyRepr(key)} can't be looked for in ${pyRepr(container)}`);
};

const lookup = (table: Readonly<Record<string, string>>, key: Json): string => {
  hashKey(key, "dict key");
  if (typeof key !== "string" || !Object.hasOwn(table, key)) throw Object.assign(new Error(pyRepr(key)), { name: "KeyError" });
  return table[key]!;
};

const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

const index = <T>(items: readonly T[], i: number): T => {
  const at = i < 0 ? items.length + i : i;
  if (at < 0 || at >= items.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
  return items[at]!;
};

const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function counted(n: number | bigint, one: string, many: string): string {
  return `${grouped(n)} ${Number(n) === 1 ? one : many}`;
}

export function listed(names: Iterable<string>): string {
  const all = [...names];
  if (!all.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
  return all.length === 1 ? all[0]! : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]!}`;
}

export function summaryText(text: unknown): string {
  const line = oneLine(text);
  const out: string[] = [];
  let at = 0;
  for (const m of line.matchAll(ACTIVE)) {
    out.push(escapeHtml(line.slice(at, m.index)), `<code>${escapeHtml(m[0])}</code>`);
    at = m.index + m[0].length;
  }
  return [...out, escapeHtml(line.slice(at))].join("");
}

export function folded(summary: string, items: readonly string[], room: number): string[] {
  const wrap = (name: string, body: readonly string[]) => [`<details><summary>${name}</summary>`, ...body, "</details>"].join("\n\n");
  const out: string[] = [];
  let body: string[] = [];
  for (const one of items) {
    let name = out.length ? `${summary}, continued` : summary;
    if (body.length && cpLength(wrap(name, [...body, one])) > room) {
      out.push(wrap(name, body));
      body = [];
      name = `${summary}, continued`;
    }
    need(
      cpLength(wrap(name, [one])) <= room,
      `one line of ${pyRepr(summary)} doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters: ${cpSlice(one, 0, 200)}`,
    );
    body.push(one);
  }
  if (body.length) out.push(wrap(out.length ? `${summary}, continued` : summary, body));
  return out;
}

export const HARNESS = "anima-research/context-view";

export const ARMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "arm-missing": { before: "base", after: "head" },
  "needs-companion": { base: "base", head: "head" },
};

const head12 = (v: Json): string => code(cpSlice(str(v), 0, 12));

export function opening(view: Json, first: string, headNow: string): string {
  const joined = item(view, "outcome") === "doesnt-merge" ? "against" : "merged onto";
  let text = `**Automatic context view** of ${head12(item(view, "head"))} ${joined} ${head12(item(view, "base"))}.`;
  if (first !== item(view, "head")) text += since(view, `as at ${code(cpSlice(first, 0, 12))}, where this comment was first posted.`);
  if (headNow !== item(view, "head")) text += ` The pull request's head has since moved to ${code(cpSlice(headNow, 0, 12))}.`;
  return text;
}

function since(view: Json, at: string): string {
  if (item(view, "outcome") !== "ran" || !truthy(item(item(view, "runs"), "compared"))) return ` It couldn't be compared for the same reasons ${at}`;
  if (truthy(get(view, "broken"))) {
    const shown = truthy(item(view, "entries")) ? "the same differences from the base" : "no difference from the base";
    return ` Its runs show ${shown}, and couldn't be compared at the same runs for the same reasons, ${at}`;
  }
  if (truthy(item(view, "entries"))) return ` Its runs show the same differences from the base ${at}`;
  return ` Its runs show no difference from the base, ${at}`;
}

export function widest(view: Json): number {
  return cpLength(opening({ ...dict(view), head: "f".repeat(40) }, "0".repeat(40), "e".repeat(40)));
}

function written(text: Json): string {
  return pyStr(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const longestTicks = (text: string): number => {
  let most = 0;
  for (const m of text.matchAll(/`+/g)) most = Math.max(most, m[0].length);
  return most;
};

function fence(text: Json): string {
  const shown = written(text);
  const ticks = longestTicks(shown);
  const f = "`".repeat(Math.max(3, ticks + 1));
  return `${f}text\n${shown}\n${f}`;
}

export function clipped(words: (shown: string, part: string) => string, text: string, room: number): string {
  const said = words(text, "");
  if (cpLength(said) <= room) return said;
  const cut = whole(text);
  const total = seen(text);
  const shown = (k: number) => {
    const end = cpLength(rstrip(cpSlice(text, 0, cut(k))));
    const prefix = cpSlice(text, 0, end);
    return words(prefix, `'s first ${grouped(seen(prefix))} of ${grouped(total)} characters`);
  };
  need(cpLength(shown(0)) <= room, `a paragraph doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters even with its text cut`);
  let lo = 0;
  let hi = cpLength(text) - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (cpLength(shown(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return shown(lo);
}

function whole(text: string): (k: number) => number {
  const spans: [number, number][] = [];
  for (const [isCode, piece, start, end] of runs(text)) {
    if (isCode) {
      spans.push([start, end]);
      continue;
    }
    let unit = 0;
    let point = start;
    for (const m of piece.matchAll(/`+/g)) {
      point += cpLength(piece.slice(unit, m.index));
      unit = m.index;
      spans.push([point, point + m[0].length]);
    }
  }
  const starts = spans.map(([s]) => s);
  return (k) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < k) lo = mid + 1;
      else hi = mid;
    }
    const at = lo - 1;
    return at >= 0 && spans[at]![1] > k ? spans[at]![0] : k;
  };
}

const SAID: Readonly<Record<string, string>> = {
  head: "the head couldn't run it",
  base: "the base couldn't run it",
  varies:
    "its self-check, which drives this head again with recording off, didn't find the two drives' requests the same, so a difference from the base can't be put down to the change alone",
  unchecked: "the head wasn't self-checked",
  outcome: "the harness gave it an outcome the view doesn't know",
  drive: "the head's second drive, with recording off, couldn't show that recording changes nothing it sends",
};

export function couldNot(view: Json, room: number): string[] {
  const kind = item(view, "outcome");
  const detail = or(get(view, "detail"), {});
  if (kind === "doesnt-merge")
    return [
      `This head couldn't be compared: it conflicts with ${code(oneLine(item(view, "baseRef")))} at ${head12(item(view, "base"))}, ` +
        "and a view runs the head merged onto its base, so those conflicts need resolving before it can be viewed.",
    ];
  if (kind === "needs-companion") return [companionStop(detail)];
  if (kind === "arm-missing") {
    const log = oneLine(or(get(detail, "log"), ""));
    const lead =
      `This head couldn't be compared: one of its ${counted(int(item(view, "jobs")), "job", "jobs")} came back without the ` +
      `${lookup(ARMS[kind]!, item(detail, "arm"))} arm's results`;
    return [log ? clipped((shown, part) => lead + ` (its last log line${part}: ${inert(shown)}).`, log, room) : `${lead}.`];
  }
  const why = (b: Json): string => {
    const parts: string[] = [];
    const what = item(b, "what");
    if (what === "unmeasured") {
      const sides = ordered(dict(item(b, "unmeasured")))
        .filter(([, names]) => truthy(names as Json))
        .map(([arm, names]) => `on the ${arm}, ${listed(list(names as Json).map((x) => inert(x)))}`);
      parts.push(`the run didn't measure (${sides.join("; ")})`);
    } else if (what !== "read") parts.push(lookup(SAID, item(b, "what")));
    const failed = ordered(dict(or(get(b, "reads"), {})))
      .filter(([, names]) => truthy(names as Json))
      .map(([arm, names]) => {
        const all = list(names as Json);
        return `the ${arm}'s ${all.length === 1 ? "read" : "reads"} of ${listed(all.map((x) => inert(x)))}`;
      });
    if (failed.length) parts.push(failed.length === 1 ? `${failed[0]!} failed` : `${failed.join(", and ")}, failed`);
    if (truthy(get(b, "unreadable"))) parts.push("the head's quarantine count couldn't be read");
    return parts.join(", and ");
  };
  const reason = (b: Json): string => {
    const words = (shown: string, part: string) => {
      const said = [shown ? inert(shown) : "", part ? `the reason${part}` : ""].filter((x) => x);
      return `This head couldn't be compared at ${code(str(item(b, "run")))}: ${why(b)}` + (said.length ? ` (${said.join(", ")}).` : ".");
    };
    return clipped(words, oneLine(item(b, "reason")), room);
  };
  return list(or(get(view, "broken"), [])).map(reason);
}

const SCOPE = "@animalabs/";

const short = (name: string): string => (name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name);

export const CHOSEN = new RegExp(`^(@animalabs/[^/@${SPACE}]+)@([^/@${SPACE}]+)$`, "u");

function asker(wantedBy: Json, side: string): string {
  if (wantedBy === null) return side === "head" ? "it" : "its base";
  const m = CHOSEN.exec(str(wantedBy));
  if (m) return `${inert(short(m[1]!))} ${code(m[2]!)}, which the view chose for the ${side},`;
  return `${fromWhom(wantedBy, side)} in the host's stack`;
}

function fromWhom(wantedBy: Json, side: string): string {
  if (wantedBy === null) return side === "head" ? "this head" : "the base";
  const m = CHOSEN.exec(str(wantedBy));
  if (m) return `${inert(short(m[1]!))} ${code(m[2]!)}`;
  return inert(short(rsplit(str(wantedBy), "node_modules/", 1).at(-1)!));
}

function rangesSaid(ranges: Json[], side: string): string {
  return listed(ranges.map((r) => `${code(str(item(r, "range")))} from ${fromWhom(item(r, "wantedBy"), side)}`));
}

function lacking(name: string, c: Json, side: string): string {
  const m = item(c, "missed");
  const held = `connectome-host's lockfile holds ${code(str(item(c, "host")))}`;
  if (item(m, "package") === name) return `${held}, which doesn't meet ${code(str(item(m, "range")))} from ${fromWhom(item(m, "wantedBy"), side)}`;
  return (
    `${held}, and with it ${fromWhom(item(m, "wantedBy"), side)} asks for ${inert(short(str(item(m, "package"))))} ${code(str(item(m, "range")))}, ` +
    `which the ${side}'s ${code(pyStr(item(m, "has")))} doesn't meet`
  );
}

function companionStop(d: Json): string {
  const side = lookup(ARMS["needs-companion"]!, item(d, "arm"));
  const why = get(d, "why");
  const lead =
    `This head couldn't be compared: ${asker(get(d, "wantedBy"), side)} asks for ${inert(short(pyStr(get(d, "package"))))} ` +
    `${code(pyStr(get(d, "range")))}`;
  if (why === "not-plain") return `${lead}, which isn't a version range, so the view can't choose a release to meet it.`;
  if (why === "no-mover") {
    if (get(d, "has") === null) return `${lead}, and the ${side}'s ${code("package.json")} gives no version.`;
    return (
      `${lead}, and the ${side}'s is ${code(pyStr(item(d, "has")))}. The view chooses releases only of agent-framework, context-manager, ` +
      "membrane and chronicle where connectome-host's lockfile holds them at its top level, so it can't change that."
    );
  }
  if (why === "no-release") {
    const ranges = list(or(get(d, "ranges"), []));
    const name = inert(short(pyStr(get(d, "release"))));
    if (!ranges.length) return `${lead}, and ${name} has no published release.`;
    const alone =
      ranges.length === 1 &&
      pyEquals(get(d, "release"), get(d, "package")) &&
      pyEquals(ranges[0]!, { range: get(d, "range"), wantedBy: get(d, "wantedBy") });
    return `${lead}, and no published release of ${name} ` + (alone ? "meets it." : `meets every range on it in the ${side}'s stack (${rangesSaid(ranges, side)}).`);
  }
  if (why === "unsettled") {
    const tried = ordered(dict(or(get(d, "tried"), {}))).sort(([a], [b]) => cpCompare(a, b));
    const said = tried.length ? ` The ${side}'s were ${listed(tried.map(([n, v]) => `${inert(short(n))} ${code(str(v as Json))}`))}.` : "";
    return `${lead}, and choosing releases for the arms came back to choices it had already made, so it stopped there.${said}`;
  }
  throw new Failed(`manifest.json: a needs-companion the view doesn't know, ${pyRepr(why)}`);
}

export function heldText(view: Json): string | null {
  const given = dict(or(get(view, "held"), {}));
  const stack = or(get(view, "stack"), {});
  const chose = (k: string): string => {
    const name = `${SCOPE}${k}`;
    const sides = (["base", "head"] as const)
      .filter((side) => has(getOr(stack, side, {}), name))
      .map((side): [string, Json] => [side, item(item(stack, side), name)]);
    if (!sides.length) return "";
    const why = sides.find(([, c]) => has(c, "missed"));
    return why
      ? ` (the view chose it for both arms, since ${lacking(name, why[1], why[0])})`
      : ` (the view chose it for both arms, where connectome-host's lockfile has ${code(str(item(sides[0]![1], "host")))})`;
  };
  let held = ordered(given) as [string, Json][];
  if (item(view, "form") === "overlay") {
    const host = cpSlice(str(item(view, "host")), 0, 12);
    held = [["connectome-host", Object.hasOwn(given, "connectome-host") ? given["connectome-host"]! : host], ...held.filter(([k]) => k !== "connectome-host")];
  }
  return held.length ? "Held the same in base and head: " + held.map(([k, v]) => `${inert(k)} ${code(str(v))}${chose(k)}`).join(", ") + "." : null;
}

export function differingLine(view: Json): string[] {
  const differing = list(or(get(view, "differing"), []));
  const stack = or(get(view, "stack"), {});
  if (!differing.length) return [];
  const names = differing.map((d) => inert(item(d, "package")));
  const said = [
    `Besides this head, the arms ran different releases of ${listed(names)}: ` +
      differing
        .map(
          (d) =>
            (differing.length === 1 ? "" : `${inert(item(d, "package"))} `) +
            `${code(str(item(d, "base")))} in the base and ${code(str(item(d, "head")))} in the head`,
        )
        .join("; ") +
      ".",
  ];
  for (const d of differing) {
    for (const side of ["base", "head"]) {
      const name = `${SCOPE}${pyStr(item(d, "package"))}`;
      const c = getOr(getOr(stack, side, {}), name, null);
      if (c === null) continue;
      said.push(
        `The view chose the ${side}'s ${inert(item(d, "package"))} ${code(str(item(c, "version")))}, ` +
          (has(c, "missed") ? `since ${lacking(name, c, side)}.` : `where connectome-host's lockfile has ${code(str(item(c, "host")))}.`),
      );
    }
  }
  said.push(`So a difference this view shows may come from ${listed(names)} as well as from this head, and it can't tell which.`);
  return [said.join(" ")];
}

const FOUR = ["@animalabs/agent-framework", "@animalabs/context-manager", "@animalabs/membrane", "@animalabs/chronicle"];

export function forcedLine(view: Json): string[] {
  const forced = or(get(view, "forced"), {});
  const sides = ["base", "head"].filter((side) => truthy(get(forced, side)));
  if (!sides.length) return [];
  const name = inert(short(str(item(view, "pack"))));
  const pairsOf = (side: string) => new Set(list(or(get(forced, side), [])).map((f) => tupleKey([item(f, "range"), item(f, "wantedBy")], "set element")));
  const basePairs = pairsOf("base");
  const headPairs = pairsOf("head");
  const path = (wantedBy: Json) =>
    split(str(wantedBy), "node_modules/")
      .map((x) => rstrip(x, "/"))
      .filter((x) => x);
  const named = (wantedBy: Json): string => {
    const m = CHOSEN.exec(str(wantedBy));
    if (m) return inert(short(m[1]!));
    const at = path(wantedBy);
    return at.length === 1 ? inert(short(at[0]!)) : `${inert(short(index(at, -2)))}'s ${inert(short(index(at, -1)))}`;
  };
  const chosen = (wantedBy: Json): boolean => {
    if (CHOSEN.test(str(wantedBy))) return true;
    const at = path(wantedBy);
    return FOUR.some((x) => at.length === 1 && at[0] === x);
  };
  const ranges = (fs: Json[], side: string) =>
    listed(
      fs.map((f) => `${code(str(item(f, "range")))} from ${CHOSEN.test(str(item(f, "wantedBy"))) ? fromWhom(item(f, "wantedBy"), side) : named(item(f, "wantedBy"))}`),
    );
  const why = (fs: Json[], admitted: string) => {
    const moved = unique(fs.filter((f) => chosen(item(f, "wantedBy"))).map((f) => named(item(f, "wantedBy"))));
    const fixed = unique(fs.filter((f) => !chosen(item(f, "wantedBy"))).map((f) => named(item(f, "wantedBy"))));
    const said = [
      ...(moved.length ? [`it could choose no release of ${listed(moved)} that admits ${admitted}`] : []),
      ...(fixed.length
        ? [
            "the view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile " +
              `holds them at its top level, so it couldn't choose a release of ${listed(fixed)}`,
          ]
        : []),
    ];
    return said.join(", and ");
  };
  const over = (fs: Json[]) => (fs.length === 1 ? "a range" : "ranges");
  const those = (fs: Json[]) => (fs.length === 1 ? "that range" : "those ranges");
  if (basePairs.size === headPairs.size && [...basePairs].every((p) => headPairs.has(p))) {
    const fs = list(item(forced, "base"));
    return [
      `In both arms, the view laid ${name} over ${ranges(fs, "base")}, ${over(fs)} that neither the base's ${code(str(item(fs[0]!, "has")))} nor the ` +
        `head's ${code(str(item(list(item(forced, "head"))[0]!, "has")))} meets: ${why(fs, "them")}. So any difference or failure this view shows may come from ` +
        `${those(fs)}, and the view can't tell whether it does.`,
    ];
  }
  let close: string;
  if (sides.length === 1 && sides[0] === "head")
    close =
      `So any difference this view shows, or any failure in the head, may come from ${those(list(item(forced, "head")))}, and the view ` +
      "can't tell whether it does.";
  else if (sides.length === 1 && sides[0] === "base")
    close =
      `So any difference this view shows, or any failure in the base or of a checkpoint, may come from ${those(list(item(forced, "base")))}, ` +
      "and the view can't tell whether it does.";
  else
    close =
      "So any difference this view shows may come from the ranges named for either arm, and the view can't tell whether it does. " +
      "Any failure in an arm may come from that arm's own ranges. A checkpoint's failure may come from the base's ranges. " +
      "The view can't tell whether either does.";
  return [
    [
      ...sides.map((side) => {
        const fs = list(item(forced, side));
        return (
          `In the ${side}, the view laid ${name} ${code(str(item(fs[0]!, "has")))} over ${ranges(fs, side)}, ${over(fs)} ` +
          `that version doesn't meet: ${why(fs, "it")}.`
        );
      }),
      close,
    ].join(" "),
  ];
}

export function flagsLine(view: Json, flagged: number): string {
  const flaggedRuns = new Set(
    list(or(get(view, "flags"), []))
      .filter((f) => truthy(item(f, "new")) || truthy(item(f, "gone")))
      .map((f) => hashKey(item(f, "run"), "set element")),
  ).size;
  const [differ, listedAs] = flagged === 1 ? ["differs", "it's"] : ["differ", "they're"];
  return (
    `Separately, ${grouped(flagged)} of the checks' flags ${differ} between the base and the head, in ` +
    `${counted(flaggedRuns, "run", "runs")}; ${listedAs} listed under "Checks' flags that differ", below.`
  );
}

type Group = { key: string; flag: Json; n: number; more: string; than: string };

export function flagsText(view: Json, room: number): string[] {
  const out: string[] = [];
  for (const f of list(or(get(view, "flags"), []))) {
    const groups: Group[] = [];
    for (const [side, more, than] of [
      ["new", "head", "base"],
      ["gone", "base", "head"],
    ] as const) {
      const times = new Map<string, Group>();
      for (const flag of list(item(f, side))) {
        const key = dumps(["check", "step", "what", "detail", "whole"].map((k) => get(flag, k)));
        const group = times.get(key) ?? { key, flag, n: 0, more, than };
        times.set(key, group);
        group.n += 1;
      }
      groups.push(...times.values());
    }
    const shown: [string, string][] = groups.map(({ flag }) => {
      const step = get(flag, "step");
      const where = step === null || step === "" || step === "the run" ? "" : ` step ${code(pyStr(step))}`;
      const said = [get(flag, "what"), get(flag, "detail")]
        .filter((x) => truthy(x))
        .map((x) => oneLine(x))
        .filter((t) => t)
        .join(": ");
      return [`${where}, check ${code(pyStr(get(flag, "check")))}`, said];
    });
    const alike = new Map<string, Set<string>>();
    groups.forEach(({ key }, i) => {
      const face = dumps(shown[i]!);
      if (!alike.has(face)) alike.set(face, new Set());
      alike.get(face)!.add(key);
    });
    groups.forEach(({ n, more, than }, i) => {
      const [place, said] = shown[i]!;
      const often = n === 1 ? "1 more time" : `${grouped(n)} more times`;
      const other = alike.get(dumps(shown[i]!))!.size > 1 ? " (another line of this run shows the same text for a different flag)" : "";
      const line = `- ${code(str(item(f, "run")))}${place}${other} flagged on the ${more} ${often} than on the ${than}`;
      if (!said) {
        out.push(line);
        return;
      }
      // The name and the detail are rendered as one text, so nothing GitHub would make live can form across the ': ' between them, as `:smile` and `: ` make an emoji.
      out.push(clipped((text, part) => line + (text ? `: ${inert(text)}` : "") + (part ? ` (the flag${part})` : ""), said, room));
    });
  }
  return out.length ? ["The checks' flags that differ between base and head:", ...out] : [];
}

export function known(change: Json, entries: ReadonlyMap<string, Json>): Json {
  need(truthy(item(change, "refs")), `change ${pyRepr(item(change, "title"))} names no entry`);
  const unknown = list(item(change, "refs")).filter((r) => {
    hashKey(r, "dict key");
    return typeof r !== "string" || !entries.has(r);
  });
  need(!unknown.length, `change ${pyRepr(item(change, "title"))} names ${pyRepr(unknown)} entries the view doesn't have`);
  return change;
}

const entryOf = (entries: ReadonlyMap<string, Json>, ref: Json): Json => {
  if (typeof ref !== "string" || !entries.has(ref)) throw Object.assign(new Error(pyRepr(ref)), { name: "KeyError" });
  return entries.get(ref)!;
};

const refsOf = (change: Json): Json[] => {
  const seenKeys = new Set<string>();
  return list(item(change, "refs")).filter((r) => {
    const k = hashKey(r, "dict key");
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
};

function quotedIn(change: Json, entries: ReadonlyMap<string, Json>): string {
  need(truthy(get(change, "place")), `change ${pyRepr(item(change, "title"))} names no place its quotes are from`);
  const run = pyStr(item(item(change, "place"), "run"));
  const step = pyStr(item(item(change, "place"), "step"));
  const places = new Set(refsOf(change).flatMap((r) => list(item(entryOf(entries, r), "places")).map((p) => tupleKey([item(p, "run"), pyStr(item(p, "step"))], "set element"))));
  need(places.has(tupleKey([run, step], "set element")), `change ${pyRepr(item(change, "title"))} is quoted from ${code(run)} at step ${code(step)}, a place it doesn't have`);
  return run;
}

export function changeBlock(change: Json, entries: ReadonlyMap<string, Json>, run: string, quoted: string, room: number): string {
  const steps = unique(
    refsOf(change).flatMap((r) =>
      list(item(entryOf(entries, r), "places"))
        .filter((p) => item(p, "run") === run)
        .map((p) => pyStr(item(p, "step"))),
    ),
  );
  const at = steps.length === 1 ? `At step ${code(steps[0]!)}` : `At ${counted(steps.length, "step", "steps")}`;
  const step = pyStr(item(item(change, "place"), "step"));
  const head = [`*${inert(oneLine(item(change, "title")))}*`];
  if (run !== quoted) {
    const said = [...head, `${at}. Its before and after are quoted under ${code(quoted)}, at step ${code(step)}.`].join("\n\n");
    need(cpLength(said) <= room, `change ${pyRepr(item(change, "title"))} doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters`);
    return said;
  }
  head.push(at + (steps.length === 1 && steps[0] === step ? "." : `; the quotes are from step ${code(step)}.`));
  const text = (keep: number | null): string => {
    const body = [...head];
    for (const side of ["before", "after"]) {
      const quote = pyStr(item(change, side));
      if (!quote) {
        body.push(`${capitalized(side)}: none.`);
        continue;
      }
      const shown = keep === null || cpLength(quote) <= keep ? quote : cpSlice(quote, 0, keep);
      const label =
        shown === quote
          ? `${capitalized(side)}:`
          : `${capitalized(side)}, its first ${grouped(cpLength(written(shown)))} of ${grouped(cpLength(written(quote)))} characters:`;
      body.push(label, fence(shown));
    }
    return body.join("\n\n");
  };
  const all = text(null);
  if (cpLength(all) <= room) return all;
  const sides = ["before", "after"].filter((side) => truthy(item(change, side))).map((side) => pyStr(item(change, side)));
  need(
    sides.length > 0,
    `change ${pyRepr(item(change, "title"))} doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters, and has no quote to cut`,
  );
  let keep = Math.max(0, Math.floor((room - cpLength(text(0))) / sides.length));
  let cut = text(keep);
  while (cpLength(cut) > room && keep > 0) {
    keep = Math.max(0, keep - Math.ceil((cpLength(cut) - room) / sides.length));
    cut = text(keep);
  }
  need(
    cpLength(cut) <= room,
    `change ${pyRepr(item(change, "title"))} doesn't fit in a comment of GitHub's ${grouped(COMMENT_MAX)} characters even with its quotes cut`,
  );
  return cut;
}

export const CHECKED = `What a context view runs and what its checks judge are in [CHECKS.md](https://github.com/${HARNESS}/blob/main/CHECKS.md).`;

export function linked(view: Json): string {
  return `What a context view runs and what its checks judge: [CHECKS.md](https://github.com/${HARNESS}/blob/${pyStr(item(item(view, "harness"), "sha"))}/CHECKS.md).`;
}

export function inside(room: number, summary: string): number {
  return room - cpLength(`<details><summary>${summary}, continued</summary>\n\n\n\n</details>`);
}

export function runFolds(view: Json, reader: Json, entries: ReadonlyMap<string, Json>, room: number): string[] {
  const changes = list(item(reader, "changes"));
  const quoted = changes.map((c) => quotedIn(c, entries));
  const out: string[] = [];
  for (const run of list(item(view, "order"))) {
    const here = changes
      .map((c, i): [Json, string] => [c, quoted[i]!])
      .filter(([c]) => refsOf(c).some((r) => list(item(entryOf(entries, r), "places")).some((p) => pyEquals(item(p, "run"), run))));
    if (here.length) {
      const summary = `<code>${escapeHtml(oneLine(run))}</code>: ${counted(here.length, "change", "changes")}`;
      out.push(...folded(summary, here.map(([c, q]) => changeBlock(c, entries, str(run), q, inside(room, summary))), room));
    }
  }
  return out;
}

function saidLine(change: Json, field: string): string {
  need(has(change, field), `change ${pyRepr(item(change, "title"))} gives no ${field}`);
  const text = item(change, field);
  const article = "aeiou".includes(field[0]!) ? "an" : "a";
  need(typeof text === "string" && oneLine(text) !== "", `change ${pyRepr(item(change, "title"))} gives ${article} ${field} that isn't a line of text`);
  return oneLine(text);
}

export function deltas(view: Json, reader: Json): string[] {
  return list(item(reader, "changes")).map((c, i) => {
    const n = i + 1;
    const follows = get(c, "follows");
    const unmentioned = get(c, "unmentioned");
    need(
      !has(c, "follows") || (typeof follows === "number" && Number.isInteger(follows) && 1 <= follows && follows < n),
      `change ${pyRepr(item(c, "title"))} follows ${pyRepr(follows)}, which isn't an earlier delta's number`,
    );
    need(!has(c, "unmentioned") || unmentioned === true, `change ${pyRepr(item(c, "title"))} gives unmentioned as ${pyRepr(unmentioned)}, not true`);
    return [
      `**Delta ${n}: ${inert(oneLine(item(c, "title")))}**` + (truthy(unmentioned) ? " (the description doesn't mention it)" : ""),
      ended(inert(saidLine(c, "where"))) + (truthy(follows) ? ` Follows from Delta ${pyStr(follows)}.` : ""),
      `- base (${code(oneLine(item(view, "baseRef")))}): ${ended(inert(saidLine(c, "base")))}\n` +
        `- head (${head12(item(view, "head"))}): ${ended(inert(saidLine(c, "head")))}` +
        (has(c, "also") ? `\n- Also in: ${ended(inert(saidLine(c, "also")))}` : ""),
    ].join("\n\n");
  });
}

export function absentLine(view: Json): string[] {
  const parts = list(or(get(view, "absent"), [])).flatMap((a) =>
    ["base", "head"]
      .filter((arm) => truthy(item(a, arm)))
      .map((arm) => `${code(str(item(a, "run")))}'s ${listed(list(item(a, arm)).map((x) => inert(x)))} on the ${arm}`),
  );
  return parts.length ? [`Parts left out where an arm's stack doesn't bring what they need: ${parts.join("; ")}.`] : [];
}

export function lostLine(lost: number): string {
  return lost === 1 ? "1 run couldn't be compared; its reason is below." : `${grouped(lost)} runs couldn't be compared; the reasons are below.`;
}

export const COMMAND = "/context-deltas";

export const ASKERS: readonly string[] = ["nissa-seru"];

export const UNREAD =
  `No model read these records for this view, which started on its own. A view asked for with a ${code(COMMAND)} comment by ` +
  `${ASKERS.map((a) => code(a)).join(" or ")} gives a model's account of the records of the pull request's head as it is when that view ` +
  "runs.";
