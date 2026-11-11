// @ts-nocheck
import { FIXTURE_AGENT, requestPairs, withJudged } from '../strategies/checks.ts';
import { isUnreadable } from '../strategies/invariants.ts';
import { prose } from '../strategies/prose.ts';
import { SIZES, guardTurn, readsOf, writer } from './turns.ts';

const blocksOf = (record) => (record.messages ?? []).flatMap((m, i) => m.blocks.map((b) => ({ i, role: m.role, b })));

export const W5 = {
  from: 'checkpoint',
  turns: 12,
  property: 'shards: the store holds both blocks, the call and its result, of each of the workload\'s own calls, and a body larger than the message cap, stored in parts, that context-manager sends whole never goes out without its tool blocks',
  steps(ctx) {
    const w = writer(ctx, 'W5');
    const steps = [guardTurn(w, 'g')];
    for (let n = 1; n <= this.turns; n++) {
      const big = n % 2 === 0;
      const t = w.turn(n, {
        callId: () => `t${ctx.seed}_${n}`,
        result: (k, canaryText) => (big
          ? { kind: 'mixed', size: w.between(SIZES.large), width: 64, height: 48, canary: canaryText }
          : { kind: 'prose', size: w.between(SIZES.result), canary: canaryText }),
        more: { reads: ['messages'] },
      });
      if (n % 4 === 1) t.replies[0].text = `${w.c(n, 'r1')} ${prose(w.between(SIZES.largeReply), `${w.id(n)}:large`)}`;
      steps.push(t);
    }
    return steps;
  },
  check(run, ctx) {
    return toolBlocksLost(run, Array.from({ length: this.turns }, (_, i) => `t${ctx.seed}_${i + 1}`));
  },
};

export function toolBlocksLost(run, calls = []) {
  const reads = readsOf(run, 'messages');
  const failed = reads.find((read) => !Array.isArray(read.answer ?? []));
  if (failed) return withJudged([{ step: failed.step ?? null, message: `couldn't judge: the store's messages couldn't be read${isUnreadable(failed.answer) ? ` (${failed.answer.unreadable})` : ''}` }], 0);
  const toolIds = new Map();
  const groupOf = new Map();
  for (const m of reads.flatMap((read) => read.answer ?? [])) {
    if (!groupOf.has(m.id)) groupOf.set(m.id, m.bodyGroupId ?? m.id);
    if (!m.bodyGroupId) continue;
    const ids = toolIds.get(m.bodyGroupId) ?? new Set();
    for (const b of m.blocks) if (b.type === 'tool_use' || b.type === 'tool_result') ids.add(`${b.type}:${b.id ?? b.toolUseId}`);
    if (ids.size) toolIds.set(m.bodyGroupId, ids);
  }
  const paired = requestPairs(run.records, run.log, FIXTURE_AGENT);
  if (!paired) return withJudged([{ step: null, message: 'couldn\'t judge: the log holds no request compile line to pair with the requests' }], 0);
  const out = [];
  let judged = calls.length;
  const stored = new Set(reads.flatMap((read) => read.answer ?? []).flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => `${b.type}:${b.id ?? b.toolUseId}`));
  const unstored = calls.flatMap((id) => [`tool_use:${id}`, `tool_result:${id}`]).filter((key) => !stored.has(key));
  if (unstored.length) out.push({ step: null, message: `the store holds none of these blocks of the workload's calls: ${unstored.join(', ')}` });
  for (const { line, request } of paired.pairs) {
    const sent = new Set(blocksOf(request).filter((x) => x.b.type === 'tool_use' || x.b.type === 'tool_result').map((x) => `${x.b.type}:${x.b.toolUseId}`));
    const whole = new Set((line.messages ?? []).flatMap((m) => m.sources ?? []).filter((s) => /^r:[^!]+$/.test(s)).map((s) => groupOf.get(s.slice(2))).filter(Boolean));
    for (const key of whole) {
      if (!toolIds.has(key)) continue;
      judged++;
      const lost = [...toolIds.get(key)].filter((id) => !sent.has(id));
      if (lost.length) out.push({ step: request.step, message: `request ${request.id}: ${key} went out whole but without its tool blocks ${[...new Set(lost)].join(', ')}` });
    }
  }
  return withJudged(out, judged);
}
