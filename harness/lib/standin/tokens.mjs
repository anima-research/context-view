// context-manager 0.24.0 estimates prose at 2.9 characters a token and dense text at 2.3 (message-store.ts).
export const RATE = { prose: 2.2, code: 1.9, json: 1.65, base64: 1.35, signature: 3.3 };

function kindOf(text) {
  if (/^[\s]*[{[]/.test(text)) { try { JSON.parse(text); return 'json'; } catch {} }
  if (text.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(text) && !/ [a-z]+ /.test(text)) return 'base64';
  return denseKind(text);
}

const DENSE = /[{}[\]":_/=;()<>`]/g;
const denseKind = (text) => (text.length && (text.match(DENSE) || []).length / text.length > 0.12 ? 'code' : 'prose');

const SEGMENT = 2000;
export function textTokens(text) {
  if (!text) return 0;
  const whole = kindOf(text);
  if (whole === 'json' || whole === 'base64' || text.length <= SEGMENT) return Math.ceil(text.length / RATE[whole]);
  let chars = 0;
  for (let at = 0; at < text.length; at += SEGMENT) {
    const part = text.slice(at, at + SEGMENT);
    chars += part.length / RATE[denseKind(part)];
  }
  return Math.ceil(chars);
}

export function pngSize(data) {
  try {
    const b = Buffer.from(data.slice(0, 64), 'base64');
    if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return null; }
}

export function blockTokens(block) {
  if (typeof block === 'string') return textTokens(block);
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return textTokens(block.text);
    case 'thinking': return textTokens(block.thinking) + Math.ceil((block.signature || '').length / RATE.signature);
    case 'redacted_thinking': return Math.ceil((block.data || '').length / RATE.signature);
    case 'tool_use': return textTokens(block.name || '') + Math.ceil(JSON.stringify(block.input ?? {}).length / RATE.json);
    case 'tool_result': return Array.isArray(block.content) ? block.content.reduce((t, b) => t + blockTokens(b), 0) : textTokens(String(block.content ?? ''));
    case 'image': {
      const size = block.source?.type === 'base64' ? pngSize(block.source.data || '') : null;
      return size ? Math.ceil((size.width * size.height) / 750) : 1600;
    }
    default: return Math.ceil(JSON.stringify(block).length / RATE.json);
  }
}

export function fitToMaxTokens(content, maxTokens) {
  let used = 0;
  const out = [];
  for (const b of content) {
    const t = blockTokens(b);
    if (used + t <= maxTokens) { out.push(b); used += t; continue; }
    if (b.type === 'text') {
      const room = maxTokens - used;
      let kept = b.text.slice(0, Math.max(0, Math.floor(room * RATE[kindOf(b.text)])));
      while (kept && textTokens(kept) > room) kept = kept.slice(0, Math.floor(kept.length * 0.99));
      if (kept) out.push({ ...b, text: kept });
    }
    return { content: out, cut: true };
  }
  return { content: out, cut: false };
}
