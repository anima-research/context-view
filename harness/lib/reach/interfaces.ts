import type { ChildProcess } from 'node:child_process';
import type { ChangedLines, Digest, ReachDrive, ReachJson, ReachPart, ReachPartRead } from '../shapes/interfaces.ts';
import { changedOf as changedOfImpl, digestOf as digestOfImpl, digestsOf as digestsOfImpl, driveOf as driveOfImpl, packRoots as packRootsImpl, type ProfiledDrive, profiledReads as profiledReadsImpl, reachAttach as reachAttachImpl, reachJoined as reachJoinedImpl, reachLaunch as reachLaunchImpl, reachPackOf as reachPackOfImpl, reachPart as reachPartImpl, type Read, type Spawned, splitBuilds as splitBuildsImpl, type Tree } from './reach.ts';

export type ReachLaunch = (options: { logDir: string }) => Promise<{ args: string[]; env: { CONTEXT_VIEW_REACH_LOG: string }; url: string; logPath: string }>;
/** What to add to a Bun command line, and its environment, to run it profiled. */
export const reachLaunch: ReachLaunch = reachLaunchImpl;
export type ReachAttach = (options: { launch: { url: string; logPath: string }; child?: ChildProcess | null; wanted?: (path: string) => boolean; killing?: () => void; stopped?: () => boolean }) => {
  attached: Promise<void>;
  atExit: Promise<Read>;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: () => number | null;
  readonly reading: Promise<Read> | null;
  readMs: () => number;
  spawnLog: () => Spawned[];
  spawnedNow: () => Promise<Spawned[]>;
  read: (wanted?: (path: string) => boolean) => Promise<Read>;
  close: () => void;
};
/** Attaches to a host started with reachLaunch's additions. `atExit` is the read taken where it exits by process.exit
 *  or process.reallyExit, or unread if it ends any other way, as by a signal. While that read is taken `reading` is its
 *  promise, and `readMs()` is the time the reads there have taken. A host it can't attach to it kills, calling
 *  `killing` first.
 *  With no `child`, as for a fleet child the host starts rather than the harness, the process has ended when its
 *  inspector closes (`ended`), the attach waits for one to listen for as long as `stopped()` says no, and `pid()` is the
 *  pid the process gives once attached, whose lines alone of the spawn log, which each of the child's processes writes
 *  to in turn, are its own. */
export const reachAttach: ReachAttach = reachAttachImpl;
export type ChangedOf = (diff: string) => ChangedLines;
/** The changed lines of `git diff -U0` output, by the head's path: each added line, and each hunk that only deletes
 *  as the head line it follows. A deleted file has no head lines, so it isn't listed. */
export const changedOf: ChangedOf = changedOfImpl;
export type DigestOf = (read: Read, tree: Tree) => Digest;
/** What one host's read says, by the tree's paths, small enough to keep for every boot of every run: with `only`,
 *  of those files alone. */
export const digestOf: DigestOf = digestOfImpl;
export type DigestsOf = (reads: Read[], id: string, tree: Tree) => Digest[];
/** Each boot's read of one run digested, a read that names why it's unread or can't be digested being an unread digest
 *  naming the run and boot, so a failure to digest costs that boot's reach, not the run's comparison. */
export const digestsOf: DigestsOf = digestsOfImpl;
export type DriveOf = (reads: Read[]) => ReachDrive[];
/** Each boot of a profiled drive, as reach.json's drives give it: read, or not. */
export const driveOf: DriveOf = driveOfImpl;
export type PackRoots = (lock: Record<string, unknown>, installDir: string, name: string) => string[];
/** Each install of a package in the candidate's lockfile. None is refused: with no install to read, nothing would be
 *  read, and every changed file would read as one no host loaded. */
export const packRoots: PackRoots = packRootsImpl;
export type ProfiledReads = (off: ProfiledDrive) => Read[];
/** The reads a self-check's profiled drive leaves: each boot's as taken, and an unread one for what it didn't run. */
export const profiledReads: ProfiledReads = profiledReadsImpl;
export type ReachJoined = (parts: Array<ReachPartRead | { missing: string }>) => ReachJson;
/** reach.json from one or more shares' reach-digests.json, each `{change, changed, onDisk, drives, digests}`, or
 *  `{missing: why}` for a share that brought none, which makes every unseen line couldn't tell. */
export const reachJoined: ReachJoined = reachJoinedImpl;
export type ReachPackOf = <P extends { name: string }>(packs: P[], named: string | null | undefined) => P | null;
/** The overlay a change's diff is of, among those laid over the host: the one, or the one named, by its package's name;
 *  null for a host change, with none. */
export const reachPackOf: ReachPackOf = reachPackOfImpl;
export type ReachPartOf = (part: Tree & Pick<ReachPart, 'change' | 'changed' | 'drives' | 'digests'> & { split?: Record<string, string> }) => ReachPart;
/** What one invocation keeps for a join: its digests, with the changed lines and their built code lines. */
export const reachPart: ReachPartOf = reachPartImpl;
export type SplitBuilds = (tree: Tree & { changed: ChangedLines }) => Record<string, string>;
/** Each changed file built into more than one script, by the scripts' own maps, with the reason: reach reads a file's
 *  code from the script a host loaded, so a line that script doesn't hold, or a line beside a deletion, may be another's.
 *  A built script whose map can't be read may hold any changed file, so it names them all. */
export const splitBuilds: SplitBuilds = splitBuildsImpl;
