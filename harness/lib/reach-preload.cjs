const { appendFileSync } = require('node:fs');

const logPath = process.env.CONTEXT_VIEW_REACH_LOG;
// A spawn that can't be logged still starts, so profiling changes nothing the host does; it's counted here instead, and
// the harness reads the count with the host's blocks.
const UNLOGGED = Symbol.for('context-view.reach.unlogged');
const log = (entry) => {
  if (!logPath) return;
  try { appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); } catch {
    globalThis[UNLOGGED] = (globalThis[UNLOGGED] ?? 0) + 1;
  }
};
const entryOf = (entry) => (entry instanceof URL ? entry.href : String(entry));

const workerThreads = require('node:worker_threads');
const ThreadWorker = workerThreads.Worker;
workerThreads.Worker = class extends ThreadWorker {
  constructor(entry, options) {
    log({ kind: 'worker', entry: entryOf(entry), eval: options?.eval === true });
    super(entry, options);
  }
};
// Bun binds node:worker_threads' named exports when a module imports them, so `import { Worker }` sees the
// replacement only once the builtin's exports are synced.
require('node:module').syncBuiltinESMExports();

const WebWorker = globalThis.Worker;
if (typeof WebWorker === 'function') {
  globalThis.Worker = class extends WebWorker {
    constructor(entry, options) {
      log({ kind: 'worker', entry: entryOf(entry), eval: false });
      super(entry, options);
    }
  };
}

for (const name of ['spawn', 'spawnSync']) {
  const original = Bun[name];
  Bun[name] = function spawned(...args) {
    const argv = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
    log({ kind: 'child', argv: Array.isArray(argv) ? argv.map(String) : [String(argv)] });
    return original.apply(this, args);
  };
}

// Bun calls process.reallyExit once the exit listeners have run. The harness pauses at debugger statements and reads a
// host's blocks at the one in readPoint, known by its function and this file rather than by a line, since the source
// Bun serves the inspector is this file transpiled; so a host that exits by process.exit pauses here, with all its code
// run, while its blocks are read.
const reallyExit = process.reallyExit;
function readPoint() {
  debugger;
}
if (logPath && typeof reallyExit === 'function') {
  process.reallyExit = function exiting(code) {
    readPoint();
    return reallyExit.call(this, code);
  };
}
