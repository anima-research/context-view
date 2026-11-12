import { prose } from '../strategies/prose.ts';
import { SIZES, writer } from './turns.ts';
import { arrivalFates } from './fates.ts';
import type { Writer } from './turns.ts';
import type { Workload } from './workloads.ts';
import type { Act, Call, Delivered, Step } from '../strategies/script.ts';

const SIDE = 'w14-side';

export const W14 = {
  from: 'checkpoint',
  fromEmpty: (variant: string | null, setup: string) => setup === 'H1b',
  compresses: (variant: string | null, setup: string) => setup !== 'H1b',
  property: 'arrivals: each message or result that arrives while a turn is alive is first carried by the request its presentation point gives, and by none before it: one at the turn\'s end by its wake turn\'s first request, after the turn\'s final reply; one at a boundary by the request after it, after the round\'s results, and one addressed from another channel with its routing notice',
  needs: { subagents: true },
  steps(ctx) {
    const w = writer(ctx, 'W14');
    const arrival = (step: string, part: string, more: Partial<Delivered> = {}): Delivered => ({ id: `${w.id(step)}.${part}`, participant: 'Tavy', text: `${w.c(step, `${part}.in`)} ${prose(w.between(SIZES.user), `${w.id(step)}:${part}`)}`, ...more });
    const holdCall = (t: ReturnType<Writer['turn']>, round: number, during: Act[]) => {
      const { calls } = t.replies[round] as { calls: Array<Call & { input: { canary: string } }> };
      const call = calls.at(-1)!;
      calls[calls.length - 1] = { ...call, input: { ...call.input, hold: true }, during };
      return call.input.canary;
    };
    const steps: Step[] = [];

    const end = w.turn('end', { more: { namedAnywhere: true } });
    const a1 = arrival('end', 'a1');
    end.replies[1] = { ...end.replies[1], hold: true, during: [{ deliver: a1 }] };
    end.replies.push({ text: `${w.c('end', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('end')}:r3`)}` });
    end.canaries.push(w.c('end', 'a1.in'));
    end.arrivals = [{ canary: w.c('end', 'a1.in'), point: 'end', after: w.c('end', 'r2'), message: a1.id }];
    steps.push(end);

    if (ctx.configurationName === 'H1b') {
      const side = w.turn('side', { more: { namedAnywhere: true } });
      const a3 = arrival('side', 'a3', { participant: 'Wren', channel: SIDE, tags: ['chat:addressed'] });
      const after = holdCall(side, 0, [{ deliver: a3 }]);
      side.replies.push({ text: `${w.c('side', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('side')}:r3`)}` });
      side.canaries.push(w.c('side', 'a3.in'));
      side.arrivals = [{ canary: w.c('side', 'a3.in'), point: 'boundary', after, routing: true, message: a3.id }];
      steps.push(side);
      return steps;
    }

    steps.push(w.other('break.budget', 'command', { command: '/budget 1' }));
    const brk = w.turn('break', { rounds: 2 });
    const a2 = arrival('break', 'a2');
    const breakAfter = holdCall(brk, 1, [{ deliver: a2 }]);
    brk.canaries.push(w.c('break', 'a2.in'));
    brk.spare = [{ text: `${w.c('break', 'spare')} ${prose(200, `${w.id('break')}:spare`)}` }];
    brk.arrivals = [{ canary: w.c('break', 'a2.in'), point: 'boundary', after: breakAfter, message: a2.id }];
    steps.push(brk);
    steps.push(w.other('break.restore', 'command', { command: `/budget ${ctx.streamBound}` }));

    const sub = w.turn('sub', { more: { namedAnywhere: true } });
    const name = `w14-${ctx.seed}`;
    const marker = `[[w14-sub:${ctx.seed}]]`;
    const subAfter = holdCall(sub, 0, [{ agentEnd: name }]);
    (sub.replies[0].calls as Call[]).unshift({ name: 'subagent--spawn', input: { name, systemPrompt: `${marker} You are the fixture's subagent.`, task: `${w.c('sub', 'task')} ${prose(w.between(SIZES.user), `${w.id('sub')}:task`)}` } });
    sub.subs = [{ marker, canaries: [w.c('sub', 'task')], replies: [{ text: `${w.c('sub', 's1')} ${prose(w.between(SIZES.reply), `${w.id('sub')}:s1`)}` }] }];
    sub.replies.push({ text: `${w.c('sub', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('sub')}:r3`)}` });
    sub.arrivals = [{ canary: w.c('sub', 's1'), point: 'boundary', after: subAfter, agent: name }];
    steps.push(sub);

    steps.push(w.other('topic', 'command', { command: '/newtopic' }));
    return steps;
  },
  check(run, ctx) {
    return arrivalFates(run, this.steps(ctx));
  },
} satisfies Workload;
