const { appendFileSync } = require('node:fs');

const logPath = process.env.CONTEXT_VIEW_REACH_LOG;
// A spawn that can't be logged still starts, so profiling changes nothing the host does; it's counted here instead, and
// the harness reads the count with the host's blocks.
const UNLOGGED: unique symbol = Symbol.for('context-view.reach.unlogged');
type Counted = typeof globalThis & { [UNLOGGED]?: number };
type Exiting = NodeJS.Process & { reallyExit?: (code?: number) => never };
type Shell = NonNullable<typeof Bun>['$'];
const log = (entry: object) => {
  if (!logPath) return;
  try { appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); } catch {
    (globalThis as Counted)[UNLOGGED] = ((globalThis as Counted)[UNLOGGED] ?? 0) + 1;
  }
};
const entryOf = (entry: string | URL) => (entry instanceof URL ? entry.href : String(entry));

const workerThreads = require('node:worker_threads');
const ThreadWorker = workerThreads.Worker;
workerThreads.Worker = class extends ThreadWorker {
  constructor(entry: string | URL, options?: import('node:worker_threads').WorkerOptions) {
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
    constructor(entry: ConstructorParameters<typeof WebWorker>[0], options?: ConstructorParameters<typeof WebWorker>[1]) {
      log({ kind: 'worker', entry: entryOf(entry), eval: false });
      super(entry, options);
    }
  };
}

for (const name of ['spawn', 'spawnSync'] as const) {
  const original = Bun![name];
  Bun![name] = function spawned(this: unknown, ...args: unknown[]) {
    const argv = Array.isArray(args[0]) ? args[0] : (args[0] as { cmd?: unknown } | undefined)?.cmd;
    log({ kind: 'child', argv: Array.isArray(argv) ? argv.map(String) : [String(argv)] });
    return original.apply(this, args);
  };
}

// Bun's shell starts its commands without Bun.spawn; `import { $ } from 'bun'` reads Bun.$, so a proxy put there logs each
// command, a builtin's too, and is otherwise the shell itself. Bun makes `$.Shell` non-configurable, so a proxy over $
// itself can't hand back a wrapped Shell: the proxy stands over a function of its own, and forwards to $, with Shell
// wrapped so a shell made with `new $.Shell()` logs its commands too, and the methods that return $ returning the proxy.
const shellCall = (args: Array<{ raw?: unknown } | undefined>) => log({ kind: 'child', argv: ['$', Array.isArray(args[0]?.raw) ? (args[0].raw as string[]).join('…') : String(args[0])] });
const shellOf = <T extends Shell>(shell: T) => new Proxy(shell, { apply(target, thisArg, args) { shellCall(args); return Reflect.apply(target, thisArg, args); } });
if (typeof Bun!.$ === 'function') {
  const original = Bun!.$;
  const Shell = new Proxy(original.Shell, { construct: (made, args, newTarget) => shellOf(Reflect.construct(made, args, newTarget)) });
  const shell = new Proxy(function $() {} as Shell, {
    apply(target, thisArg, args) { shellCall(args); return Reflect.apply(original, original, args); },
    get(target, prop) {
      if (prop === 'Shell') return Shell;
      const value = Reflect.get(original, prop);
      if (typeof value !== 'function' || Object.hasOwn(original, prop)) return value;
      return (...args: unknown[]) => { const made = Reflect.apply(value, original, args); return made === original ? shell : made; };
    },
  });
  Bun!.$ = shell;
}

// Bun calls process.reallyExit once the exit listeners have run. The harness pauses at debugger statements and reads a
// host's blocks at the one in readPoint, known by its function and this file rather than by a line, since the source
// Bun serves the inspector is this file transpiled; so a host that exits by process.exit pauses here, with all its code
// run, while its blocks are read.
const reallyExit = (process as Exiting).reallyExit;
function readPoint() {
  debugger;
}
if (logPath && typeof reallyExit === 'function') {
  (process as Exiting).reallyExit = function exiting(this: unknown, code?: number) {
    readPoint();
    return reallyExit.call(this, code);
  };
}
