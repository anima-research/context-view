import { Worker } from 'node:worker_threads';
import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
const w = new Worker(new URL('./fixpkg/dist/req-worker.js', import.meta.url));
await new Promise((r) => w.on('message', r));
await w.terminate();
console.log('ready');
setInterval(() => {}, 1000);
