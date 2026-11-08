import { parentPort, workerData } from 'node:worker_threads';
const mod = await import(workerData.script);
parentPort?.postMessage(mod.answer());
//# sourceMappingURL=script-worker.js.map