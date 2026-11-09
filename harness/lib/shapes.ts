export type Versions = Record<string, string | null>;

export interface Pack { path: string; name: string; integrity: string }

export interface Release { tag: string; versions: Versions | null }

export interface Flag { check: number; step: string; what?: string; detail?: string; whole?: string }

export interface Flags { new: Flag[]; gone: Flag[]; kept: Flag[] }

export type Figure = 'input' | 'cacheRead' | 'cacheWrite' | 'output';

export type Sums = Record<Figure | 'requests' | 'dropped', number>;

export interface Usage {
  kinds: Record<string, Sums>;
  history?: Record<string, Sums>;
  lastDropped: number | null;
  calibration: { multiplier: number; provisional: boolean; reset: boolean } | null;
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
