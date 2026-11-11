#!/usr/bin/env node
import { harnessMain } from './lib/interfaces.ts';

await harnessMain(process.argv.slice(2));
