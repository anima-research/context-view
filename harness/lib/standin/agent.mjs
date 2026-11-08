import { prose } from '../strategies/prose.mjs';
import { CANARY, found, texts } from './view.mjs';

const THINKING_CHARS = 600;

export function agent({ configuration: config }) {
  let step = null;
  const answered = { primary: 0, sub: 0 };
  let toolNumber = 0;

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

  function claim(view) {
    const unclassified = (reason) => ({ kind: 'unclassified', reason });
    const last = view.messages.at(-1);
    if (last.role !== 'user') return unclassified(`the last message is the ${last.role}'s`);
    if (!step) return unclassified('no step is set');
    const agent = step.sub && view.system.includes(step.sub.marker) ? 'sub' : 'primary';
    const script = agent === 'sub' ? step.sub : step;
    const lastTexts = texts({ messages: [last] });
    const carried = found(lastTexts, CANARY);
    const where = script.namedAnywhere === true ? texts(view) : lastTexts;
    const named = (script.also || []).some((s) => where.some((t) => t.includes(s)))
      || (script.namedAnywhere === true && found(where, CANARY).some((c) => (script.canaries || []).includes(c)));
    if (!named && !carried.some((c) => (script.canaries || []).includes(c))) return unclassified(`its last message carries none of step ${step.id}'s ${agent === 'sub' ? 'subagent\'s ' : ''}canaries (it carries ${carried.join(' ') || 'none'})`);
    const replies = [...(script.replies || []), ...(script.spare || [])];
    if (answered[agent] >= replies.length) return unclassified(`step ${step.id} has no scripted ${agent === 'sub' ? 'subagent ' : ''}reply left (${answered[agent]} answered)`);
    const scripted = replies[answered[agent]++];
    return {
      kind: 'agent',
      agent,
      answer(record) {
        if (scripted.error) {
          record.answer = { shape: 'error', status: scripted.error.status };
          return { error: { status: scripted.error.status, message: scripted.error.message ?? 'stand-in: scripted error', type: scripted.error.type, headers: scripted.error.headers } };
        }
        if (scripted.hold) return { held: () => reply(view, record, scripted), during: scripted.during ?? [] };
        if (scripted.settle) return { held: () => reply(view, record, scripted) };
        return reply(view, record, scripted);
      },
    };
  }

  return { claim, onStep: (next) => { step = next; answered.primary = 0; answered.sub = 0; } };
}
