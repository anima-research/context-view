import { withJudged } from '../strategies/checks.ts';
import { BEFORE_CONTENT_MS } from './turns.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { Reply, Step } from '../strategies/script.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Run } from './workloads.ts';

export type Breach = { step?: string | null; request?: string; what?: string; message: string };
export type Breaches = Breach[] & { readonly judged?: number; readonly judgedBy?: number; readonly besides?: string };
export type Owned = { check: number; what?: string };

export const cutByBound = (cut: true | 'ends' = true): Reply => ({ hold: true, cut: true, during: [{ advance: BEFORE_CONTENT_MS, cut }] });
export const stalled = (step: Step & { replies: Reply[] }) => ({ ...step, replies: [cutByBound(), ...step.replies], retries: true });

export function stallFlag(mine: RequestRecord[], stall: 'cut' | 'failed' | 'waited') {
  const digests = (r: RequestRecord) => (r.messages ?? []).map((m) => m.digest).join();
  const cuts = mine.filter((r) => r.answer?.shape === 'cut').length;
  if (stall === 'cut' && (cuts !== 1 || mine[0]?.answer?.shape !== 'cut' || !mine[1] || digests(mine[1]) !== digests(mine[0]))) return `the held call wasn't cut and sent again once with the same messages (${cuts} of the step's ${mine.length} request(s) cut, the first ${mine[0]?.answer?.shape ?? 'unanswered'}), where the inference bound cuts it ${BEFORE_CONTENT_MS} ms after its send and the deadline schedule gives it one fresh call`;
  if (stall === 'failed' && (mine.length !== 2 || cuts !== 2 || digests(mine[1]) !== digests(mine[0]))) return `the held call and its fresh call weren't both cut with the same messages (${cuts} of the step's ${mine.length} request(s) cut), where the inference bound cuts each ${BEFORE_CONTENT_MS} ms after its send and the deadline schedule gives the call one fresh call before the turn fails`;
  if (stall === 'waited' && (cuts || mine[0]?.answer?.shape !== 'reply')) return `${cuts} of the step's ${mine.length} request(s) were cut, the first ${mine[0]?.answer?.shape ?? 'unanswered'}, where with no inference bounds nothing cuts the held call and its own reply answers it`;
  return null;
}

export function arrivalFates(run: Run, steps: Step[]) {
  const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const blocksOf = (r: RequestRecord) => (r.messages ?? []).flatMap((m) => m.blocks);
  const at = (r: RequestRecord, c: string) => blocksOf(r).findIndex((b) => (b.canaries ?? []).includes(c));
  const out: Breach[] = [];
  let judged = 0;
  for (const s of steps) {
    for (const a of s.arrivals ?? []) {
      const log = run.log.filter((e) => e.step === s.id);
      const subs = new Set<string | undefined>(log.filter((e) => e.kind === 'request' && (e.request?.agent ?? 'primary') !== 'primary').map((e) => (e as Extract<LogEntry, { kind: 'request' }>).request.id));
      const released = log.findIndex((e) => e.kind === 'send' && e.via === 'release' && !subs.has(e.request));
      const sent = a.console ? log.findIndex((e) => e.kind === 'send' && e.via === 'console' && e.during !== undefined && e.id === a.message) : a.push ? log.findIndex((e) => e.kind === 'send' && e.via === 'push' && e.during !== undefined && e.eventId === a.message) : a.message ? log.findIndex((e) => e.kind === 'send' && e.via === 'channel' && e.during !== undefined && e.message?.messageId === a.message) : log.findIndex((e) => e.kind === 'agent-end');
      const stored = sent >= 0 && released > sent && (a.agent || log.slice(sent, released).some((e) => e.kind === 'ipc' && e.event?.type === 'message:added' && e.event.source === (a.console ? 'external-message' : a.push ? 'mcpl:push-event' : 'mcpl:channel-incoming')));
      const first = primary.find((r) => at(r, a.canary) >= 0);
      if (!stored) { out.push({ step: s.id, message: `couldn't judge ${a.canary}: it wasn't stored before its hold's release` }); continue; }
      if (!first) { out.push({ step: s.id, message: `couldn't judge ${a.canary}: no request carries it` }); continue; }
      judged++;
      const held = a.point === 'end' ? primary.find((r) => r.id === (log[released] as Extract<LogEntry, { kind: 'send' }>).request) : null;
      const due = a.point === 'end' ? (held ? primary.find((r) => r.seq > held.seq) : null) : primary.find((r) => at(r, a.after) >= 0);
      const where = a.point === 'end' ? 'its wake turn\'s first request, the first after the turn\'s held final request' : `the request after its boundary, the first to carry ${a.after}`;
      if (first !== due) { out.push({ step: s.id, request: first.id, message: `${a.canary} is first carried by request ${first.id}, where its point gives ${due ? `request ${due.id}` : 'no request'}, ${where}` }); continue; }
      const ahead = at(first, a.after);
      if (ahead < 0) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary} without ${a.after}, which its point puts ahead of it` });
      else if (at(first, a.canary) < ahead) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary} before ${a.after}` });
      if (a.routing) {
        const rest = blocksOf(first).slice(at(first, a.canary) + 1);
        const next = rest.findIndex((b) => !b.notice && (b.canaries ?? []).length > 0);
        if (!(next < 0 ? rest : rest.slice(0, next)).some((b) => b.notice === 'routing')) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary` });
      }
    }
  }
  return withJudged(out, judged);
}
