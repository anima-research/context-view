// @ts-nocheck
import { blocksOf, CANARY, found } from './view.ts';

// agent-framework's suppression review (gate/suppression-review.ts, REVIEW_SYSTEM and reviewRequest) opens its system
// prompt so, lists the events a rule hid one to a line as `#N [time] type · source · channel · author: text`, and
// reads one JSON object back: `{"fits": …, "flagged": [N, …], "note": "…"}`.
const OPENS = /^You review a filter an AI agent set on its own attention\./;
const EVENT = /^#(\d+) \[[^\]\n]*\] ([^\n]*)$/gm;

export const FLAG = '[[flag]]';

export function review() {
  function claim(view) {
    if (!OPENS.test(view.system)) return null;
    const last = view.messages.at(-1);
    const text = last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').at(-1)?.text ?? '' : '';
    const events = [...text.matchAll(EVENT)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    if (!events.length) return { kind: 'unclassified', reason: 'a suppression review\'s request whose last text block lists no event' };
    const flagged = events.filter((e) => e.text.includes(FLAG));
    return {
      kind: 'review',
      fields: (mask) => ({ batch: [...new Set(found(events.map((e) => mask(e.text)), CANARY))], flagged: [...new Set(found(flagged.map((e) => mask(e.text)), CANARY))] }),
      answer(record) {
        const text = JSON.stringify({ fits: flagged.length === 0, flagged: flagged.map((e) => e.n), note: flagged.length ? `the events carrying ${FLAG}` : `nothing carries ${FLAG}` });
        record.answer = { shape: 'verdict', verdict: flagged.length ? 'flagged' : 'fits', chars: text.length };
        return { content: [{ type: 'text', text }], stop: 'end_turn' };
      },
    };
  }
  return { claim };
}
