#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sleep } from './lib/common.mjs';
import { installCandidate, readPacks } from './lib/install.mjs';
import { EPOCH, contentsOf, keptWhole, laneVersion, releaseOf } from './lib/strategies/lane.mjs';
import { keptBody, tokensSent } from './lib/standin/standin.mjs';
import { historySteps, usageOf } from './lib/usage.mjs';
import { FIXTURE_AGENT } from './lib/strategies/checks.mjs';
import { RUNS, WORKLOADS, runOf } from './lib/strategies/workloads.mjs';
import { configurations } from './lib/strategies/script.mjs';
import { callText, exitCode, refuseUnrecordable, renderRecordLines } from './lib/record.mjs';
import { flagsAgainst, measuredOf, readAgainst, recordAgainst, releaseDiffers, slug, upgradesDiffer } from './lib/against.mjs';
import { differencesOf, entriesOf } from './lib/entries.mjs';
import { changedRequests, readsFailedOf, stepSummaryAfter, summaryOf, unmeasured, viewOf } from './lib/view.mjs';
import { generatedTexts, transcriptOf } from './lib/strategies/transcript.mjs';
import { ledgerOf, moduleCounts } from './lib/strategies/ledger.mjs';
import { orderOf, shares } from './lib/shares.mjs';
import { selfCheckOf } from './lib/strategies/compare.mjs';
import { cutError } from './lib/strategies/cut.mjs';
import { keptReleases } from './lib/kept.mjs';
import { changedOf, digestOf, digestsOf, driveOf, packRoots, profiledReads, reachJoined, reachPackOf, reachPart, splitBuilds } from './lib/reach.mjs';
import { forwardStops, runChild, slots, stopChildren } from './lib/pool.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = '[whole-host]';

const { opt, flag, missing } = parseArgs(process.argv.slice(2));
let failedFile = null;
const say = (message) => { console.error(`${LABEL} ${message}`); if (message.includes('\n')) console.error(`${LABEL} ${message.split('\n')[0]}`); };
const writeFailed = (message) => {
  if (!failedFile) return;
  try { writeFileSync(failedFile, `${JSON.stringify({ why: message })}\n`); } catch (e) { console.error(`${LABEL} ${failedFile} couldn't be written: ${e.message}`); }
};
const fail = (message) => { say(message); writeFailed(message); process.exit(2); };
const pair = flag('pair');
for (const name of missing(['against', 'checkpoints', 'drives', 'host', 'host-head', 'out', 'overlay', 'reach', 'reach-package', 'ready', 'runs', 'seconds', 'shard', 'width', 'workdir'])) fail(`--${name} needs a value`);
if (pair && opt('against')) fail('--pair compares its two arms in one invocation, so it takes no --against');
if (pair && opt('overlay')) fail('--pair reads each arm\'s packs from --ready, so it takes no --overlay');
if (pair && flag('update-seconds')) fail('--update-seconds writes one arm\'s seconds, so it needs an invocation without --pair');
if (!pair && opt('ready')) fail('--ready says when each of --pair\'s arms is ready, so it needs --pair');
if (!pair && opt('host-head')) fail('--host-head names --pair\'s head arm, so it needs --pair');
if (opt('reach') && !flag('self-check')) fail('--reach reads the self-check drive, so it needs --self-check');
if (opt('reach-package') && !opt('reach')) fail('--reach-package names the overlay --reach reads, so it needs --reach');
const list = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean).map((p) => resolve(p));
if (!pair && opt('reach') && !opt('reach-package') && list(opt('overlay', '')).length > 1) fail(`--reach with ${list(opt('overlay', '')).length} overlays needs --reach-package, naming the overlay the diff is of`);
const stack = JSON.parse(readFileSync(join(HERE, 'stack.json'), 'utf-8'));
const all = configurations();
const everyRun = RUNS;
const listed = String(opt('runs', everyRun.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = listed.filter((n) => !everyRun.includes(n));
if (unknown.length) fail(`no run ${unknown.join(', ')}; there are ${everyRun.join(', ')}`);
const twice = [...new Set(listed.filter((n, i) => listed.indexOf(n) !== i))];
if (twice.length) fail(`--runs names ${twice.join(', ')} more than once`);
const shard = /^(\d+)\/(\d+)$/.exec(opt('shard', '1/1'));
if (!shard || +shard[1] < 1 || +shard[1] > +shard[2]) fail(`--shard takes i/n with 1 <= i <= n, not ${opt('shard')}`);
if (!/^[1-9][0-9]*$/.test(opt('drives', '1'))) fail(`--drives takes a whole number of at least 1, not ${opt('drives')}`);
const drives = +opt('drives', '1');
if (!/^[1-9][0-9]*$/.test(opt('width', '1'))) fail(`--width takes a whole number of at least 1, not ${opt('width')}`);
const width = +opt('width', '1');
if (!opt('host')) fail('--host DIR names the connectome-host checkout to drive: the harness runs outside it');
const notHost = (option, dir) => {
  let name;
  try { name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name; } catch (e) { return `--${option} ${dir} has no package.json that can be read: ${e.message}`; }
  return name === '@animalabs/connectome-host' ? null : `--${option} ${dir} is ${name ?? 'a package with no name'}, not connectome-host`;
};
const hostDir = resolve(opt('host'));
if (notHost('host', hostDir)) fail(notHost('host', hostDir));
const hostName = '@animalabs/connectome-host';
const headDir = pair && opt('host-head') ? resolve(opt('host-head')) : hostDir;
const secondsFile = opt('seconds') ? resolve(opt('seconds')) : null;
const given = (() => {
  if (!secondsFile) return {};
  let text;
  try { text = readFileSync(secondsFile, 'utf-8'); } catch (e) { return fail(`--seconds ${secondsFile} can't be read: ${e.code ?? e.message}`); }
  let value;
  try { value = JSON.parse(text); } catch (e) { return fail(`--seconds ${secondsFile} isn't JSON: ${e.message}`); }
  const table = (x) => x === undefined || (x !== null && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0));
  const shaped = value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((k) => k === 'runs' || k === 'checkpoints') && table(value.runs) && table(value.checkpoints);
  if (!shaped) fail(`--seconds ${secondsFile} isn't {"runs": {RUN: SECONDS}, "checkpoints": {CHECKPOINT: SECONDS}}, each SECONDS a number of at least 0: ${JSON.stringify(value).slice(0, 300)}`);
  return value;
})();
const planned = { ...stack.seconds, runs: { ...stack.seconds?.runs, ...given.runs }, checkpoints: { ...stack.seconds?.checkpoints, ...given.checkpoints } };
const runOptions = { prefixTurns: stack.prefixTurns ?? {} };
const checkpointKey = (id) => runOf(id, all, {}, runOptions).from;
const upgradeOf = (id) => { const from = checkpointKey(id); const tag = from === null ? null : releaseOf(from, stack); return tag === stack.release ? null : tag; };
let share;
try { share = shares(listed, +shard[2], planned, checkpointKey, drives, upgradeOf)[+shard[1] - 1]; } catch (e) { fail(e.message); }
const names = share.ids;
const listing = (option, dir) => { try { return readdirSync(dir); } catch (e) { return fail(`${option} ${dir} can't be listed: ${e.code ?? e.message}`); } };
const workdir = opt('workdir') ? resolve(opt('workdir')) : null;
if (workdir && existsSync(workdir) && listing('--workdir', workdir).length) fail(`--workdir ${workdir} isn't empty: the release is installed there and every run's store starts there, so give it an empty or new directory`);
const outGiven = opt('out') ? resolve(opt('out')) : null;
if (outGiven && existsSync(outGiven) && listing('--out', outGiven).length) fail(`--out ${outGiven} isn't empty: an --out holds one invocation's evidence, so give it an empty or new directory`);
if (outGiven && workdir && `${outGiven}${sep}`.startsWith(`${workdir}${sep}`)) fail(`--out ${outGiven} is inside --workdir ${workdir}, which holds the drives' scratch, so give it a directory outside`);
const reachFrom = (packs) => {
  const pack = reachPackOf(packs, opt('reach-package') ?? null);
  const file = resolve(opt('reach'));
  let diff;
  try { diff = readFileSync(file, 'utf-8'); } catch (e) {
    let why;
    try { why = readFileSync(`${file}.err`, 'utf-8'); } catch { throw new Error(`--reach ${opt('reach')} can't be read: ${e.message}, and there's no ${file}.err saying why it wasn't made`); }
    return { none: why.trim() };
  }
  try { return { pack, changed: changedOf(diff) }; } catch (e) { throw new Error(`--reach ${opt('reach')} isn't a diff the harness reads: ${e.message}`); }
};
let overlays = null;
let reachGiven = null;
if (!pair) {
  try { overlays = readPacks(list(opt('overlay', ''))); } catch (e) { fail(e.message); }
  if (opt('reach')) { try { reachGiven = reachFrom(overlays); } catch (e) { fail(e.message); } }
}
if (!names.length) { console.log(`${LABEL} shard ${shard[0]} holds none of ${listed.join(', ')}`); process.exit(0); }
const work = workdir ?? mkdtempSync(join(tmpdir(), 'whole-host-'));
const out = outGiven ?? join(work, 'out');
if (+shard[2] > 1) console.log(`${LABEL} shard ${shard[0]}: ${names.length} of ${listed.length} runs, about ${share.seconds} s by ${secondsFile ? `${secondsFile}'s seconds over stack.json's` : 'stack.json\'s seconds'}${drives > 1 ? ` for a job that drives each run ${drives} times` : ''}`);
const runs = everyRun.filter((n) => listed.includes(n));
const lane = laneVersion();
const runtime = { node: process.version, platform: process.platform, arch: process.arch };
let readBase = null;
if (opt('against')) { try { readBase = readAgainst(resolve(opt('against')), { lane, runs, names, runtime }); } catch (e) { fail(e.message); } }
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
failedFile = join(out, 'failed.json');
const checkpointsDir = opt('checkpoints') ? resolve(opt('checkpoints')) : null;
const named = (versions) => Object.entries(versions).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

class Stop extends Error {}
const live = new Set();
forwardStops(live);
let stopping = false;
async function stop(message) {
  if (stopping) return;
  stopping = true;
  say(message);
  writeFailed(message);
  await stopChildren(live);
  process.exit(2);
}
const never = new Promise(() => {});
let children = 0;
mkdirSync(join(work, 'children'), { recursive: true });
const child = (spec, label) => (stopping ? never : runChild({ ...spec, result: join(work, 'children', `${++children}.json`) }, { label, live, onFailure: (e) => stop(e.message) }));
const pool = slots(width);
const order = orderOf(names, planned, checkpointKey);
const since = (t) => Math.round((performance.now() - t) / 100) / 10;
const settled = (p) => p.then((v) => ({ v }), (e) => ({ e }));
const ok = (s) => s.then((r) => (r.e ? never : r.v));

const arms = (pair ? [['before', hostDir, 'base'], ['after', headDir, 'head']] : [[null, hostDir, null]]).map(([name, dir, side], index) => ({
  name, side, index, hostDir: dir,
  out: name ? join(out, name) : out,
  work: side ? join(work, side) : work,
  whose: side ? `the ${side} arm's candidate` : 'the candidate',
  ready: side && opt('ready') ? join(resolve(opt('ready')), side) : null,
  selfCheck: flag('self-check') && index === (pair ? 1 : 0),
  results: new Map(), done: new Map(), seconds: { runs: {}, checkpoints: {} },
}));
const [base] = arms;
const head = arms.at(-1);
for (const arm of arms) for (const d of [arm.out, arm.work]) mkdirSync(d, { recursive: true });
const tell = (arm, text) => console.log(arm.name ? text.split('\n').map((l) => `${arm.name}: ${l}`).join('\n') : text);

const releases = keptReleases({ dir: checkpointsDir, lane, install: (tag) => child({ kind: 'release', hostDir, tag, dir: join(work, 'releases', tag) }, `installing ${tag}`), log: (s) => console.log(`${LABEL} ${s}`) });

console.log(`${LABEL} lane ${lane.slice(0, 12)} · release ${stack.release}${stack.upgrades?.length ? ` · upgrades from ${stack.upgrades.join(', ')}` : ''} · work ${work}`);
const needed = [...new Set(names.map(checkpointKey).filter((from) => from !== null).map((from) => releaseOf(from, stack)))];
const versionsOf = new Map();
let previous = Promise.resolve();
for (const tag of needed) {
  const read = previous.then(async () => {
    const versions = await releases.versions(tag);
    console.log(`${LABEL} checkpoints from ${tag}: ${named(versions)}`);
    return versions;
  });
  versionsOf.set(tag, read);
  previous = read.catch(() => {});
}
const usedNow = settled((async () => {
  const used = {};
  for (const tag of needed) used[tag] = await versionsOf.get(tag);
  return used;
})());

async function candidateOf(arm) {
  let paths = [];
  if (arm.ready) {
    if (!existsSync(arm.ready)) {
      console.log(`${LABEL} waiting for ${arm.whose}: ${arm.ready}`);
      while (!existsSync(arm.ready)) await sleep(100);
    }
    paths = list(readFileSync(arm.ready, 'utf-8'));
  }
  const own = arm.side === 'head' && opt('host-head') ? notHost('host-head', arm.hostDir) : null;
  if (own) throw new Stop(own);
  let packs = overlays;
  if (!packs) { try { packs = readPacks(paths); } catch (e) { throw new Stop(e.message); } }
  const spec = { root: arm.hostDir, packs, dir: join(arm.work, 'candidate'), leaveOut: [work, out] };
  const t = performance.now();
  try {
    const installed = packs.length ? await child({ kind: 'candidate', ...spec }, `installing ${arm.whose}`) : installCandidate({ ...spec, npmCi: null });
    const candidate = { ...installed, packs, seconds: since(t) };
    console.log(`${LABEL} ${arm.name ? `${arm.side} arm's ` : ''}candidate ${named(candidate.versions)}${packs.length ? `, with ${packs.map((p) => p.name).join(', ')} laid over, installed in ${candidate.seconds} s` : ''}`);
    return candidate;
  } catch (e) { throw new Stop(`installing ${arm.whose} failed: ${e.message}`); }
}
const candidates = arms.map((arm) => settled(candidateOf(arm)));
for (const [i, arm] of arms.entries()) arm.candidate = ok(candidates[i]);

async function reachOf(candidate) {
  let given = reachGiven;
  if (!given) { try { given = reachFrom(candidate.packs); } catch (e) { throw new Stop(e.message); } }
  if (given.none !== undefined) {
    tell(head, `${LABEL} no reach, since the change's diff couldn't be made: ${given.none}`);
    return null;
  }
  const { pack, changed } = given;
  try {
    const lock = candidate.packs.length ? JSON.parse(readFileSync(join(candidate.installDir, 'package-lock.json'), 'utf-8')).packages ?? {} : {};
    const roots = pack ? packRoots(lock, candidate.installDir, pack.name) : [candidate.hostDir];
    const reach = {
      change: pack?.name ?? hostName,
      changed,
      tree: { roots, built: candidate.packs.length ? ['dist'] : [], harnessDir: HERE, only: Object.keys(changed), home: head.work },
      reads: new Map(),
      profiled: { logDir: join(head.work, 'reach'), realRoots: roots.map((r) => realpathSync(r)) },
    };
    mkdirSync(reach.profiled.logDir, { recursive: true });
    return reach;
  } catch (e) {
    tell(head, `${LABEL} reach couldn't be set up, so this arm runs without it and brings no reach home: ${e.message}`);
    return null;
  }
}

const reachNow = settled(opt('reach') ? head.candidate.then(reachOf) : Promise.resolve(null));
const reachOfHead = ok(reachNow);
const asStop = (e) => (e instanceof Stop ? e.message : `the harness failed: ${e?.stack ?? e}`);
for (const [part, why] of [[usedNow, (e) => e.message], ...candidates.map((c) => [c, asStop]), [reachNow, asStop]]) part.then((r) => { if (r.e) stop(why(r.e)); });
let release = null;
let upgrades = [];
const setup = (async () => {
  const u = await usedNow;
  if (u.e) throw new Stop(u.e.message);
  release = { tag: stack.release, versions: u.v[stack.release] ?? null };
  upgrades = needed.filter((tag) => tag !== stack.release).map((tag) => ({ tag, versions: u.v[tag] }));
  const otherRelease = readBase && (releaseDiffers(readBase, release) ?? upgradesDiffer(readBase, upgrades));
  if (otherRelease) throw new Stop(otherRelease);
  for (const c of candidates) {
    const got = await c;
    if (got.e) throw got.e;
  }
  const r = await reachNow;
  if (r.e) throw r.e;
})();

const checkpoints = new Map();
const built = new Map();
function checkpointOf(from) {
  if (!checkpoints.has(from)) {
    checkpoints.set(from, makeCheckpoint(from).catch((e) => { const c = cutError(e, 2000); return { failed: c.shown, ...(c.full ? { failedFull: c.full } : {}) }; }).then((cp) => { built.set(from, cp); return cp; }));
  }
  return checkpoints.get(from);
}

async function makeCheckpoint(from) {
  const tag = releaseOf(from, stack);
  const configName = from.split('/')[0];
  const factsOf = async (r) => {
    const t = performance.now();
    const read = await child({ kind: 'facts', hostDir: r.hostDir, configuration: configName }, `reading ${tag}'s recipe facts for ${configName}`);
    console.log(`${LABEL} ${tag}'s recipe facts for ${configName}: read in ${since(t)} s`);
    return read;
  };
  const { versions, facts } = await releases.facts(tag, configName, factsOf, await versionsOf.get(tag));
  const job = runOf(from, all, facts, runOptions);
  const key = createHash('sha256').update(JSON.stringify({ lane, release: versions, from, configuration: job.configuration, epoch: EPOCH, steps: job.steps() })).digest('hex').slice(0, 16);
  const kept = checkpointsDir ? join(checkpointsDir, 'workloads', `${slug(from)}-${key}`) : null;
  const texts = (dir) => ({ steps: job.steps(), answers: join(dir, 'answers') });
  if (kept && existsSync(kept) && !keptWhole(kept)) rmSync(kept, { recursive: true, force: true });
  if (kept && keptWhole(kept)) {
    console.log(`${LABEL} checkpoint ${from}: reused ${kept}`);
    return { ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store'), ...texts(kept) };
  }
  const side = await releases.installed(tag, versions);
  const windowFrom = typeof facts.window === 'number' ? null : (await base.candidate).hostDir;
  const dir = kept ? `${kept}.writing-${process.pid}` : join(work, 'checkpoints', slug(from));
  rmSync(dir, { recursive: true, force: true });
  const hostLogs = { dir: join(base.out, 'checkpoints', slug(from)), at: `checkpoints/${slug(from)}` };
  rmSync(hostLogs.dir, { recursive: true, force: true });
  const free = await pool.take(order.checkpoint(from));
  const t = performance.now();
  let run;
  try {
    run = await child({ kind: 'checkpoint', from, facts, side: { hostDir: side.hostDir }, windowFrom, dir, hostLogs }, `the checkpoint ${from}'s build`);
  } catch (e) { if (kept) rmSync(dir, { recursive: true, force: true }); throw e; } finally { free(); }
  const took = since(t);
  const made = (cp) => { base.seconds.checkpoints[from] = took; return cp; };
  console.log(`${LABEL} checkpoint ${from}: ${run.ok ? 'built' : 'its build failed'} in ${took} s`);
  if (!run.ok) {
    if (kept) rmSync(dir, { recursive: true, force: true });
    return { failed: run.failure?.reason ?? 'no reason given', ...(run.failure?.full ? { failedFull: run.failure.full } : {}) };
  }
  if (!kept) return made({ storeDir: join(dir, 'store'), clockEnd: run.clockEnd, ...texts(dir) });
  writeFileSync(join(dir, 'checkpoint.json'), `${JSON.stringify({ from, key, clockEnd: run.clockEnd, contents: contentsOf(dir) })}\n`);
  try { renameSync(dir, kept); } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (!keptWhole(kept)) throw new Error(`the checkpoint couldn't be kept at ${kept} (${e.message}), and nothing whole is there`);
  }
  return made({ ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store'), ...texts(kept) });
}

const DRIVES = ['recording', 'recording', 'self-check'];
async function runDrive(arm, id, { recording, dir, rawDir, profiled = null }) {
  const candidate = await arm.candidate;
  const from = checkpointKey(id);
  const cp = from === null ? null : await checkpointOf(from);
  const kind = recording ? arm.index : 2;
  const label = `${arm.name ? `the ${arm.side} arm's ` : 'the '}${DRIVES[kind]} drive of ${id}`;
  const free = await pool.take([...order.run(id), kind]);
  const t = performance.now();
  try {
    return { value: await child({
      kind: 'run', id, recording, dir, rawDir, scratch: join(arm.work, 'runs', slug(id) + (recording ? '' : '.recording-off')), out: arm.out, profiled,
      candidate: { hostDir: candidate.hostDir, installDir: candidate.installDir },
      checkpoint: cp && { from, storeDir: cp.storeDir, clockEnd: cp.clockEnd, failed: cp.failed, failedFull: cp.failedFull },
    }, label), seconds: since(t) };
  } catch (e) { return { threw: e, seconds: since(t) }; } finally { free(); }
}

function builtHistory(id, r) {
  const from = WORKLOADS[id.split('/')[1]]?.from;
  return r.from === 'empty' && from ? historySteps(r.steps ?? [], from) : new Set();
}

const reportCouldnt = (dir, id, r) => {
  mkdirSync(dir, { recursive: true });
  (r.reported ? appendFileSync : writeFileSync)(join(dir, 'report.txt'), `${id}: couldn't run: ${r.reason}\n${r.reasonFull ? `  whole: ${r.reasonFull}\n` : ''}`);
};

async function settleRun(arm, id) {
  const dir = join(arm.out, slug(id));
  const bodies = join(arm.work, 'runs', slug(id), 'raw');
  const offDir = join(arm.out, `${slug(id)}.recording-off`);
  const offBodies = join(arm.work, 'runs', `${slug(id)}.recording-off`, 'raw');
  const recorded = runDrive(arm, id, { recording: true, dir, rawDir: bodies });
  const off = arm.selfCheck ? (async () => runDrive(arm, id, { recording: false, dir: offDir, rawDir: offBodies, profiled: opt('reach') ? (await reachOfHead)?.profiled ?? null : null }))() : null;
  const drove = await recorded;
  const against = arm === head && pair ? { dir: base.out, result: (run) => base.results.get(run) } : readBase;
  if (arm === head && pair) await base.done.get(id);
  let r = null;
  let row;
  let record = null;
  let flags = null;
  let selfCheck = null;
  let view = null;
  let stage = 'it couldn\'t be run';
  let selfChecked = false;
  try {
    if (drove.threw) throw drove.threw;
    r = drove.value;
    tell(arm, (r.lines?.length ? r.lines : [`${id}: couldn't run: ${r.reason}`]).join('\n'));
    stage = 'its record couldn\'t be checked';
    if (refuseUnrecordable(r)) tell(arm, `${LABEL} ${id}: couldn't run: ${r.reason}`);
    if (r.outcome !== 'couldnt-run') {
      stage = 'its record couldn\'t be written';
      const answersIn = (d) => (existsSync(d) ? readdirSync(d) : []).filter((f) => /^r\d+\.answer\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(d, f), 'utf-8')));
      const cp = r.from === 'empty' ? null : built.get(r.from);
      const steps = [...(cp?.steps ?? []), ...r.steps];
      const answers = [...(cp ? answersIn(cp.answers) : []), ...answersIn(bodies)];
      // A frame's registry holds the answered calls too; the transcripts' keeps the texts it always held.
      const recordLines = renderRecordLines({ header: { configuration: id, from: r.from }, log: r.log, records: r.records, end: r.end, judged: r.judged, generated: generatedTexts({ steps, answers, callText }), runDir: dirname(bodies) });
      const text = `${recordLines.map((l) => l.text).join('\n')}\n`;
      writeFileSync(join(dir, `${slug(id)}.record`), text);
      stage = 'its record couldn\'t be compared with the base arm\'s';
      const compared = recordAgainst(against, id, text);
      record = compared.record;
      flags = flagsAgainst(against, id, r.flagged);
      let changed = null;
      if (record === 'differs') {
        stage = 'its differences couldn\'t be grouped';
        arm.differences ??= new Map();
        arm.differences.set(id, differencesOf(id, compared.base, text));
        stage = 'its view couldn\'t be written';
        changed = changedRequests(compared.base, recordLines);
        const generated = generatedTexts({ steps, answers });
        const owner = new Map(recordLines.filter((l) => l.request).map((l) => [l.request, l]));
        const apiOf = new Map(r.records.map((x) => [x.id, x.head?.api ?? null]));
        const reasonOf = new Map(r.records.map((x) => [x.id, x.reason ?? null]));
        const viewText = viewOf({
          run: id, changed, lines: recordLines,
          ledger: (request) => {
            const l = owner.get(request);
            if (!l?.compile) return [];
            return [l.round ? 'As context-manager compiled it for the turn:' : 'As context-manager compiled it:', ...ledgerOf(r.log, l.compile)];
          },
          transcript: (request, seen) => {
            const api = apiOf.get(request);
            const read = keptBody(bodies, request, api, reasonOf.get(request));
            return read.view ? transcriptOf(read.view, generated, seen, { api }) : [`(no transcript: ${read.reason})`];
          },
        });
        writeFileSync(join(dir, 'view.md'), viewText);
        view = { run: id, path: `${slug(id)}/view.md`, text: viewText };
        tell(arm, `${LABEL} ${id}: the record differs from the base arm's; the run's is ${slug(id)}/${slug(id)}.record in this job's evidence, and what changed is in ${slug(id)}/view.md`);
      }
      stage = 'its counts couldn\'t be read';
      row = { run: id, outcome: r.outcome, flags: r.failures?.length ?? 0, ...(against && flags ? { compared: { new: flags.new.length, gone: flags.gone.length } } : {}), record, changed, ledgerOf: r.agent, counts: moduleCounts(r.log, r.records, r.agent), tokens: tokensSent(r.records) };
    } else {
      reportCouldnt(dir, id, r);
      row = { run: id, outcome: r.outcome, reason: r.reason, record: 'couldn\'t run' };
    }
    if (off && r.outcome !== 'couldnt-run') {
      stage = 'its self-check couldn\'t run';
      selfChecked = true;
      const drew = await off;
      const o = drew.threw ? (() => { const c = cutError(drew.threw, 2000); return { couldnt: c.shown, ...(c.full ? { couldntFull: c.full } : {}) }; })() : drew.value;
      if (opt('reach')) (await reachOfHead)?.reads.set(id, profiledReads(o));
      selfCheck = selfCheckOf({
        on: { ok: r.end?.ok === true, reason: r.end?.reason },
        off: o.couldnt ? { couldnt: o.couldnt } : { ok: o.d.run.ok, reason: o.d.run.failure?.reason, log: o.d.log },
        onBodies: bodies, offBodies, onRun: dirname(bodies), offRun: o.scratch ?? null,
      });
      row.selfCheck = selfCheck;
      if (selfCheck.outcome === 'differs') {
        mkdirSync(join(dir, 'self-check'), { recursive: true });
        const [on, offFile] = selfCheck.files ?? [];
        if (on) cpSync(join(bodies, on), join(dir, 'self-check', `recording-on-${on}`));
        if (offFile) cpSync(join(offBodies, offFile), join(dir, 'self-check', `recording-off-${offFile}`));
      }
      tell(arm, `${LABEL} ${id}: self-check: ${selfCheck.outcome === 'same' ? `the stand-in received the same ${selfCheck.requests} request bodies with the test module's recording off` : selfCheck.outcome === 'couldnt-run' ? `couldn't run: ${selfCheck.reason}` : `request ${selfCheck.at} differs with recording off: ${selfCheck.detail}`}`);
    }
  } catch (e) {
    const c = cutError(e, 2000);
    r = { ...(r ?? {}), outcome: 'couldnt-run', reason: `${stage}: ${c.shown}`, ...(c.full ? { reasonFull: `${stage}: ${c.full}` } : {}) };
    record = null;
    flags = null;
    selfCheck = null;
    view = null;
    arm.differences?.delete(id);
    rmSync(join(dir, 'view.md'), { force: true });
    reportCouldnt(dir, id, r);
    row = { run: id, outcome: r.outcome, reason: r.reason, record: 'couldn\'t run' };
    tell(arm, `${LABEL} ${id}: couldn't run: ${r.reason}`);
  }
  if (off && !selfChecked) {
    await off;
    rmSync(offDir, { recursive: true, force: true });
  }
  const baseResult = against?.result(id);
  const measured = measuredOf(r, { against: Boolean(against), base: baseResult, log: r.log ?? [] });
  Object.assign(row, measured);
  const why = [[unmeasured(row), 'didn\'t measure'], [readsFailedOf(row), 'a read failed']].filter(([said]) => said).map(([said, what]) => `${what}: ${said}`);
  if (why.length) tell(arm, `${LABEL} ${id}: can't be compared: ${why.join('; ')}`);
  const counts = row.counts && { compiles: row.counts.compiles, compressions: row.counts.compressions, merges: row.counts.merges, quarantines: row.counts.quarantines };
  const usage = r.records && r.outcome !== 'couldnt-run' ? usageOf(r.records, r.log ?? [], r.agent ?? FIXTURE_AGENT, builtHistory(id, r)) : null;
  const result = { run: id, outcome: r.outcome, reason: r.reason, record, ...(flags ? { flags } : {}), ...measured, ...(counts ? { counts } : {}), ...(usage ? { usage } : {}), ...(selfCheck ? { selfCheck } : {}) };
  if (result.outcome !== 'couldnt-run') arm.seconds.runs[id] = drove.seconds;
  arm.results.set(id, result);
  return { row, result, view, flagged: r.failures?.length ? { run: id, flags: r.failures } : null };
}

for (const arm of arms) for (const id of names) arm.done.set(id, settleRun(arm, id));
try {
  await Promise.all([setup, ...arms.flatMap((arm) => names.map((id) => arm.done.get(id)))]);
} catch (e) {
  await stop(e instanceof Stop ? e.message : `the harness failed: ${e?.stack ?? e}`);
}
if (stopping) await never;

const runJsons = [];
try {
  for (const arm of arms) {
    const settledRuns = await Promise.all(names.map((id) => arm.done.get(id)));
    const results = settledRuns.map((s) => s.result);
    const reach = arm.selfCheck && opt('reach') ? await reachOfHead : null;
    if (reach) {
      try {
        const read = names.filter((n) => reach.reads.has(n));
        const digests = read.flatMap((id) => digestsOf(reach.reads.get(id), id, reach.tree));
        for (const id of names.filter((n) => !reach.reads.has(n))) digests.push({ ...digestOf({ unread: `${id} had no profiled drive, since it couldn't run` }, reach.tree), noDrive: true });
        const part = reachPart({ ...reach.tree, change: reach.change, changed: reach.changed, drives: Object.fromEntries(read.map((id) => [id, driveOf(reach.reads.get(id))])), digests, split: splitBuilds({ ...reach.tree, changed: reach.changed }) });
        const joined = reachJoined([part]);
        const { files } = joined;
        writeFileSync(join(arm.out, 'reach-digests.json'), JSON.stringify(part));
        writeFileSync(join(arm.out, 'reach.json'), JSON.stringify(joined, null, 1));
        const count = (k) => Object.values(files).reduce((n, f) => n + f[k].length, 0);
        tell(arm, `${LABEL} reach: of ${Object.keys(files).length} changed files' lines, ${count('ran')} ran, ${count('notRan')} ran in no profiled drive, ${count('couldntTell')} couldn't be told, ${count('unloaded')} that no read or built map gives as code or as no code, ${count('noCode')} map to no code`);
      } catch (e) {
        for (const f of ['reach-digests.json', 'reach.json']) rmSync(join(arm.out, f), { force: true });
        tell(arm, `${LABEL} reach couldn't be written, so this share brings none home: ${e.message}`);
      }
    }
    if (arm === head && (pair || readBase)) writeFileSync(join(arm.out, 'entries.json'), JSON.stringify(entriesOf(runs.flatMap((id) => arm.differences?.get(id) ?? [])), null, 1));
    const table = summaryOf({ rows: settledRuns.map((s) => s.row), flagged: settledRuns.map((s) => s.flagged).filter(Boolean) });
    writeFileSync(join(arm.out, 'summary.md'), `${table}\n`);
    const shown = settledRuns.map((s) => s.view).filter((v) => v && results.find((x) => x.run === v.run)?.outcome !== 'couldnt-run');
    if (process.env.GITHUB_STEP_SUMMARY) {
      const file = process.env.GITHUB_STEP_SUMMARY;
      const text = stepSummaryAfter(existsSync(file) ? statSync(file).size : 0, { table, views: shown });
      if (text) appendFileSync(file, text);
    }
    const candidate = await arm.candidate;
    const installs = arm === base && Object.keys(releases.seconds).length ? { installs: releases.seconds } : {};
    runJsons.push([arm, JSON.stringify({ lane, runs, runtime, release, ...(upgrades.length ? { upgrades } : {}), candidate: { versions: candidate.versions, overlays: candidate.packs }, seconds: { ...arm.seconds, ...installs }, results }, null, 1)]);
    arm.final = results;
  }
  for (const [arm, text] of runJsons) writeFileSync(join(arm.out, 'run.json'), text);
} catch (e) {
  for (const arm of arms) rmSync(join(arm.out, 'run.json'), { force: true });
  await stop(`writing the invocation's output failed: ${e.message}`);
}
if (flag('update-seconds')) {
  const merged = { runs: { ...stack.seconds?.runs, ...base.seconds.runs }, checkpoints: { ...stack.seconds?.checkpoints, ...base.seconds.checkpoints }, installs: { ...stack.seconds?.installs, ...releases.seconds } };
  const written = join(HERE, `stack.json.${process.pid}`);
  writeFileSync(written, `${JSON.stringify({ ...stack, seconds: merged }, null, 2)}\n`);
  renameSync(written, join(HERE, 'stack.json'));
  console.log(`${LABEL} wrote ${Object.keys(base.seconds.runs).length} runs' and ${Object.keys(base.seconds.checkpoints).length} checkpoints' seconds into stack.json`);
}
process.exit(exitCode(head.final));
