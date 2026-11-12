import { withJudged } from '../strategies/checks.ts';
import { entries, writer } from './turns.ts';
import type { Breach } from './fates.ts';
import type { Workload } from './workloads.ts';
import type { Step } from '../strategies/script.ts';

type Pin = { id?: unknown; kind?: unknown; level?: unknown; maxLevel?: unknown; firstMessageId?: unknown; lastMessageId?: unknown };
type End = { storeAt: number; withBlock?: string } | { canary: string };

export const W11 = {
  from: 'checkpoint',
  turns: 14,
  property: 'protections: pins and document marks an operator puts on older messages stay placed through a budget cut and a restore, as context-manager\'s pins promise (a compile that can\'t hold them refuses instead), and the pins invariant holds each compile to them',
  steps(ctx) {
    const w = writer(ctx, 'W11');
    const budget = ctx.budget;
    const pin = (step: string, first: End, last: End, opts: Record<string, unknown> = {}) => w.other(step, 'panel', { op: 'pin-add', params: { firstMessageId: first, lastMessageId: last, ...opts } });
    const steps: Step[] = [];
    for (let n = 1; n <= this.turns; n++) {
      if (n === 9) steps.push(w.other('9.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: Math.round((budget as number) * 0.35), immediate: true }, edge: { reserve: ctx.reserve } }));
      if (n === 13) steps.push(w.other('13.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: budget, immediate: true } }));
      const failFirst = n === 2 && ctx.configurationName === 'H1';
      const t = w.turn(n, { more: { ...(n >= 9 && n < 13 ? { mayFail: true } : {}), ...(failFirst ? { retries: true } : {}) } });
      if (failFirst) t.replies = [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, ...t.replies];
      steps.push(t);
      switch (n) {
        case 2:
          steps.push(pin('2.level0', { storeAt: 0.10 }, { storeAt: 0.10 }, { level: 0 }));
          steps.push(pin('2.max0', { storeAt: 0.14 }, { storeAt: 0.14 }, { maxLevel: 0 }));
          break;
        case 3:
          steps.push(pin('3.result', { storeAt: 0.30, withBlock: 'tool_result' }, { storeAt: 0.30, withBlock: 'tool_result' }));
          break;
        case 4:
          steps.push(pin('4.max2', { storeAt: 0.45 }, { storeAt: 0.45 }, { maxLevel: 2 }));
          steps.push(pin('4.level1', { storeAt: 0.55 }, { storeAt: 0.55 }, { level: 1 }));
          break;
        case 8:
          steps.push(pin('8.document', { storeAt: 0.20 }, { storeAt: 0.20 }, { kind: 'document', maxLevel: 1 }));
          steps.push(pin('8.level1', { canary: w.c(1, 'in') }, { canary: w.c(1, 'r2') }, { level: 1 }));
          break;
        case 12:
        case 14:
          steps.push(w.other(`${n}.pins`, 'panel', { op: 'pins', params: {} }));
          break;
        default:
          break;
      }
    }
    return steps;
  },
  // context-manager 0.24.0's README: "`listPins` and `unpin` manage the pins", and "A compile whose budget can't
  // hold the raw pins beside the rest refuses with `OverBudgetError`".
  check(run, ctx) {
    const panels = entries(run, 'panel');
    const pinsAt = (step: string) => (panels.filter((e) => e.step === `${ctx.seed}.${step}`).at(-1)?.response as { data?: { pins?: unknown } } | undefined)?.data?.pins;
    const placed = (pinsAt('8.level1') ?? []) as Pin[];
    if (!placed.length) return withJudged([{ step: `${ctx.seed}.8.level1`, message: 'couldn\'t judge: the panel listed no pin once the last was added' }], 0);
    const named = (p: Pin) => `${p.kind}${p.level !== undefined ? ` at L${p.level}` : ''}${p.maxLevel !== undefined ? ` to L${p.maxLevel}` : ''}`;
    const protection = (p: Pin) => JSON.stringify([p.kind, p.level, p.maxLevel, p.firstMessageId, p.lastMessageId]);
    const out: Breach[] = [];
    let judged = 0;
    let before: Pin[] | null = [];
    for (const step of ['2.level0', '2.max0', '3.result', '4.max2', '4.level1', '8.document', '8.level1']) {
      const listed = pinsAt(step);
      if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s answer to this pin holds no list' }); before = null; continue; }
      if (before) {
        judged++;
        const gone = before.filter((p) => !listed.some((q: Pin) => q.id === p.id));
        const added = listed.filter((p: Pin) => !before!.some((q) => q.id === p.id));
        if (gone.length || added.length !== 1) out.push({ step: `${ctx.seed}.${step}`, message: `adding this pin listed ${added.length} new pin(s) or mark(s), and ${gone.length} listed before it are gone${gone.length ? `: ${gone.map(named).join(', ')}` : ''}` });
      }
      before = listed;
    }
    for (const step of ['12.pins', '14.pins']) {
      const listed = pinsAt(step);
      if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s pins answer holds no list' }); continue; }
      judged += placed.length;
      const now = new Map(listed.map((p: Pin): [unknown, Pin] => [p.id, p]));
      const gone = placed.filter((p) => !now.has(p.id));
      const changed = placed.filter((p) => now.has(p.id) && protection(now.get(p.id)!) !== protection(p));
      if (gone.length) out.push({ step: `${ctx.seed}.${step}`, message: `${gone.length} of the ${placed.length} pins and marks placed by step 8 are gone: ${gone.map(named).join(', ')}` });
      if (changed.length) out.push({ step: `${ctx.seed}.${step}`, message: `${changed.length} of the ${placed.length} pins and marks placed by step 8 no longer protect what they did: ${changed.map((p) => `${named(p)} is now ${named(now.get(p.id)!)}${now.get(p.id)!.firstMessageId !== p.firstMessageId || now.get(p.id)!.lastMessageId !== p.lastMessageId ? ' over another range' : ''}`).join(', ')}` });
    }
    return withJudged(out, judged);
  },
} satisfies Workload & { turns: number };
