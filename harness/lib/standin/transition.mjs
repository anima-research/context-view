import { blocksOf, CANARY, found } from './view.mjs';

// context-manager 0.25.0's transition summary for a bare /newtopic (autobiographical.ts generateTransitionSummary)
// opens its system prompt so and sends the head window's text in one user text block, reading the answer's text back
// as the summary.
const OPENS = /^You are forming a transition summary between conversation topics\./;

export const TRANSITION = 'The fixture\'s conversation so far, summarised for the new topic.';

export function transition() {
  function claim(view) {
    if (!OPENS.test(view.system)) return null;
    const last = view.messages.at(-1);
    const text = last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : '';
    return {
      kind: 'transition',
      fields: (mask) => ({ batch: [...new Set(found([mask(text)], CANARY))] }),
      answer(record) {
        record.answer = { shape: 'verdict', verdict: 'summarised', chars: TRANSITION.length };
        return { content: [{ type: 'text', text: TRANSITION }], stop: 'end_turn' };
      },
    };
  }
  return { claim };
}
