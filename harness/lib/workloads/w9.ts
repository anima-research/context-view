import { judgedBy } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { SIZES, canary, guardTurn, summarises, writer } from './turns.ts';
import type { Workload } from './workloads.ts';
import type { Step } from '../strategies/script.ts';

function markdownPaste(seed: number, step: string, target: number) {
  const window = target * 4;
  let s = `${canary(seed, step, 'in')} `;
  const fill = (to: number) => { if (s.length < to) s += prose(Math.round(to) - s.length, `${seed}.${step}:${s.length}`); };
  const kind = step.endsWith('h') ? 'headings' : step.endsWith('i') ? 'fence' : 'blank';
  if (kind === 'headings') { fill(0.4 * window); s += '\n## Notes\n'; fill(0.75 * window); s += '\n### Detail\n'; }
  else if (kind === 'fence') { fill(0.3 * window); s += '\n```\nconst x = 1;\n```\n'; fill(0.75 * window); s += '\n\n'; }
  else { fill(0.4 * window); s += '\n\n'; fill(0.75 * window); s += '\n'; }
  fill(2.5 * window);
  return s;
}

export const W9 = {
  from: 'checkpoint',
  turns: 20,
  property: 'lifecycle: a store closed and reopened compiles the request it compiled before it closed (check 12, on dry compiles either side of the restart)',
  needs: { webui: true, subagents: true },
  steps(ctx) {
    const w = writer(ctx, 'W9');
    const { budget, adaptive, folding, native } = ctx;
    const dry = { op: 'dry-compile', budget: { maxTokens: budget, reserveForResponse: ctx.reserve } };
    const panel = (step: string, op: string, params: Record<string, unknown>) => w.other(step, 'panel', { op, params });
    const command = (step: string, text: string, more: Partial<Step> = {}) => w.other(step, 'command', { command: text, ...more });
    const steps: Step[] = [];
    for (let n = 1; n <= this.turns; n++) {
      if (n === 9) for (const k of ['a', 'b', 'c']) steps.push(w.turn(`9${k}`, { calls: 0, size: SIZES.reading }));
      if (n === 16) steps.push({ ...guardTurn(w, '16g'), namedAnywhere: true });
      steps.push(w.turn(n, { ...(n === 18 && native ? { arrival: { after: 1 } } : {}), ...(n >= 16 ? { more: { namedAnywhere: true } } : {}) }));
      switch (n) {
        case 2:
          if (adaptive) for (const k of ['h', 'i', 'j']) steps.push({ ...w.turn(`2${k}`, { calls: 0 }), text: markdownPaste(ctx.seed, `2${k}`, 3000) });
          break;
        case 3:
          steps.push(w.other('3.reopen', 'restart', { reloadCheck: true }));
          break;
        case 4:
          steps.push(panel(`4.pins`, 'pins', {}));
          break;
        case 5:
          steps.push({ ...panel('5.tail', 'settings-update', { tailTokens: 15000 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
          if (folding === 'kv-stable') steps.push(panel('5.prepare', 'settings-update', { contextBudgetTokens: Math.round((budget as number) * 0.6), transitionPaceTokens: 10000 }));
          break;
        case 6:
          steps.push(w.other('6.witnessed', 'restart', { agent: { strategy: { witnessedBeforeSequence: { sequenceOf: w.c(6, 'r2') }, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.', witnessedInstruction: 'Write the memory of this slice of the log. It is a record the strategy fixture inherited. Target ~{targetTokens} tokens.' } } }));
          break;
        case 7: {
          const fork = w.turn('7f', { calls: 0 });
          const marker = `[[fork:${ctx.seed}]]`;
          steps.push({
            ...fork,
            canaries: [...fork.canaries, w.c('7f', 'task'), w.c('7f', 'f1')],
            replies: [
              { text: `${w.c('7f', 'r1')} forking`, calls: [{ name: 'subagent--fork', input: { name: `fork-${ctx.seed}`, task: `${w.c('7f', 'task')} ${prose(300, `${w.id('7f')}:task`)}`, systemPrompt: `${marker} You are the fork.`, sync: true } }] },
              { text: `${w.c('7f', 'r2')} ${prose(300, `${w.id('7f')}:r2`)}` },
            ],
            subs: [{ marker, canaries: [w.c('7f', 'task')], replies: [{ text: `${w.c('7f', 'f1')} ${prose(400, `${w.id('7f')}:f1`)}` }] }],
          });
          break;
        }
        case 8:
          steps.push(w.other('8.prompt', 'restart', { agent: { systemPrompt: 'You are the strategy fixture\'s agent, with a prompt an operator changed.' } }));
          if (folding === 'kv-stable') steps.push(panel('8.prepare', 'settings-update', { contextBudgetTokens: Math.round((budget as number) * 0.6), transitionPaceTokens: 50000 }));
          break;
        case 10:
          steps.push({ ...panel('10.pin', 'pin-add', { firstMessageId: { canary: w.c(1, 'in') }, lastMessageId: { canary: w.c(1, 'r2') }, name: `w9-${ctx.seed}` }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
          break;
        case 11:
          steps.push({ ...panel('11.pin-level', 'pin-add', { firstMessageId: { canary: w.c(2, 'in') }, lastMessageId: { canary: w.c(2, 'r2') }, level: 1 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
          break;
        case 13:
          steps.push(command('13.undo', '/undo', { reads: [dry] }));
          steps.push(command('13.redo', '/redo', { reads: [dry] }));
          break;
        case 14:
          if (summarises(ctx.configuration)) steps.push(panel('14.unpin', 'pin-remove', { pinId: { pin: `w9-${ctx.seed}` } }));
          break;
        case 15:
          steps.push(command('15.newtopic', '/newtopic A new topic.', summarises(ctx.configuration) ? {} : { expect: 'failed' }));
          break;
        case 17:
          steps.push(w.other('17.suppress', 'suppress', { messages: [{ canary: w.c(16, 'in') }] }));
          break;
        case 19:
          steps.push(w.other('19.head', 'restart', { agent: { strategy: { headWindowTokens: 8000 } } }));
          steps.push(command('19.branchto', `/branchto ${w.c(18, 'r2')}`, { reads: [dry] }));
          break;
        default:
          break;
      }
    }
    return steps;
  },
  check: () => judgedBy([], 12),
} satisfies Workload & { turns: number };
