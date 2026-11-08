import { parentPort } from 'node:worker_threads';
const { inChild } = require('./index.js');
parentPort?.postMessage(inChild(5));
