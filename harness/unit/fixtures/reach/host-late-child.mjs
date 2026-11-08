import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
console.log('ready');
setTimeout(async () => {
  const child = Bun.spawn(['bun', new URL('./child.mjs', import.meta.url).pathname], { stdout: 'inherit' });
  await child.exited;
  console.log('late');
}, 500);
setInterval(() => {}, 1000);
