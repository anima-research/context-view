import { createHash } from 'node:crypto';
import { runVaryingMasker } from './compare.ts';
import { fixtureWords } from './results.ts';
import { TOOL } from './script.ts';
import { pngSize } from '../standin/tokens.ts';
import { CANARY, markerOf, SUMMARY } from '../standin/view.ts';
import type { JsonLike } from './compare.ts';
import type { Step } from './script.ts';
import type { Block, View } from '../standin/view.ts';

export type Named = { name: string; text: string };
export type Generated = { texts: Named[]; index: Map<string, number[]>; short: string[]; calls: Set<string> };
export type Run = { e: number; from: number; start: number; length: number };
export type Part = { run: Run; text?: undefined } | { text: string; run?: undefined };
type Tool = { name?: unknown; description?: unknown; input_schema?: unknown; cache_control?: unknown; [field: string]: unknown };
type Called = { name?: unknown; input?: unknown };

const KEY = 32;
const STRIDE = 16;
const HEAD = 40;
const NAMED = 200;

const MARK = new RegExp(`${CANARY.source}|${SUMMARY.source}`);
const markOf = (text: string) => text.match(MARK)?.[0] ?? null;
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const count = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const oneLine = (s: string) => s.replace(/\s+/g, ' ');
const headOf = (s: string) => {
  const t = s.trimStart();
  return t.length > HEAD ? `${oneLine(t.slice(0, HEAD))}…` : oneLine(t);
};

export function generatedTexts({ steps = [], answers = [], callText = null }: { steps?: Step[]; answers?: Block[][]; callText?: ((call: Block) => string) | null }): Generated {
  const texts: Named[] = [];
  const known = new Set<string>();
  const short = new Set<string>();
  const calls = new Set<string>();
  const add = (text: unknown, kind: string, call = false) => {
    if (typeof text !== 'string') return;
    if (text.length < KEY) {
      if (call) calls.add(text);
      else if (text.match(MARK)) short.add(text);
      return;
    }
    if (known.has(text)) return;
    known.add(text);
    texts.push({ name: markOf(text) ?? kind, text });
  };
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (MARK.test(v)) add(v, '(text)'); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if ((v as Called).name === TOOL && (v as Called).input && typeof (v as Called).input === 'object') {
      const result = fixtureWords((v as Called).input);
      if (!result.isError) for (const b of result.content) if (b.type === 'text') add(b.text, '(result)');
    }
    Object.values(v).forEach(walk);
  };
  walk(steps);
  for (const content of answers) {
    for (const b of content ?? []) {
      if (b.type === 'text') add(b.text, '(reply)');
      else if (b.type === 'thinking') add(b.thinking, '(thinking)');
      else {
        if (callText && b.type === 'tool_use') add(callText(b), '(call)', true);
        walk(b);
      }
    }
  }
  const index = new Map<string, number[]>();
  texts.forEach(({ text }, e) => {
    for (let at = 0; at + KEY <= text.length; at += STRIDE) {
      const key = text.slice(at, at + KEY);
      const hits = index.get(key);
      if (hits) hits.push(e, at); else index.set(key, [e, at]);
    }
  });
  return { texts, index, short: [...short].sort((a, b) => b.length - a.length), calls };
}

export function partsOf(s: string, generated: Pick<Generated, 'texts' | 'index'>, from = 0, to = s.length): Part[] {
  const { texts, index } = generated;
  const parts: Part[] = [];
  let i = from;
  let free = from;
  while (i + KEY <= to) {
    if (!index.has(s.slice(i, i + KEY))) { i++; continue; }
    let best: Run | null = null;
    for (let j = i; j < i + STRIDE && j + KEY <= to; j++) {
      const hits = index.get(s.slice(j, j + KEY)) ?? [];
      for (let h = 0; h < hits.length; h += 2) {
        const g = texts[hits[h]].text;
        const at = hits[h + 1];
        let back = 0;
        while (back < at && j - back > free && s.charCodeAt(j - back - 1) === g.charCodeAt(at - back - 1)) back++;
        let fwd = KEY;
        while (at + fwd < g.length && j + fwd < to && s.charCodeAt(j + fwd) === g.charCodeAt(at + fwd)) fwd++;
        const c = { e: hits[h], from: at - back, start: j - back, length: back + fwd };
        if (!best || c.length > best.length || (c.length === best.length && (c.start < best.start || (c.start === best.start && g.length < texts[best.e].text.length)))) best = c;
      }
    }
    if (best!.start > free) parts.push(...partsOf(s, generated, free, best!.start));
    parts.push({ run: best! });
    i = free = best!.start + best!.length;
  }
  if (free < to) parts.push({ text: s.slice(free, to) });
  return parts;
}

function runPart({ e, from, length }: Run, { texts }: Pick<Generated, 'texts'>) {
  const { name, text } = texts[e];
  const to = from + length;
  const span = from === 0 && to === text.length ? `${count(length)} chars` : `chars ${count(from)}–${count(to)} of ${count(text.length)}`;
  let said = text.slice(from, to);
  if (said.startsWith(name)) said = said.slice(name.length).trimStart();
  return `⟪${name} ${span}: ${headOf(said)}⟫`;
}

export const RESULT_FORM = 'Results below went with their content as a string and is_error: false, unless a line says otherwise.';

export function transcriptOf(view: View, generated: Generated, seen = new Set<string>(), { api }: { api?: string | null } = {}) {
  const errorForm = api === 'messages';
  const lines: string[] = [];
  const mask = runVaryingMasker();
  const stack = (label: string | null, text: string, shortest = NAMED) => {
    const masked = mask(text);
    if (masked.length < shortest) return masked;
    const key = digest(masked);
    if (seen.has(key)) return `(as above: ${label ?? JSON.stringify(headOf(masked))}, ${count(masked.length)} chars, ${key})`;
    seen.add(key);
    return masked;
  };
  const emit = (indent: number, header: string, content?: string) => {
    const pad = '  '.repeat(indent);
    if (content === undefined) { lines.push(`${pad}${header}`); return; }
    const rows = content.split('\n');
    if (rows.length === 1) { lines.push(`${pad}${header}: ${content}`); return; }
    lines.push(`${pad}${header}:`);
    for (const row of rows) lines.push(`${pad}    | ${row}`);
  };
  const rendered = (s: string) => partsOf(s, generated).map((p) => (p.run ? runPart(p.run, generated) : stack(null, p.text))).join('');
  const renderedJson = (v: JsonLike): string => {
    if (typeof v === 'string') return `"${partsOf(v, generated).map((p) => (p.run ? runPart(p.run, generated) : stack(null, JSON.stringify(p.text).slice(1, -1)))).join('')}"`;
    if (Array.isArray(v)) return `[${v.map(renderedJson).join(',')}]`;
    if (JSON.isRawJSON(v)) return v.rawJSON;
    if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${renderedJson(x)}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  };
  const cache = (b: { cache_control?: unknown; [field: string]: unknown } | undefined) => (b?.cache_control === null ? ' [cache null]' : b?.cache_control !== undefined ? ` [cache ${markerOf(b.cache_control)}]` : '');
  const blocksOf = (content: JsonLike | Block[]): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

  const besides = (b: Block | Tool, shown: string[], more = {}) => {
    const other = { ...Object.fromEntries(Object.entries(b).filter(([k]) => !shown.includes(k))), ...more };
    return Object.keys(other).length ? ` ${JSON.stringify(mask(other))}` : '';
  };

  const block = (b: Block, indent: number): void => {
    switch (b.type) {
      case 'text': return emit(indent, `text${cache(b)}${besides(b, ['type', 'text', 'cache_control'])}`, rendered(b.text ?? ''));
      case 'thinking': {
        const said = b.thinking ?? '';
        return emit(indent, `thinking${cache(b)} ${typeof b.signature === 'string' && b.signature ? 'signed' : 'unsigned'}${besides(b, ['type', 'thinking', 'signature', 'cache_control'])}`, rendered(said));
      }
      case 'redacted_thinking': return emit(indent, `redacted_thinking${cache(b)}${besides(b, ['type', 'data', 'cache_control'])}`, `${count((b.data ?? '').length)} chars`);
      case 'image': {
        const src = b.source ?? {};
        if (src.type !== 'base64') return emit(indent, `image${cache(b)}${besides(b, ['type', 'source', 'cache_control'])}`, JSON.stringify(mask(src)));
        const data = src.data ?? '';
        const size = pngSize(data);
        const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        const fromSource = Object.fromEntries(Object.entries(src).filter(([k]) => !['type', 'media_type', 'data'].includes(k)));
        return emit(indent, `image${cache(b)}${besides(b, ['type', 'source', 'cache_control'], Object.keys(fromSource).length ? { source: fromSource } : {})}`, `${src.media_type}${size ? ` ${size.width}×${size.height}` : ''}, ${count(bytes)} bytes`);
      }
      case 'tool_use': return emit(indent, `tool_use ${mask(String(b.id))} ${b.name}${cache(b)}${besides(b, ['type', 'id', 'name', 'input', 'cache_control'])}`, renderedJson(b.input ?? {}));
      case 'tool_result': {
        const form = [
          ...(b.is_error === true ? ['(error)'] : 'is_error' in b || !errorForm ? [] : ['(no is_error)']),
          ...(typeof b.content === 'string' ? [] : Array.isArray(b.content) ? ['(content as blocks)'] : b.content === undefined ? ['(no content)'] : [`(content ${JSON.stringify(mask(b.content))})`]),
        ];
        emit(indent, `tool_result ${mask(String(b.tool_use_id))}${form.map((f) => ` ${f}`).join('')}${cache(b)}${besides(b, ['type', 'tool_use_id', 'content', 'cache_control', ...(b.is_error === true || b.is_error === false ? ['is_error'] : [])])}`);
        for (const inner of blocksOf(b.content)) block(inner, indent + 1);
        return undefined;
      }
      default: {
        const { cache_control: _c, ...rest } = b;
        return emit(indent, `${b.type}${cache(b)}`, stack(null, JSON.stringify(rest)));
      }
    }
  };

  if (view.system) emit(0, 'system', stack('system', view.system));
  for (const tool of (view.tools ?? []) as Tool[]) {
    const { cache_control: _c, name, description, input_schema: schema, ...rest } = tool;
    const shown = [`description: ${description ?? ''}`, `input_schema: ${JSON.stringify(schema ?? null)}`, ...(Object.keys(rest).length ? [`other: ${JSON.stringify(rest)}`] : [])];
    emit(0, `tool ${name}${cache(tool)}`, stack(`tool ${name}`, shown.join('\n'), 0));
  }
  (view.messages ?? []).forEach((m, i) => {
    const { role, content: _c, cache_control: _m, ...envelope } = m;
    emit(0, `#${i} ${role}${cache(m)}${Object.keys(envelope).length ? ` ${JSON.stringify(mask(envelope))}` : ''}`);
    for (const b of blocksOf(m.content)) block(b, 1);
  });
  if (errorForm && (view.messages ?? []).some((m) => blocksOf(m.content).some((b) => b?.type === 'tool_result'))) lines.unshift(RESULT_FORM);
  return lines;
}
