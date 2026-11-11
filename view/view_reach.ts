import { code, cpCompare, cpLength, grouped, inert, item, get, oneLine, ordered, truthy, type Json } from "review-workflow/view";
import { beyond, HOLDS, LISTS } from "./view_read.ts";
import { clipped, counted, listed } from "./view_words.ts";

export const LISTED = 360;

const list = (v: Json): Json[] => {
  if (!Array.isArray(v)) throw new TypeError("a list is needed here");
  return v;
};

const ints = (v: Json): number[] => list(v).map((n) => Number(n));

const str = (v: Json): string => {
  if (typeof v !== "string") throw new TypeError("a str is needed here");
  return v;
};

const sortedFiles = (files: Json): [string, Json][] => (ordered(files as object) as [string, Json][]).sort(([a], [b]) => cpCompare(a, b));

export function spans(lines: readonly number[]): [string, number][] {
  const out: [number, number][] = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => [b > a ? `${a}–${b}` : `${a}`, b - a + 1]);
}

const atLines = (spansOf: readonly string[]): string => `${spansOf.length === 1 && !spansOf[0]!.includes("–") ? "line" : "lines"} ${listed(spansOf)}`;

function fitted<T>(items: readonly T[], render: (xs: readonly T[]) => string): number {
  let k = 1;
  while (k < items.length && cpLength(render(items.slice(0, k + 1))) <= LISTED) k += 1;
  return k;
}

type Counted = readonly [string, unknown, number];

const unlisted = (rest: readonly Counted[], noun = "line"): string =>
  `${counted(rest.reduce((n, x) => n + x[2], 0), `more ${noun}`, `more ${noun}s`)} in ${counted(new Set(rest.map((x) => x[0])).size, "file", "files")}`;

function byFile<P>(items: readonly (readonly [string, P, number])[], each: (name: string, pieces: P[]) => string): string[] {
  const out = new Map<string, P[]>();
  for (const [name, piece] of items) {
    if (!out.has(name)) out.set(name, []);
    out.get(name)!.push(piece);
  }
  return [...out].map(([name, pieces]) => each(name, pieces));
}

function reasonSaid(prefix: string, reason: Json, after: string, cuts: unknown[], room: number | null = null): string {
  const words = (shown: string, part: string) => `${prefix}${inert(shown)}` + (part ? ` (the reason${part})` : "") + after;
  const said = clipped(words, oneLine(reason), room === null ? cpLength(words("", "")) + LISTED : room);
  if (said !== words(oneLine(reason), "")) cuts.push(reason);
  return said;
}

const afterLines = (afters: readonly number[]): string => `after ${afters.length === 1 ? "line" : "lines"} ${listed(afters.map((a) => String(a)))}`;

export function reachParagraph(reach: Json): string {
  return reachSaid(reach)[0];
}

const delsOf = (f: Json, ...states: string[]): number[] =>
  list(item(f, "deletions"))
    .filter((x) => states.includes(item(x, "state") as string))
    .map((x) => Number(item(x, "after")));

export function reachSaid(reach: Json): [string, boolean] {
  const cuts: unknown[] = [];
  if (Object.hasOwn(reach as object, "couldnt")) {
    const said = reasonSaid("Couldn't tell which of this change's source lines ran: ", item(reach, "couldnt"), ".", cuts);
    return [said + (cuts.length ? " The whole reason is in the fold below." : ""), cuts.length > 0];
  }
  const files = sortedFiles(item(reach, "files"));
  const notes = list(item(reach, "notes"));
  if (!files.length) return [`This change adds or edits no line under ${code("src/")}.`, false];
  const loaded = files.filter(([, f]) => item(f, "state") === "read");
  const unread = files.filter(([, f]) => item(f, "state") === "not-loaded");
  const untold = files.filter(([, f]) => item(f, "state") !== "not-loaded");
  const lost = (f: Json): number[] => [...ints(item(f, "couldntTell")), ...(item(f, "state") === "couldnt-tell" ? ints(item(f, "unloaded")) : [])];
  const out: string[] = [];
  const notRan = loaded.flatMap(([n, f]) => spans(ints(item(f, "notRan"))).map(([s, c]): readonly [string, string, number] => [n, s, c]));
  if (notRan.length) {
    const render = (xs: readonly (readonly [string, string, number])[]) => byFile(xs, (n, ps) => `${code(n)} ${atLines(ps)}`).join("; ");
    const k = fitted(notRan, render);
    cuts.push(...notRan.slice(k));
    const nLines = notRan.reduce((n, [, , c]) => n + c, 0);
    out.push(
      `**In the files profiled hosts loaded, ${counted(nLines, "changed source line that maps", "changed source lines that map")} ` +
        `to code ran in no profiled drive:** ${render(notRan.slice(0, k))}` +
        (notRan.slice(k).length ? `; and ${unlisted(notRan.slice(k))}` : "") +
        ".",
    );
  }
  if (unread.length) {
    const held = (f: Json): string => {
      const lines = LISTS.reduce((n, k) => n + list(item(f, k)).length, 0);
      const ds = list(item(f, "deletions")).length;
      return [lines ? counted(lines, "changed line", "changed lines") : "", ds ? counted(ds, "deletion", "deletions") : ""].filter((x) => x).join(" and ");
    };
    const items = unread.map(([n, f]): readonly [string, string, number] => [n, `${code(n)} (${held(f)})`, 1]);
    const render = (xs: readonly (readonly [string, string, number])[], more = "") => {
      const names = [...xs.map((x) => x[1]), ...(more ? [more] : [])];
      return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]!}`;
    };
    const k = fitted(items, (xs) => render(xs));
    const rest = items.slice(k);
    cuts.push(...rest);
    out.push(`**No profiled host loaded ${render(items.slice(0, k), rest.length ? counted(rest.length, "more file", "more files") : "")}.**`);
  }
  const unreached = loaded.flatMap(([n, f]) => delsOf(f, "not-reached").map((a): readonly [string, number, number] => [n, a, 1]));
  if (unreached.length) {
    const render = (xs: readonly (readonly [string, number, number])[]) =>
      byFile(xs, (n, afters) => `${code(n)}, the ${afters.length === 1 ? "one" : "ones"} ${afterLines(afters)}`).join("; ");
    const k = fitted(unreached, render);
    cuts.push(...unreached.slice(k));
    out.push(
      `No profiled drive reached ${grouped(unreached.length)} of this change's deletions: ${render(unreached.slice(0, k))}` +
        (unreached.slice(k).length ? `; and ${unlisted(unreached.slice(k), "deletion")}` : "") +
        ".",
    );
  }
  const toldDelsOf = (f: Json) => [...delsOf(f, "couldnt-tell"), ...(item(f, "state") === "couldnt-tell" ? delsOf(f, "unloaded") : [])];
  const toldLines = untold.reduce((n, [, f]) => n + lost(f).length, 0);
  const toldBins = untold.filter(([, f]) => truthy(get(f, "binary"))).map(([n]) => n);
  const toldDels = untold.reduce((n, [, f]) => n + toldDelsOf(f).length, 0);
  const ran = loaded.reduce((n, [, f]) => n + list(item(f, "ran")).length, 0);
  const reached = loaded.reduce((n, [, f]) => n + delsOf(f, "reached").length, 0);
  const told = toldLines || toldDels || toldBins.length;
  if (!(notRan.length || unread.length || unreached.length || told) && (ran || reached)) {
    let lead = "";
    if (ran === 1) lead = "This change's 1 changed source line that maps to code ran in at least one profiled drive";
    else if (ran) lead = `All ${grouped(ran)} of this change's changed source lines that map to code ran in at least one profiled drive`;
    if (ran && reached)
      out.push(lead + (reached === 1 ? ", as did code beside 1 of its deletions." : `, as did code beside each of ${grouped(reached)} of its deletions.`));
    else if (ran) out.push(`${lead}.`);
    else
      out.push(
        (reached === 1 ? "Code beside 1 of this change's deletions" : `Code beside each of ${grouped(reached)} of this change's deletions`) +
          " ran in at least one profiled drive.",
      );
  }
  if (told && notes.length) {
    const whether = [
      toldLines ? `whether ${counted(toldLines, "changed source line", "changed source lines")} ran` : "",
      toldDels ? `whether ${counted(toldDels, "deletion was", "deletions were")} reached` : "",
      toldBins.length ? `whether the change to ${counted(toldBins.length, "binary file", "binary files")} ran` : "",
    ].filter((x) => x);
    const more = notes.length > 1 ? `; and ${counted(notes.length - 1, "more reason", "more reasons")}` : "";
    cuts.push(...notes.slice(1));
    out.push(reasonSaid(`Couldn't tell ${whether.join(", or ")}, since `, notes[0]!, more + ".", cuts));
  } else if (told) {
    const said: string[] = [];
    const rest: [string, number, number, boolean][] = [];
    for (const [n, f] of untold) {
      const lines = lost(f);
      const ds = toldDelsOf(f);
      const binary = truthy(get(f, "binary"));
      if (!(lines.length || ds.length || binary)) continue;
      if (said.length && said.reduce((t, s) => t + cpLength(s), 0) >= LISTED) {
        rest.push([n, lines.length, ds.length, binary]);
        continue;
      }
      const deleted = `${ds.length === 1 ? "deletion" : "deletions"} ${ds.length ? afterLines(ds) : ""} ${ds.length === 1 ? "was" : "were"} reached`;
      const whether = binary
        ? `whether the change to ${code(n)} ran`
        : lines.length
          ? `whether ${grouped(lines.length)} of ${code(n)}'s changed lines ran` + (ds.length ? `, or whether its ${deleted}` : "")
          : `whether ${code(n)}'s ${deleted}`;
      said.push(reasonSaid(`Couldn't tell ${whether}: `, item(f, "reason"), ".", cuts));
    }
    cuts.push(...rest);
    if (rest.length) {
      const lines = rest.reduce((t, x) => t + x[1], 0);
      const ds = rest.reduce((t, x) => t + x[2], 0);
      const bins = rest.reduce((t, x) => t + (x[3] ? 1 : 0), 0);
      const whether = [
        lines ? `whether ${counted(lines, "more changed line", "more changed lines")} ran` : "",
        ds ? `whether ${counted(ds, "more deletion was", "more deletions were")} reached` : "",
        bins ? `whether the change to ${counted(bins, "more binary file", "more binary files")} ran` : "",
      ].filter((x) => x);
      said.push(`Couldn't tell either ${whether.join(", or ")}, in ${counted(rest.length, "more file", "more files")}, each for its own reason.`);
    }
    out.push(...said);
  }
  const nothing = untold
    .map(([n, f]): [string, Json[], number[]] => [n, list(item(f, "noCode")), delsOf(f, "no-code")])
    .filter(([, lines, ds]) => lines.length || ds.length);
  if (nothing.length) {
    const z = nothing.reduce((t, x) => t + x[1].length, 0);
    const zd = nothing.reduce((t, x) => t + x[2].length, 0);
    const piece = (n: string, lines: readonly Json[], ds: readonly number[]): string => {
      if (!ds.length) return `${grouped(lines.length)} of ${code(n)}'s` + (zd ? " lines" : "");
      const deleted = `${ds.length === 1 ? "deletion" : "deletions"} ${afterLines(ds)}`;
      return lines.length ? `${grouped(lines.length)} of ${code(n)}'s lines and its ${deleted}` : `${code(n)}'s ${deleted}`;
    };
    const items = nothing.map(([n, lines, ds]): [string, string, number, number] => [n, piece(n, lines, ds), lines.length, ds.length]);
    const render = (xs: readonly [string, string, number, number][]) => {
      const ps = xs.map((x) => x[1]);
      return !zd || ps.length === 1 ? listed(ps) : `${ps.slice(0, -1).join(", ")}, and ${ps[ps.length - 1]!}`;
    };
    const k = fitted(items, render);
    const rest = items.slice(k);
    cuts.push(...rest);
    const more = [
      rest.some((x) => x[2]) ? counted(rest.reduce((t, x) => t + x[2], 0), "more line", "more lines") : "",
      rest.some((x) => x[3]) ? counted(rest.reduce((t, x) => t + x[3], 0), "more deletion", "more deletions") : "",
    ]
      .filter((x) => x)
      .join(" and ");
    const listing = rest.length
      ? items
          .slice(0, k)
          .map((x) => x[1])
          .join(", ") + `, and ${more} in ${counted(rest.length, "more file", "more files")}`
      : render(items);
    let lead: string;
    if (z && zd)
      lead =
        `${counted(z, "changed source line maps", "changed source lines map")} to nothing the host runs, and ` +
        `${counted(zd, "deletion has", "deletions have")} no code line on either side of ${zd === 1 ? "it" : "them"} to be judged by`;
    else if (z) lead = `${counted(z, "changed source line maps", "changed source lines map")} to nothing the host runs`;
    else
      lead =
        `${grouped(zd)} of this change's deletions ${zd === 1 ? "has" : "have"} no code line on either side of ` +
        `${zd === 1 ? "it" : "them"} to be judged by`;
    out.push(`${lead}: ${listing}.`);
  }
  const fold = Boolean(cuts.length || unread.length || toldLines || toldDels || (toldBins.length && notes.length) || nothing.length);
  if (fold) out.push("The whole list is in the fold below.");
  return [out.join(" "), fold];
}

export const REACH_FOLD = "Changed source lines and deletions not seen to run, by file";
export const REACH_WHY = "Why it couldn't tell which of this change's source lines ran";

export function reachItems(reach: Json, room: number): string[] {
  if (Object.hasOwn(reach as object, "couldnt")) return [reasonSaid("Couldn't tell which of this change's source lines ran: ", item(reach, "couldnt"), ".", [], room)];
  const notes = list(item(reach, "notes"));
  const out = notes.map((n) => reasonSaid("Couldn't tell for any line or deletion not seen to run, since ", n, ".", [], room));
  for (const [n, f] of sortedFiles(item(reach, "files"))) {
    const its = (afters: readonly number[]) => `its ${afters.length === 1 ? "deletion" : "deletions"} ${afterLines(afters)}`;
    const at = (lines: readonly number[]) => atLines(spans(lines).map(([s]) => s));
    let parts: string[];
    let lost: number[] = [];
    let lostDs: number[] = [];
    if (item(f, "state") === "not-loaded") {
      const lines = LISTS.flatMap((k) => ints(item(f, k))).sort((a, b) => a - b);
      const ds = delsOf(f, ...HOLDS["not-loaded"]![1]);
      parts = ["no profiled host loaded it: " + [lines.length ? `changed ${at(lines)}` : "", ds.length ? its(ds) : ""].filter((x) => x).join(" and ")];
    } else {
      lost = [...ints(item(f, "couldntTell")), ...(item(f, "state") === "couldnt-tell" ? ints(item(f, "unloaded")) : [])];
      lostDs = delsOf(f, "couldnt-tell", "unloaded");
      const notRan = ints(item(f, "notRan"));
      const noCode = ints(item(f, "noCode"));
      const was = lostDs.length === 1 ? "was" : "were";
      parts = [
        truthy(get(f, "binary")) ? "couldn't tell whether its change ran" : "",
        notRan.length ? `${at(notRan)} ran in no profiled drive` : "",
        delsOf(f, "not-reached").length ? `no profiled drive reached ${its(delsOf(f, "not-reached"))}` : "",
        noCode.length ? `${at(noCode)} ${noCode.length === 1 ? "maps" : "map"} to nothing the host runs` : "",
        delsOf(f, "no-code").length ? `${its(delsOf(f, "no-code"))} ${delsOf(f, "no-code").length === 1 ? "has" : "have"} no code line on either side` : "",
        [
          lost.length ? `couldn't tell whether ${at([...lost].sort((a, b) => a - b))} ran` : "",
          lostDs.length ? (lost.length ? `whether ${its(lostDs)} ${was} reached` : `couldn't tell whether ${its(lostDs)} ${was} reached`) : "",
        ]
          .filter((x) => x)
          .join(", or "),
      ].filter((x) => x);
    }
    if (!parts.length) continue;
    const said = `${code(n)}: ${parts.join("; ")}`;
    const own =
      item(f, "state") !== "not-loaded" && (lost.length || lostDs.length || truthy(get(f, "binary"))) ? beyond(str(item(f, "reason")), notes.map(str)) : null;
    if (own && !notes.length) out.push(reasonSaid(`${said}, since `, own, ".", [], room));
    else if (own) out.push(reasonSaid(`${said}, since `, own, ", besides the reasons above.", [], room));
    else out.push(`${said}.`);
  }
  return out;
}
