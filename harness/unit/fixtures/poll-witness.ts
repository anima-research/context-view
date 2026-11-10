import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const watched = process.env.POLL_WITNESS;
const existsSync = fs.existsSync;
fs.existsSync = (path) => {
  const found = existsSync(path);
  if (!found && watched !== undefined && String(path) === watched) process.stdout.write(`poll-witness: absent ${watched}\n`);
  return found;
};
syncBuiltinESMExports();
