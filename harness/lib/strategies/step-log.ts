import { FIXTURE_AGENT, FORK_PREFIX } from './checks.ts';
import type { HostLine } from '../standin/standin.ts';

const MARK = /\[\[s:M[0-9a-f]{8}\]\]/g;

type Seen = { boot: number; line: { seq: number; agent: string; kind: string; outcome?: string; error?: unknown; stamp?: string; messages?: Array<{ content?: string }> } };

export const compileRef = (boot: number, seq: number) => `c${boot}:${seq}`;

export function hostLines() {
  const marks = new Map<string, string[]>();
  const held = new Set<string>();
  let written: Array<[string, string]> = [];
  const compiling = new Set<string>();
  let compiles: Seen[] = [];
  return {
    see(kind: string, fields: Record<string, unknown>) {
      if (kind !== 'compiles') return;
      for (const [id, v] of Object.entries((fields.blobs ?? {}) as Record<string, unknown>)) {
        const found = JSON.stringify(v ?? null).match(MARK);
        if (found) marks.set(id, [...new Set(found)]);
      }
      for (const [agent, st] of Object.entries((fields.store ?? {}) as Record<string, { summaries?: unknown }>)) {
        if (!Array.isArray(st?.summaries)) continue;
        for (const sm of st.summaries as Array<{ content?: unknown }>) {
          if (typeof sm?.content !== 'string') continue;
          const mark = marks.get(sm.content)?.[0];
          if (fields.at === 'boot') { if (mark !== undefined) held.add(mark); } else written.push([agent, sm.content]);
        }
      }
      for (const line of (fields.lines ?? []) as Seen['line'][]) {
        if (line.kind === 'request' && line.outcome === 'compiled') compiling.add(line.agent);
        compiles.push({ boot: Number(fields.boot), line });
      }
    },
    take(): { lines: HostLine[]; primary: string; wrote: Map<string, string> } {
      const lines: HostLine[] = [];
      compiles.forEach(({ boot, line }, i) => {
        if (line.kind === 'other' || !(line.kind === 'dry' || line.outcome === 'refused' || line.error)) return;
        const next = compiles.slice(i + 1).find((x) => x.boot === boot && x.line.agent === line.agent && x.line.kind === 'request' && x.line.outcome === 'compiled' && /^\d+$/.test(x.line.stamp ?? ''));
        const stamp = /^\d+$/.test(line.stamp ?? '') ? line.stamp! : next?.line.stamp ?? null;
        const needs = [...new Set((line.messages ?? []).flatMap((m) => marks.get(m.content ?? '') ?? []))];
        lines.push({ ref: compileRef(boot, line.seq), agent: line.agent, at: stamp === null ? null : BigInt(stamp), needs });
      });
      compiles = [];
      const only = [...compiling];
      const writers = new Map<string, Set<string>>();
      for (const [agent, content] of written) {
        const mark = marks.get(content)?.[0];
        if (mark !== undefined) writers.set(mark, (writers.get(mark) ?? new Set()).add(agent));
      }
      written = [];
      const wrote = new Map<string, string>();
      for (const [mark, agents] of writers) {
        if (agents.size === 1 && !held.has(mark)) wrote.set(mark, [...agents][0]);
        held.add(mark);
      }
      return { lines, primary: only.length === 1 && only[0].startsWith(FORK_PREFIX) ? only[0] : FIXTURE_AGENT, wrote };
    },
  };
}

const ACTS = new Set(['send', 'moving', 'advance', 'awaits', 'crash', 'boot', 'reload', 'remove', 'copy', 'checkpoint', 'suppress', 'panel', 'shutdown']);

export function settleGap() {
  let open = false;
  return {
    see(kind: string, fields: Record<string, unknown>) {
      if (kind === 'settle' && fields.phase === 'end') open = true;
      else if (ACTS.has(kind)) open = false;
    },
    stepEnded() { open = true; },
    get open() { return open; },
  };
}

export const driverLine = (kind: string, fields: Record<string, unknown>) => (kind === 'send' && (fields.via === 'ipc' || fields.via === 'fixture')) || kind === 'checkpoint' || kind === 'absent';
