import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = /\bimg_([0-9a-z]+)_(\d+)\b/g;
const SESSION = /(<run>\/store\/sessions\/)[^/\s"'\\]+/g;
const FORK = /\b(fork-[^\s"]*?-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
// membrane 0.8.0's subscription mode keys the Codex backend's prompt cache on `<sessionId>:<12 hex of a digest>`, sent
// as `prompt_cache_key` and the `session_id` header, its sessionId a random UUID for each adapter unless the caller
// pins one (`openai-responses-api.ts`, buildRequest).
// Its shape alone would erase which requests share a key, which moves what the backend can cache, so a masker given a
// run's `keys` numbers each key by its first appearance there. Only a request's own top-level field of either name, on
// any API, or its `session_id` header, is masked so, through `mask.request`: a string of that shape anywhere else, a
// nested field of either name included, is content.
const CODEX_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{12}$/;
const CODEX_KEY_FIELDS = new Set(['prompt_cache_key', 'session_id']);

const ownText = (s, runDir) => (runDir ? s.split(runDir).join('<run>').replace(SESSION, '$1<session>') : s);

export function maskRunDir(value, runDir = process.env.FIXTURE_RUN_DIR || null) {
  if (!runDir) return value;
  const walk = (v) => (typeof v === 'string' ? ownText(v, runDir) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

// agent-framework 0.32.0 names a tool-result image `img_<nonce>_<seq>`, its nonce minted by a ledger that lives only
// as long as its process (tool-image-ledger.ts).
export function runVaryingMasker(keys = null, { runDir = process.env.FIXTURE_RUN_DIR || null } = {}) {
  const forks = new Map();
  const nonces = new Map();
  const nth = (map, key) => { if (!map.has(key)) map.set(key, map.size + 1); return map.get(key); };
  const own = (s) => ownText(s, runDir);
  const mask = (value) => {
    if (typeof value === 'string') {
      return own(value).replace(REF, (_, nonce, n) => `img_N${nth(nonces, nonce)}_${n}`).replace(FORK, (_, prefix, uuid) => `${prefix}UUID${nth(forks, uuid)}`);
    }
    if (Array.isArray(value)) return value.map((v) => mask(v));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'signature' && value.type === 'thinking' ? '(masked)' : mask(v)]));
  };
  // A request body, the record's other body fields, or the header wrapped as `{ session_id }`.
  mask.request = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return mask(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CODEX_KEY_FIELDS.has(k) && typeof v === 'string' && CODEX_KEY.test(v) ? (keys ? `<uuid>:<12 hex>#${nth(keys, v)}` : '<uuid>:<12 hex>') : mask(v)]));
  };
  return mask;
}

export const maskRunVarying = (value, options) => runVaryingMasker(null, options)(value);
export const maskRequest = (value, options) => runVaryingMasker(null, options).request(value);

export function sameBodies(onDir, offDir, { onRun = null, offRun = null } = {}) {
  const files = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => /^r\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  const read = (dir, runDir) => { const keys = new Map(); return files(dir).map((f) => runVaryingMasker(keys, { runDir }).request(JSON.parse(readFileSync(join(dir, f), 'utf-8')))); };
  const [a, b] = [read(onDir, onRun), read(offDir, offRun)];
  if (!a.length) return { outcome: 'differs', at: 0, detail: `no request bodies were saved in ${onDir}` };
  const at = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
  if (at === -1 && a.length === b.length) return { outcome: 'same', requests: a.length };
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const field = a[i] && b[i] ? Object.keys({ ...a[i], ...b[i] }).find((k) => JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) : null;
  return { outcome: 'differs', at: i, files: [files(onDir)[i], files(offDir)[i]], detail: `${a.length} requests with recording on, ${b.length} with it off${field ? `; its ${field} differs` : ''}` };
}

export function selfCheckOf({ on, off, onBodies, offBodies, onRun = null, offRun = null }) {
  if (!on.ok) return { outcome: 'couldnt-run', reason: `the run with recording on failed: ${on.reason ?? 'no reason given'}` };
  if (off.couldnt) return { outcome: 'couldnt-run', reason: `the run with recording off couldn't run: ${off.couldnt}` };
  if (!off.ok) return { outcome: 'couldnt-run', reason: `the run with recording off failed: ${off.reason ?? 'no reason given'}` };
  const recorded = (off.log ?? []).filter((e) => e.kind === 'compiles').length;
  if (recorded) return { outcome: 'couldnt-run', reason: `the run with recording off logged ${recorded} compile batch${recorded === 1 ? '' : 'es'}, so the test module recorded though its recording was off` };
  return sameBodies(onBodies, offBodies, { onRun, offRun });
}
