export const BOOT_MS = 120_000;
export const TURN_MS = 120_000;
export const COMMAND_MS = 60_000;
export const MAINTAIN_MS = 120_000;
export const SHUTDOWN_MS = 30_000;
// How long a cut act's release waits, in real time, for the stand-in to see the held call's connection close, once the
// host has given the call up. Its floor is how late that close can be seen: 18.5 ms at most in the probe's eight held
// calls, and in the views' stamps a single request's handling blocks the pair process for 167 ms at most, so nine
// drives' blocks queued together come to about 1.5 s there; one run on a busier machine saw a single block of 955 ms.
// Its ceiling is the turn's speech wait (TURN_MS), already running when this wait begins, which the release must not
// outlast. Too short gives a false flag, a cut call answered and counted as uncut, as the race did; too long only
// delays the answer to a call the host keeps open, which check 14 flags either way. So it sits well above the floor, at
// about seven times it, and well under the ceiling.
export const HELD_CLOSE_MS = 10_000;
export const RESTART_MS = 1_000;
// chokidar 4's awaitWriteFinish holds a write it has seen until `new Date()` has moved its stabilityThreshold (100 ms in
// agent-framework's watcher) past the write, statting the file through `fs.stat` meanwhile, and the host's Date moves
// only with the workload's clock. So a watched write's step waits for that stat, then moves the clock a second: a
// resident's time passing, and more than the threshold.
export const WRITE_SETTLE_MS = 1_000;
