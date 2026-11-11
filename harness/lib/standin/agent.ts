import { prose } from '../strategies/prose.ts';
import { CANARY, found, lastRun, texts } from './view.ts';
import { FIXTURE_AGENT } from '../strategies/checks.ts';
import type { JsonLike } from '../strategies/compare.ts';
import type { Answer, Claim, Kind, Reply, RequestRecord, Unclassified } from './standin.ts';
import type { Block, Message, ReadView } from './view.ts';

export interface AgentConfiguration {
  agent?: { formatter?: string; name?: string };
  thinks?: boolean;
}

interface Call { id?: string; name: string; input?: { [key: string]: JsonLike } }

interface Scripted {
  thinking?: string;
  text?: string;
  calls?: Call[] | ((messages: Message[]) => Call[]);
  stop?: string;
  error?: { status: number; message?: string; type?: string; headers?: Record<string, string> };
  hold?: boolean;
  settle?: boolean;
  during?: unknown[];
}

interface Script {
  canaries?: string[];
  also?: string[];
  namedAnywhere?: boolean;
  replies?: Scripted[];
  spare?: Scripted[];
}

interface Sub extends Script {
  marker: string;
  as?: string;
}

export interface AgentStep extends Script {
  id: string;
  reader?: { prefix?: unknown };
  subs?: Sub[];
  probe?: { text: string; error?: undefined } | { error: NonNullable<Scripted['error']>; text?: undefined };
}

const THINKING_CHARS = 600;

/** The id the stand-in gives a scripted call that names none: `toolu_fx` and a count of six digits or more. */
export const TOOL_ID = /toolu_fx\d{6,}(?!\w)/g;

// membrane 0.8.0's anthropic-xml formatter sends an agent's turn as a prefill: its last message is the assistant's,
// the transcript ending in the agent's name or a tool round's results, and the model's calls are XML in the text, cut
// at the `</function_calls>` stop sequence it sends, which the API leaves out of the text (formatters/anthropic-xml.js,
// utils/tool-parser.js).
const CALLS_STOP = '</function_calls>';

const xmlCalls = (calls: Call[]) => `<function_calls>\n${calls.map((c) => `<invoke name="${c.name}">\n${Object.entries(c.input ?? {}).map(([k, v]) => `<parameter name="${k}">${typeof v === 'string' ? v : JSON.stringify(v)}</parameter>\n`).join('')}</invoke>\n`).join('')}`;

export function agent({ configuration: config, toolIds = 0 }: { configuration: AgentConfiguration; toolIds?: number }): Kind & { toolIds(): number } {
  let step: AgentStep | null = null;
  let answered: Record<string, number> = {};
  let probed = false;
  let toolNumber = toolIds;
  const prefills = config.agent?.formatter === 'anthropic-xml';

  function reply(view: ReadView, record: RequestRecord, scripted: Scripted): Reply {
    const content: Block[] = [];
    const thinking = scripted.thinking ?? (config.thinks ? prose(THINKING_CHARS, view.seed()) : undefined);
    if (thinking !== undefined) content.push({ type: 'thinking', thinking });
    if (scripted.text !== undefined) content.push({ type: 'text', text: scripted.text });
    for (const call of (typeof scripted.calls === 'function' ? scripted.calls(view.messages) : scripted.calls) || []) content.push({ type: 'tool_use', id: call.id ?? `toolu_fx${String(++toolNumber).padStart(6, '0')}`, name: call.name, input: call.input });
    const stop = scripted.stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    record.answer = { shape: 'reply', chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), stop, toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id!) };
    return { content, stop };
  }

  function prefillReply(view: ReadView, record: RequestRecord, scripted: Scripted): Reply {
    const thinking = scripted.thinking ?? (config.thinks ? prose(THINKING_CHARS, view.seed()) : undefined);
    const calls = (typeof scripted.calls === 'function' ? scripted.calls(view.messages) : scripted.calls) || [];
    const parts = [...(thinking !== undefined ? [`<thinking>${thinking}</thinking>`] : []), ...(scripted.text !== undefined ? [scripted.text] : [])];
    const text = ` ${parts.join('\n')}${calls.length ? `\n${xmlCalls(calls)}` : ''}`;
    const stop = scripted.stop ?? (calls.length ? 'stop_sequence' : 'end_turn');
    record.answer = { shape: 'reply', chars: text.length, stop, toolUseIds: [] };
    return { content: [{ type: 'text', text }], stop, ...(stop === 'stop_sequence' ? { stopSequence: CALLS_STOP } : {}) };
  }

  function claim(view: ReadView): Claim {
    const unclassified = (reason: string): Unclassified => ({ kind: 'unclassified', reason });
    const last = view.messages.at(-1)!;
    const prefill = prefills && last.role === 'assistant';
    if (last.role !== 'user' && !prefill) return unclassified(`the last message is the ${last.role}'s`);
    if (!step) return unclassified('no step is set');
    if (step.probe && !probed && view.messages.length === 1 && !found(texts(view), CANARY).length && !(step.also || []).some((s) => texts(view).some((t) => t.includes(s)))) return probe(step.probe);
    // In agent-framework a persistent reader or subagent carries its marker in its system prompt; a reader fork shares
    // the resident's prompt and gets its voice block, which carries the marker, in a message after the fork point.
    const forked = (x: Sub) => step!.reader?.prefix !== undefined && texts(view).some((t) => t.includes(x.marker));
    const sub = (step.subs ?? []).find((x) => view.system.includes(x.marker) || forked(x));
    const agent = sub ? (sub.as ?? 'sub') : 'primary';
    if (prefill && agent === 'primary') {
      const name = config.agent?.name ?? FIXTURE_AGENT;
      // membrane's prefill messages each open a participant's turn, the agent's name alone in the last where it's the
      // agent's to begin, or continue one past a cache marker or an image, so their texts are joined a line apart.
      const transcript = view.messages.map((m) => texts({ messages: [m] }).join('')).join('\n').trimEnd();
      const awaits = transcript === `${name}:` || transcript.endsWith(`\n${name}:`);
      if (!awaits && !(transcript.endsWith('</function_results>') && lastRun(transcript).name === name)) return unclassified(`its prefill ends in no turn of ${name}'s`);
    }
    const script = sub ?? step;
    const who = !sub ? '' : agent === 'sub' ? 'subagent' : `subagent ${agent}`;
    const anywhere = prefill || script.namedAnywhere === true;
    const lastTexts = prefill ? texts(view) : texts({ messages: [last] });
    const carried = found(lastTexts, CANARY);
    const where = anywhere ? texts(view) : lastTexts;
    const named = (script.also || []).some((s) => where.some((t) => t.includes(s)))
      || (anywhere && found(where, CANARY).some((c) => (script.canaries || []).includes(c)));
    if (!named && !carried.some((c) => (script.canaries || []).includes(c))) return unclassified(`its ${prefill ? 'prefill' : 'last message'} carries none of step ${step.id}'s ${who ? `${who}'s ` : ''}canaries (it carries ${carried.join(' ') || 'none'})`);
    const replies = [...(script.replies || []), ...(script.spare || [])];
    const n = answered[agent] ?? 0;
    if (n >= replies.length) return unclassified(`step ${step.id} has no scripted ${who ? `${who} ` : ''}reply left (${n} answered)`);
    const scripted = replies[n];
    const answerWith = prefill ? prefillReply : reply;
    const framing = sub && forked(sub) ? view.messages.findLastIndex((m) => texts({ messages: [m] }).some((t) => t.includes(sub.marker))) : -1;
    return {
      kind: 'agent',
      agent,
      ...(framing >= 0 ? { forkAt: framing } : {}),
      answer(record): Answer {
        answered[agent] = (answered[agent] ?? 0) + 1;
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

  function probe(scripted: NonNullable<AgentStep['probe']>): Claim {
    return {
      kind: 'probe',
      answer(record): Answer {
        probed = true;
        if (scripted.error) {
          record.answer = { shape: 'error', status: scripted.error.status };
          return { error: { status: scripted.error.status, message: scripted.error.message ?? 'stand-in: scripted error', type: scripted.error.type, headers: scripted.error.headers } };
        }
        record.answer = { shape: 'verdict', verdict: 'answered', chars: scripted.text.length };
        return { content: [{ type: 'text', text: scripted.text }], stop: 'end_turn' };
      },
    };
  }

  return { claim, onStep: (next: AgentStep) => { step = next; answered = {}; probed = false; }, toolIds: () => toolNumber };
}
