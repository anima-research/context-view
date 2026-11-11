// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { CANARY_MARK, writer } from './turns.ts';

// A call the fixture server never answers is answered with an error by agent-framework once the recipe's
// `requestTimeoutMs` passes.
export const W6 = {
  from: 'checkpoint',
  turns: 12,
  property: 'tools: no request carries a mark of membrane\'s pairing repair, which would mean context-manager handed it a result without its call or a call without its result; context-manager\'s own repair marks, the designed output for the suppression it scripts, are counted beside (marks are found by their text, which the fixture\'s tool output never quotes; check 11 judges each compile\'s pairs); and no tool result goes out right after an assistant message carrying the canary of a call none of the scripted replies that message holds made, which an operator\'s suppression of turn 5\'s first result tests, leaving that call unanswered while the turn\'s second round reuses its id',
  recipe: { fixtureServer: { requestTimeoutMs: 2000 } },
  needs: { webui: true },
  steps(ctx) {
    const w = writer(ctx, 'W6');
    const steps = [];
    for (let n = 1; n <= this.turns; n++) {
      switch (n % 4) {
        case 0:
          steps.push(w.turn(n, { calls: 2 }));
          break;
        case 1:
          steps.push(w.turn(n, { rounds: 2, callId: () => `t${ctx.seed}_reuse_${n}` }));
          if (n === 5) steps.push(w.other(`${n}.unanswered`, 'suppress', { messages: [{ canary: w.c(n, 'call1') }] }));
          break;
        case 2:
          steps.push(w.turn(n, n === 2 ? { result: (k, canaryText) => ({ kind: 'prose', size: 400, canary: canaryText, hold: true }), more: { also: ['server didn\'t answer within'] } } : {}));
          break;
        default:
          steps.push(w.turn(n));
          steps.push(w.other(`${n}.suppress`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
      }
    }
    return steps;
  },
  // membrane 0.8.0's normalizer repairs both shapes on the wire (normalize-tool-pairs.ts), so a request that
  // reaches the stand-in shows them only as its repair marks.
  check(run, ctx) {
    const requests = run.records.filter((r) => r.kind === 'agent');
    const marks = requests.flatMap((r) => (r.messages ?? []).flatMap((m) => m.blocks.flatMap((b) => (b.repairs ?? []).map((mark) => ({ r, mark })))));
    const membrane = marks.filter((x) => x.mark.startsWith('membrane:'));
    const own = marks.length - membrane.length;
    const out = membrane.map(({ r, mark }) => ({ step: r.step, request: r.id, message: `request ${r.id} carries membrane's ${mark.slice('membrane:'.length)} repair mark, so context-manager handed it a call or result unpaired` }));
    const callsOf = new Map(this.steps(ctx).flatMap((s) => (s.replies ?? []).filter((reply) => CANARY_MARK.test(reply.text ?? '')).map((reply) => [reply.text.match(CANARY_MARK)[0], new Set((reply.calls ?? []).map((c) => c.input.canary))])));
    let results = 0;
    for (const r of requests) {
      const messages = r.messages ?? [];
      messages.forEach((m, k) => {
        const said = m.role === 'assistant' ? (m.blocks ?? []).flatMap((b) => b.canaries ?? []).filter((c) => callsOf.has(c)) : [];
        if (!said.length) return;
        const made = new Set(said.flatMap((c) => [...callsOf.get(c)]));
        for (const b of messages[k + 1]?.blocks ?? []) {
          if (b.type !== 'tool_result') continue;
          results++;
          const foreign = (b.canaries ?? []).filter((c) => !made.has(c));
          if (foreign.length) out.push({ step: r.step, request: r.id, message: `request ${r.id}: a result after the calls of ${said.length > 1 ? `replies ${said.join(' and ')}` : `reply ${said[0]}`} carries ${foreign.join(', ')}, which no call of ${said.length > 1 ? 'those replies' : 'that reply'} made` });
        }
      });
    }
    const held = `${ctx.seed}.2`;
    const at = run.log.filter((e) => e.step === held);
    if (!at.some((e) => e.kind === 'notice' && e.peer === 'server' && e.notice === 'held')) out.push({ step: held, message: 'the fixture server held no call at this step, so the call it should hold never reached it' });
    else if (!at.some((e) => e.kind === 'ipc' && e.event?.type === 'tool:failed' && String(e.event.error ?? '').includes('didn\'t answer within'))) out.push({ step: held, message: 'the call the fixture server held never timed out at this step' });
    return withJudged(out, requests.length + results + 1, `${requests.length} request(s), ${membrane.length} membrane repair mark(s), ${own} of context-manager's own, ${results} result(s) judged by their reply's calls, and the held call's timeout`);
  },
};
