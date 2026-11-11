export const BOOT_MS = 120_000;
export const TURN_MS = 120_000;
export const COMMAND_MS = 60_000;
export const MAINTAIN_MS = 120_000;
export const SHUTDOWN_MS = 30_000;
export const RESTART_MS = 1_000;
// chokidar 4's awaitWriteFinish holds a write it has seen until `new Date()` has moved its stabilityThreshold (100 ms in
// agent-framework's watcher) past the write, statting the file through `fs.stat` meanwhile, and the host's Date moves
// only with the workload's clock. So a watched write's step waits for that stat, then moves the clock a second: a
// resident's time passing, and more than the threshold.
export const WRITE_SETTLE_MS = 1_000;
export const VIRTUAL_FROM_MS = 30_000;
