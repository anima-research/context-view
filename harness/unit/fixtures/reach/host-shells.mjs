import { $ } from 'bun';
await $`/bin/echo one`;
await $.nothrow()`/bin/echo two`;
await new $.Shell()`/bin/echo three`;
await new Bun.$.Shell()`/bin/echo four`;
console.log('ready');
setInterval(() => {}, 1000);
