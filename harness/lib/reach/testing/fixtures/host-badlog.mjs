import { appendFileSync } from 'node:fs';
import { sign } from './fixpkg/dist/index.js';
appendFileSync(process.env.CONTEXT_VIEW_REACH_LOG, '{"kind":"wor');
console.log(sign(1));
console.log('ready');
setInterval(() => {}, 1000);
