// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { writer } from './turns.ts';

export const W20 = {
  from: null,
  compresses: false,
  property: 'a fleet\'s relay: a parent whose two children, src and dst, answer every request with an empty round relays src\'s latest reply to dst before src has replied, after src answers a task, after the parent\'s crash, and after src is killed, and each relay, having nothing to pass on, answers as an error; and the parent\'s boot after its crash adopts both children, its fleet module reading the same pids as before',
  steps: (ctx) => fleetSteps(ctx),
  check(run, ctx) {
    const out = [];
    let judged = 0;
    const steps = this.steps(ctx);
    const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary').sort((a, b) => a.seq - b.seq);
    // Each relay's result, as the first request after its call carries it.
    const resultOf = (id) => {
      for (const r of primary) for (const m of r.messages ?? []) for (const b of m.blocks ?? []) if (b.type === 'tool_result' && b.toolUseId === id) return { request: r, block: b };
      return null;
    };
    for (const s of steps.filter((x) => x.w20)) {
      for (const id of s.w20.relays) {
        // A relay's case is reached by the calls before it in its turn: src sent a task and awaited, or killed.
        const before = s.w20.calls.slice(0, s.w20.calls.findIndex((c) => c.id === id));
        const unreached = before.map((c) => ({ ...c, got: resultOf(c.id) })).find((c) => !c.got || c.got.block.isError === true);
        if (unreached) {
          const why = unreached.got ? 'answered as an error' : 'had its result in no request';
          out.push({ step: s.id, message: `couldn't judge the relay ${id}: its case wasn't reached, since ${unreached.name} ${unreached.id} before it ${why}` });
          continue;
        }
        const got = resultOf(id);
        if (!got) { out.push({ step: s.id, message: `couldn't judge: no request carried the result of the relay ${id}` }); continue; }
        judged++;
        if (got.block.isError !== true) out.push({ step: s.id, request: got.request.id, message: `the relay ${id} answered as a success, where src's latest round had nothing to pass on, or src had no reply since the parent's connection to it opened (request ${got.request.id})` });
      }
    }
    // The parent's next boot after its crash adopts the children that live on (connectome-host docs/fleet-protocol.md
    // §4.5, "Adopt on start"), so its fleet module reads each child's pid as the boot before did (fleet.ts fleetReady).
    const crashStep = steps.find((x) => x.kind === 'crash');
    if (crashStep) {
      const crashed = run.log.find((e) => e.kind === 'crash');
      const at = (boot) => run.log.find((e) => e.kind === 'fleet' && e.boot === boot);
      const before = crashed ? at(crashed.boot) : null;
      const after = crashed ? at(crashed.boot + 1) : null;
      const pidsOf = (e) => new Map((e?.children ?? []).map((c) => [c.name, c.pid]));
      const was = pidsOf(before);
      const now = pidsOf(after);
      const unread = [...new Set([...was.keys(), ...now.keys()])].filter((n) => !Number.isInteger(was.get(n)) || !Number.isInteger(now.get(n)));
      if (!crashed || !before || !after) out.push({ step: crashStep.id, message: `couldn't judge the boot after the crash: the run logged ${!crashed ? 'no crash' : `no children at boot ${before ? crashed.boot + 1 : crashed.boot}`}` });
      else if (unread.length) out.push({ step: crashStep.id, message: `couldn't judge the boot after the crash: ${unread.join(' and ')}'s pid wasn't read at both boots` });
      else {
        judged++;
        const anew = [...now.keys()].filter((n) => now.get(n) !== was.get(n));
        if (anew.length) out.push({ step: crashStep.id, message: `boot ${after.boot}, after the parent's crash, started ${anew.join(' and ')} anew (${anew.map((n) => `pid ${was.get(n)}, then ${now.get(n)}`).join('; ')}) rather than adopting ${anew.length > 1 ? 'them' : 'it'}` });
      }
    }
    return withJudged(out, judged);
  },
};

// W20's parent is the only agent the record follows: its children answer on the stand-in's `/empty` route (Hfleet), so
// each relay finds src with no reply since the parent's connection to it last opened (f1, and f4 after the crash) or
// with an empty latest round (f2, and f5 once src is killed), and a correct host relays nothing (fleet-module.ts,
// fleet--relay's description). Each relay's call has an id of its own, by which the check finds its result. f0's
// refused round, thinking and text, and f4's empty last round after a tool round, are what the record's speech lines
// show; no check judges them.
function fleetSteps(ctx) {
  const w = writer(ctx, 'W20');
  const said = (step, k, size = 240) => `${w.c(step, k)} ${prose(size, `${w.id(step)}:${k}`)}`;
  const call = (step, k, name, input) => ({ id: `toolu_w20${step.toLowerCase()}${k}`, name: `fleet--${name}`, input });
  const relay = (step, k) => call(step, k, 'relay', { from: 'src', to: 'dst' });
  const turn = (step, calls, { last = { text: said(step, `r${calls.length + 1}`, 300) }, more = {} } = {}) => ({
    ...w.turn(step, { calls: 0 }),
    namedAnywhere: true,
    replies: [...calls.map((c, i) => ({ text: said(step, `r${i + 1}`), calls: [c] })), last],
    ...(calls.some((c) => c.name === 'fleet--relay') ? { w20: { relays: calls.filter((c) => c.name === 'fleet--relay').map((c) => c.id), calls: calls.map((c) => ({ id: c.id, name: c.name })) } } : {}),
    ...more,
  });
  return [
    { ...w.turn('f0', { calls: 0 }), namedAnywhere: true, replies: [{ thinking: said('f0', 'think'), text: said('f0', 'r0'), stop: 'refusal' }, { text: said('f0', 'r1', 300) }] },
    turn('f1', [relay('f1', 1)]),
    turn('f2', [call('f2', 1, 'send', { name: 'src', content: said('f2', 'task', 120) }), call('f2', 2, 'await', { names: ['src'], timeoutMs: 20_000 }), relay('f2', 3)]),
    w.other('f3', 'crash', {}),
    turn('f4', [relay('f4', 1)], { last: {}, more: { ends: 'unspoken' } }),
    turn('f5', [call('f5', 1, 'kill', { name: 'src' }), relay('f5', 2)]),
  ];
}
