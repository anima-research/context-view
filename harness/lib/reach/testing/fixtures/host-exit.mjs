import { planted, sign } from './fixpkg/dist/index.js';
process.on('exit', () => { planted(1); });
console.log(sign(1));
console.log('ready');
setTimeout(() => process.exit(0), 200);
setInterval(() => {}, 1000);
