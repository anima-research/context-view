import { blocksOf, CANARY, found } from './view.ts';
import type { Claim, Kind } from './standin.ts';
import type { ReadView } from './view.ts';

// connectome-host's retrieval module (src/modules/retrieval-module.ts, CONCEPT_FLAG_PROMPT and
// RELEVANCE_VALIDATION_PROMPT) opens each of its two requests' system prompts so, sends one user text block, and
// reads a JSON array back: keywords for the first, lesson ids for the second, whose candidates it lists after
// "Candidate lessons:" one to a line as `[id] (confidence) content`.
const CONCEPTS = /^You are a knowledge retrieval assistant\./;
const RELEVANCE = /^You are a relevance filter\./;
const CANDIDATES = '\n\nCandidate lessons:\n';
const CANDIDATE = /^\[([^\]\n]+)\] \(\d+(?:\.\d+)?\) (.*)$/gm;

export const STALE = '[[stale]]';

export type ConceptsFields = { batch: string[] };
export type RelevanceFields = { batch: string[]; kept: string[] };

const lastText = (view: ReadView) => {
  const last = view.messages.at(-1);
  return last?.role === 'user' ? blocksOf(last.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : '';
};
const unique = (xs: string[]) => [...new Set(xs)];

export function retrieval(): Kind {
  function claim(view: ReadView): Claim<'concepts'> | Claim<'relevance'> | null {
    if (CONCEPTS.test(view.system)) {
      const named = unique(found([lastText(view)], CANARY));
      return {
        kind: 'concepts',
        fields: (mask): ConceptsFields => ({ batch: unique(found(named.map<string>(mask), CANARY)) }),
        answer(record) {
          const text = JSON.stringify(named);
          record.answer = { shape: 'verdict', verdict: named.length ? 'named' : 'none', chars: text.length };
          return { content: [{ type: 'text', text }], stop: 'end_turn' };
        },
      };
    }
    if (!RELEVANCE.test(view.system)) return null;
    const text = lastText(view);
    const at = text.lastIndexOf(CANDIDATES);
    const candidates = at < 0 ? [] : [...text.slice(at + CANDIDATES.length).matchAll(CANDIDATE)].map((m) => ({ id: m[1], content: m[2] }));
    if (!candidates.length) return { kind: 'unclassified', reason: 'a relevance filter\'s request whose last text block lists no candidate lesson' };
    const kept = candidates.filter((c) => !c.content.includes(STALE));
    return {
      kind: 'relevance',
      fields: (mask): RelevanceFields => ({ batch: unique(found(candidates.map((c) => mask(c.content)), CANARY)), kept: unique(found(kept.map((c) => mask(c.content)), CANARY)) }),
      answer(record) {
        const answer = JSON.stringify(kept.map((c) => c.id));
        record.answer = { shape: 'verdict', verdict: kept.length === candidates.length ? 'kept' : 'filtered', chars: answer.length };
        return { content: [{ type: 'text', text: answer }], stop: 'end_turn' };
      },
    };
  }
  return { claim };
}
