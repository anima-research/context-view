import { sign } from './fixpkg/dist/index.js';
import { bare } from './fixpkg/dist/bare.js';
console.log(sign(1), bare(1));
console.log('ready');
setInterval(() => {}, 1000);
