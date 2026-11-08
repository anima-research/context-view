import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANARY, SUMMARY } from '../standin/view.mjs';
import { namingCanaries } from './names.mjs';
import { isUnreadable, storedMessages, summaryLacks } from './invariants.mjs';

export async function readStore({ installDir, storePath, namespace, isolate = false }) {
  const cmEntry = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'src', 'index.js');
  const { ContextManager, AutobiographicalStrategy } = await import(pathToFileURL(cmEntry).href);
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false, topologyPolicy: 'report', auditOnly: true });
  // context-manager 0.24.0's `ContextManager.open` locks the store and opens it with `openOrCreate`, so a caller passes a copy.
  const cm = await ContextManager.open({ path: storePath, namespace, strategy, ...(isolate ? { isolate: true } : {}) });
  try {
    const stored = storedMessages(cm);
    if (isUnreadable(stored)) throw new Error(`getAllMessages: ${stored.unreadable}`);
    // A store whose window is presented (context-manager 0.25.0's windowMode) gives each row its window holds the ordinal
    // it entered it at, which orders what that agent is sent.
    const presents = cm.windowMode?.() === 'presented';
    const messages = stored.map((m) => {
      const ordinal = presents ? cm.ordinalOf(m.id) : undefined;
      return { ...storedEntry(m), ...(typeof ordinal === 'number' ? { ordinal } : {}) };
    });
    const ids = cm.getSummariesInRange({}).map((s) => s.id);
    if (ids.length === 0) throw new Error(`no summaries in ${namespace} at ${storePath}, from a configuration that compresses; it holds ${messages.length} message(s)${messages.length ? `, first carrying ${messages.find((m) => m.canaries.length)?.canaries[0] ?? 'no canary'}` : ''}`);
    const entries = new Map();
    for (const id of ids) {
      const s = cm.getSummary(id);
      if (!s) throw new Error(`getSummary(${id}) is null, though getSummariesInRange lists it`);
      const lacks = summaryLacks(s);
      if (lacks) throw new Error(`getSummary(${id}) ${lacks}`);
      entries.set(id, s);
    }
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    const leaves = (s, seen = new Set()) => {
      if (seen.has(s.id)) return [];
      seen.add(s.id);
      if (s.sourceLevel === 0) return s.sourceIds;
      return s.sourceIds.flatMap((id) => {
        const child = entries.get(id) ?? cm.getSummary(id);
        if (!child) throw new Error(`summary ${s.id}'s source ${id} can't be read`);
        const lacks = summaryLacks(child);
        if (lacks) throw new Error(`getSummary(${id}) ${lacks}`);
        return leaves(child, seen);
      });
    };
    const summaries = [...entries.values()].map((s) => ({
      id: s.id,
      level: s.level,
      sourceLevel: s.sourceLevel,
      sourceIds: s.sourceIds,
      ...summaryMarks(s),
      covers: leaves(s).flatMap((id) => byMessage.get(id)?.canaries ?? []),
    }));
    const violations = strategy.getTopologyViolations().map((v) => `L${v.level} ${v.id}: ${v.leafCount} leaves ${v.span.first}..${v.span.last}, ${v.holes} hole(s) e.g. ${v.holeSample.join(',')}${v.holeOwners.length ? ` owned by ${v.holeOwners.join(',')}` : ''}`);
    return { presented: presents, messages, summaries, violations };
  } finally {
    await cm.close();
  }
}

// A summary's number is the first stand-in summary mark in its text. A summary the split-stitch rung made
// (context-manager 0.25.0's `stitched`) is its fold parts' texts joined, so it carries one mark per fold part: the
// first is its number and the rest its `parts`, and each of its placeholders, a message no part folded, is a source it
// declares on purpose (`placeheld`) where its text carries that placeholder naming the message's id.
export function summaryMarks(s) {
  const text = String(s.content ?? '');
  const marks = [...new Set(text.match(SUMMARY) ?? [])];
  const number = marks[0] ?? null;
  if (!s.stitched) return { number };
  const named = (p) => typeof p?.messageId === 'string' && typeof p.text === 'string' && text.includes(p.text) && p.text.includes(`message id ${p.messageId})`);
  return { number, parts: marks.slice(1), placeheld: (Array.isArray(s.stitched.placeholders) ? s.stitched.placeholders : []).filter(named).map((p) => p.messageId) };
}

const textOf = (content) => (Array.isArray(content) ? content : [content]).map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'tool_result' ? JSON.stringify(b.content) : '')).join('');

export function storedEntry(m) {
  return {
    id: m.id,
    participant: m.participant,
    canaries: textOf(m.content).match(CANARY) ?? [],
    nameCanary: namingCanaries(m.content)[0],
    ...(m.participant === 'Context Manager' && (Array.isArray(m.content) ? m.content : []).some((b) => b?.type === 'text' && b.text.startsWith('[Topic Transition]')) ? { topicTransition: true } : {}),
    ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId, shardIndex: m.shardIndex } : {}),
  };
}
