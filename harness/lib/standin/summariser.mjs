import { createHash } from 'node:crypto';
import { prose } from '../strategies/prose.mjs';
import { RATE } from './tokens.mjs';
import { CANARY, found, SUMMARY, texts } from './view.mjs';

// The openings of context-manager 0.24.0's compression instructions (autobiographical.ts, knowledge.ts) and of this
// host's frontdesk strategy (src/strategies/frontdesk-strategy.ts).
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

function requestedTarget(instruction) {
  const m = instruction.match(/Target ~(\d+) tokens|Aim for about (\d+) tokens/);
  return m ? Number(m[1] ?? m[2]) : null;
}

// context-manager 0.24.0's merge instructions open so (autobiographical.ts's formatMergeInstruction,
// formatWitnessedMergeInstruction and formatReadingMergeInstruction, knowledge.ts's consolidation), and each names the
// level it asks for, as `Ln`, which none of its L1 instructions names.
const MERGE_OPENS = /You have just reviewed [\s\S]+? in chronological order\.|You have just re-experienced [\s\S]+? in chronological order\.|Please consolidate these \d+ L\d summaries/;

function requestedLevel(instruction) {
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

const canaryOrder = (a, b) => {
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

const sha = (s) => createHash('sha256').update(s).digest('hex');

function readSummariser(view, target) {
  const all = [view.system, ...texts(view)];
  return {
    target,
    canaries: [...new Set(found(all, CANARY))].sort(canaryOrder),
    recalled: [...new Set(found(all, SUMMARY))].sort(),
  };
}

export function contentAt(view, level) {
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

// The instruction a request ends with, from the last message's last text block. A block that carries no canary or
// summary is the instruction whole, as the Messages API sends it. The OpenAI-compatible adapter joins a message's text
// blocks into one string (membrane's openai-compatible.ts, convertMessages), so on the Chat Completions API a block can
// be the slice, its canaries or summaries marking it, joined to the instruction after it, and the slice can quote a
// target, a level or an opening of its own. In such a block the instruction opens at the start of the line that holds
// the first opening after the last marked line. Each step is a single pass over the block (one matchAll, one search per
// opening), with no loop of its own, so it ends on every text. `at` is where the instruction starts.
const MARKED = /\[\[c:[^\]\s]+\]\]|\[\[s:M[0-9a-f]{8}\]\]/g;
function instructionOf(view) {
  const last = view.messages.at(-1);
  const block = last?.content.at(-1);
  if (last?.role !== 'user' || block?.type !== 'text' || typeof block.text !== 'string') return null;
  const text = block.text;
  const marks = [...text.matchAll(MARKED)];
  if (!marks.length) return INSTRUCTIONS.some((re) => re.test(text)) ? { block, text, at: 0 } : null;
  const lastMark = marks.at(-1);
  const lineEnd = text.indexOf('\n', lastMark.index + lastMark[0].length);
  if (lineEnd === -1) return null;
  const rest = text.slice(lineEnd + 1);
  const opens = INSTRUCTIONS.map((re) => rest.search(re)).filter((i) => i >= 0);
  if (!opens.length) return null;
  const first = Math.min(...opens);
  const at = lineEnd + 1 + (first === 0 ? 0 : rest.lastIndexOf('\n', first - 1) + 1);
  return { block, text: text.slice(at), at };
}

// The call record's texts: each text block that carries no canary, the instruction as a text of its own where a block
// joined it to what came before it.
const summariserTexts = (view, mask) => {
  const instruction = instructionOf(view);
  const pieces = (b) => (instruction?.block === b && instruction.at > 0 ? [b.text.slice(0, instruction.at - 1), instruction.text] : [b.text || '']);
  return view.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').flatMap(pieces).filter((t) => !t.match(CANARY)).map((t) => mask(t)));
};

export function summariser({ refuseMerges = false, rejectMerges = false, refuseContent = false }) {
  const badQueue = [];
  const badlyAnswered = [];
  // context-manager 0.24.0 re-sends a merge after a bad answer with its recall budget halved per attempt, keeping
  // whichever prior summaries fit (`capRecallPairs`), with its sources last; an L1 request it retries is re-sent whole.
  const alike = (b, read) => b.level === read.level && b.target === read.target && JSON.stringify(b.canaries) === JSON.stringify(read.sent.canaries);
  const resent = (read) => {
    const sources = (b) => (read.level >= 2 ? b.summaries.at(-1) === read.sent.summaries.at(-1) : JSON.stringify(b.summaries) === JSON.stringify(read.sent.summaries));
    return badlyAnswered.findLast((b) => !b.settled && alike(b, read) && sources(b)) ?? null;
  };
  // context-manager 0.24.0 retries the merge at the head of its queue until that merge is written or quarantined
  // (`recordMergeRejection`, src/strategies/autobiographical.ts:6909).
  const cutAndOpen = (read) => (read.level >= 2 ? badlyAnswered.findLast((b) => !b.settled && b.shape === 'max-tokens' && alike(b, read)) ?? null : null);

  function shapeOf(record) {
    const merge = record.level >= 2;
    if (rejectMerges && merge) return 'rejection';
    if (refuseMerges && merge) return 'refusal';
    if (record.carried) return 'refusal';
    if (badQueue.length && !record.resends) {
      const shape = badQueue.shift();
      badlyAnswered.push({ level: record.level, target: record.target, canaries: record.sent.canaries, summaries: record.sent.summaries, shape, settled: false });
      return shape;
    }
    return 'summary';
  }

  function answer(view, record, read) {
    const shape = record.answer.shape;
    if (shape === 'rejection') return { error: { status: 400, message: `stand-in: merge request ${record.id} is rejected for its request` } };
    const seed = sha([read.target, read.canaries.join(','), read.recalled.join(',')].join('\u0000'));
    const words = parseInt(seed.slice(8, 16), 16);
    const summary = `[[s:M${seed.slice(0, 8)}]]`;
    const head = `${summary} Memory ${seed.slice(0, 8)}, carried ${read.canaries.length} canaries to ${read.canaries.at(-1)?.slice(2, -2) ?? 'none'}:`;
    const memory = (chars) => `${head} ${prose(chars - head.length - 1, words)}`;
    let content; let stop = 'end_turn';
    if (shape === 'refusal') { content = [{ type: 'text', text: 'I can\'t help with that.' }]; stop = 'refusal'; }
    else if (shape === 'empty') content = [{ type: 'text', text: '' }];
    else if (shape === 'thinking-only') content = [{ type: 'text', text: `<thinking>${prose(200, words)}</thinking>` }];
    else if (shape === 'max-tokens') content = [{ type: 'text', text: memory(Math.ceil(view.maxTokens * RATE.prose * 2)) }];
    else content = [{ type: 'text', text: memory(Math.floor(record.target * RATE.prose)) }];
    if (['summary', 'max-tokens'].includes(shape)) record.answer.summary = summary;
    record.answer.chars = content.reduce((t, b) => t + (b.text ?? b.thinking ?? '').length, 0);
    record.answer.stop = stop;
    return { content, stop };
  }

  function claim(view) {
    const instruction = instructionOf(view);
    if (!instruction) return null;
    if (requestedTarget(instruction.text) === null) return { kind: 'unclassified', reason: 'its compression instruction states no target length' };
    if (requestedLevel(instruction.text) === null) {
      const named = MERGE_OPENS.test(instruction.text) ? null : instruction.text.match(/\bL\d+\b/)[0];
      return { kind: 'unclassified', reason: named ? `its instruction names a level (${named}) in none of the forms the stand-in reads` : 'its merge instruction names no level' };
    }
    const all = texts(view);
    const read = { level: requestedLevel(instruction.text), sent: { canaries: found(all, CANARY), summaries: found(all, SUMMARY) }, target: requestedTarget(instruction.text) };
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
    const fields = (mask) => ({ texts: summariserTexts(view, mask), level: read.level, sent: read.sent, target: read.target, ...(carried ? { carried } : {}), retry, ...(of ? { resends: of.shape } : {}) });
    if (reason) return { kind: 'unclassified', reason, fields };
    return {
      kind: 'summariser',
      fields,
      answer(record) {
        const got = readSummariser(view, record.target);
        record.answer = { shape: shapeOf(record) };
        if (of && record.answer.shape === 'summary') of.settled = true;
        return answer(view, record, got);
      },
    };
  }

  return { claim, onStep: (step) => { badQueue.push(...(step?.badAnswers || [])); } };
}
