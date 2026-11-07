export const CANARY = /\[\[c:[^\]\s]+\]\]/g;
export const SUMMARY = /\[\[s:M[0-9a-f]{8}\]\]/g;

export const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

export function texts(view) {
  const out = [];
  const walk = (b) => {
    if (typeof b === 'string') { out.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') out.push(b.text || '');
    if (b.type === 'tool_result') blocksOf(b.content).forEach(walk);
  };
  for (const m of view.messages || []) blocksOf(m.content).forEach(walk);
  return out;
}

export const found = (strings, re) => strings.flatMap((s) => s.match(re) || []);

// What a request's tool pairs went through, by the marks the repairs write, at the stack's locked versions:
// membrane 0.8.0's normalizer textifies a result with no call before it or a second one for a call, and answers a
// call left without one with `[pending]` (normalize-tool-pairs.ts:546, :641, :968); context-manager 0.24.0's
// pairing repair leaves `[tool call omitted]` for blocks it drops, a moved result's note and a stub for a call whose
// result it hasn't (autobiographical.ts:19390, :19500, :19319; normalize-tool-messages.ts:133).
export function repairMarks(type, text) {
  const out = [];
  for (const m of text.matchAll(/\[(orphan|duplicate) tool_result for [^\]\n]*\]/g)) out.push(`membrane:${m[1]}`);
  if (type === 'tool_result' && text === '[pending]') out.push('membrane:pending');
  for (const m of text.matchAll(/\[tool call omitted\]|\[tool result moved during context repair\]/g)) out.push(m[0] === '[tool call omitted]' ? 'context-manager:omitted' : 'context-manager:moved');
  if (type === 'tool_result' && text.startsWith('[this call\'s result isn\'t shown in this context.')) out.push('context-manager:stub');
  return out;
}
