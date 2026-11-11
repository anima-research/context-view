import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
const child = Bun.spawn(['bun', new URL('./harness-side/server.mjs', import.meta.url).pathname], { stdout: 'inherit' });
await child.exited;
console.log('ready');
setInterval(() => {}, 1000);
