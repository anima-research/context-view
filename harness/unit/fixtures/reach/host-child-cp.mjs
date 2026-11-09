import { spawnSync } from 'node:child_process';
import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
spawnSync('bun', [new URL('./child.mjs', import.meta.url).pathname], { stdio: 'inherit' });
console.log('ready');
setInterval(() => {}, 1000);
