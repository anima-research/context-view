export type Versions = Record<string, string | null>;

export interface Pack { path: string; name: string; integrity: string }

export interface Release { tag: string; versions: Versions | null }

export interface Flag { check: number; step: string | null; what?: unknown; detail?: string; whole?: string }

export interface Flags { new: Flag[]; gone: Flag[]; kept: Flag[] }

export type Figure = 'input' | 'cacheRead' | 'cacheWrite' | 'output';

/** A kind's sums: its requests' tokens and dropped thinking, and, where the run was priced, what the priced ones cost
 *  in USD and how many had no price. */
export type Sums = Record<Figure | 'requests' | 'dropped', number> & { cost?: number; unpriced?: number };

export interface Context {
  seams: number;
  /** The tokens the seams took out, summed. */
  out: number;
  largest: number;
  /** The most context one agent request held: its input, cache read and cache write. */
  peak: number;
}

export interface Usage {
  kinds: Record<string, Sums>;
  history?: Record<string, Sums>;
  lastDropped: number | null;
  /** The run's seams: requests in which an agent no longer carries part of what its previous request carried, or
   *  withholds from its model a part with no copy left over in that request, carried or withheld, each of that
   *  request's parts covering one copy at most. */
  context: Context;
  calibration: { multiplier: number; provisional: boolean; reset: boolean } | null;
  /** Why the arm's host couldn't price the run's requests, where it couldn't. */
  priceUnread?: string;
}

export interface Counts {
  compiles: number;
  compressions: number;
  merges: number;
  quarantines: Record<'compression' | 'merge', number | 'unreadable'> | 'not-reported';
}

export type SelfCheck =
  | { outcome: 'same'; requests: number }
  | { outcome: 'differs'; at: number; files?: [string | null | undefined, string | null | undefined]; detail: string }
  | { outcome: 'couldnt-run'; reason: string };

export interface RunResult {
  run: string;
  outcome: 'pass' | 'flags' | 'invalid' | 'couldnt-run';
  reason?: string;
  record: 'same' | 'differs' | 'missing' | 'written' | null;
  flags?: Flags;
  unmeasured?: string[];
  baseUnmeasured?: string[];
  readsFailed?: string[];
  baseReadsFailed?: string[];
  baseReason?: string;
  absent?: string[];
  baseAbsent?: string[];
  counts?: Counts;
  usage?: Usage;
  selfCheck?: SelfCheck;
}

export interface Runtime { node: string; platform: string; arch: string }

export interface RunJson {
  lane: string;
  runs: string[];
  runtime: Runtime;
  /** The workloads module's digest, for an invocation that ran one (run.ts --workloads). */
  workloads?: { sha256: string };
  release: Release;
  upgrades?: Release[];
  candidate: { versions: Versions; overlays: Pack[] };
  seconds: { runs: Record<string, number>; checkpoints: Record<string, number>; installs?: Record<string, number> };
  results: RunResult[];
}

export interface Entry {
  id: string;
  describe: string;
  count: number;
  runs: string[];
  places: Array<{ run: string; step: string; digest: string }>;
  examples: Array<{ run: string; step: string; before: string; after: string }>;
}

export type ChangedLines = Record<string, { lines: number[]; deletions: Array<{ after: number }>; binary?: true }>;

export interface ReachDeletion { after: number; state: 'reached' | 'not-reached' | 'couldnt-tell' | 'no-code' | 'unloaded'; by: number | null }

export interface ReachFile {
  state: 'read' | 'not-loaded' | 'couldnt-tell';
  ran: number[];
  notRan: number[];
  noCode: number[];
  couldntTell: number[];
  unloaded: number[];
  deletions: ReachDeletion[];
  binary?: true;
  reason?: string;
}

// `child` names the fleet child whose process a read is, where it isn't the host the harness started.
export interface ReachDrive { boot: number | null; read: boolean; child?: string }

export interface Digest {
  named: Record<string, { code: number[]; ran: number[] }>;
  notes: string[];
  fallbacks: string[];
  maplessBuilt: string[];
  unprofiled: Record<string, string>;
  noDrive?: true;
}

export interface ReachPart {
  change: string;
  writer: string;
  changed: ChangedLines;
  onDisk: Record<string, number[]>;
  split: Record<string, string>;
  drives: Record<string, ReachDrive[]>;
  digests: Digest[];
}

export type ReachPartRead = Pick<ReachPart, 'change' | 'changed' | 'onDisk' | 'digests'> & Partial<Pick<ReachPart, 'writer' | 'split' | 'drives'>>;

export interface Reach {
  change: string;
  files: Record<string, ReachFile>;
  notes: string[];
  fallbacks: { fired: number; notes: string[] };
  drives: Record<string, ReachDrive[]>;
  code: { wrote: Array<string | null | undefined>; joined: string };
}

export type ReachJson = Reach | { couldnt: string };
