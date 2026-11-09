import { partsOf } from './strategies/transcript.mjs';

export const OWN = '\u27e8own text\u27e9';

// The text a message carries besides the fixture's words, those words in it written as placeholders, or null where it
// carries nothing else. generated: generatedTexts' registry, its texts and index for partsOf and its short marked texts.
export function frameOf(text, generated) {
  const placeholder = ({ e, from, length }) => {
    const n = generated.texts[e].text.length;
    return from === 0 && length === n ? OWN : `\u27e8own text, chars ${from}\u2013${from + length} of ${n}\u27e9`;
  };
  const short = (s) => generated.short.reduce((out, t) => out.split(t).join(OWN), s);
  const frame = partsOf(text, generated).map((p) => (p.run ? placeholder(p.run) : short(p.text))).join('');
  return frame.split(OWN).join('').trim() === '' ? null : frame;
}
