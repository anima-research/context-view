import { blocksOf, CANARY, found } from './view.ts';
import type { Claim, Kind } from './standin.ts';
import type { ReadView } from './view.ts';

// connectome-host's session naming (src/synesthete.ts, buildNamingPrompt and generateSessionName) opens its system
// prompt so and sends a summary of the conversation's first messages as one user text block, reading back a name of
// at most 60 characters on one line.
const OPENS = /^You are a session naming assistant\./;

export const NAME = 'Fixture Wake Paths';

export function naming(): Kind {
  function claim(view: ReadView): Claim | null {
    if (!OPENS.test(view.system)) return null;
    const last = view.messages.at(-1);
    const summary = last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : '';
    return {
      kind: 'naming',
      fields: (mask) => ({ batch: [...new Set(found([mask(summary)], CANARY))] }),
      answer(record) {
        record.answer = { shape: 'verdict', verdict: 'named', chars: NAME.length };
        return { content: [{ type: 'text', text: NAME }], stop: 'end_turn' };
      },
    };
  }
  return { claim };
}
