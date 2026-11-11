import { parentPort } from 'node:worker_threads';
import { inChild } from './index.js';

parentPort?.postMessage(inChild(5));
