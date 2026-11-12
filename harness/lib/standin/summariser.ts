import { createHash } from 'node:crypto';
import { prose } from '../strategies/prose.ts';
import { RATE } from './tokens.ts';
import { CANARY, found, SUMMARY, texts } from './view.ts';
import type { Masker } from '../strategies/compare.ts';
import type { AnswerRecord, Claim, Failure, Kind, Reply, RequestRecord } from './standin.ts';
import type { Block, ReadView, View } from './view.ts';

export type BadAnswer = 'empty' | 'thinking-only' | 'max-tokens';

export interface SummariserStep {
  badAnswers?: BadAnswer[];
  summariserHold?: { level?: number; during?: unknown[] };
}

type Placed = 'merge' | 'ahead' | 'unplaced' | 'slice';

type Asked = { level: number; sent: { canaries: string[]; summaries: string[] }; target: number };

type SummariserFields = Asked & { texts: string[]; carried?: Placed; retry: boolean; resends?: BadAnswer };

export type SummariserRecord = RequestRecord & SummariserFields;

interface Bad { id: string; level: number; target: number; canaries: string[]; summaries: string[]; shape: BadAnswer; settled: boolean }

// The openings of context-manager 0.24.0's compression instructions (autobiographical.ts, knowledge.ts) and of
// connectome-host's frontdesk strategy (src/strategies/frontdesk-strategy.ts).
export const INSTRUCTIONS = [
  /Write the memory of events since the most recent memory system notification\./,
  /Write the memory of this slice of the log\./,
  /You have just been reading a substantial body of text/,
  /You have just reviewed [\s\S]+? in chronological order\./,
  /You have just re-experienced [\s\S]+? in chronological order\./,
  /Summarize the research performed\./,
  /Capture the reasoning and conclusions from this discussion\./,
  /Record what knowledge was captured\./,
  /Summarize the subagent work\./,
  /Please consolidate these \d+ L\d summaries/,
  /Starting from my last message, please describe everything that has happened\./,
];

function requestedTarget(instruction: string): number | null {
  const m = instruction.match(/Target ~(\d+) tokens|Aim for about (\d+) tokens/);
  return m ? Number(m[1] ?? m[2]) : null;
}

// context-manager 0.24.0's merge instructions open so (autobiographical.ts's formatMergeInstruction,
// formatWitnessedMergeInstruction and formatReadingMergeInstruction, knowledge.ts's consolidation), and each names the
// level it asks for, as `Ln`, which none of its L1 instructions names.
const MERGE_OPENS = /You have just reviewed [\s\S]+? in chronological order\.|You have just re-experienced [\s\S]+? in chronological order\.|Please consolidate these \d+ L\d summaries/;

function requestedLevel(instruction: string): number | null {
  const merge = instruction.match(/into a single L(\d+) memory|single L(\d+) memory|at L(\d+)\.|consolidate these \d+ L(\d) summaries/);
  if (!merge) return MERGE_OPENS.test(instruction) || /\bL\d+\b/.test(instruction) ? null : 1;
  const named = merge.slice(1).find((x) => x !== undefined);
  return /consolidate these/.test(merge[0]) ? Number(named) + 1 : Number(named);
}

export const REFUSED_CONTENT = 'REFUSED-CONTENT';

// context-manager 0.24.0's L1 requests, its source-only and split-stitch rungs included, open the slice they ask the
// summariser to remember with this notice (`COMPRESSION_MARKER`, src/strategies/autobiographical.ts:513), once, and
// "the target itself may quote the marker" (:9671).
const SLICE_OPENS = 'System: You will soon form a new memory, get ready.';

export const canaryOrder = (a: string, b: string) => {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y) && BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const seedOf = (read: { target: number; canaries: string[]; recalled: string[] }) => sha([read.target, read.canaries.join(','), read.recalled.join(',')].join('\u0000'));

function readSummariser(view: ReadView, target: number) {
  const all = [view.system, ...texts(view)];
  return {
    target,
    canaries: [...new Set(found(all, CANARY))].sort(canaryOrder),
    recalled: [...new Set(found(all, SUMMARY))].sort(),
  };
}

export function contentAt(view: View, level: number): Placed | null {
  const messages = JSON.stringify(view.messages ?? []);
  const outside = JSON.stringify({ ...view, messages: undefined }).includes(REFUSED_CONTENT);
  const at = messages.indexOf(REFUSED_CONTENT);
  if (at === -1 && !outside) return null;
  if (level >= 2) return 'merge';
  if (outside) return 'ahead';
  const opens = messages.indexOf(SLICE_OPENS);
  if (opens === -1 || messages.includes(SLICE_OPENS, opens + 1)) return 'unplaced';
  return at > opens ? 'slice' : 'ahead';
}

// A block that carries no canary or summary is the instruction whole, as the Messages API sends it. membrane's
// OpenAI-compatible adapter joins a message's text blocks into one string (openai-compatible.ts, convertMessages), so on
// the Chat Completions API a block can be the slice, its canaries or summaries marking it, joined to the instruction
// after it, and the slice can quote a target, a level or an opening of its own.
const MARKED = /\[\[c:[^\]\s]+\]\]|\[\[s:M[0-9a-f]{8}\]\]/g;
function instructionOf(view: View): { block: Block; text: string; at: number } | null {
  const last = view.messages.at(-1);
  const block = last?.content.at(-1);
  if (last?.role !== 'user' || block?.type !== 'text' || typeof block.text !== 'string') return null;
  const text = block.text;
  const marks = [...text.matchAll(MARKED)];
  if (!marks.length) return INSTRUCTIONS.some((re) => re.test(text)) ? { block, text, at: 0 } : null;
  const lastMark = marks.at(-1)!;
  const lineEnd = text.indexOf('\n', lastMark.index + lastMark[0].length);
  if (lineEnd === -1) return null;
  const rest = text.slice(lineEnd + 1);
  const opens = INSTRUCTIONS.map((re) => rest.search(re)).filter((i) => i >= 0);
  if (!opens.length) return null;
  const first = Math.min(...opens);
  const at = lineEnd + 1 + (first === 0 ? 0 : rest.lastIndexOf('\n', first - 1) + 1);
  return { block, text: text.slice(at), at };
}

const summariserTexts = (view: View, mask: Masker) => {
  const instruction = instructionOf(view);
  const pieces = (b: Block) => (instruction?.block === b && instruction.at > 0 ? [b.text!.slice(0, instruction.at - 1), instruction.text] : [b.text || '']);
  return view.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').flatMap(pieces).filter((t) => !t.match(CANARY)).map((t) => mask(t)));
};

function sliceCanaries(view: View) {
  const out: string[] = [];
  let open = false;
  for (const t of texts(view)) {
    const at = open ? 0 : t.indexOf(SLICE_OPENS);
    if (at < 0) continue;
    open = true;
    out.push(...(t.slice(at).match(CANARY) ?? []));
  }
  return [...new Set(out)];
}

export function summariser({ refuseMerges = false, rejectMerges = false, refuseContent = false, refusalCategory = null, thinkingWrapped = false, summaryTokens = null }: { refuseMerges?: boolean; rejectMerges?: boolean; refuseContent?: boolean; refusalCategory?: string | null; thinkingWrapped?: boolean; summaryTokens?: Record<number, number> | null }): Kind {
  let hold: { level: number; during: unknown[] | undefined; used: boolean } | null = null;
  const badQueue: BadAnswer[] = [];
  const badlyAnswered: Bad[] = [];
  // context-manager 0.24.0 re-sends a merge after a bad answer with its recall budget halved per attempt, keeping
  // whichever prior summaries fit (`capRecallPairs`), with its sources last; an L1 request it retries is re-sent whole.
  const alike = (b: Bad, read: Asked) => b.level === read.level && b.target === read.target && JSON.stringify(b.canaries) === JSON.stringify(read.sent.canaries);
  const resent = (read: Asked) => {
    const sources = (b: Bad) => (read.level >= 2 ? b.summaries.at(-1) === read.sent.summaries.at(-1) : JSON.stringify(b.summaries) === JSON.stringify(read.sent.summaries));
    return badlyAnswered.findLast((b) => !b.settled && alike(b, read) && sources(b)) ?? null;
  };
  // context-manager 0.24.0 retries the merge at the head of its queue until that merge is written or quarantined
  // (`recordMergeRejection`, src/strategies/autobiographical.ts:6909).
  const cutAndOpen = (read: Asked) => (read.level >= 2 ? badlyAnswered.findLast((b) => !b.settled && b.shape === 'max-tokens' && alike(b, read)) ?? null : null);

  function shapeOf(record: SummariserRecord): AnswerRecord['shape'] {
    const merge = record.level >= 2;
    if (rejectMerges && merge) return 'rejection';
    if (refuseMerges && merge) return 'refusal';
    if (record.carried) return 'refusal';
    if (badQueue.length && !record.resends) {
      const shape = badQueue.shift()!;
      badlyAnswered.push({ id: record.id, level: record.level, target: record.target, canaries: record.sent.canaries, summaries: record.sent.summaries, shape, settled: false });
      return shape;
    }
    return 'summary';
  }

  function answer(view: ReadView, record: SummariserRecord, read: ReturnType<typeof readSummariser>): Reply | Failure {
    const shape = record.answer!.shape;
    if (shape === 'rejection') return { error: { status: 400, message: `stand-in: merge request ${record.id} is rejected for its request` } };
    const seed = seedOf(read);
    const words = parseInt(seed.slice(8, 16), 16);
    const summary = `[[s:M${seed.slice(0, 8)}]]`;
    const head = `${summary} Memory ${seed.slice(0, 8)}, carried ${read.canaries.length} canaries to ${read.canaries.at(-1)?.slice(2, -2) ?? 'none'}:`;
    const memory = (chars: number) => `${head} ${prose(chars - head.length - 1, words)}`;
    let content: Block[]; let stop = 'end_turn';
    // The API's refusal before any output has no content; one after output began keeps what was sent before it.
    if (shape === 'refusal') { content = refusalCategory === null ? [{ type: 'text', text: 'I can\'t help with that.' }] : []; stop = 'refusal'; }
    else if (shape === 'empty') content = [{ type: 'text', text: '' }];
    else if (shape === 'thinking-only') content = [{ type: 'text', text: `<thinking>${prose(200, words)}</thinking>` }];
    else if (shape === 'max-tokens') content = [{ type: 'text', text: memory(Math.ceil(view.maxTokens! * RATE.prose * 2)) }];
    else {
      const chars = Math.floor((summaryTokens?.[record.level] ?? record.target) * RATE.prose);
      content = [{ type: 'text', text: thinkingWrapped ? `<thinking>${memory(chars)}</thinking>` : memory(chars) }];
    }
    if (['summary', 'max-tokens'].includes(shape)) record.answer!.summary = summary;
    record.answer!.chars = content.reduce((t, b) => t + (b.text ?? b.thinking ?? '').length, 0);
    record.answer!.stop = stop;
    return { content, stop, ...(stop === 'refusal' && refusalCategory !== null ? { category: refusalCategory } : {}) };
  }

  function claim(view: ReadView): Claim<SummariserFields> | null {
    const instruction = instructionOf(view);
    if (!instruction) return null;
    if (requestedTarget(instruction.text) === null) return { kind: 'unclassified', reason: 'its compression instruction states no target length' };
    if (requestedLevel(instruction.text) === null) {
      const named = MERGE_OPENS.test(instruction.text) ? null : instruction.text.match(/\bL\d+\b/)![0];
      return { kind: 'unclassified', reason: named ? `its instruction names a level (${named}) in none of the forms the stand-in reads` : 'its merge instruction names no level' };
    }
    const all = texts(view);
    const read: Asked = { level: requestedLevel(instruction.text)!, sent: { canaries: found(all, CANARY), summaries: found(all, SUMMARY) }, target: requestedTarget(instruction.text)! };
    const carried = refuseContent ? contentAt(view, read.level) : null;
    const retry = /do not call any tools for this|do not wrap it in <thinking>/.test(instruction.text);
    // context-manager 0.24.0 re-sends a request answered with only thinking, or with nothing, with a retry hint,
    // and a merge cut at max_tokens with none.
    const of = resent(read);
    const hinted = of ? of.shape !== 'max-tokens' : false;
    let reason = null;
    if ((of !== null || retry) && retry !== hinted) {
      reason = !of
        ? 'it carries a retry hint, but no earlier request with its canaries and summaries took a bad answer'
        : hinted
          ? `it re-sends a request answered ${of.shape}, but carries no retry hint the stand-in knows`
          : 'it re-sends a request cut at max_tokens, which context-manager 0.24.0 re-sends with no retry hint, but carries one';
    } else if (!of && cutAndOpen(read)) {
      reason = 'it matches a merge cut at max_tokens and not yet re-sent in level, target and canaries, but ends with another summary, so it can\'t be told from that merge\'s re-send';
    }
    const fields = (mask: Masker): SummariserFields => ({ texts: summariserTexts(view, mask), level: read.level, sent: read.sent, target: read.target, ...(carried ? { carried } : {}), retry, ...(of ? { resends: of.shape } : {}) });
    if (reason) return { kind: 'unclassified', reason, fields };
    return {
      kind: 'summariser',
      name: `summariser-M${seedOf(readSummariser(view, read.target)).slice(0, 8)}`,
      ...(of ? { resendOf: of.id } : {}),
      fields,
      answer(record) {
        const got = readSummariser(view, record.target);
        record.answer = { shape: shapeOf(record) };
        if (of && record.answer.shape === 'summary') of.settled = true;
        if (hold && !hold.used && read.level === hold.level) {
          hold.used = true;
          return { held: () => answer(view, record, got), during: hold.during, canaries: sliceCanaries(view) };
        }
        return answer(view, record, got);
      },
    };
  }

  return {
    claim,
    onStep: (step: SummariserStep) => {
      badQueue.push(...(step?.badAnswers || []));
      hold = step?.summariserHold ? { level: step.summariserHold.level ?? 1, during: step.summariserHold.during, used: false } : null;
    },
  };
}
