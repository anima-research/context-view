import { blocksOf, CANARY, found } from './view.ts';
import type { Claim, Kind } from './standin.ts';
import type { Act } from '../strategies/script.ts';
import type { ReadView } from './view.ts';

// agent-framework's reply judge (gate/reply-judge.ts, judgeSystemPrompt and judgeQuestion) opens its system prompt so,
// and ends its last text block with the question, which lists the batch it asks about between these tags.
const OPENS = /^You are the reply judge for an AI agent named /;
const BATCH = /<new_events count="\d+">\n([\s\S]*?)\n<\/new_events>/;

export type JudgeFields = { batch: string[] };

export const WAKE = '[[wake]]';
// membrane doesn't retry a 400 whose text reads as neither an account refusal nor a context overflow
// (types/errors.ts classifyByStatus, 0.8.0), so the judge's call fails at once.
export const JUDGE_FAILS = '[[judge-fails]]';
export const JUDGE_HOLDS = '[[judge-holds]]';

export interface JudgeStep { id: string; judgeHold?: { during: Act[] } }

export function judge(): Kind {
  let step: JudgeStep | null = null;
  function claim(view: ReadView): Claim<'judge'> | null {
    if (!OPENS.test(view.system)) return null;
    const last = view.messages.at(-1);
    const question = last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').at(-1)?.text ?? '' : '';
    const batch = BATCH.exec(question)?.[1];
    if (batch === undefined) return { kind: 'unclassified', reason: 'a reply judge\'s request whose last text block holds no <new_events> batch' };
    const reply = batch.includes(WAKE);
    const fails = batch.includes(JUDGE_FAILS);
    const holds = batch.includes(JUDGE_HOLDS);
    return {
      kind: 'judge',
      fields: (mask): JudgeFields => ({ batch: [...new Set(found([mask(batch)], CANARY))] }),
      answer(record) {
        if (fails) {
          record.answer = { shape: 'error', status: 400 };
          return { error: { status: 400, type: 'invalid_request_error', message: `stand-in: the batch carries ${JUDGE_FAILS}` } };
        }
        const verdict = () => {
          const text = reply ? `REPLY: the batch carries ${WAKE}` : `WAIT: the batch carries no ${WAKE}`;
          record.answer = { shape: 'verdict', verdict: reply ? 'reply' : 'wait', chars: text.length };
          return { content: [{ type: 'text', text }], stop: 'end_turn' };
        };
        if (!holds) return verdict();
        if (!step?.judgeHold) throw new Error(`its batch carries ${JUDGE_HOLDS}, and step ${step?.id ?? '(none)'} gives no judgeHold acts to run while it's held`);
        return { held: verdict, during: step.judgeHold.during };
      },
    };
  }
  return { claim, onStep: (next: JudgeStep | null) => { step = next; } };
}
