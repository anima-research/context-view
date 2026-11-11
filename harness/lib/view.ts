import type { Counts, RunResult } from './shapes/interfaces.ts';

type Op = '=' | '+' | '-';
export interface RecordLine { text: string; request?: string | null }
export interface Changed { requests: string[]; was: Map<string, string>; moved: Set<string>; stopped: string[]; added: number; removed: number; unattributed: number }
export interface SummaryRow {
  run: string;
  outcome?: string;
  reason?: string;
  record?: RunResult['record'] | "couldn't run";
  changed?: { requests: unknown[]; stopped?: unknown[]; added: number; removed: number } | null;
  flags?: number;
  compared?: { new: number; gone: number };
  selfCheck?: { outcome: string; reason?: string } | null;
  counts?: { compiles?: number; refused?: number; compressions?: number; merges?: number; quarantines?: Counts['quarantines']; raw?: number; summarised?: number; out?: number; invariantLines?: number } | null;
  ledgerOf?: string;
  tokens?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } | null;
  unmeasured?: string[];
  baseUnmeasured?: string[];
  readsFailed?: string[];
  baseReadsFailed?: string[];
  absent?: string[];
  baseAbsent?: string[];
  baseReason?: string;
}
export type ViewChanged = Pick<Changed, 'requests' | 'added' | 'removed'> & Partial<Pick<Changed, 'was' | 'moved' | 'stopped' | 'unattributed'>>;
export interface Flagged { run: string; flags: Array<{ check: number; step: string; request?: string; message: string }> }
export interface SummaryView { run: string; path: string; text: string }

const SENT = /^ {2}(compile|round|call|unclassified|ask)\b(?: \[(?!T:)([^\]]+)\])?/;
const HEAD = /, head (H:[0-9a-f]{8})/;
function effectiveHeads(texts: string[]) {
  const last = new Map<string, string>();
  return texts.map((t) => {
    const m = SENT.exec(t);
    if (!m) return null;
    const who = m[1] === 'call' ? 'summariser' : m[1] === 'unclassified' ? 'unclassified' : m[2] ?? '';
    const named = HEAD.exec(t)?.[1];
    if (named) last.set(who, named);
    return last.get(who) ?? null;
  });
}

export function lcsSteps<T>(a: readonly T[], b: readonly T[]) {
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const steps: Array<[Op, number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { steps.push(['=', i++, j++]); continue; }
    if (j < b.length && (i === a.length || common[i * width + j + 1] >= common[(i + 1) * width + j])) { steps.push(['+', i, j++]); continue; }
    steps.push(['-', i++, j]);
  }
  return steps;
}

function lineDiff(before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const added: number[] = [];
  const hunks: Array<{ before: number[]; after: number[] }> = [];
  let removed = 0;
  let hunk: { before: number[]; after: number[] } | null = null;
  for (const [op, i, j] of lcsSteps(before.slice(start, before.length - tail), after.slice(start, after.length - tail))) {
    if (op === '=') { hunk = null; continue; }
    if (!hunk) { hunk = { before: [], after: [] }; hunks.push(hunk); }
    if (op === '+') { added.push(start + j); hunk.after.push(start + j); } else { removed++; hunk.before.push(start + i); }
  }
  return { added, removed, hunks };
}

export function changedRequests(base: string, lines: RecordLine[]): Changed {
  const before = base.split('\n');
  if (before.at(-1) === '') before.pop();
  const after = lines.map((l) => l.text);
  const { added, removed } = lineDiff(before, after);
  const sent = (texts: string[]) => effectiveHeads(texts).map((head, k) => `${texts[k].replace(HEAD, '')}\u0000${head ?? ''}`);
  const sentBefore = sent(before), sentAfter = sent(after);
  const bySent = lineDiff(sentBefore, sentAfter);
  const requests = [...new Set(bySent.added.map((k) => lines[k].request).filter(Boolean))] as string[];
  const formOf = (t: string) => { const m = SENT.exec(t); return m && /, body [0-9a-f]{8}$/.test(t) ? { kind: `${m[1]} ${m[2] ?? ''}`, form: /^ [-+=]/.test(t.slice(m[0].length)) ? 'delta' : 'whole' } : null; };
  const kindOf = (t: string) => formOf(t)?.kind ?? null;
  const was = new Map<string, string>();
  const moved = new Set<string>();
  const gone = bySent.hunks.map((h) => h.before.filter((k) => kindOf(before[k])));
  const came = bySent.hunks.map((h) => h.after.filter((k) => lines[k].request && kindOf(after[k])));
  const take = (c: number, k: number) => { if (!was.has(lines[c].request!)) was.set(lines[c].request!, before[k]); };
  for (const [g, list] of gone.entries()) {
    for (const k of [...list]) {
      for (const [h, cs] of came.entries()) {
        const at = cs.findIndex((c) => sentAfter[c] === sentBefore[k]);
        if (at < 0) continue;
        const [c] = cs.splice(at, 1) as [number];
        take(c, k);
        moved.add(lines[c].request!);
        list.splice(list.indexOf(k), 1);
        break;
      }
    }
  }
  const shared = (x: string, y: string) => {
    const count = new Map<string, number>();
    for (const t of x.split(' ')) count.set(t, (count.get(t) ?? 0) + 1);
    let n = 0;
    for (const t of y.split(' ')) if (count.get(t)! > 0) { n++; count.set(t, count.get(t)! - 1); }
    return n;
  };
  const stopped: string[] = [];
  for (const [h, list] of gone.entries()) {
    const cs = came[h];
    for (const c of [...cs]) {
      const ofKind = list.filter((k) => kindOf(before[k]) === kindOf(after[c]));
      const sameForm = ofKind.filter((k) => formOf(before[k])!.form === formOf(after[c])!.form);
      const kin = sameForm.length ? sameForm : ofKind;
      if (!kin.length) continue;
      const best = kin.reduce((a, k) => (shared(before[k], after[c]) > shared(before[a], after[c]) ? k : a));
      take(c, best);
      list.splice(list.indexOf(best), 1);
      cs.splice(cs.indexOf(c), 1);
    }
    stopped.push(...list.map((k) => before[k]));
  }
  return { requests, was, moved, stopped, added: added.length, removed, unattributed: added.filter((k) => !lines[k].request).length };
}

// GitHub fails a step whose summary passes 1 MiB (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#step-isolation-and-limits).
export const STEP_SUMMARY_BYTES = 1024 * 1024;
const HEADING_CHARS = 200;

const quarantinesOf = (c: SummaryRow, kind: 'compression' | 'merge') => (c.counts?.quarantines === 'not-reported' ? 'not reported' : c.counts?.quarantines?.[kind]);

const COLUMNS: Array<[string, (c: SummaryRow) => unknown]> = [
  ['request compiles', (c) => c.counts?.compiles],
  ['refused', (c) => c.counts?.refused],
  ['requests to summarise messages', (c) => c.counts?.compressions],
  ['requests to merge summaries', (c) => c.counts?.merges],
  ['compression quarantines entered', (c) => quarantinesOf(c, 'compression')],
  ['merge quarantines entered', (c) => quarantinesOf(c, 'merge')],
  ['ledger of', (c) => c.ledgerOf],
  ['raw', (c) => c.counts?.raw],
  ['summarised', (c) => c.counts?.summarised],
  ['left out', (c) => c.counts?.out],
  ['tokens sent', (c) => (c.tokens ? (c.tokens.input ?? 0) + (c.tokens.cacheRead ?? 0) + (c.tokens.cacheWrite ?? 0) : undefined)],
  ['invariant lines', (c) => c.counts?.invariantLines],
];

const byArm = (head: string[] | undefined, base: string[] | undefined) => [...(head ?? []), ...(base ?? []).map((x) => `${x} (base arm)`)].join(', ');
export const unmeasured = (r: Pick<SummaryRow, 'unmeasured' | 'baseUnmeasured'>) => byArm(r.unmeasured, r.baseUnmeasured);
export const readsFailedOf = (r: Pick<SummaryRow, 'readsFailed' | 'baseReadsFailed'>) => byArm(r.readsFailed, r.baseReadsFailed);

export function summaryTable(rows: SummaryRow[]) {
  const cell = (v: unknown) => (v === undefined || v === null ? '?' : String(v));
  const record = (r: SummaryRow) => (r.record === 'differs' ? `differs: ${r.changed!.requests.length} request(s)${r.changed!.stopped?.length ? `, ${r.changed!.stopped.length} no longer sent` : ''}, +${r.changed!.added} -${r.changed!.removed} line(s)` : r.record === 'missing' ? (r.baseReason === undefined ? 'the base arm has none' : `the base arm couldn't run it: ${r.baseReason || 'no reason given'}`) : r.record ?? 'none');
  const escaped = (t: string) => t.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
  const counted = (r: SummaryRow) => `${r.flags ?? '?'} flag(s)`;
  const outcome = (r: SummaryRow) => {
    const main = r.outcome === undefined ? '?' : r.outcome === 'couldnt-run' ? `couldn't run: ${r.reason ?? 'no reason given'}` : r.outcome === 'flags' ? counted(r) : r.outcome === 'invalid' ? `invalid: ${counted(r)}` : r.outcome;
    const moved = r.compared && (r.compared.new || r.compared.gone) ? `, ${r.compared.new} new and ${r.compared.gone} gone against the base arm` : '';
    const why = ([[unmeasured(r), 'didn\'t measure'], [readsFailedOf(r), 'a read failed'], [byArm(r.absent, r.baseAbsent), 'absent from its stack, so not run']] as Array<[string, string]>).filter(([said]) => said).map(([said, what]) => `; ${what}: ${said}`).join('');
    const self = !r.selfCheck ? '' : `; self-check ${r.selfCheck.outcome === 'couldnt-run' ? `couldn't run: ${r.selfCheck.reason ?? 'no reason given'}` : r.selfCheck.outcome}`;
    return escaped(`${main}${moved}${self}${why}`);
  };
  return [
    `| run | outcome | record | ${COLUMNS.map(([name]) => name).join(' | ')} |`,
    `|---|---|---|${COLUMNS.map(([name]) => (name === 'ledger of' ? '---' : '---:')).join('|')}|`,
    ...rows.map((r) => `| ${r.run} | ${outcome(r)} | ${record(r)} | ${COLUMNS.map(([, of]) => cell(of(r))).join(' | ')} |`),
  ].join('\n');
}

export function summaryOf({ rows, flagged = [] }: { rows: SummaryRow[]; flagged?: Flagged[] }) {
  const clean = rows.every((r) => (r.outcome === 'pass' || (r.outcome === 'flags' && r.compared)) && (['same', 'written'] as Array<SummaryRow['record']>).includes(r.record) && !r.compared?.new && !r.compared?.gone && (!r.selfCheck || r.selfCheck.outcome === 'same') && !unmeasured(r) && !readsFailedOf(r));
  const parts = [summaryTable(rows)];
  if (!clean) {
    parts.push("Each run's `report.txt`, and its record and view where it wrote them, are under its directory in this job's evidence, its name with `/` written as `_`.");
  }
  for (const { run, flags } of flagged) {
    parts.push([`### ${run}: ${flags.length} flag(s)`, ...flags.map((f) => `- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}`)].join('\n'));
  }
  return parts.join('\n\n');
}

const CONTEXT_ITEMS = 2;

export function movedIn(was: string, now: string) {
  const a = was.trim().split(' ');
  const b = now.trim().split(' ');
  const steps = lcsSteps(a, b);
  const groups: Array<{ at: number; gone: string[]; came: string[] }> = [];
  let group: { at: number; gone: string[]; came: string[] } | null = null;
  steps.forEach(([op, i, j], k) => {
    if (op === '=') { group = null; return; }
    if (!group) { group = { at: k, gone: [], came: [] }; groups.push(group); }
    if (op === '-') group.gone.push(a[i]); else group.came.push(b[j]);
  });
  const cap = (items: string[]) => items.join(' ');
  const out: string[] = [];
  let shownTo = -1;
  for (const g of groups) {
    const end = g.at + g.gone.length + g.came.length;
    const before = steps.slice(Math.max(shownTo + 1, g.at - CONTEXT_ITEMS), g.at).filter(([op]) => op === '=').map(([, , j]) => b[j]);
    const after = steps.slice(end, end + CONTEXT_ITEMS).filter(([op]) => op === '=').map(([, , j]) => b[j]);
    if (before.length) out.push(`  ${g.at - before.length > shownTo + 1 ? '… ' : ''}${before.join(' ')}`);
    else if (g.at > shownTo + 1) out.push('  …');
    if (g.gone.length) out.push(`- ${cap(g.gone)}`);
    if (g.came.length) out.push(`+ ${cap(g.came)}`);
    if (after.length) out.push(`  ${after.join(' ')}`);
    shownTo = end + after.length - 1;
  }
  if (shownTo < steps.length - 1) out.push('  …');
  return out;
}

export interface ViewInput {
  run: string;
  changed: ViewChanged;
  lines: RecordLine[];
  transcript: (id: string, seen: Set<unknown>) => string[];
  ledger: (id: string) => string[] | null | undefined;
}

export function viewOf({ run, changed, lines, transcript, ledger }: ViewInput) {
  const out = [`## ${run}`, ''];
  out.push(`${changed.requests.length} request(s) changed and ${changed.stopped?.length ?? 0} no longer sent: ${changed.added} record line(s) added and ${changed.removed} removed${changed.unattributed ? `, ${changed.unattributed} of the added belonging to no request (such as a summary written or removed, a dry compile, an action, a checkpoint or the totals)` : ''}.`, '');
  const lineOf = new Map<string, string>();
  const short = (t: string) => (t.length > HEADING_CHARS ? `${t.slice(0, HEADING_CHARS - 1)}…` : t);
  for (const l of lines) if (l.request && !lineOf.has(l.request)) lineOf.set(l.request, short(l.text.trim()));
  const seen = new Set<unknown>();
  const fullOf = new Map<string, string>();
  for (const l of lines) if (l.request && !fullOf.has(l.request)) fullOf.set(l.request, l.text);
  for (const id of changed.requests) {
    out.push(`### ${id}: \`${lineOf.get(id) ?? '(no line)'}\``, '');
    const was = changed.was?.get(id);
    if (changed.moved?.has(id)) out.push('Sent at another place in the run, with its record line unchanged.', '');
    else if (was && fullOf.has(id)) out.push('Where its record line moved:', '', '```diff', ...movedIn(was, fullOf.get(id)!), '```', '');
    else out.push('A request the base arm\'s record doesn\'t have.', '');
    const owned = ledger(id);
    if (owned?.length) out.push(...owned, '');
    out.push('```text', ...transcript(id, seen), '```', '');
  }
  for (const line of changed.stopped ?? []) {
    out.push(`### no longer sent: \`${short(line.trim())}\``, '', 'The base arm\'s record has this request and the head no longer sends it, so there is no body to show; its line is:', '', '```text', line.trim(), '```', '');
  }
  return `${out.join('\n')}\n`;
}

// GitHub holds one step's summary file to 1 MiB in all.
export function stepSummaryAfter(there: number, { table, views }: { table: string; views: SummaryView[] }) {
  const budget = STEP_SUMMARY_BYTES - there;
  if (budget <= 0) return '';
  const text = stepSummary({ table, views, budget });
  return Buffer.byteLength(text, 'utf8') <= budget ? text : '';
}

export function stepSummary({ table, views, budget = STEP_SUMMARY_BYTES }: { table: string; views: SummaryView[]; budget?: number }) {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  const cutNote = (n: number) => `${n} more flag(s) didn't fit within this summary's ${budget} bytes: they're in summary.md and each run's report.txt in the job's evidence.\n`;
  const viewsNote = `${views.length} views didn't fit within this summary's ${budget} bytes: each is <run>/view.md in the job's evidence.\n`;
  if (bytes(`${table}\n\n`) + bytes(viewsNote) > budget) {
    const lines = table.split('\n');
    const flagLines = lines.filter((l) => l.startsWith('- check ')).length;
    const kept: string[] = [];
    let used = bytes(cutNote(flagLines)) + bytes(viewsNote) + 2;
    for (const l of lines) {
      if (used + bytes(l) + 1 > budget) break;
      kept.push(l);
      used += bytes(l) + 1;
    }
    const cut = flagLines - kept.filter((l) => l.startsWith('- check ')).length;
    return `${kept.join('\n')}\n\n${cutNote(cut)}${views.length ? viewsNote : ''}`;
  }
  const head = `${table}\n\n`;
  const notes = views.map((v) => `The view of ${v.run} (${bytes(v.text)} bytes) didn't fit within this summary's ${budget} bytes: it's ${v.path} in the job's evidence.\n`);
  if (bytes(head) + notes.reduce((n, x) => n + bytes(x), 0) > budget) return `${head}${views.length} views didn't fit within this summary's ${budget} bytes: each is <run>/view.md in the job's evidence.\n`;
  let used = bytes(head);
  const shown: string[] = [];
  const skipped: string[] = [];
  views.forEach((v, i) => {
    const rest = notes.slice(i + 1).reduce((n, x) => n + bytes(x), 0);
    if (used + bytes(v.text) + rest <= budget) { shown.push(v.text); used += bytes(v.text); } else { skipped.push(notes[i]); used += bytes(notes[i]); }
  });
  return head + shown.join('') + skipped.join('');
}
