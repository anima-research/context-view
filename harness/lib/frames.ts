import { partsOf } from './strategies/transcript.ts';
import type { Generated, Part, Run } from './strategies/transcript.ts';

export const OWN = '\u27e8own text\u27e9';

export function frameOf(blocks: string[], generated: Generated) {
  const placeholder = ({ e, from, length }: Run) => {
    const n = generated.texts[e].text.length;
    return from === 0 && length === n ? OWN : `\u27e8own text, chars ${from}\u2013${from + length} of ${n}\u27e9`;
  };
  const short = (s: string) => generated.short.reduce((out, t) => out.split(t).join(OWN), s);
  let own = true;
  const framed = blocks.filter((block) => block !== '').map((block) => {
    if (generated.calls.has(block) || generated.short.includes(block)) return OWN;
    const found: Part[] = partsOf(block, generated);
    const [only] = found;
    if (found.length === 1 && only.run && only.run.start === 0 && only.run.length === block.length && only.run.from === 0 && only.run.length === generated.texts[only.run.e].text.length) return OWN;
    own = false;
    return found.map((p) => (p.run ? placeholder(p.run) : short(p.text))).join('');
  });
  return own ? null : framed.join('\n');
}
