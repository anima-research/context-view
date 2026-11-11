import { $ } from 'bun';
import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
await $`/bin/echo shell`;
console.log('ready');
setInterval(() => {}, 1000);
