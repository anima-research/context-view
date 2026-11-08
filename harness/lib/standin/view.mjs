export const CANARY = /\[\[c:[^\]\s]+\]\]/g;
export const SUMMARY = /\[\[s:M[0-9a-f]{8}\]\]/g;
const MARK = /\[\[c:[^\]\s]+\]\]|\[\[s:M[0-9a-f]{8}\]\]/g;
const IMAGE_NOT_SHOWN = '[system: an image in this tool result was NOT shown to you';

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

export const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

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

export const markerOf = (cc) => (cc && typeof cc === 'object' && cc.type === 'ephemeral' && Object.keys(cc).every((k) => k === 'type' || k === 'ttl') && [undefined, '5m', '1h'].includes(cc.ttl) ? cc.ttl ?? '5m' : JSON.stringify(sorted(cc)));

// agent-framework's `[delivered]` receipt names where a turn's plain speech landed, its destinations and then its notes
// joined by ` · ` (framework.ts appendProseDeliveryReceipt, the same at 0.32.0 and 0.33.0): `plain speech → chat ·
// side`, `plain speech → no channel — N plain-speech segment(s) kept in the transcript (…)` in disabled mode, or
// `nothing — N plain-speech segment(s) held as draft(s) …`. A draft a resend delivered is a destination with its draft
// named after it.
export function deliveredOf(body) {
  const landed = /^plain speech → ([\s\S]*)$/.exec(body);
  const none = landed && landed[1].startsWith('no channel — ');
  const rest = landed ? (none ? landed[1].slice('no channel — '.length) : landed[1]) : body.replace(/^nothing(?: confirmed)? — /, '');
  const out = { to: [], held: 0, kept: 0, transcript: 0 };
  for (const item of rest.split(' · ')) {
    const count = (re) => Number(re.exec(item)?.[1] ?? 0);
    const held = count(/^(\d+) plain-speech segment\(s\) held as drafts? /);
    const kept = count(/^(\d+) plain-speech segment\(s\) kept private\b/);
    const transcript = count(/^(\d+) plain-speech segment\(s\) kept in the transcript\b/);
    out.held += held;
    out.kept += kept;
    out.transcript += transcript;
    if (landed && !none && !held && !kept && !transcript && !/^(\d+ plain-speech segment|drafts? )/.test(item)) out.to.push(item.replace(/ \(draft [^)]*\)$/, ''));
  }
  return out;
}

export function blockRecord(b) {
  const text = b.type === 'text' ? b.text || '' : b.type === 'tool_result' ? texts({ messages: [{ content: [b] }] }).join('') : '';
  const out = { type: b.type, chars: b.type === 'text' || b.type === 'tool_result' ? text.length : b.type === 'thinking' ? (b.thinking || '').length : b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length : b.type === 'image' ? (b.source?.data || '').length : JSON.stringify(b).length };
  const canaries = text.match(CANARY); if (canaries) out.canaries = canaries;
  const summaries = text.match(SUMMARY); if (summaries) out.summaries = summaries;
  // A block that carries both, in the order it carries them: on the Chat Completions API membrane joins a message's
  // text blocks into one string (openai-compatible.ts, convertMessages), so a summary and the reply after it can share
  // a block, which the lists above don't order between them.
  if (canaries && summaries) out.marks = text.match(MARK);
  // membrane's text for an image in a tool result it sends as text only (TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER,
  // providers/utils.ts), as its OpenAI-compatible adapter sends every tool result.
  const unshown = text.split(IMAGE_NOT_SHOWN).length - 1; if (unshown) out.imagesNotShown = unshown;
  // agent-framework's placeholder for an image it no longer sends: `[image: image/png, ~691KB, ref img_k7x3q2_7]`.
  const placeholders = text.match(/\[image: [^\]]*\]/g); if (placeholders) out.placeholders = placeholders.length;
  const repairs = repairMarks(b.type, text); if (repairs.length) out.repairs = repairs;
  // agent-framework's batched-wake line opens its text block: `[Gate: 2 events matched]` (event-gate.ts `wakeLineText`).
  const wake = b.type === 'text' ? /^(?:[^\n:]{1,60}: )?\[Gate: (\d+) events? matched\]/.exec(text) : null; if (wake) out.wakeLine = Number(wake[1]);
  // connectome-host's notices module opens what it tells the resident with `[host-notice]`, and agent-framework its
  // suppression review's and its wake onboarding's notices with `[suppression review]` and `[wake onboarding]`, and
  // its marker for turns a refusal's rewind set aside with `[refusal-rewind]`, its notice that a reply couldn't be
  // posted with `[discord-send-failed]`, and its notices of where the agent's speech goes with `[routing]`
  // (notice-tags.ts). In text a person or
  // a server supplied, agent-framework puts a backslash before the bracket of each of its own tags, `Gate` and the
  // review's and onboarding's among them (supplied-text.ts `markNoticeOpenings`), so that text can't
  // read as its own. A message's first text block is written after its participant's name (membrane's native
  // formatter, `nameFormat` '{name}: '), and a channel message's after its author's too (agent-framework's
  // `presentAuthor`), so the names a marked tag comes after are recorded with it. agent-framework's own rows of how a
  // turn's speech goes and ends open with their tags too: explicit mode's `[prose-routing]` bounce, autoContinue's
  // `[continue]`, the tool-wrapper guard's `[tool-boundary]` and `[send-undeliverable]` for a reply with no channel to
  // go to.
  const notice = b.type === 'text' ? /^(?:[^\n:]{1,60}: )?\[(host-notice|suppression review|wake onboarding|refusal-rewind|discord-send-failed|routing|prose-routing|continue|tool-boundary|send-undeliverable)\]/.exec(text) : null; if (notice) out.notice = notice[1];
  const marked = b.type === 'text' ? /^((?:[^\n:]{1,60}: ){0,2})\\\[(Gate|suppression review|wake onboarding)(?=[\]:])/.exec(text) : null;
  if (marked) out.markedNotice = { tag: marked[2], after: marked[1].split(': ').slice(0, -1) };
  // agent-framework's `[delivered]` receipt for a turn says so when the turn's speech could be neither sent nor held as
  // drafts: "suppressed and NOT held as drafts (ERROR)" (framework.ts appendProseDeliveryReceipt, 0.32.0 and 0.33.0).
  if (b.type === 'text' && /^(?:[^\n:]{1,60}: )?\[delivered\][\s\S]*\bsuppressed and NOT held as drafts \(/.test(text)) out.notHeld = true;
  const receipt = b.type === 'text' ? /^(?:[^\n:]{1,60}: )?\[delivered\] ([\s\S]*)$/.exec(text) : null;
  if (receipt) out.delivered = deliveredOf(receipt[1]);
  // connectome-host's retrieval module heads the lessons it injects `## Retrieved Knowledge` (retrieval-module.ts), and
  // agent-framework stores them as a row of the participant `system_context:retrieval` (stored-injections.ts).
  if (b.type === 'text' && /^(?:system_context:retrieval: )?## Retrieved Knowledge\b/.test(text)) out.retrieved = true;
  if (b.type === 'tool_use') out.toolUseId = b.id;
  if (b.type === 'tool_result') {
    out.toolUseId = b.tool_use_id;
    const images = blocksOf(b.content).filter((x) => x?.type === 'image').length;
    if (images) out.images = images;
    const inner = blocksOf(b.content).map((x) => (x?.cache_control != null ? markerOf(x.cache_control) : null));
    if (inner.some(Boolean)) out.contentCache = inner;
  }
  if (b.cache_control != null) out.cache = markerOf(b.cache_control);
  if (b.type === 'thinking') out.signature = b.signature ?? null;
  return out;
}
