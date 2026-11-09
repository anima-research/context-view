import { chmodSync, writeFileSync } from 'node:fs';
import { sign } from './fixpkg/dist/index.js';
// The spawn log is made unwritable before the child starts, so the preload can't log it.
writeFileSync(process.env.CONTEXT_VIEW_REACH_LOG, '');
chmodSync(process.env.CONTEXT_VIEW_REACH_LOG, 0o444);
console.log(sign(1));
const child = Bun.spawn(['bun', new URL('./child.mjs', import.meta.url).pathname], { stdout: 'inherit' });
await child.exited;
console.log(`child exited ${child.exitCode}`);
console.log('ready');
setInterval(() => {}, 1000);
