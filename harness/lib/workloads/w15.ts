// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL } from '../strategies/script.ts';
import { SIZES, readerRead, tuneOut, writer } from './turns.ts';

export const W15 = {
  from: null,
  compresses: false,
  property: 'reader: the reader\'s read after a /restore doesn\'t carry the row stored between its checkpoint and the restore; its read after a restart, on the branch /checkout went back to, carries the row that branch holds and not the one the restore\'s branch holds; a row suppressed through the Web UI is in none of its later reads; and its read after the restart starts where its read before it started',
  needs: { webui: true },
  recipe: { fixtureSend: true, modules: { history: true } },
  steps(ctx) {
    const w = writer(ctx, 'W15');
    const command = (step, text) => w.other(step, 'command', { command: text });
    const h2 = w.c('h2', 'in');
    const side = w.turn('side', { calls: 0, more: { channel: SIDE_W15, namedAnywhere: true } });
    side.replies = [
      { text: `${w.c('side', 'r1')} ${prose(200, `${w.id('side')}:r1`)}`, calls: [{ name: 'mcpl--fixture--send_message', input: { channelId: CHANNEL, content: `${w.c('side', 'sent')} ${prose(300, `${w.id('side')}:sent`)}` } }] },
      { text: `${w.c('side', 'r2')} ${prose(200, `${w.id('side')}:r2`)}`, calls: [{ name: 'history--search', input: { query: h2 } }] },
      { text: `${w.c('side', 'r3')} ${prose(200, `${w.id('side')}:r3`)}` },
    ];
    return [
      w.turn(1),
      tuneOut(w),
      readerRead(w, 1),
      command('checkpoint', '/checkpoint w15'),
      { id: w.id('h2'), segment: 'W15', kind: 'deliver', topic: 'W15', messages: [{ channel: CHANNEL, id: w.id('h2'), participant: 'Tavy', text: `${h2} ${prose(w.between(SIZES.user), `${w.id('h2')}:in`)}`, held: true }], canaries: [h2], tunedOut: [h2] },
      command('restore', '/restore w15'),
      readerRead(w, 3),
      command('back', '/checkout main'),
      w.other('suppress', 'suppress', { messages: [{ canary: w.c('h1', 'in') }] }),
      side,
      w.other('restart', 'restart', {}),
      readerRead(w, 4),
    ];
  },
  check(run, ctx) {
    return readerWindows(run, this.steps(ctx), ctx.seed);
  },
};

const SIDE_W15 = 'w15-side';

function readerWindows(run, steps, seed) {
  const reads = (step) => run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && r.step === `${seed}.${step}`);
  const carries = (r, c) => (r.messages ?? []).some((m) => m.blocks.some((b) => (b.canaries ?? []).includes(c)));
  const c = (step) => `[[c:${seed}.${step}.in]]`;
  const out = [];
  let judged = 0;
  const missing = (step, what) => out.push({ step: `${seed}.${step}`, message: `couldn't judge ${what}: the reader made no request at step ${step}` });
  const [h3] = reads('h3');
  if (!h3) missing('h3', 'the read after the restore');
  else {
    judged++;
    if (carries(h3, c('h2'))) out.push({ step: `${seed}.h3`, request: h3.id, message: `request ${h3.id}, the reader's read after /restore, carries ${c('h2')}, which was stored after the checkpoint` });
  }
  const [h4] = reads('h4');
  if (!h4) missing('h4', 'the read after the restart');
  else {
    judged++;
    if (!carries(h4, c('h2'))) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, doesn't carry ${c('h2')}, which the branch /checkout went back to holds` });
    if (h3 && !carries(h3, c('h3'))) out.push({ step: `${seed}.h4`, message: `couldn't judge whether the reader's read after the restart leaves out ${c('h3')}: ${h3.id}, its read after /restore, doesn't carry it` });
    else if (h3 && carries(h4, c('h3'))) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, carries ${c('h3')}, which only the restore's branch holds` });
  }
  const suppressed = steps.findIndex((s) => s.id === `${seed}.suppress`);
  const later = new Set(steps.slice(suppressed + 1).map((s) => s.id));
  const earlier = new Set(steps.slice(0, suppressed).map((s) => s.id));
  const after = run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && later.has(r.step));
  const before = run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && earlier.has(r.step)).at(-1);
  if (!after.length) out.push({ step: `${seed}.suppress`, message: 'couldn\'t judge the suppression: the reader made no request after it' });
  else if (!before) out.push({ step: `${seed}.suppress`, message: 'couldn\'t judge the suppression: the reader made no request before it' });
  else if (!carries(before, c('h1'))) out.push({ step: `${seed}.suppress`, message: `couldn't judge the suppression: request ${before.id}, the reader's last before it, doesn't carry ${c('h1')}` });
  else {
    judged++;
    for (const r of after.filter((x) => carries(x, c('h1')))) out.push({ step: r.step, request: r.id, message: `request ${r.id}, the reader's after the suppression, carries ${c('h1')}, which the suppression removed` });
  }
  if (h3 && h4) {
    judged++;
    const start = (r) => (r.messages ?? []).flatMap((m) => m.blocks).find((b) => b.canaries?.length)?.canaries[0] ?? null;
    if (start(h4) !== start(h3)) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, starts at ${start(h4) ?? 'no row a canary names'}, where ${h3.id}, its read before it, starts at ${start(h3) ?? 'no row a canary names'}` });
  }
  return withJudged(out, judged);
}
