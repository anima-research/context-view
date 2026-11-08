import { prose } from '../strategies/prose.mjs';
import { CANARY, found, lastRun, texts } from './view.mjs';
import { FIXTURE_AGENT } from '../strategies/checks.mjs';

const THINKING_CHARS = 600;

// membrane 0.8.0's anthropic-xml formatter sends an agent's turn as a prefill: its last message is the assistant's,
// the transcript ending in the agent's name or a tool round's results, and the model's calls are XML in the text, cut
// at the `</function_calls>` stop sequence it sends, which the API leaves out of the text (formatters/anthropic-xml.js,
// utils/tool-parser.js).
const CALLS_STOP = '</function_calls>';

const xmlCalls = (calls) => `<function_calls>\n${calls.map((c) => `<invoke name="${c.name}">\n${Object.entries(c.input ?? {}).map(([k, v]) => `<parameter name="${k}">${typeof v === 'string' ? v : JSON.stringify(v)}</parameter>\n`).join('')}</invoke>\n`).join('')}`;

export function agent({ configuration: config }) {
  let step = null;
  const answered = { primary: 0, sub: 0 };
  let toolNumber = 0;
  const prefills = config.agent?.formatter === 'anthropic-xml';

  function reply(view, record, scripted) {
    const content = [];
    const thinking = scripted.thinking ?? (config.thinks ? prose(THINKING_CHARS, view.seed()) : undefined);
    if (thinking !== undefined) content.push({ type: 'thinking', thinking });
    if (scripted.text !== undefined) content.push({ type: 'text', text: scripted.text });
    for (const call of (typeof scripted.calls === 'function' ? scripted.calls(view.messages) : scripted.calls) || []) content.push({ type: 'tool_use', id: call.id ?? `toolu_fx${String(++toolNumber).padStart(6, '0')}`, name: call.name, input: call.input });
    const stop = scripted.stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    record.answer = { shape: 'reply', chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), stop, toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id) };
    return { content, stop };
  }

  function prefillReply(view, record, scripted) {
    const thinking = scripted.thinking ?? (config.thinks ? prose(THINKING_CHARS, view.seed()) : undefined);
    const calls = (typeof scripted.calls === 'function' ? scripted.calls(view.messages) : scripted.calls) || [];
    const parts = [...(thinking !== undefined ? [`<thinking>${thinking}</thinking>`] : []), ...(scripted.text !== undefined ? [scripted.text] : [])];
    const text = ` ${parts.join('\n')}${calls.length ? `\n${xmlCalls(calls)}` : ''}`;
    const stop = scripted.stop ?? (calls.length ? 'stop_sequence' : 'end_turn');
    record.answer = { shape: 'reply', chars: text.length, stop, toolUseIds: [] };
    return { content: [{ type: 'text', text }], stop, ...(stop === 'stop_sequence' ? { stopSequence: CALLS_STOP } : {}) };
  }

  function claim(view) {
    const unclassified = (reason) => ({ kind: 'unclassified', reason });
    const last = view.messages.at(-1);
    const prefill = prefills && last.role === 'assistant';
    if (last.role !== 'user' && !prefill) return unclassified(`the last message is the ${last.role}'s`);
    if (!step) return unclassified('no step is set');
    // A persistent reader or subagent carries its marker in its system prompt; a reader fork shares the resident's
    // prompt and gets its voice block, which carries the marker, in a message after the fork point.
    const agent = step.sub && (view.system.includes(step.sub.marker) || texts(view).some((t) => t.includes(step.sub.marker))) ? 'sub' : 'primary';
    if (prefill && agent === 'primary') {
      const name = config.agent?.name ?? FIXTURE_AGENT;
      // membrane's prefill messages each open a participant's turn, the agent's name alone in the last where it's the
      // agent's to begin, or continue one past a cache marker or an image, so their texts are joined a line apart.
      const transcript = view.messages.map((m) => texts({ messages: [m] }).join('')).join('\n').trimEnd();
      const awaits = transcript === `${name}:` || transcript.endsWith(`\n${name}:`);
      if (!awaits && !(transcript.endsWith('</function_results>') && lastRun(transcript).name === name)) return unclassified(`its prefill ends in no turn of ${name}'s`);
    }
    const script = agent === 'sub' ? step.sub : step;
    const anywhere = prefill || script.namedAnywhere === true;
    const lastTexts = prefill ? texts(view) : texts({ messages: [last] });
    const carried = found(lastTexts, CANARY);
    const where = anywhere ? texts(view) : lastTexts;
    const named = (script.also || []).some((s) => where.some((t) => t.includes(s)))
      || (anywhere && found(where, CANARY).some((c) => (script.canaries || []).includes(c)));
    if (!named && !carried.some((c) => (script.canaries || []).includes(c))) return unclassified(`its ${prefill ? 'prefill' : 'last message'} carries none of step ${step.id}'s ${agent === 'sub' ? 'subagent\'s ' : ''}canaries (it carries ${carried.join(' ') || 'none'})`);
    const replies = [...(script.replies || []), ...(script.spare || [])];
    if (answered[agent] >= replies.length) return unclassified(`step ${step.id} has no scripted ${agent === 'sub' ? 'subagent ' : ''}reply left (${answered[agent]} answered)`);
    const scripted = replies[answered[agent]];
    const answerWith = prefill ? prefillReply : reply;
    return {
      kind: 'agent',
      agent,
      answer(record) {
        answered[agent]++;
        if (scripted.error) {
          record.answer = { shape: 'error', status: scripted.error.status };
          return { error: { status: scripted.error.status, message: scripted.error.message ?? 'stand-in: scripted error', type: scripted.error.type, headers: scripted.error.headers } };
        }
        if (scripted.hold) return { held: () => answerWith(view, record, scripted), during: scripted.during ?? [] };
        if (scripted.settle) return { held: () => answerWith(view, record, scripted) };
        return answerWith(view, record, scripted);
      },
    };
  }

  return { claim, onStep: (next) => { step = next; answered.primary = 0; answered.sub = 0; } };
}
