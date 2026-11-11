import { existsSync } from 'node:fs';
import { sign } from './fixpkg/dist/index.js';
console.log(sign(1));
console.log('ready');
// The child starts only once the test has read the host's blocks and made the trigger file.
const waiting = setInterval(async () => {
  if (!existsSync(process.env.REACH_LATE_TRIGGER)) return;
  clearInterval(waiting);
  const child = Bun.spawn(['bun', new URL('./child.mjs', import.meta.url).pathname], { stdout: 'inherit' });
  await child.exited;
  console.log('late');
}, 20);
setInterval(() => {}, 1000);
