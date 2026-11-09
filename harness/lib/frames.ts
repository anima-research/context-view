import { partsOf } from './strategies/transcript.ts';

export const OWN = '\u27e8own text\u27e9';

export interface Generated { texts: Array<{ text: string }>; short: string[]; calls: Set<string> }
interface Part { run?: { e: number; from: number; start: number; length: number }; text: string }

// The text a message carries besides the fixture's words, or null where each of its blocks is one of the fixture's texts
// whole. blocks: the message's blocks' texts, in order (record.ts's textParts); generated: generatedTexts' registry.
// In a block, the fixture's longer texts are found by partsOf and its short marked texts anywhere, since a canary can't
// match by chance; a short answered call is the fixture's only as a block of its own, as a call is written. A block
// with nothing but the fixture's words is `⟨own text⟩`, a part of one `⟨own text, chars a–b of N⟩`; the blocks are
// joined by a line break, as the record's text of a message is, and an empty block holds nothing to show.
export function frameOf(blocks: string[], generated: Generated) {
  const placeholder = ({ e, from, length }: NonNullable<Part['run']>) => {
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
