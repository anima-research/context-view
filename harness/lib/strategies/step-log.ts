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
  const acted = new Set<string>();
  const created = new Set<string>();
  let compiles: Seen[] = [];
  return {
    see(kind: string, fields: Record<string, unknown>) {
      const event = fields.event as { type?: unknown; agentName?: unknown } | undefined;
      if (kind === 'ipc' && event?.type === 'dendrite:agent-created' && typeof event.agentName === 'string') created.add(event.agentName);
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
        if (typeof line.agent === 'string') acted.add(line.agent);
        compiles.push({ boot: Number(fields.boot), line });
      }
    },
    take(): { lines: HostLine[]; primary: string; wrote: Map<string, string>; managers: Set<string> } {
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
      const managers = new Set([...acted, ...created]);
      return { lines, primary: only.length === 1 && only[0].startsWith(FORK_PREFIX) ? only[0] : FIXTURE_AGENT, wrote, managers };
    },
  };
}

const ACTS = new Set(['send', 'moving', 'advance', 'awaits', 'crash', 'boot', 'reload', 'remove', 'copy', 'checkpoint', 'suppress', 'panel', 'stopping', 'shutdown']);

const driverLine = (kind: string, fields: Record<string, unknown>) => (kind === 'send' && (fields.via === 'ipc' || fields.via === 'fixture')) || kind === 'checkpoint' || kind === 'absent';

export function stepWatch() {
  let open = false;
  let asked = false;
  return {
    logged(kind: string, fields: Record<string, unknown>, step: string | null = null): string | null {
      if (kind === 'settle' && fields.phase === 'end') open = true;
      else if (ACTS.has(kind)) open = false;
      return asked && driverLine(kind, fields) ? `the driver wrote its ${kind === 'send' ? 'action' : kind} line after a request in step ${step ?? '(none)'}, and the record puts a driver's line first in its step, so it would show it before that request` : null;
    },
    request(r: { id: string; kind: string }, step: string | null = null): string | null {
      asked = true;
      return open ? `request ${r.id} (${r.kind}) arrived after a settle or a step ended and before the driver's next act, where the host's settle rule starts nothing, so the record can't say which step it belongs to` : null;
    },
    stepStarted() { asked = false; },
    stepEnded() { open = true; },
    get open() { return open; },
  };
}
