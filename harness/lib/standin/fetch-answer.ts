import { blocksOf, CANARY, found } from './view.ts';
import type { Claim, Kind, Step } from './standin.ts';
import type { ReadView } from './view.ts';

// connectome-host's fetch module opens the system text of the request that asks another model about a document so,
// and sends one user text block: the document between tags carrying a code, then the agent's request between
// `<request>` tags (src/modules/fetch-module.ts ANSWER_SYSTEM and answer(), at anima-research/connectome-host#679's
// merge).
const OPENS = /^You read one document for an AI agent and answer the agent's request from it\./;
const DOCUMENT = /<document-([0-9a-f]{12})>\n([\s\S]*?)\n<\/document-\1>/;
const REQUEST = /<request>\n([\s\S]*?)\n<\/request>/;

const ANSWERED = 'The fixture\'s answer, from the document it was sent.';

export type FetchAnswerFields = { batch: string[]; asked: string[] };

const unique = (xs: string[]) => [...new Set(xs)];

export function fetchAnswer(): Kind {
  let step: Step | null = null;
  function claim(view: ReadView): Claim<'fetch-answer'> | null {
    if (!OPENS.test(view.system)) return null;
    const last = view.messages.at(-1);
    const text = last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : '';
    const [document, asked] = [DOCUMENT.exec(text)?.[2] ?? '', REQUEST.exec(text)?.[1] ?? ''];
    const answer = `[[c:${step?.id ?? '~'}.answer]] ${ANSWERED}`;
    return {
      kind: 'fetch-answer',
      fields: (mask): FetchAnswerFields => ({ batch: unique(found([mask(document)], CANARY)), asked: unique(found([mask(asked)], CANARY)) }),
      answer(record) {
        record.answer = { shape: 'verdict', verdict: 'answered', chars: answer.length };
        return { content: [{ type: 'text', text: answer }], stop: 'end_turn' };
      },
    };
  }
  return { claim, onStep: (next) => { step = next; } };
}
