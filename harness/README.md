# Whole-host records

`harness/` drives connectome-host against a stand-in for the model's API (Anthropic's Messages API, also as Amazon Bedrock serves it for P3, OpenAI's Responses API for P1 and P2, and the Chat Completions API as OpenAI documents it for P5 and as OpenRouter serves it for P4), through a set of workload runs, and writes one record per run. Each run's recipe loads the host's context strategy and the fixture's own MCPL server. It leaves the `wake`, `workspace`, `channelMode` and `subscriptionGc` modules as the host has them when a recipe doesn't name them, which is on, as a resident's recipe that names no modules has them, but under `Hoff`, whose `false` for each holds whatever a workload's recipe names. It turns off the subagents module (H2's and H5's configurations and W9's and W14's workloads turn it back on), the lessons and retrieval modules (H5's configuration turns both back on, retrieval with the module's own default model, as a recipe that turns it on and names no model gets it), cache keepalive and the context maintenance timer (`driver.ts`'s recipe, `script.ts`'s configurations). H7's tool presentation file, which connectome-host requires named by an absolute path, is written into the run's working directory and named there (`laneRecipe`). A record says what every request the run sent carried.

The host runs on a clock of the harness's own (`virtual-date.ts`, which the host loads first). Its `Date` reads a fixed start and, within a boot, moves only at a workload's advance step, at a step's held-call advance, and by a second at a step that writes into a watched mount, or whose host writes the gate's watched config file (below). Between boots it moves by a second at a restart, and by a day where a history the run built boots again (`boot` in `driver.ts`). Its timers from 30 s up to 2^31−1 ms, from `setTimeout`, `setInterval`, `node:timers`, `node:timers/promises`' `setTimeout` and `util.promisify(setTimeout)`, run on that clock too; a longer one is left to the runtime, outside the clock. Such a timer fires only when a step moves the clock to or past its due time: one at a time, earliest first, and in the order they were set where two are due at once, with the clock standing at its due time, and the driver settles after each before the advance goes on. A settle can't see a request the reply judge or the suppression review has in flight, so a step whose decision one of their timers starts names that timer, by the delay and repeat the clock reports when it fires: a judge rule's `debounceMs` from the recipe, one-shot, and the review's interval, one-shot, as agent-framework's own `reviewSettings` gives it for the gate options the host's `gateOptionsFor` builds. Neither function is public, so only a run whose script reaches the review reads them, and where either can't be called that run can't run, naming it. After the round that fires it, the driver waits for the decision's trace, `gate:judge-verdict` or `gate:suppression-review`, before that round's settle, so the settle comes after any request the judge or the review sent for it, and after the reply judge's dry compile of the agent's context, which comes before the judge's request. It then waits for the turns the decision starts before the clock moves on, since what the decision brings, such as a judged batch's line with its oldest message's age, is written by the clock as it reads then. A step whose advance ends without that timer firing fails, naming it. A timer of less runs in real time, as the host's own progress does. The host's monotonic clocks, `performance.now()`, `process.hrtime` and its `bigint`, and `Bun.nanoseconds()`, read real time plus everything the clock has advanced, all by the same amount and only forward, so a deadline the host keeps on one of them, as membrane's progress bounds do, passes at the advance that passes it, and an interval measured between two advances is real. The test module's compile stamps come from `clock_gettime` itself, through Bun's FFI, so they stay real. Only a step's held-call advance moves the clock while a request is held, which is how W12's and W13's stalls let membrane's bound cut the held call; no other advance comes while a run waits on a request, so no other timer the clock holds cuts a request that hangs: the driver's own bounds do. Under Bun, `Bun.sleep` and `AbortSignal.timeout` don't go through those timers, so they run in real time whatever their length. The preload also wraps `fs.stat`, passing every call through unchanged, and tells the driver when the host first stats a file the driver asked about. A step that writes into a mount watched always relies on that: chokidar 4's `awaitWriteFinish` holds a write until `new Date()` has moved its stability threshold (100 ms in agent-framework's watcher) past it, statting the file with callback `fs.stat` meanwhile, so the step waits for that stat, then moves the clock a second. A chokidar that settles a write some other way sends no such stat, and the run fails at the step's bound, whose message names chokidar's settle poll and the chokidar version found in the host's install. A step whose host writes the gate's watched config file settles that write's echo the same way, and the first boot of a fresh store waits for the start's; CHECKS.md's W12 section gives the rule.

The context view runs it twice for a pull request in context-manager, agent-framework, membrane or connectome-host: once with the base branch's tip, the base arm, and once with the pull request merged onto it, the head arm, with everything else installed from the host's lockfile; laying a pull request's packages over it with `npm install` can move another package from its locked version where their own version ranges require it. A change that moves what the resident's requests carry changes the head arm's records, and how they differ from the base arm's is what the view shows. Both arms run this harness, from this repository, so a change to the harness moves both arms alike. `CHECKS.md`, at the repository's root, says what the runs and checks are in plain words, for a maintainer reading a view; this README holds their exact rules.

## Running it

`node harness/run.ts --host DIR` drives the connectome-host checkout at `DIR` through every run, judges each, and writes its record. With `--against BASE`, it compares each run's record with the base arm's in `BASE`. It exits 0 when every run's record is the same as the base arm's, with no flag new or gone (or, with no `--against`, written, with no flag at all), and its self-check, where one ran, the same; 1 when a record differs or has no base record to compare with, a flag is new or gone, or a self-check differs; and 2 when a run or its self-check couldn't run, a run didn't measure or a read failed on either arm ("Flags across the arms"), or the invocation itself failed ("When the invocation fails", below). With `--pair`, it runs both arms of a share in one invocation, and exits as its head arm would.

The harness imports only Node's own modules, and Bun's in the test module the host loads, so it needs no install of its own. `npm ci` in `harness/` installs context-manager for one unit test, `readStore`'s, and membrane 0.8.0 for the codecs' tests, and `npm test` runs the unit tests.

- `--host DIR` names the connectome-host checkout to drive, by its `package.json`. It's required. Without `--overlay` the candidate is `DIR`'s own install, so `DIR` needs `npm ci` first; with one, the harness copies `DIR` and installs the copy itself. The releases whose checkpoints the runs start from are cloned from the repository `DIR`'s `package.json` names, at the tags `stack.json` names: `release`, and each of `upgrades` a run's variant names (below).
- `--against BASE` compares each run's record with the one the base arm wrote, where `BASE` is the base arm's `--out`. The invocation stops before it runs anything, exit 2, unless `BASE/run.json` was written by the same harness (its `lane`, which covers `lib/`, `run.ts` and `stack.json` less its `seconds`) under the same Node version, platform and architecture, from the same `--runs` and for the same share's runs, with each record it lists present; once the release is installed, it stops the same way unless the base arm's checkpoints came from the same release and stack. Otherwise a difference could be put down to the change that isn't the change's. `seconds` is left out of the lane because it shapes only the shares, which the check of the share's runs covers. The candidate isn't compared, since it's what the two arms are run to tell apart, and neither is the environment the host inherits. A run the base arm couldn't run has no record there, so its record is `missing`. Only a run whose record `differs` gets a view.
- `--runs A,B` runs only those (`CONFIGURATION/WORKLOAD[/VARIANT]`, as `workloads.ts` `RUNS` lists them), each named once.
- `--overlay PACK.tgz` lays a packed agent-framework, context-manager, membrane or chronicle over `--host`'s install, to see what a change to one of them does to the host. A host change is a change to the `--host` checkout itself.
- `--forced-package NAME`, with packs to lay over, installs `NAME`'s pack by pointing the host copy's own dependency on it at the pack, in each of `dependencies`, `optionalDependencies` and `devDependencies` that names it, or in `dependencies` where none does, and pointing every override of `NAME` in its `overrides`, by `NAME` or a version-qualified `NAME@RANGE`, at the top or nested under another package, at that dependency, so the pack replaces every copy even where a range in the host's tree refuses its version. An override object of `NAME`'s keeps its other keys. Where the ranges already admit it and no override of the host's names it, the tree is the one a plain overlay installs. A `--forced-package` that names no package is refused, and so is a forced package with no pack, before anything is copied or installed. `NAME` must be among the packs; otherwise the install is refused. The run side passes it where its plan forced a range on the candidate's package (AGENTS.md, "The stack").
- `--checkpoints DIR` keeps the runs' starting checkpoints in `DIR` between invocations, keyed by the lane, their release's versions, the run that writes each, its configuration, the clock's start and its steps. The environment the host inherits isn't in the key. Both arms of a view can share it, since their checkpoints come from the same releases. Beside them it keeps each release's versions and the recipe facts each setup reads from it (`releases/<tag>-<lane>.json`), so an invocation that reuses every checkpoint it needs installs no release, and reads the versions its same-release check compares there; where those facts were lost, it installs the release again to read them.
- `--self-check` drives each run a second time with the test module's recording off, and fails a run whose request bodies differ once the run-varying values are masked in both, wherever they appear, cache markers included, where a record writes a marker whole: every record rests on recording changing nothing the host sends. It compares the bodies alone, not the headers, path or query; the record's heads hold the path, the query and the `anthropic-beta` and `anthropic-version` headers. With recording off the driver sets `FIXTURE_RECORD=off`, and otherwise leaves it unset, dropping a runner's own, so a runner's setting can't turn the recording arm off. An arm with recording off that logged compile batches anyway can't be judged, nor can one whose drive failed, and the summary names which arm. Where they differ, the first differing pair of request bodies is kept in the run's evidence, under `self-check/`. The context view runs it on the head arm. A change whose effect recording happened to hide would leave every record as it was, so only the self-check would show it, and it also shows a head whose requests vary from one drive to the next.
- `--shard i/n` runs share `i` of `n`, balanced by the seconds `stack.json` records, or by those `--seconds` gives over them. Both arms of a view take the same share.
- `--seconds FILE` gives seconds over `stack.json`'s, for the share's balance and the order its drives start in: a JSON file `{"runs": {RUN: SECONDS}, "checkpoints": {CHECKPOINT: SECONDS}}`, each SECONDS a number of at least 0, where a run or checkpoint it doesn't name keeps `stack.json`'s. Any other file is refused before anything runs. A view passes the seconds its runners measured, so its plan follows them with no harness release.
- `--pair` runs both arms of a share in one invocation. The base arm drives `--host` and writes `OUT/before`; the head arm drives `--host-head`, or `--host` when it's not given, and writes `OUT/after`; each writes there what one arm's invocation writes to its `--out`. The head arm's runs are compared with the base arm's as `--against` compares them, each once the base arm has written that run's record, and `--self-check` and `--reach` are the head arm's. The release is installed once for both arms and each checkpoint built once, and a checkpoint whose release gives no window takes the base arm's candidate's. It takes no `--against`, `--overlay` or `--update-seconds`.
- `--ready DIR`, with `--pair`, says when each arm's candidate can be installed: once `DIR/base` or `DIR/head` is there, which its writer makes whole by a rename. Each holds that arm's comma-separated pack paths, read as `--overlay` reads its list, or nothing for a host change, whose checkout's own install is the arm's candidate. An arm's install, and so its drives, waits for its file, saying so once, and `--host-head`'s checkout is read only then, so a setup can clone it after the invocation starts; the release's install doesn't. A checkpoint is built once a run that starts from it has its arm's candidate, and one whose release gives no window takes the base arm's candidate's, so it waits for `DIR/base`. Without `--ready`, both arms are ready from the start, with no packs.
- `--width N` drives up to N runs or checkpoints at once, 1 when not given, each drive in a child process of its own (below). The installs and the reads of a release's recipe facts, in child processes too, run beside the drives, outside that bound. Of the drives whose inputs are ready, the longest starts first, by the share's seconds: a checkpoint ranks by its own and the longest run that starts from it, so of the chains whose inputs are ready, a share's longest starts first, and a run's drives rank by the run's. Every drive waits for its arm's candidate and its run's checkpoint before it takes its place. What the invocation writes doesn't depend on N, but for the seconds, which are measured: those in `run.json`, and with `--update-seconds` those it merges into `stack.json`. Give N only where the invocation has the machine to itself: a view's job on a runner passes it, and runs on a machine shared with other work give 1.
- `--drives N` says how many times the caller drives each run across the invocations of one share, 1 when not given. The context view's job gives 3: its base arm, its head arm and the head arm's self-check. `--shard` counts each run's seconds N times and each checkpoint's once, since a checkpoint is built once when the invocations share `--checkpoints`. Give each invocation of a share the same N: with another, an arm can take other runs, and the head arm's `--against` then stops.
- `--workdir DIR` keeps the run's installs and stores in `DIR`, which must be empty or new, since the release is installed there and every run's store starts there. The candidate is `--host`'s own install unless `--overlay` is given, when it's installed there too. With `--pair`, each arm's runs and candidate are under `DIR/base` and `DIR/head`, names of one length: a request carries its run's directory, which the record masks, but a count of the request's size sees its length.
- `--out DIR` chooses where each run's record, `report.txt` and view are written, and `run.json` and `summary.md`; it's `DIR/out` under the work directory when not given, and a given one may not lie under `--workdir`. It must be empty or new, since it holds one invocation's evidence: otherwise an invocation that stopped partway could leave an earlier `run.json` naming records it had replaced. `run.json` names the harness (`lane`), the runs the shares were drawn from (`runs`, in `RUNS` order), the Node version, platform and architecture it ran under (`runtime`), the release that wrote the checkpoints with its stack (`release`), the candidate's stack and overlays (`candidate`), each run's and checkpoint's seconds, and each run's result: its outcome (`pass`, `flags`, `invalid` or `couldnt-run`) and the reason it couldn't run, its record (`same`, `differs`, `missing` or `written`, or `null` when it couldn't run), its flags, `new`, `gone` and `kept` against the base arm's ("Flags across the arms", below), its counts (`counts`) of request compiles, of the requests the stand-in classified as the summariser's, requests to summarise messages (`compressions`: level 1, whatever the instruction, a compression's, a transition's or a subagent's) and requests to merge summaries (`merges`: every level above it), each counted under the level it asked for whether or not it was answered, and of quarantines entered (`quarantines` is `'not-reported'` or `{compression, merge}`, each a count or `'unreadable'`), the reads of the test module's that failed (`readsFailed`, such as `receipt` or `merge quarantines`, and with `--against`, `baseReadsFailed`), the base arm's reason where it couldn't run the run (`baseReason`, its record then `missing`, and its summary row saying "the base arm couldn't run it: …"), the names of the stretches, or the setup's part (`conversations`, under `Hconv`), the run left out because the arm's installed agent-framework doesn't bring their module (`absent`, and with `--against`, the base arm's `baseAbsent`, each only where there are some, as CHECKS.md's `W12` section and its `Hconv` paragraph under `W13` say), and its self-check (`selfCheck`, whose `outcome` is `same`, `differs` or `couldnt-run`, the last with its `reason`).
- `--update-seconds` merges this invocation's seconds, each run's, each checkpoint's and each release install's, over the ones `stack.json` records, which `--shard` balances by. It writes the file through a temporary one, so an interrupted write leaves the old file whole. Two invocations writing at once each keep their own merge, and the later one's stands. A run's seconds are those of the drive that recorded it, with its judging, and a checkpoint's those of its build. A run that couldn't run and a checkpoint that failed write none, so `stack.json`'s, or the plan's, stand for them.

Each drive, a run's or a checkpoint's, runs in a child process of its own (`lib/child.ts`), and so does each install and each read of a release's recipe facts, while the invocation's own process keeps the shared state: the release's install and kept facts, the checkpoints, the records, the comparison with the base arm, and the files it writes. A drive waits on real-time timers (`until`'s bound, the boot waits and the settle's), and the harness's own synchronous work, its installs, its reads of a host's facts through `bun` and the judge's read of the store, would hold up every other drive's timers in one process, so a run that wasn't late could fail.

### When the invocation fails

A failure of the invocation's own, rather than of a run, exits 2 and writes no `run.json`. It says why on stderr, ending with the reason's first line, and once `--out` is made, also writes it to `failed.json` there, as `{"why": …}`, so a caller can name it. Such a failure is one of these:
- an argument it refuses, before anything runs;
- a setup that fails: a release's install needed for its versions, or a candidate's ("installing the candidate failed", or with `--pair`, the base or the head arm's), or a `--host-head` that, once the head arm is ready, isn't a connectome-host checkout;
- a drive's host ended by a signal the harness didn't send, or one of the harness's child processes ended by any signal, or one that exited without its result. Where processes share a machine's memory, as a share's drives do on a runner at width 3, or a run and other work do on a shared machine, the kernel's out-of-memory kill picks its process mostly by size, not by which one used the memory up, so such a death may not be its run's doing. So a death by signal fails the share, naming the drive (the base or head arm's recording drive, the self-check's, or a checkpoint's build), its run and the signal, rather than show as that run's failure in one arm. A host's own crash by a signal, such as SIGSEGV or SIGABRT, a candidate's bug included, fails the share the same way. The harness's own stop of a host that didn't exit within its shutdown bound fails only that run, as before, and so does a host that exits with a code of its own;
- an error of the harness's own, such as a `report.txt` that can't be written.

It then stops every child's process group before it exits, and a signal that stops the invocation stops its children's groups too.

Records are made on Linux. The test module stamps each request compile from the machine's monotonic clock, which it reads there (`module.ts`), under Bun through `clock_gettime` in `libc.so.6`. A run whose compiles carry no stamp is refused as couldn't-run (`record.ts`, `unrecordable`), so every run couldn't run anywhere but Linux, and under Bun on a Linux whose C library isn't at `libc.so.6`, such as a plain musl one.

A run that throws anywhere in its own work, from being set up to its self-check, or whose checkpoint couldn't be made, couldn't run, with the reason in the invocation's output and summary; the other runs go on, unless its `report.txt` can't be written, which fails the invocation ("When the invocation fails"). A self-check whose drive with recording off failed couldn't run, and one whose bodies differ fails, but neither makes its run couldn't-run: the run's record is still written and compared, and the invocation exits 2 or 1. A run whose last take of the test module's compiles at a host's shutdown fails is a failed run, its record ending `end failed`, since it lost what was compiled after the last settle.

A run that continues another starts from that run's checkpoint, but for a fresh twin (below), written by the release `stack.json` names, installed from that release's own lockfile, so the records show the candidate against a fixed starting store. A run whose variant names an older release, `from-<version>`, starts instead from a checkpoint that release wrote, its variant carried into the checkpoint's name (`H1b/prefix/from-0.9.0`); `stack.json`'s `upgrades` lists the releases a variant may name. A release is installed only where a checkpoint must be written from it, or its kept facts read again, and `--shard` puts every run of one older release in one share, holding no run of another where a share is left without one, so where there are at least as many shares as older releases, a job installs at most one beside `stack.json`'s. An older release lacks some of what the harness reads of the host, and `older.ts` reads its own form in each such place, keyed on what's missing, so a candidate, which has them all, reaches none of it: a host with no `src/model-limits.ts` (before connectome-host 0.16.0) gives no window, and its checkpoint's drive takes the candidate's, the base arm's with `--pair`, which sets only the stand-in's refusal past the window; and an agent-framework with no `listAgents` or `getPrimaryAgentName` (before agent-framework 0.30.0) is read through its `agents` map, whose one agent is the primary. A run that continues none (W1, W2 and others) starts empty under the candidate. So does a run on a setup that builds its history (`buildsHistory` in `script.ts`'s configurations, P4 alone): one the release can't drive, as v0.21.0's OpenRouter adapter takes no base URL. Its run is the history's steps, whose last copies the store, stops the host and boots it again a day later (`CHECKPOINT_GAP_MS`, the gap a checkpoint's run starts after, as the step's `gapMs`), then its own workload's, all under the candidate. So its workload starts on a freshly booted host a day after its history, as a checkpoint's run does, and its record holds the history's requests too. `H1b/continuation/fresh`, the twin of the runs from older releases' stores, builds its history the same way (`buildsFresh` in `workloads.ts`): it writes the prefix they continue under the candidate, in its own run, then its continuation. Moving to a newer release is a change of its own.

## Which of a change's lines ran (`--reach`)

`--reach DIFF`, which needs `--self-check`, reads which of the change's lines ran, `DIFF` being its `git diff -U0` with `a/` and `b/` prefixes. An added line is changed, and a hunk that only deletes is changed at the head line it follows. The lines are read in the host checkout, outside its `node_modules`, for a host change, and in every installed copy of the overlay's package for an overlay, whose built `dist` files map to the `src` it ships. `--reach` reads one change: with several overlays, such as a stack's companions, `--reach-package NAME` names the one the diff is of, and it refuses several overlays without it. Quoted paths in the diff's headers read as the paths they name.

`DIFF` is read once the arm's candidate is ready: at the start for one arm, and with `--pair` once the head arm is ready, so a setup can make the diff after the invocation starts. Its writer leaves one of two files: `DIFF`, the diff, or `DIFF.err`, why it couldn't make one, such as git's own words. With `DIFF.err` alone, the arm runs without reach, writes no reach files and says why in its log, since its records matter more than its reach. With neither, the invocation fails, as its writer broke its own order: before anything runs for one arm, and with `failed.json` with `--pair`.

- **What's profiled.** The self-check's drive, with recording off, starts every host under Bun's inspector (`--inspect-wait`) with the control-flow profiler on and `lib/reach-preload.cts` preloaded. The recording drive and the base arm aren't profiled, so no record changes, and the self-check's comparison of request bodies shows anything profiling changes in the bodies the host sends, but for the values it masks as varying from run to run, such as thinking signatures. A profiled host still has its shutdown's time to exit, and a host the profiler can't attach to can't run under `--inspect-wait`, so it's stopped: either fails the self-check's drive, which makes the run couldn't-run and the invocation exit 2, as any failed self-check does.
- **Where it's read.** At the host's exit. The preload wraps `process.reallyExit`, which Bun calls once the exit listeners have run, and calls a function there holding a `debugger` statement. The harness pauses at `debugger` statements and reads at that one, known by its function and the preload's file rather than by a line, since the source Bun serves the inspector is the preload transpiled. So the host pauses with all its code run, its basic blocks are read, and it resumes and exits. A `debugger` statement in the host's own code pauses it only until the harness resumes it. A host that exits any other way (killed on its shutdown's timeout, crashed, or ended without `process.exit`) reads as unread, and so would one whose Bun didn't pause at that statement, which its unread reason names beside the rest. The shutdown's wait for the host to exit doesn't count the time the read takes.
- **Which lines ran.** Bun serves its own printing of every module, with an inline map to the file on disk, and a package's built file maps on to `src` through its own `.js.map`. Blocks nest, and the innermost block covering a mapped position says whether it ran. A segment that only repeats the position before it, at the start of a printed line, is skipped, since Bun's map opens each printed line with one. A changed line ran when an executed block covers code mapped from it, in any host of any profiled drive. Code that only the recording drive runs, such as the test module's reads of the store, isn't read. A line mapped to no code, such as a comment or a type, is `noCode`. A file is read when a host loaded a script whose map names it, the script itself for a `.ts` run directly, even where nothing in it maps to code, as for a module of types alone. A file no host loaded takes its code lines from the built maps on disk. A line that no read and no built map gives as code or as no code is `unloaded`, whatever else is said of its file, so "couldn't tell" holds only lines known to hold code.
- **Ran in no profiled drive, or couldn't tell.** A line of code that ran in no read host reads "ran in no profiled drive" (`notRan`) only when every host of every profiled drive was read and no worker or child process ran unprofiled that could have run it. Otherwise it reads "couldn't tell", with the reason:
  - a host that wasn't read, a profiled drive that failed (the steps after its failure never ran there, though the recording drive's may have), couldn't run or started no host, or a run with no profiled drive since it couldn't run;
  - a script whose maps couldn't be read, or a script in the tree whose map names a source outside it or not on disk;
  - a built script with no source map, loaded by any host: it may hold a copy of any changed file's code, so its reason is a note, and every line not seen to run, a loaded file's included, reads couldn't tell;
  - a changed file that isn't script source (not `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`), a binary one included, which `changedOf` keeps from Git's `Binary files … differ`: it can't be read back to lines a host ran, so its change reads couldn't tell, with its own reason;
  - a worker or child a host started whose code the read can't follow: a child, unless its script is one of the harness's own files; a worker whose entry can't be placed or that runs code given as text; or a worker whose entry's static import closure holds a load the scan can't follow, such as a path known only as it runs, or mentions `Worker` anywhere, since it may start one. Each such worker or child is one firing of the fallback, counted in `fallbacks`, however many loads in its closure the scan can't follow; a host that wasn't read still counts the ones its spawn log names, though one the preload couldn't log is counted only by a host read where it exits. A changed file built into more than one script, by the scripts' own maps, is a reason for that file's unseen lines, since a read places a file's code from the script a host loaded: a line that script doesn't hold reads couldn't tell rather than no code, and so does a deletion with no code beside it there. A built script whose map can't be read makes every changed file so. Reasons name files by the repository's paths, with the runner's install and work directories taken out, so one reason from every share reads as one. The preload logs a child started by `Bun.spawn`, `Bun.spawnSync`, any of `node:child_process`'s forms, which go through them, or Bun's shell (`$`, a configured `$`, or a shell made with `new $.Shell()`), whose every command, a builtin's too, is logged. A worker gets no preload, so the closure scan reads any load of `'bun'` in its closure, or any use of `Bun.$`, as starting a child. A line of the spawn log that can't be read is a firing as well, and so is each spawn the preload couldn't log: it still starts, so profiling changes nothing the host does, and the preload counts it in the host, where the read takes the count with the host's blocks. The files a worker's closure does name read "couldn't tell" by themselves, naming the worker.
- **Deletions.** A hunk that only deletes is judged by the nearest code line on each side of it on the head: reached when either ran, saying which line judged it. Where neither side has a code line, as in a file of types alone, it's `no-code`.

Each boot's read is digested to the changed files, so the whole run keeps line sets rather than scripts and blocks, and `reach-digests.json` keeps the digests with the changed lines and the built maps' code lines of those files, so the context view joins its shares' reads with no tree at hand. It names the sha256 of the reach code that wrote it, `lib/reach.ts` and `lib/reach-preload.cts`, which read hosts, shape the digests and join them, and `lib/strategies/cut.ts`, which gives an error's text in them, and a join names that beside its own, so a join by another version shows. `reach.json` is the reading of this invocation's digests.

## Reading a record

A record opens with one header line: the run, and the checkpoint it starts from (`empty` for one that starts empty). No record names a version, so a candidate that differs from the base arm's only in its version, as a release's `npm version` makes it, moves no record. The versions are in each arm's `run.json`: the release that writes the checkpoints with its stack, and the candidate's stack, with the Bun that ran.

Then come two blocks. Each text the stack wrote is written once for each role
it's sent in, in `templates`, and each request head once, in `heads`; the lines
below name them.

- **`T:KEY = TEXT`.** A key is the text's role, its first three words with
  numbers as `#`, and the first 12 hex digits of the sha256 of the text as
  written, which for a text over 4,096 bytes is its `{ sha256, bytes, head,
  tail }` form:
  `T:user-clock-#-#-utc-9b6932fc9102 = Clock: #:# UTC`. A summary's key is
  instead `summary-lN-` and the first 12 hex digits of the sha256 of its whole
  text, the digits a long summary's `sha256` begins with. A key depends on its
  text alone, so a text leaving the set renames no other, and a one-word edit
  to a text renames it in every line that carries it, since each of those
  requests did change. Two different texts taking one key, a 48-bit
  collision, make the record refuse to be written, naming both. A
  summary's text is keyed by its level and that hash. A line that names a
  template gives its numbers after it: `[T:user-clock-#-#-utc-9b6932fc9102](12,10)`.
  A text's later lines are indented two spaces. A text over 4,096 bytes is
  written as `{ sha256, bytes, head, tail }`.
- **`H:KEY = api API, model …, …`.** One per distinct request head, keyed by
  a hash of it: the API it was sent to, the model, then that API's own fields
  in its own names, so a reader sees which fields a request's head carries
  and what moved. A few distinct values read alike in the line, though their
  keys differ: where a literal `#` sits among a text's digits (a template
  writes each run of digits as `#` and lists them after it), a missing header
  and one sent as `-`, a beta list joined with `+` and one holding a `+`, a
  digest past its first 8 hex digits, and a scalar's JSON type (`0` and
  `"0"`). No host sends these, and the head is whole in the run's
  `records.json`, which tells them apart.
  - **`api messages, model …, max_tokens …, stream …, tool_choice …,
    thinking …, system …, tools …, headers beta … version …`**: its limits,
    `tool_choice` and `thinking` as sent, each system block as a template with
    its cache marker (`^5m`, `^1h`, or `^null` for a `cache_control` sent as
    null) and a hash of any other field it carries (`{HASH}`), each tool by
    name and a hash of its whole definition, and the `anthropic-beta` and
    `anthropic-version` headers.
  - **`api responses, model …, max_output_tokens …, stream …, instructions …,
    tools …, reasoning …, include …, store …, service_tier …, headers
    organization … project …`**: the output limit (`null` where the request
    names none), the instructions as one template (`-` where it sends none,
    as P1's summariser does), each tool by name and a hash of its whole
    definition, and `reasoning`, `include`, `store` and `service_tier` where
    the body has them, as sent. The headers part appears only where an
    `OpenAI-Organization` or `OpenAI-Project` header was sent, which no run
    does.
  - **`api codex, …`**: the same fields as `api responses`, with
    `headers session_id <uuid>:<12 hex>#N` in place of the organization and
    project: the `session_id` header by its shape, since membrane draws its
    id at random for each adapter, and numbered by its first appearance in
    the run, so the requests that share a key share its number.
  - **`api chat-completions, dialect …, model …, max_tokens …,
    max_completion_tokens …, stream …, stream_options …, tool_choice …,
    reasoning_effort …, thinking …, tools …, headers …`**: each field where
    the request sent it, but `stream`, which is always written; each tool by
    name and a hash of its whole definition; and OpenAI's organization and
    project headers, or OpenRouter's referer and title, where either was
    sent. The system prompt is a message on this API, so a change to it moves
    the body hash, not the head.

  Every Chat Completions head names its dialect after the API (`dialect
  openai`), and a Bedrock head is an `api messages` head with `dialect
  bedrock`; Anthropic's own Messages head names none. For every API, the line
  then gives the path where it isn't the API's own, `/v1/messages`,
  `/v1/responses`, `/codex/responses` or the chat dialect's
  (`/v1/chat/completions`, `/chat/completions` or `/api/v1/chat/completions`),
  so every Bedrock head gives its path, which names the model and the route;
  the query where there's one; and `rest`, anything else on the request body
  as its JSON text, masked as other texts are, under a template, where there's
  any: P1's `context_management` with its threshold, or a Codex request's
  `prompt_cache_key`, by the same shape as its `session_id`.

Then the run's form lines, where it has any:

- **`form [T:KEY] NAMES`**, with the agent in brackets after `form` where it
  isn't the fixture: a frame (below) that is the same at every compile the
  record writes of each message it names, and holds no number once named,
  written once. NAMES are the messages that carry it, each by every name it's
  written under: those from a store in store order, as ranges, then those
  named by their summaries in the order first met. Those messages' items stay
  bare and keep their ranges, but for an item with `!content`, `!shards` or
  `:no-thinking`, which stands alone as ever. A message is told by its agent
  and its sources, and one sourced from summaries by its speaker too, since
  context-manager gives a recall pair's question its summary's sources. A form
  line's names move with the compiles: where which messages carry a form
  changes, as when a change recalls more summaries, the form line changes
  beside the `compile` lines that show it.

Then each step of the run, in order, with what it made happen. Within a step,
the lines of requests are in the order the stand-in received them:

- **`compile ITEMS ^ N,M, head H:KEY, body HASH`**: a compile context-manager
  made and the request it was sent as.
  - **ITEMS** are the messages it sent. A stored message is named by the
    canary its text carries (`p.12.in`, `c.tool.call1`), or by its occurrence
    (`p.12.in:2`) where an earlier message in its store carries that canary
    too, and a run of messages stored next to each other as a range
    (`p.3.in-p.9.r1`). A message sent raw without one is its template. A
    summary is its level and the first and last messages it covers,
    `L1(p.3.in-p.5.r1)`, with `~` after it where only part of it went. A
    stored message without a canary is named, there and in the receipt line,
    by the nearest earlier message in its store that carries one and its place
    after it (`p.3.r1+2`), or by its place from the store's start (`start+3`),
    as check 11's flags name it. Names are as each store stood at the settle
    after that compile's step, where the log takes its store delta, so a later
    step's edit renames nothing earlier, and a message the delta reports
    removed anchors no name from then on.
  - **`!content` or `!shards`** after a name: context-manager's own provenance
    says that body went altered, or without all its shards. **`:no-thinking`**:
    the stored message holds thinking and the copy sent holds none. Either way
    it stands alone, outside any range.
  - **A frame**, `p.1.in[T:KEY](N,…)` or `L1(p.3.in-p.5.r1)[T:KEY]`: the text a
    message the item names by its canary or its summaries carries besides the
    fixture's words, as a template with its numbers after it. The fixture's
    words are the texts in the run's and its checkpoint's steps that carry a
    canary or a summary's mark, each result of the fixture's tool, and each
    answer the stand-in gave them, its thinking included and an answered call
    as `name {input}`, as a call's text is written. Each block of the message
    is read on its own. A text of the fixture's is found where a run of its
    words holds one of the 32-character windows taken every 16 characters from
    its start: any run of 47 characters or more, and a shorter one where it
    lines up. A marked text under 32 characters is found anywhere, whole, and
    an answered call under 32 characters only as a block of its own. In a
    frame, a text found whole is `⟨own text⟩` and a part of one `⟨own text,
    chars a–b of N⟩`, and the blocks are joined by a line break. A message
    each of whose blocks is one of the fixture's texts whole has no frame. Any
    other has one: it carries added text, whitespace included, or only part of
    one of the fixture's texts, as after a cut. A recall pair's question
    carries none of the fixture's words. So frontdesk's header reads `[fixture
    · #chat · topic "prefix" · @Wren · #:# · msg p.#]` then `Wren: ⟨own
    text⟩`, and a message `maxMessageTokens` cut carries `⟨own text, chars #–#
    of #⟩` with context-manager's note after it. A value each run mints, which
    a request's digest masks, is named in a frame as in the record's other
    templates: those `compare.ts`'s `RUN_VARYING` lists, and the run's
    directory, its session paths and its lesson ids. A request's head arrives
    already named by the stand-in, in its own way. A frame that is its
    message's form is on the form line (above), and the item is bare. Any
    other stands at the item, outside any range, before any `!content` or
    `:no-thinking`. Under membrane's `anthropic-xml` formatter the stand-in
    writes its calls in its answer's text. So a reply's frame there is the
    part of the answer before them, as `⟨own text, chars a–b of N⟩` where it's
    long enough to be found and as itself where it isn't, and each call as
    membrane read it.
  - **`compile -N + ITEMS`**: the agent's previous compile of the same kind
    (request or dry) less its first N items, then ITEMS added. So a change
    shows on the line of the request it changed. `= (as before)` is that
    previous compile again. Where no such N leaves the previous compile's
    items at the start of this one, as when an earlier item's form changed,
    the compile is written whole.
  - **`^ N,M`**: the places, in the list context-manager compiled, of the
    messages it marked for caching. The stand-in judges no cache marker; each
    is recorded as sent, a plain one as its TTL and any other shape whole. A
    marker on a message block or inside a tool result, wherever it was added,
    is held in the body hash; this list is context-manager's own marks, so a
    marker an adapter adds after the compile, or one nested in a tool result's
    blocks, moves the body hash without a place here. One on a system block
    shows in the head, after that block's template (`^5m`), and one on the
    body is written in the head's `rest`. One on a tool or on a message itself
    is held only in the tool's definition hash or the message's digest. A
    change to any of them moves the record.
  - **`head H:KEY`** appears when the agent's head differs from its previous
    request's. **`body HASH`** is a hash of each message as sent, digest and
    cache markers, so a change to any of them moves it, apart from the forms
    the record writes alike, listed after this list.
  - **`compile dry`** is a dry compile, which sends nothing.
    **`compile refused CLASS [T:…]`** is one that threw.
  - **`compile [AGENT]`** is another agent's than the fixture's own, such as a
    subagent or a reader, whichever compiled first.
- **`round + CANARIES, body HASH`**: a continuation round, a request sent with
  no compile of its own, with the canaries it carries beyond the agent's
  previous request. A request no compile pairs with is a round too, under
  `[sub]` where no agent of the stand-in's subagent side compiled at all.
- **`call CARRIED [T:…] -> SHAPE, head H:KEY, body HASH`**: a request to the
  summariser. CARRIED are the canaries of the messages it carried, each
  summary it carried by its name. The templates are its own words, such as its
  instruction. SHAPE is the stand-in's answer.
- **`ask [review] HIDDEN -> VERDICT, head H:KEY, body HASH`**: a request from
  agent-framework's suppression review, which asks whether a suppress rule hid
  what its agent would have wanted to see. The stand-in tells it by its system
  prompt's opening, "You review a filter an AI agent set on its own
  attention". HIDDEN are the canaries of the events it lists, one to a line as
  `#N [time] …: text`, and VERDICT the stand-in's answer, the JSON the review
  reads: `flagged`, naming by number each event that carries `[[flag]]`, or
  `fits` where none does. One that lists no event is unclassified.
- **`ask [judge] BATCH -> VERDICT, head H:KEY, body HASH`**: a request from
  agent-framework's reply judge, which a `judge` wake rule asks whether to wake
  the agent for a batch. The stand-in tells it by its system prompt's opening,
  "You are the reply judge for an AI agent named". BATCH are the canaries of
  the events it lists between `<new_events …>` and `</new_events>` in its last
  text block, and VERDICT the stand-in's answer: `reply` when that batch
  carries `[[wake]]`, `wait` when it doesn't, whatever the context document or
  the rule's instructions before it carry. A batch carrying `[[judge-fails]]`
  is answered instead with the 400 the API gives an invalid request, which
  membrane doesn't retry, so the judge fails, and its line reads
  `-> error 400`. Its head holds the judge's own
  system prompt and model, and its body the document, the batch and the
  instructions, so a change to any of them names the request. A judge request
  whose last text block lists no batch is unclassified.
- **`ask [concepts] NAMED -> VERDICT, head H:KEY, body HASH`**: the first of
  connectome-host's retrieval module's two requests, which asks for keywords
  naming what in the recent conversation might want background knowledge. The
  stand-in tells it by its system prompt's opening, "You are a knowledge
  retrieval assistant". NAMED are the canaries that conversation names, which
  the stand-in answers as its keywords, so a W12 lesson, whose content opens
  with its own canary, is a candidate exactly when the conversation names that
  canary; VERDICT is `named`, or `none` where it names none.
- **`ask [relevance] CANDIDATES -> VERDICT, head H:KEY, body HASH`**: the
  retrieval module's second request, which it sends only when more than three
  lessons are candidates, asking which are relevant. The stand-in tells it by
  its system prompt's opening, "You are a relevance filter". CANDIDATES are the
  canaries of the lessons it lists, one to a line as `[id] (confidence)
  content`, and the stand-in answers the ids of those whose content doesn't
  carry `[[stale]]`, a mark of its own: VERDICT is `filtered` where it drops
  one, `kept` where it keeps all. One that lists no lesson is unclassified.
- **`ask [naming] SUMMARISED -> named, head H:KEY, body HASH`**: connectome-host's
  session naming request, which it sends once the third message typed at the
  console, or sent through its TUI, web UI or headless `text` command, has
  arrived, and whose answer only renames the session in the host's session
  index, never a resident's request (`synesthete.ts`, `index.ts`
  `setupSynesthete`). Its model is Claude Haiku 4.5, whatever the recipe. The
  stand-in tells it by its system prompt's opening, "You are a session naming
  assistant", and answers one fixed name. SUMMARISED are the canaries in the
  summary of the conversation's first messages that the request carries.
- **`ask [transition] HEAD -> summarised, head H:KEY, body HASH`**:
  context-manager's transition summary for a bare `/newtopic`, written from
  the agent's head window and its latest higher summaries, which it
  stores nothing of (`generateTransitionSummary`, 0.25.0); connectome-host
  stores it as the topic's transition only if nothing moved while it was
  written (`commands.ts` `bareTransition`). The stand-in tells it by its
  system prompt's opening, "You are forming a transition summary between
  conversation topics", and answers one fixed text. HEAD are the canaries in
  the head its instruction quotes.
- **`unclassified CARRIED, head H:KEY, body HASH`**: a request the stand-in
  could tell as none of the kinds above, an agent's, the summariser's, the
  suppression review's, the reply judge's, the retrieval module's, the
  session namer's or the transition summary's, such as one whose
  compression instruction it doesn't recognise or states no target length;
  one it can't count under a level, since its instruction opens as a merge
  instruction does but names no level, or names a level (`Ln`) in none of
  the forms the stand-in reads, as a merge reworded to open as an L1
  instruction would (an L1 instruction that quotes a level from the
  conversation, as the host's frontdesk transition quotes the user's open
  questions verbatim, is refused the same way, so its run doesn't measure,
  or counted under the quoted level where the quote takes one of the
  stand-in's forms; no workload's text names one, as a unit test pins); or
  one to a route the stand-in doesn't serve, any but a POST to a path ending
  in `/v1/messages`, `/responses` or `/codex/responses`, to a chat dialect's
  own path (`/v1/chat/completions`, `/chat/completions` or
  `/api/v1/chat/completions`), or to Bedrock's `…/model/{id}/invoke` or
  `…/invoke-with-response-stream`, `count_tokens` included, which no run
  sends. So is a summariser retry whose hint doesn't
  fit what it re-sends. A request re-sends one the stand-in answered badly, and whose
  re-send it hasn't yet answered well, when it has the same level, target
  and canaries, and the same summaries for an L1 request or the same last
  summary for a merge, since context-manager 0.24.0 re-sends a merge with
  whichever prior summaries its halved recall budget fits, its sources last.
  After an answer that was only thinking, or empty, the re-send must carry a
  retry hint, after one cut at `max_tokens` none, and a hint with nothing to
  re-send is refused too. Since context-manager retries the merge at the head
  of its queue until it is written or quarantined, a hintless merge alike in
  level, target and canaries to one cut at `max_tokens` and not yet answered
  well on a re-send can only be that re-send, so one that ends with another
  summary is refused. The stand-in sees no quarantine, so once context-manager
  quarantines such a merge, its re-sends all refused, later merges alike in
  those three are refused too, and the run can't be compared. A merge whose
  sources went raw, so that its last summary is its newest prior, and whose
  retry dropped that prior, isn't read as a re-send, so it is refused, with a
  hint or without, and its run can't be compared though nothing is wrong. Its
  retry can drop that prior only if the prior alone runs past the halved
  recall budget, 50,000 tokens at a first retry, half the 100,000 that
  `compressionRecallBudgetTokens` defaults to. Summariser requests name no
  agent, so a second agent's merge alike to one the stand-in answered badly
  couldn't be told from its re-send, and no run that queues a bad answer has
  a second agent that can compress, a subagent or a subconscious, as a unit
  test pins. Check 1 fails the run, naming the stand-in's
  reason, and the line
  lets the view show the request. The line carries no method, and a body that
  doesn't parse, or parses to a falsy value such as `null`, gets no head, so no
  path or query either; for a route the stand-in doesn't serve, the reason
  names the method and the path. A request the stand-in claimed and then
  couldn't answer, refusing it or sending its reply, shows as two such
  lines, the first with its head and the second without, since the driver
  hears it as claimed and then as unclassified.
- **`action COMMAND`**: a host command the workload sent: a connectome-host
  command by its slash, such as `/branchto`, or one the fixture server sent
  agent-framework as an operator's `host/command`, by its name, such as
  W16's `unstick`. For one the fixture server sent, the driver waits for the
  turn it starts, then settles.
- **`wrote NAME [T:…]`** and **`removed NAMES`**: a summary the store added or
  changed, with its text, and those it removed. The driver takes the test
  module's compiles as each boot becomes ready, before the steps that follow
  it, and a manager's first take in a process lists its store whole. What it
  lists at the first boot is the store as the run began, so a checkpoint's
  summaries aren't written. What it lists after a restart is compared with
  what the record knew, so a summary the reloaded store lacks is `removed` at
  the restart's step, and a message it lacks names nothing from then on. An
  agent first seen later in the run, such as a subagent, has every summary it
  holds written.
- **`absent STRETCH`**: a stretch of the workload, or the part of a setup that
  needs it, that the host's installed agent-framework can't run, left out of
  the run, as `CHECKS.md` says of W12 and of `Hconv`.
- **`checkpoint NAME`**: where the script took a checkpoint, under its step's `step` line, which a step with nothing else to show still has.

The record ends with `end ok` or `end failed`, then each agent's last receipt
from context-manager, `receipt AGENT #SEQ changes LEAF/KIND/LEVEL/LAST …`
(`LEAF/removed` for a leaf it removed), `totals`, and `judged`, each check's
count of what it judged, so a drop in a count that stays above zero moves a
line. The receipt is the head of the kv-unified receipt chain that
context-manager's strategy keeps for that agent, as the harness last read it
from the strategy. The resident neither writes nor sees it, and it isn't one
of the receipts agent-framework puts in a resident's requests, such as
`[delivered]`, which `CHECKS.md` speaks of. An agent whose last reported
receipt head is none, or couldn't be read, has no receipt line.

A record of P1's or P2's runs, on OpenAI's Responses API or ChatGPT's Codex
backend, reads the same way, with these differences:

- A request's body is a list of input items, and the record holds each item
  as a message of its own: a message by its role, and a `function_call`, a
  `function_call_output`, a `reasoning` item or a `compaction` item by its
  type, each with its own digest. A change to any one item moves the
  `body HASH`, and the run's `records.json` says which item moved. A compile
  line's ITEMS are context-manager's messages, as on the Messages API, and
  one stored message can go as several items: an answer's reasoning, its
  text and its call each go as one.
- A `reasoning` item's content is opaque `encrypted_content`, which the
  stand-in mints from the thinking text and the request's record holds as a
  `redacted_thinking` block with `sealed`, whether the content is the
  stand-in's own. So a change to the reasoning a request replays shows as
  its item's digest moving, with no text to read, and an item whose content
  the stand-in didn't mint shows as `sealed: false`.
- A `compaction` item is a message of role `compaction`, whose content is the
  stand-in's digest of the input it compacted. In P1 it comes back in the
  continuation rounds after the answer that carried it, in `round` lines.
- No Codex request carries `context_management`, which the host gives to
  `openai-responses` alone, and a Codex summariser request sends no
  instructions, so its head reads `instructions -`.
- A Codex request's `prompt_cache_key` and `session_id` are written by their
  shape, `<uuid>:<12 hex>`, since membrane draws them at random for each
  adapter, and numbered by first appearance in the run, `#1`, `#2`, …, since
  which requests share a key moves what the backend can cache. So neither
  moves a record between two arms or two runs, but a change that gives two
  requests one key, or one request's key to another, does; `--self-check`
  numbers the keys the same way in the bodies it compares. Only a request's
  own top-level field of either name, `prompt_cache_key` or `session_id`, on
  any API, and its `session_id` header are masked so: a string of that shape
  anywhere else in a request, a nested field of either name included, is its
  content, and a change to it moves its item's digest.
  The
  reasoning content the stand-in mints depends only on its scripted thinking,
  and a compaction item's digest only on the input it compacted, so neither
  varies from one run to the next.
- A record holds no token counts. The budgets check (check 3) reads the
  stand-in's usage, and the host's calibration, which check 10 reads, learns
  from it. Both see a request as the stand-in renders it: from its latest
  compaction item, and without earlier turns' reasoning under
  `reasoning.context: current_turn`.

So `same` for a P1 or P2 run means, besides the rest of the record, every
request's head and every input item's digest as in the base arm. A change
to how an item is written, such as how membrane writes an assistant's text,
moves the `body HASH` of each request whose items it rewrites, and, where
it changes the characters of a text the line names as a template, such as a
summariser's instruction, that template too. On the Codex backend such a change in
membrane's subscription input reached the summariser's requests and not the
agent's, whose history reaches membrane as items it passes through as they
are.

A record of P5's and P4's runs, on the Chat Completions API, reads the same
way, with these differences:

- The record holds each message the request sent by its own digest and the
  side it reads as: a `system` message on the system side, which every agent
  request opens with and no summariser request has, a `user` or `assistant`
  message on its own, and a
  `tool` message on the user's side. So the system prompt is in the body
  here, and a change to it moves the `body HASH`, where on the Messages API
  it moves the head. One stored message can go as several: a turn's tool
  results go as one `tool` message each, and an answer's calls go inside its
  `assistant` message.
- membrane's OpenAI-compatible adapter joins a message's text blocks into one
  string, and its OpenRouter adapter does so for a message with no cache
  marker, image or audio among its parts (`openrouter.js`, `useArray`), so a
  summary and the reply after it can arrive as one block. The
  run's `records.json` gives such a block the order its summaries and
  canaries came in (`marks`), which check 4 reads.
- An image in a tool result goes as membrane's own text in its place, since
  the API's tool messages carry text only (`imagesNotShown` in
  `records.json`). So a change to such an image itself moves nothing.
- OpenAI's dialect sends no reasoning back, and membrane's OpenRouter adapter
  reads none of what OpenRouter's sends, so no request of P5's or P4's carries
  a thinking block. Under DeepSeek's dialect, and OpenRouter's in the unit
  tests, a thinking block's record names the field it came under and whether
  its text is the stand-in's own (`sealed`).
- Check 3 counts a round's input as membrane's adapter does. On P5 each
  round's whole `prompt_tokens`, cached prefix included, counts toward the
  stream bound. On P4 it's `prompt_tokens` less `cached_tokens`, so a round's
  cache writes count, where an Anthropic run counts only input neither read
  from the cache nor written to it.
- P4's record holds the history its run builds as well as the
  continuation's stretches: its requests at the `p.N` steps come first.

A record of P3's runs, on Amazon Bedrock, is a Messages API record: its
messages and blocks are written as on Anthropic's own API, and its head is
an `api messages` head with `dialect bedrock`, the version and betas, which
ride in Bedrock's body, under `headers`, and the path, which names the model
and whether the request streamed. The record holds what the request sent,
not how the answer came back, so Bedrock's event-stream framing never shows
in it.

So `same` for a P3 or P5 run means, besides the rest of the record, every
request's head and every message's digest as in the base arm. A change to how
membrane writes a message moves the `body HASH` of each request it rewrites:
membrane's OpenAI-compatible adapter joining a message's text blocks with a
blank line rather than a newline moved all 37 of P5's continuation requests,
so every one carried a message of more than one text block. A change to what
membrane puts in the head moves the head instead: its Bedrock adapter asking
one more `max_tokens` gave P3's continuation two new heads, which each
request's line names, with every `body HASH` unchanged. A P4 record is a
Chat Completions record with `dialect openrouter`, OpenRouter's attribution
headers in its head, and each text part's cache marker in its block's record,
so `same` for a P4 run means the same, history included.

A reader fork's name, `reader/<resident>/<8 hex>/<n>`, and its framing's
header, `[Tune-out reader — <channel>, epoch <8 hex>, …]`, carry the first 8 hex
of its tune-out's epoch id, which agent-framework 0.33.0 mints at random. So
the record names each epoch wherever its text carries one in either form, in
the order the run's compiles met them (`reader/fixture/E1/1`), and before a
text's template is shaped; the digests name it by its first appearance across
the run's requests; and the report names it as the record does, so a flag
both arms raise for a fork, its check 13 counts and its unmeasured lines
compare alike. Text in neither form isn't named as an epoch.

Image refs carry a nonce agent-framework mints for each process, so the record
names each nonce by the order it first appears (`img_na_1`, `img_nb_1`), and
the digests a body hash takes name it by its first appearance in that request
(`img_N1_1`). A fork's call id ends in a random UUID where the fork's own call
isn't in context, so the digests name each such UUID the same way. A
reminder's id is its time on the workload's clock and four random characters
(`rem_mk0xssww_mvqs`), so the digests name those four the same way
(`rem_mk0xssww_R1`). A draft id agent-framework mints when it holds a turn's
speech is `d-` and seven random characters from its own alphabet
(`d-mckugqs`), so the record names each by the order it first appears across
the run's boots (`d-Da`, `d-Db`), and the digests by its first appearance in
that request (`d-D1`); both leave as sent the one constant agent-framework
writes in that form, `d-k7x3qm2`, the example its drafts tool's schema and its
refusal of a malformed `draftIds` quote (`framework.ts:14086` and `:23245` at
0.33.0, `:13189` and `:20654` at 0.32.0). So a request naming two image
ledgers, a call and a result naming different forks, two reminders or two
drafts, still differs from one that names one. The naming goes by the text's form, so a text written in that form by
anything else is named the same way. The store sequences agent-framework's history module shows the agent, the `id` of
each message in a search's or an extract's result whose text opens as the module writes one, a search's
`skipSequences`, an extract's `anchorId` and the agent's `aroundId`, are named the same way, in the record across the
run (`sa`, `sb`) and in the digests in each request (`S1`, `S2`), and CHECKS.md's W12 section says why, where, and in
what order.
The run's own directory reads as `<run>`, and the session under its store as
`<run>/store/sessions/<session>`. connectome-host's lessons module names each
lesson with eight random hex digits and lists them, in the order it made them,
in `<run>/store/lessons.json`, so each id that file lists reads as `lesson-N`,
N its place in the file, wherever it stands as a word of its own: two runs that
made their lessons in one order read alike, and a lesson more before them
shows. A lessons file of another shape fails the mask rather than leave ids
unmasked: the harness module can't record the compile, and the stand-in
refuses the request as unclassified, each naming the file.
The stand-in's thinking signatures hash the request ahead of them and the
thinking itself, and carry a digest of the thinking alone: a signature's
first 22 characters bind it to the request ahead of it and its last 21 are
the thinking's own, so it keeps the length of one digest, and the price of a
block, which counts its signature's characters, doesn't move. On the Messages
API, on every configuration, a request whose latest assistant message holds a thinking block
whose text no longer matches that digest is refused with the extended-thinking
page's 400: "If thinking blocks are modified, the API returns a 400
`invalid_request_error` whose message contains `thinking` or
`redacted_thinking` blocks in the latest assistant message cannot be
modified" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking,
`modifiedThinking`). Where the model binds, the stand-in checks every
assistant message's thinking this way, refusing an
edited block with that error's wording at its own index. That wording names
the latest message, and applying it to any message is the stand-in's own
reading of the troubleshooting page, which says that where a signature
"didn't verify", "`prefix_mismatch_behavior` doesn't apply. Edited thinking
text returns a different error", without limiting that error to the latest
message (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
Where the model doesn't bind, only the latest message is checked. Whether a
model binds is the request's own model's: "A request that replays earlier
thinking blocks to a Claude 5.1 or later model can fail" with the binding 400
(the troubleshooting page), so Claude Opus 5.5 and Claude Haiku 5.5 of the
models the stand-in knows, and a run whose compressor is on another model than
its agent has each request judged by its own. On a
request whose model binds, a block whose text verifies but whose
signature no longer matches the request ahead of it is dropped where the
request asks `drop_block`, as the host's binding requests do, and refused
otherwise (`unbound` and `bindingRefusal`). That refusal is a newer account's:
"What's new in Claude Opus 5.5" gives the 400 for a field left unset "on
accounts created on or after August 31, 2026, 00:00 UTC. … On accounts
created before that date, the request gets the error only when it sets the
field to `"error"`"
(https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5).
A configuration names an older account with `account: 'older'`, and there a
block left unset is shown to the model as it came, on Opus 5.5 alone, by
its Messages API id (`olderAccountTakesUnset`), so on Anthropic's front: each
model's page gives its own rule, "What's new
in Claude Haiku 5.5" gives none
(https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5,
read 2026-11-08), and the Claude Fable 5.1 and Claude Mythos 5.1 migration
guide gives Mythos 5.1 the 400 for an unset field on any account. Under the
`thinking-binding-controls-2026-08-01` beta header, every answer on
Anthropic's Messages API front carries `input_transformations`, one entry
per block that failed the check, in
request order, `[]` where none did: `thinking_dropped` for a block set aside,
`thinking_mismatch_allowed` for one an older account showed, each with the
reason `prefix_binding_mismatch` and its `path`, as the beta Messages
reference gives them
(https://platform.claude.com/docs/en/api/typescript/beta/messages/create).
membrane reads that report (`readInputTransformations`), and agent-framework
withholds a calibration sample from a stream whose call dropped thinking, so
without it a drop the stand-in made reached no one. An answered request's
record keeps what failed the check whether the header asked for the report or
not (`transformations`), and its line in the record ends `dropped N` where N
blocks were set aside; a request the check refuses keeps its refusal
instead. The stand-in's Bedrock front reports none of this. The digests mask
the signatures. How
each model thinks is the troubleshooting page's table, "Thinking support,
defaults, and rejected configurations by model"
(https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting):
a `thinking.type` it rejects is refused with a 400 in that page's words, and
on a model whose thinking is always on or on by default, Claude Opus 5.5 and
Claude Haiku 5.5 of those the stand-in knows, every answer to a request that
doesn't turn thinking off leads with thinking signed for its request, the
summariser's too, which asks for none, and its text is empty unless the
request asks `display: "summarized"`. Adaptive thinking may also skip thinking,
which the stand-in can't know, so it answers every such request as one where
the model thought. Where a Claude 5 model thinks,
"`thinking.display` defaults to `"omitted"`, so `thinking` blocks arrive with
an empty `thinking` field alongside their `signature`"
(https://platform.claude.com/docs/en/models/opus-5-5/migration-guide), and
under `display: "updates"`, which the host's agent asks, "reasoning blocks
stream as they do under `"omitted"`"
(https://platform.claude.com/docs/en/build-with-claude/thinking), both read
2026-11-08. It writes no progress-update block, a note some models write
between tool calls, since no script asks for one. On a model whose manual
thinking doesn't interleave, Claude Opus 4.6 and Claude Haiku 4.5 of those it
knows, an answer to a request asking `type: "enabled"` carries no thinking
where the request's last user turn, as the API joins consecutive user
messages, holds a tool result: "Claude Opus 4.6:
manual mode has no interleaved thinking at all", and "Claude Haiku 4.5 does
not support interleaved thinking"
(https://platform.claude.com/docs/en/build-with-claude/extended-thinking),
where "Claude thinks once at the start of the assistant turn"
(https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows). A block the answer brings no
thinking for is empty under `"summarized"` too. On a model that thinks only
when asked, a scripted reply's thinking, and a thinking configuration's, is
answered whether the request asks for thinking or not, which CHECKS.md names
as a limit. These rules by model are the Messages API's: the stand-in applies
them on Anthropic's front and on Bedrock's, which reads its model by the
Messages API id it serves, and none of them on the Chat Completions dialects,
OpenRouter's Claude included. The
stand-in's summary of a request is seeded from the canaries it carried, and
names the last of them, in an order of digit runs by number and the rest by
code unit, which needs no collation data that could differ between machines.
On a configuration whose summaries come wrapped in thinking (C9h's
`thinkingWrappedSummaries`), a summary answer is the same memory wrapped
whole in one closed literal `<thinking>` tag pair with no tag inside, the
shape context-manager 0.25.0 reads as prose under
`recoverLiteralThinkingWrappedCompression` (`unwrapWholeLiteralThinkingWrapper`,
`autobiographical.js`), and stores without the tags; its bad answers are as
without it.

On a configuration whose formatter is `anthropic-xml` (H6), membrane 0.8.0
sends each of the agent's requests as a prefill: a first user message (the
recipe's `prefillUserMessage`), then the transcript in `participant: text`
runs as the assistant's, split into messages at a cache marker and around an
image, ending in the agent's name or a tool round's results
(`formatters/anthropic-xml.js`). The stand-in reads a request whose last
message is the assistant's as the agent's there alone, where the transcript
ends in the agent's turn, in its name or in a tool round's results within
its turn, and by a canary of the step's anywhere in it, since the transcript
carries the whole conversation and a canary only that step brought names it.
It answers by continuing the
prefill, as one text block: a space, the reply's thinking in literal
`<thinking>` tags, its text, then its calls as membrane's XML, an `<invoke>`
per call and a `<parameter>` per input, a string as written and anything
else as JSON, stopping with `stop_reason` `stop_sequence` and
`stop_sequence` `</function_calls>`, the sequence left out of the text, as
membrane 0.8.0 says the API leaves it ("The API stops before the stop
sequence, leaving a closing tag out of the text", `src/membrane.ts:2257`),
which none of Anthropic's pages says. A reply with no calls ends
its turn. A prefill to a model that takes none is refused with the errors
page's 400, "This model does not support assistant message prefill", since
"Claude 4.6 and later models and Claude Mythos Preview do not support
prefilling assistant messages" ("Prefill not supported",
https://platform.claude.com/docs/en/api/errors, read 2026-11-08): of the
models the stand-in knows, it takes Claude Haiku 4.5's. That refusal, as each
the API makes before a model reads a request, also goes to a request the
stand-in doesn't classify, off this formatter too, and a refused request
spends none of the step's scripted replies. Each text block
holding the transcript's tool rounds is recorded with the canaries of its
results, inside `<function_results>` or to the block's end where an image
split them off (`xmlResults`); of the results whose own `<result>` holds an
image's placeholder (`xmlPlaceheld`); and of the calls in a
`<function_calls>` block whose turn, since the round before, opens with
literal thinking (`xmlThoughtCalls`), read outside the rounds' XML.
The prefill read and `xmlThoughtCalls` take a turn to open (`lastRun`,
`view.ts`) at any line that starts with up to 60 characters holding no
colon, bracket or angle bracket, then `: `, outside the rounds' XML, a
block that opens inside a round's results reading them to their closing
tag, as membrane writes a turn's opening. So such a line in the text of the
agent's turn would read as another participant's turn. Then a prefill could
be unclassified, or a call's thinking product missing, and a line
`name: <thinking>…</thinking>` before a call would count the call as led by
thinking. The agent's turns hold the stand-in's replies, which have no such
line. A text block whose runs include one that opens with a notice's tag of
lowercase words joined by hyphens, `name: [speech-not-posted]` as
agent-framework stores it in a prefill, is also recorded with its canaries
and those tags in the order the text has them (`xmlMarks`), which places a
notice after a round. A tag with a space or a capital, such as
`[wake onboarding]`, isn't taken, nor is a line inside a round's results,
whose canaries still count. A round's results run across the request's
blocks in order, so a block an image split can open inside them, or lie
wholly inside them where a round was split twice. These aren't record lines,
so they move no record; check 2 reads the first three, and W19's property
`xmlMarks`.

The stand-in prices the prompt cache by its own model of the provider's, from
the prompt-caching page
(https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the
thinking page's "Thinking and prompt caching"
(https://platform.claude.com/docs/en/build-with-claude/thinking). It reads a
request's prefix as tools, then system, then messages. It reads back the
longest prefix it holds unexpired that ends within the page's lookback of a
cache marker: "The system checks at most 20 positions for each breakpoint,
counting the breakpoint itself as the first", where "a run of consecutive
`tool_use` blocks counts as one position, and so does a run of consecutive
`tool_result` blocks" ("How automatic prefix checking works"). It writes each
later marker's prefix for its own
lifetimes of 5 minutes or an hour. It doesn't write a prefix shorter than the
model's minimum cacheable length ("Cache limitations": 4,096 tokens for Claude
Opus 4.6 and Claude Haiku 4.5, and 512 for Claude Opus 5.5 and Claude Haiku 5.5), measured in its own
pricing. The
messages' prefixes key on the thinking configuration, its mode and
`budget_tokens`, which the prompt-caching page says is rendered into the
prompt, so changing it always invalidates the messages cache. Tools and
system don't key on it: that page says they're invalidated too "on models
that render the configuration ahead of them", and neither page names one.
The key is the configuration as sent, so a request that sends its model's
default explicitly reads as a change, where the thinking page says setting a
parameter to its default is the same as omitting it. The messages' prefixes
also key on whether the request sends any image, in a message or a tool
result, since the prompt-caching page says adding or removing images anywhere
in the prompt invalidates the messages cache.

The messages' prefixes key on `output_config.effort` too, since the same
page says changing it "always invalidates message blocks". Unlike the thinking
configuration, an effort the model takes by default keys as none sent, since
that page says "Setting effort explicitly to the model's default is
equivalent to omitting it and does not invalidate", and the effort page names
each default: medium for Claude Opus 5.5 and Claude Haiku 5.5, high for every
other model that takes effort. The reply judge sends `low` unless the host sets another. Which values each model takes comes from the same page's "Effort levels" table (https://platform.claude.com/docs/en/build-with-claude/effort), as read on 2026-11-08, whose rows are the five levels `low`, `medium`, `high`, `xhigh` and `max`. Its rows for `low`, `medium` and `high` give no "Available on" list; it gives `max` to Claude Opus 4.6, Claude Opus 5.5 and Claude Haiku 5.5 among others, and gives `xhigh` to Claude Opus 5.5 and Claude Haiku 5.5 but not to Claude Opus 4.6.

The prompt-caching page's "What invalidates the cache" also keys the
messages cache on `tool_choice`, and the system and messages caches on
`speed`. No run sends either, or any field of `output_config` but `effort`,
so the stand-in refuses a request that carries `tool_choice`, `speed` or
another field of `output_config` as unclassified, naming the field, and the
run fails. It does the same for a model it knows no minimum for, for an
effort sent with a model whose default effort it doesn't know, such as
Bedrock's, whose ids aren't the Anthropic API's, for an effort sent with Claude
Haiku 4.5, which takes none (its overview's "Default effort" is "Not
supported"), for an effort value the model doesn't take, naming the value,
and for a system that is
neither a string nor a list of blocks or tools that aren't a list of tools.
So a host change that starts sending one stops the runs, naming it, rather
than reading as a cache read the provider wouldn't give or, for an effort
value the effort page doesn't give the model, as answered.

A body any codec throws on, reading, recording or answering it, is refused
the same way, its reason naming the exception ("the stand-in couldn't read
it: TypeError: …"), and the stand-in goes on serving: check 1 flags it, so a
gap in a codec shows in the run's record rather than ending the
invocation.

The stand-in also serves Amazon Bedrock's InvokeModel and
InvokeModelWithResponseStream, which membrane's `BedrockAdapter` sends to
`${baseURL}/model/{id}/invoke` and `…/invoke-with-response-stream`, for P3.
For a Claude model Bedrock's body is the Messages API's, with
`anthropic_version` and the betas (`anthropic_beta`) in it and the model and
the streaming in the path, so a front (`bedrock.ts`) reads it as the Messages
body it is and answers through the Messages codec: its `read` gives the core
the body with the path's `model` and `stream`, which every other member takes.
A body that names a model or streaming of its own is refused as unclassified,
and recorded as it came, with the path's model only where it names none.
It knows one model, by the id in the path: `us.anthropic.claude-opus-4-6-v1`,
the US geo inference id AWS's Claude Opus 4.6 model card gives, with the card's
explicit caching (a 4,096-token minimum, 4 checkpoints, 5-minute and 1-hour
lifetimes) and no implicit caching
(https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-6.html,
read Nov 7 2026), so the Messages codec's cache rule prices it with that
minimum. It refuses what AWS documents Bedrock refusing: a body without
`anthropic_version` `bedrock-2023-05-31`, which the Claude Messages page calls
required, and a top-level `cache_control`, which the prompt-caching guide says
a model without automatic caching refuses, Opus 4.6 among them, in the
stand-in's own words. An error is Bedrock's exception, named in
`x-amzn-ErrorType` with its status from the InvokeModel references
(`ValidationException` 400, `AccessDeniedException` 403,
`ResourceNotFoundException` 404, `ModelTimeoutException` 408,
`ModelErrorException` 424, `ThrottlingException` 429,
`InternalServerException` 500 and `ServiceUnavailableException` 503, the
stand-in's pick where a status has more than one), and a body
`{"message": …}` of the stand-in's own. A scripted status the references give
no exception for goes as a `ValidationException` 400 below 500 and an
`InternalServerException` 500 from 500 up. The references tie no exception to an
overloaded model, so answering a scripted overload as
`ServiceUnavailableException` 503 is the stand-in's choice, and membrane, which
takes only a 529 as an overload, reads it as a server error. A prompt past
the window says "Input is too long for requested model.", Bedrock's words as
membrane quotes them, which membrane reads as context length. A stream is
AWS's event stream encoding, with the header lengths' sizes membrane's reader
takes, since AWS's page gives them only in a diagram: each message a `chunk`
event whose CRCs hold and whose `bytes` are one of the Messages API's stream
events, which is how membrane reads them; AWS's pages don't show a Claude
stream's events. The record's head names `api messages` and `dialect bedrock`,
the model from the path, the version and betas under `headers`, and the path;
the request's own headers are AWS's signing, which it leaves out.

The stand-in also serves OpenAI's Responses API, a POST to a path ending
`/responses`, for a model whose limits and prompt cache it knows: today
`gpt-6.1-sol`, with its model page's 128,000 output tokens
(https://developers.openai.com/api/docs/models/gpt-6.1-sol), taken as the
output limit where a request names none. P1's run sends them. It reads each
input item into the same view the Messages API's requests give its scripted
answers: a user, assistant, developer or system message by its role, the
developer and system ones joining the instructions; a `function_call` as a
call and a `function_call_output` as its result; a `reasoning` item as
redacted thinking where it carries `encrypted_content`; and a `compaction`
item as its own block. Consecutive items on one side are one message of the
view, so a script written for one API answers the other. It refuses as
unclassified, naming why, a request that asks for state it doesn't keep
(`previous_response_id`, `conversation`, `prompt`, `background`),
`truncation: auto`, explicit cache breakpoints, a cache lifetime other than
`"30m"` (`prompt_cache_options.ttl`, such as `"12h"`: its cache models the
default 30 minutes alone), an input item of another type, a message of
another role, or whose content is neither a string nor a list, a message or
tool output holding a content part of a type other than text, refusal or
image (kept whole in the view where it sits in a user or assistant message or
a tool output, so its transcript shows it), instructions that aren't a
string, tools that aren't a list of tools, an input with no item but
developer or system messages (a tool output is the user's side), or a model
it doesn't know. The record holds one message per input item, each
with its own digest, and its head names `api responses`, the instructions as a
template, the tools, `max_output_tokens`, `reasoning`, `include`, `store` and
`service_tier`, and the rest of the body as its text. A request whose input
passes the window is refused with a 400 `invalid_request_error`, code
`context_length_exceeded`, which membrane reads as a context-length error; the
API reference says only that such a request "will fail with a 400 error"
(`truncation`, https://developers.openai.com/api/reference/resources/responses/methods/create),
so the code and wording are the stand-in's. An overloaded error a script gives
in the Messages API's name goes as the error-codes guide's 503
`service_unavailable_error`, code `server_is_overloaded`
(https://developers.openai.com/api/docs/guides/error-codes).

Its reasoning is returned as `encrypted_content` the stand-in mints from the
thinking text: the text, and a digest of it, with no summary, whatever
`reasoning.summary` asks. The reasoning guide documents no
refusal of an item sent back changed
(https://developers.openai.com/api/docs/guides/reasoning), so none is sent:
the record's block for a reasoning item says, as `sealed`, whether its content
is the stand-in's own. A streamed answer's events for a text message follow
the "Streaming" example of the API reference cited above. The refusal and function-call-argument events appear
in the streaming guide only by name, and `response.incomplete`, which ends a
reply cut at its limit, in neither, so their fields are the stand-in's own,
shaped as membrane 0.8.0's adapter reads a stream: each item whole from
`response.output_item.done`, a call's arguments from
`response.function_call_arguments.delta`, and `response.incomplete` as a
terminal response like `response.completed`. Under `reasoning.context:
current_turn`, a request's reasoning items before its last user message aren't
rendered, in its tokens or its prompt cache, since the service "does not
render reasoning from earlier turns into the next sample" (the reasoning
guide); that a turn begins at the last user message is the stand-in's own
reading, since the guide doesn't say where one begins. A request whose `context_management` sets a
`compact_threshold`, once its tokens by the stand-in's count reach it, gets a `compaction` item ahead of its answer, with a
digest of the input as its encrypted content, as the compaction guide says the
server emits one when "the rendered token count crosses the configured
threshold" (https://developers.openai.com/api/docs/guides/compaction). A
request that carries a compaction item is rendered from the latest one: the
items before it count for nothing in its tokens, its prompt cache, its window
or its threshold. That is the stand-in's reading of the compaction guide's
"prunes context before continuing inference" and "The latest compaction item
carries the necessary context", and of the prompt-caching guide's
`context_management`, which "Replaces earlier conversation content with a
compacted context"; the guides say such items may be dropped, not that the
server ignores them when they're sent, and nothing has checked it against the
API. It prices the prompt cache by the prompt-caching guide's rules for
GPT-5.6 and later
(https://developers.openai.com/api/docs/guides/prompt-caching): reading the
model and the settings the guide says can change the prefix
(`parallel_tool_calls`, `text.format`, `reasoning.effort` and
`text.verbosity`, each as sent), then tools, then instructions, then the
input as rendered, it writes the prefix ending at the latest
eligible message, a user message or the last of a run of tool outputs, when
that prefix is 1,024 tokens or more; it reads back the longest unexpired
prefix ending at that breakpoint or one of the 20 eligible endings before it,
exactly; a prefix lives 30 minutes, and a read keeps it at least 30 minutes
from then. Usage is the API's own: `input_tokens` counts every input token,
with `cached_tokens` and `cache_write_tokens` inside it, and
`cache_write_tokens_details` breaks the writes into `ttl_30m_tokens` and
`ttl_12h_tokens`, both there when one is zero, as the guide says. Each record
also holds the totals every codec reports alike (fresh input, cache reads,
cache writes, output), which a run's token counts sum.

A POST to a path ending `/codex/responses` is the Responses API on ChatGPT's
Codex backend, which the host's `openai-codex` provider reaches through
`CODEX_BASE_URL`, as P2's run does with a fixture `CODEX_GATE_TOKEN`, so the
host runs no Codex CLI. It is read, recorded and answered as above, under
`api codex`, but for what the backend does differently. It renders a request
as it does one to the API above, from the latest compaction item and under
its reasoning context, by the stand-in's own assumption that the backend
renders as the API does. The backend is
undocumented, so each rule names where it was seen:

- It refuses, with a 400 `invalid_request_error` naming the field, what a probe
  of every field found it refusing (orca-router's `usage.md`, "Codex
  compatibility caveats", May 4, 2026): `background`, `conversation`,
  `max_tool_calls`, `metadata`, `previous_response_id`, `prompt`,
  `safety_identifier`, `stream_options`, `temperature`, `top_logprobs`,
  `top_p`, `truncation` and `user`; a string `input`; a `service_tier` other
  than `priority`; and the tool types that probe
  found refused. That list is a capture, not a recheck, and two of its
  refusals have since gone: `max_output_tokens` was taken when rechecked on
  October 31, and a request with no `instructions` on November 7 (asking
  gpt-6.1-terra, with no `include`, `tools`, `service_tier` or
  `prompt_cache_key` in it), so the stand-in answers both. membrane's
  subscription mode drops `temperature`, `top_p` and any service tier but
  `priority`; a change that sent one of these would fail the resident's turn
  in P2 as it would live.
- It refuses as unclassified an unstreamed request, since membrane's
  subscription mode always streams, and one carrying `context_management` or a
  prompt cache setting, which it has no model of on this backend. The host
  never sends `context_management` there. So too a request whose `store`
  isn't false: `usage.md` records no answer of the backend's to one, only
  orca-router's own refusal of it (`providers.contract`, PVR-004), a rule of
  that router's rather than the backend's. membrane 0.8.0 sends `store: false`
  on every request.
- Its usage reports cache reads in whole blocks of 128 tokens and no cache
  writes, as orca-router's usage log shows: of the 4,879 rows of its
  `usage_log` table with ids 5474903 to 5505970 (November 7, 2026, 06:55 to
  11:04 UTC) whose `provider` is `openai`, `status_code` 200 and
  `credential_id` null or not an API key's (not `openai-key-%`), the 4,855
  with a `cache_read_tokens` each hold a multiple of 128, and none has an
  `input_tokens_details.cache_write_tokens` above 0 in its `usage_json`,
  nor a `cache_write_tokens_details`, which the stand-in leaves out here too.
  Those are all that was seen of the backend's cache. The rest of the
  prompt cache is the one above, the API's, taken for the backend's by the
  stand-in's own assumption: which prefixes it writes and reads back, the
  1,024-token minimum, the 20 earlier endings and the 30-minute lifetime.
- Its `response.completed` carries an empty `output`, the items only in the
  stream's events, as the backend's comes with `output` empty or absent
  (orca-router's `providers.contract`, PVR-016, which gives no date of its
  own and is in the repository's first commit, of October 9, 2026), so
  membrane's rebuilding of a reply from those events runs; and every answer
  echoes `service_tier: "default"` whatever was asked (orca-router's
  `usage.md`, probes of July 23 and September 23, 2026), so fast mode's
  fallback notice runs too.
- An input past the window, and an overloaded error a script gives, come as a
  streamed `response.failed` with code `context_length_exceeded` or
  `server_is_overloaded`, the form in which OpenAI's own Codex client reads
  them (codex-rs at `67f0994b53`, `codex-api/src/sse/responses.rs` and
  `responses_error.rs`).
- membrane's subscription mode sends `prompt_cache_key` and a `session_id`
  header built from a random id for each adapter and a digest of the
  instructions and the first input item, so the record holds both by shape,
  numbered by first appearance in the run, `<uuid>:<12 hex>#N`. What seeds the
  answers masks the key by its shape alone, so its random draw moves no
  answer, though a request sending no key, or one of another shape, seeds
  differently.
- Its models are the Responses API's above. For gpt-6.1-sol the Codex
  client's catalog gives both `context_window` 272,000 and
  `max_context_window` 872,000 (codex-rs at `67f0994b53`,
  `models-manager/models.json`), and the client takes 272,000 as the window
  unless its configuration sets one, which it caps at 872,000
  (`models-manager/src/model_info.rs`, `with_config_overrides`). The
  stand-in refuses past P2's window, 872,000. Which limit the backend holds
  to isn't documented. orca-router's usage log shows it answering
  gpt-6.1-sol requests of up to 530,038 input tokens (row 668858, October 7,
  2026): the query above, for that model and over every id, finds 6,796
  above 272,000 by the backend's own `usage.input_tokens`. Above 530,038 the
  window is unverified.

The stand-in also serves the Chat Completions API, which membrane's
`OpenAICompatibleAdapter` and `OpenRouterAdapter` send to
`${baseURL}/chat/completions`, in three dialects, each read from its vendor's
documentation on Nov 7 2026 and each at its vendor's own path. P5's run sends
OpenAI's, and P4's OpenRouter's.
- **OpenAI's own**, at `/v1/chat/completions`
  (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
  for `gpt-5.6-sol`, whose model page lists Chat Completions and function
  calling and gives 128,000 output tokens
  (https://developers.openai.com/api/docs/models/gpt-5.6-sol). GPT-6.1 Sol's
  page says tool calling requires the Responses API, and GPT-6 Sol's allows it
  on Chat Completions only with `reasoning_effort: "none"`, so neither serves a
  resident, whose every request declares tools. The model reasons on every
  reply when its setup says it thinks, but the API sends no reasoning: its
  tokens count in `completion_tokens` and
  `completion_tokens_details.reasoning_tokens`. The prompt cache is the
  Responses API's, from the same guide, read over the tools and then the
  messages, a tool message ending an eligible message only as the last of a
  run of them, with a chain that starts from the model alone: the guide's
  settings that can change the prefix are Responses API fields, and it doesn't
  say whether their Chat Completions counterparts act alike. `prompt_tokens`
  counts every input token, with `cached_tokens`
  and `cache_write_tokens` inside it. A refusal is the API's `refusal` field,
  with no content, which membrane 0.8.0's adapter doesn't read, so such a
  reply reaches the host with no text. One the reply's limit cuts goes as
  content, with finish `length`, since the stand-in fits a reply to its limit
  before it chooses the field; OpenAI documents no cut refusal. A stream that asks for usage gets it
  in a last chunk of its own, with no choices.
- **DeepSeek's**, at `/chat/completions`
  (https://api-docs.deepseek.com/api/create-chat-completion), for
  `deepseek-flash`, whose reasoning comes as `reasoning_content`, the
  convention membrane's adapter reads as an alias of `reasoning`. It's served
  for the unit tests alone. Its thinking-mode guide says that for a request
  carrying tools, "the `reasoning_content` must be fully passed back to the
  API in all subsequent requests … If your code does not correctly pass back
  `reasoning_content`, the API will return a 400 error"
  (https://api-docs.deepseek.com/guides/thinking_mode), so the stand-in
  refuses such a request with a 400 in its own words. membrane 0.8.0 sends a
  prior turn's reasoning back as `reasoning`, so its second request in a
  conversation with tools is refused, and no run serves the
  dialect while that holds. Its cache is the context-caching guide's units
  at the end of a request's input and of its answer
  (https://api-docs.deepseek.com/guides/kv_cache), counted in
  `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; the guide's other
  two ways a unit persists aren't specified closely enough to model. Its
  usage comes on the last content chunk of a stream, as its reference says.
- **OpenRouter's**, at `/api/v1/chat/completions`, the path of membrane's
  `OpenRouterAdapter`'s default base URL, for `anthropic/claude-opus-4.6`,
  whose entry in OpenRouter's public model list gives 1,000,000 tokens of
  context and 128,000 of completion. P4's run sends it, through the host's
  `OPENROUTER_BASE_URL`, which connectome-host reads since its pull request
  #620. Under P4 the host's HTTPS proxy is the stand-in, which tunnels
  nothing and records a request to tunnel as unclassified, and the host
  inherits no other proxy. So a host that doesn't read the variable, and
  whose HTTPS client honours `HTTPS_PROXY` as Bun 1.4.4's fetch does, fails the run
  there rather than sending to openrouter.ai. Its caching guide says a Claude model caches by
  Anthropic's own rules, with `cache_control` on content blocks
  (https://openrouter.ai/docs/features/prompt-caching), so the stand-in prices
  such a request with the Messages codec's cache (`anthropicCache`, exported
  from `anthropic.ts`), over the Messages body the request is forwarded as.
  What OpenRouter forwards to Anthropic isn't documented, so that body is the
  stand-in's own map (`forwarded` in `chat.ts`): the system messages' parts,
  with their markers, as the system; each other message's blocks with theirs;
  calls as `tool_use` and tool messages as `tool_result`; consecutive messages
  on one side as one; and the tools by name. A marker is a text part's: its
  Chat Completions reference gives an image part none, so the stand-in refuses
  as unclassified a request that marks one. Usage is OpenRouter's:
  `prompt_tokens` with `cached_tokens` and `cache_write_tokens` among them,
  as its caching guide says ("`cache_write_tokens` counts prompt tokens written
  to the cache, and `cached_tokens` counts prompt tokens read from it"), in the
  fields its usage-accounting page gives. A reply's reasoning goes as the assistant
  message's `reasoning`, which membrane 0.8.0's adapter doesn't read. A stream
  opens with an `: OPENROUTER PROCESSING` comment and ends with a usage chunk
  that repeats the last chunk's finish reason, as its streaming page says. An
  error is `{error: {code, message, metadata: {error_type}}}`: a request past
  the window is a 400 `context_length_exceeded`, and an overloaded provider a
  503 `provider_overloaded`, from its errors page.

Every dialect reads each message into the same view as the other APIs: a
system or developer message joins the system prompt, a tool message is a
result on the user's side, and an assistant message's reasoning, under either
field, is a thinking block ahead of its text and calls. The record holds one
message per wire message, each with its own digest and its side; its head
names `api chat-completions` and the dialect, `max_tokens` and `max_completion_tokens`,
`tool_choice`, `reasoning_effort`, `thinking`, `stream_options` and the tools,
and the rest of the body as its text. A thinking block's record names the
field it came under and says, as `sealed`, whether its text is one the
stand-in sent: the stand-in ends each reasoning text it sends with a line that
seals it. It refuses as unclassified, naming why, a model it doesn't know, a
content part of a type it doesn't read, such as audio or a file (in a user or
assistant message or tool output, the view keeps the part whole, so the
transcript shows it), a message whose content is neither text nor a list of
parts, tools that aren't a list of objects, more than one choice,
explicit cache breakpoints, a cache lifetime other than
`"30m"` (the reference: "currently the only supported value"), a
prefix completion, a message of another role, or messages with none but
system or developer ones (a `tool` message is the user's side). A request
whose input passes the window is refused with a 400 membrane reads as a
context-length error, in the stand-in's own words, since neither vendor
documents them; an overloaded error goes as OpenAI's 503
`service_unavailable_error`, code `server_is_overloaded`, which DeepSeek's
error-codes page gives the status of and no body for.

The stand-in prices text at its own rates, prose at 2.2 characters a token and
denser text at fewer, about 1.3 times context-manager 0.24.0's own estimate of
2.9 and 2.3 (`message-store.ts`), so context-manager's calibration has a gap to
close. It binds a signed thinking block to the system prompt, the tools, the
model, the body's other fields but `stream` and `metadata`, and the messages
before it, cache markers aside (`bindingIdentity`). The workloads size what
they send by the host's own limits: a document is several times the host's
default message cap of 10,000 tokens (`framework-strategy.ts`), so it's stored
in shards, and a large reply stays within the host's default reply ceiling of
16,384 tokens (`recipe-fit.ts`) at the stand-in's prose rate. An agent turns
the tool-result guard on with `toolsets--open` on its settings, then
`agent_settings`. While the stand-in holds a subagent's reply, the driver waits
for compression to go idle by maintenance passes rather than a settle, since
the turn whose request is held keeps the host from draining. A script holds a
turn at one of two places to make something arrive while it's alive: a reply
marked `hold`, which the stand-in holds, or a call whose input carries `hold`,
which the fixture's MCPL server holds. Either lists the acts the driver does,
in order, before it releases the hold (`during`): `deliver` a channel message,
then wait for the host's `admission:decided` for it and, after that, a
`message:added` from `mcpl:channel-incoming`, a stored arrival from a channel,
which is the message delivered, since a hold's acts deliver one message at a
time and the trace names the stored row, not the channel's message; type a
message at the console (`console`), as a console step does, then wait until the
host has stored it as console input (`message:added` from `external-message`);
or wait for a subagent's end, until a result of its is stored for its launcher
since the step began (agent-framework's `dendrite:mail-delivered`, from the
agent connectome-host names `spawn-<name>-<stamp>`, its stamp a number, for a
subagent spawned as `<name>`), so an earlier step's subagent of the same name
doesn't answer it. A held call that lists no acts is never answered, as W6's
isn't, and agent-framework's request timeout ends it. A step can also hold a
summariser request: `summariserHold: { level, during }` has the stand-in hold
the first summariser request at `level` (1 when unset) that arrives while the
step is current, once, and answer it at its release with the shape it took when
it arrived, so a bad answer still queued then applies to it: the stand-in gives
a queued bad answer to the next summariser request, at any level, that isn't a
re-send or one the run refuses or rejects anyway, which in W18 is the held L1.
Its acts can name a message as `{ fromHeld: k }`, the k-th canary the held L1
request's slice carries (after context-manager's notice that opens the slice),
and can `remove` messages: the test module removes each through
agent-framework's `ModuleContext.removeMessage`, which removes it on the
store's own branch, as agent-framework's Discord module does on a delete, and
the driver waits for the module's answer to each.

The harness leans on this host's own behaviour in six more places. A recipe
that leaves the strategy unset gets autobiographical, adaptive and kv-unified
with the standard block (`framework-strategy.ts`), and on claude-opus-5-5 the
host passes agent-framework's `thinkingBinding` and the drop control
(anima-research/connectome-host#500). A binding configuration boots with the
host's binding probe off (`THINKING_BINDING_PROBE`), since the host shapes
requests alike for no probe outcome and for an account that refuses or drops a
changed block (`logging-adapter.ts` tells only `shows` apart). Every run boots
with `CONNECTOME_UPDATE_CHECK=0`, since otherwise the host reads npm's
registry for its update notice at start and once a day (`docs/DEPLOYMENTS.md`,
`update.ts`' `checksOn`): no run reaches outside the machine for it, and none
rests on what the registry answered. The notice goes to the host's log,
`/update`, the Web UI's banner and `/healthz`, by that doc, not to the agent.
`/budget` writes a header, then a line per agent, `  <name>: …`, which is how
the driver knows the report has ended. A maintenance pass names each agent it
reports by `agentName`, which is how a settle finds the run's own agent, and
returns at once while a compression the host's auto-tick started is in flight,
and no event marks that work's end, so a settle waits for the test module's
tick counts too. And the web UI, which W6, W9 and W15 open, is a WebSocket to `/ws`
on the URL the host logs (`[webui] listening on <url>`), whose welcome names
the session (`welcome.session.id`), which a session-changing message such as
`suppress` must carry.

A store read the test module couldn't make is a line of its own,
`unreadable messages: REASON`, `unreadable summaries: REASON` or
`unreadable receipt: REASON`. An agent that has left agent-framework's
registry, which deregisters an ephemeral agent at its run's end without
closing its manager, is read from the manager kept from its compiles, until
its compression ticks settle and while a take of it reads unreadable, so what
a take couldn't read is still reported once it can be.

A request's line, with the head in force for it, changes whenever what that
request sends changes, apart from what the record leaves out or writes alike
and the run-varying values it masks by their pattern in the messages, the
system prompt and the digests of the tools and the body's other fields, the
run's own text included (an image-ref nonce in any string there but a block's
cache marker, which it writes whole, while a marker on a tool, the body or a
message's own fields is masked inside its digest with the rest; a fork call's UUID, and a reminder id's four random
characters, in the system prompt and the digests, though a message's or summary's text the record writes from a
compile keeps them as they are; a draft id but `d-k7x3qm2` anywhere there; and the signature of any object typed
`thinking`), a change to one of which alone moves no line.
The head's other fields, the model, `max_tokens`, `tool_choice`, `thinking`,
the tools' names, the headers, the path and the query, it writes unmasked,
and no run puts such a value in them. It leaves
out every header but `anthropic-beta` and `anthropic-version`, and keeps the
betas as a set, so their order and repeats move nothing. It writes alike an
omitted or null `system`, an empty list, and any other value that is neither a
string nor a list, while a string, the empty one included, is one text block;
an omitted, null or empty `tools`; a system prompt sent as a string and
as one text block, a system block's null or missing text and an empty one,
and its null or missing `type`; an omitted `thinking` and a null one; any
`stream` but `true` and none; a block's ephemeral cache marker with no TTL and
one of `5m`, though on a tool, the body or a message's own fields, where it is
part of a digest, the two differ; and a message's string
content and one text block, and its null or missing content, or any that is
neither a string nor a list, and an empty list. It writes alike an omitted and
a null `model`, an omitted and a null `max_tokens`, and an omitted, null or
empty `messages`, each of which the stand-in refuses. A `tool_choice`, even a null one, is refused as
unclassified, as above, and the head writes a null one as none. A head is named only on the
first line of its agent's under it, so a later request under a changed head
keeps its line, and the view still names it.

A line can also change when nothing its request sends does. Its delta is from
its agent's previous compile of the same kind, so a change to that compile
moves it too. A summary is named by the messages context-manager's provenance
says it covers, so a change to that provenance renames it. And `^` lists
context-manager's own cache marks, so a mark moved between the compile and the
request's assembly moves the line, with the body hash unchanged. No change to
one text renames another, since each key comes from its own text. The record's
other lines record the store and the run: summaries written and removed, reads
that failed, actions, checkpoints and the end.

## What a run's requests cost

Each run the harness records is priced once it's judged, by the arm's own host;
its self-check drive and a checkpoint's build are priced nothing.
`lib/prices.ts` runs `bun -e` in the host's directory, importing its
`src/call-pricing.ts`, and hands its `priceCall` one call for each request the
stand-in answered with usage, the requests `run.json`'s `usage` sums. The call
comes from the record alone:
- the provider from `head.api` and `head.dialect`: `messages` is `anthropic`,
  or `bedrock` in Bedrock's dialect; `responses` is `openai-responses`; `codex`
  is `openai-codex`; `chat-completions` is `openrouter` in OpenRouter's dialect
  and `openai-compatible` in any other; any other API goes by its own name;
- the model from `head.model`, and the tier from `head.serviceTier`, the tier
  the request asked for, where it asked for one (on `responses` and `codex`),
  since the stand-in's answers echo none; an Anthropic call carries no tier or
  geography, since the stand-in's Anthropic usage reports neither, so it's
  priced as the host's ledger prices such a usage, at the standard tier and
  globally;
- the tokens from `tokens`, with the cache writes split by lifetime where the
  usage reports it (the Messages API's 5-minute and 1-hour writes, on
  Anthropic's API and Bedrock alike, and the Responses API's 30-minute and
  12-hour ones) and the rest unclassified. A request with an unclassified
  write gets no price on either API, and counts in `unpriced`.

The host gets 10 s to price a run, past which bun is killed and the run's
prices are unread. On the VPS, `bun -e` pricing H1/W1's 279 requests took
20–27 ms over 20 tries, and 2,790 requests 34–48 ms, at a load of 12 on 12
cores (Nov 9, 2026), so the bound is some 200 times the slowest; a host that
hangs there costs its run 10 s, under the longest run's seconds in
`stack.json`.

Each kind of `run.json`'s `usage` gains `cost`, in USD, and `unpriced`, and
the run's `prices.json` keeps the call the harness made for each request,
beside `priceCall`'s answer or `null`. Where the host can't price, because its
`src/call-pricing.ts` exports no `priceCall` or can't be loaded, bun exits
without answering or is killed at the bound, or `priceCall` answers something
other than a price or nothing, every price is `null`, `prices.json`'s `unread`
and `usage`'s `priceUnread` say why, and the run is otherwise as it was. bun
answers through a file, so nothing the host prints is read as its answer;
where it exits on its own without answering, the reason quotes its stderr, or
its stdout where there's none. A bun that prints more than the 1 MiB of each
that `spawnSync` keeps is killed, and the run's prices are unread unless it
had already answered. A bun ended by a signal the harness didn't send fails
the invocation, as any of the harness's child processes would (`AGENTS.md`,
exit codes). A price rests on the stand-in's token estimate, cache hits as the
script's pacing gives them and scripted replies, so it's no more a measurement
than the tokens are.

## The view of what changed

The record diff says that a request changed. The view, which `run.ts` writes
beside a head arm's record that differs from the base arm's, says what the resident received. A
request it shows is one whose line, read without its head note and with the
head in force for it, differs from the base arm's. A removed request
line (one carrying a body hash) identical to an added one elsewhere is a
request sent at another place. Within each hunk of the diff, an added
request line pairs with the removed one of its kind and agent it shares most
items with, among those written the same way, as a change or whole, while
any is left; a removed one left unpaired is a request the head no longer
sends. The pairing is the view's best reading; the record diff beside it is
what holds.

- **`summary.md`** has one row per run: its outcome (`pass`, its flags' count,
  `invalid`, or why it couldn't run, then the self-check's outcome where one
  ran), whether its record matched the base arm's, and for one that differs how many requests
  changed, then its counts. Those are, across every agent, the request compile
  calls made and refused (a refusal whose retry compiled counts as one of
  each), the requests to summarise messages and to merge summaries (as `run.json`'s `counts`, above), and the compression and merge quarantines entered during the run, each counted once per agent by its identity (a compression quarantine by its span's `chunkSourceHash`, so a chunk re-cut into a new span counts anew; a merge quarantine by its record's `key`). They're counted as the test module's takes of the store saw them, at each boot's ready, at each settle's end, after a reload's dry compile and at shutdown, so one that entered and cleared between two takes isn't counted. A kind is `unreadable` when any agent's read of it failed at any take, and both are `not reported` when no agent's strategy reports quarantines, as on a passthrough. Then the stored messages raw, summarised and left out at the last
  compile of the agent its checks judge (named in the row, H2's knowledge
  subagent for H2), the tokens sent (cached and uncached input), and the
  compile lines whose check 11 entries hold a breach or a part it couldn't
  judge; a compile it couldn't record isn't among them. `?` is a count the run
  couldn't give. Where anything isn't clean, the table is followed by where
  each run's report, record and view are in the evidence, then every flag of each flagged run. A missing product and a
  calibration edge, which a report counts apart from its flags, are in the
  run's `report.txt`.
- **`<run>/view.md`**, for each run whose record differs from the base arm's,
  has a section for each request whose record lines changed. Each section has
  its record line in its heading, cut at 200 characters (a changed line's
  moved items follow it whole, and a new or moved request's whole line is in
  the record diff), then, for an agent's request, the ledger of where each
  message of its turn's compile's view went (raw, raw with its body
  incomplete, under which summary, or left out: its one unit in
  context-manager's layout, so a message sent raw shows raw even where a
  summary sent also covers it, which check 11 flags), headed "As
  context-manager compiled it", since agent-framework can still drop a row after the compile,
  then the request's system prompt, tools and messages as the resident
  received them, read through the codec of the API its record's head names
  into the view the stand-in answers from, a request the stand-in refused
  included (its model, its output limit, `stream`, the other fields its API's
  head line gives, such as `tool_choice` and thinking on the Messages API or
  `reasoning` and `service_tier` on the Responses API, its headers, path and
  query, and `rest`, the text of every other body field, are in the record's
  head line, named by key on the first request's line under it). The system
  prompt shows as one text: the blocks it was sent in are in the record's
  lines, each with its cache marker and a digest of any other field it
  carries (`{HASH}`), so a change to such a field shows there as its digest
  moving, and its value in the raw body kept with the run. A body its codec can't
  read gets a line saying why in place of a transcript, with two gaps, each
  loud: a body that isn't JSON stops the view's writing, so the run couldn't
  run, and a request the stand-in kept no head for, since it couldn't read or
  record the body, gets a line naming no API ("couldn't be read as the null
  API"), where its record's reason names the exception. A transcript shows:
  - the stack's words, verbatim: the system prompt, each tool's definition,
    templates, notices and framing. The run's content is marked in messages
    alone. Run content a host put into the system prompt or a tool's
    description would show there verbatim, as stack words, while the record's
    head line still moves;
  - the run's own content, as its mark, its length and a short head, with
    `chars a–b of n` where only part of it went, thinking included. A stretch
    shorter than 32 characters is never taken as the run's, and one shorter
    than 47 may not be, since the index keeps a 32-character key every 16
    characters, so it shows verbatim whoever wrote it: a short reply, an image
    result's bare canary, or a heading context-manager split into a block of
    its own. A run span ends where the request's text stops matching the text
    the run generated, so if a stack text continues a cut run text with the
    very characters the run text goes on with, those characters show inside
    the span. A change there still shows, as a different span and the changed
    words;
  - on the Messages API, a message's fields besides its role and content,
    shown beside its role, and a block's fields besides those its line shows,
    shown beside its type, each masked as the message's digest masks it. On
    the Responses and Chat Completions APIs the view keeps each item's or
    message's side and content alone, consecutive ones on a side together,
    so its other fields show only as its digest moving in the record's
    lines, and in the raw body kept with the run. On the Messages API, a
    transcript of a request holding a result opens with the form nearly every
    result in the runs takes, content as a string with `is_error: false`. A
    result in that form is unmarked, and one departing from
    it says how, as `(content as blocks)` or `(no is_error)`, since the digest
    tells those forms apart and a mark on every line would show no change.
    The Responses and Chat Completions APIs' results carry no `is_error`, so
    their transcripts state no form, and a result says only how its content
    departs from a string;
  - a tool's definition already shown in that view is named again rather
    than repeated, and so is any other stack text of 200 characters or more;
    a shorter one always shows.
- **On GitHub,** the job's summary holds `summary.md`'s text and then as many
  views as fit within its 1 MiB, GitHub's limit for one step's summary
  ("Step isolation and limits" in its workflow commands reference), naming
  each one that didn't fit and where it is in the evidence the job keeps, or,
  where even those names wouldn't fit, saying how many didn't. Where
  `summary.md` itself is longer, the summary holds as much of it as fits and
  says how many flags it left out; every flag is in `summary.md` and in its
  run's `report.txt`. The evidence is what `--out` holds. An invocation
  appends to whatever the step's summary file already holds, as a view's
  second arm does after its first in one step, so it takes only what the file
  leaves of that 1 MiB, and adds nothing where even its notes wouldn't fit.
  A run that couldn't run shows no view there, and keeps none in `--out`,
  even one written before it failed.

## The differences as data

With `--against`, `entries.json` at `--out`'s root groups every difference between the two arms' records into entries, one per kind of difference, for the context view's reader. It's `[]` when no record differs. A run whose record differs has at least one place: two records that differ where no kind of difference is found, such as only in their order or a trailing newline, fail the run as couldn't run, "its differences couldn't be grouped", so a run never reads as differing with nothing to show. Each entry is `{id, describe, count, runs, places, examples}`:

- **`id`** is the first 12 hex of the sha256 of the entry's signature, so one kind of difference has the same id in every share's file.
- **The signature** is the kind of difference. For a record line, it's the line's kind (its first word) and, for a line that changed, the tokens it lost and the tokens it gained, each set with hex runs of 8 or more written `H`, digit runs `#` and canaries `C`, any trailing `…` dropped (the mark a token repeated in a row takes, though one the line itself ends a token with goes too), then sorted, each once. For a template or head text, it's the text's role and which arm alone has it. The role is its key less a final 12-hex digest, masked as tokens are, and with each run of hex letters and `#` that holds both, such as a memory id `m#add#` from `[[s:M56add800]]`, and a memory id of digits alone, `m#` or `memory-#` from `[[s:M12345678]]`, written `H`, so a fork's text names one role whatever its memory. A form line is a line too, placed at the step `forms`. A step only one arm recorded, one whose lines are in only one arm's record (a step that writes no lines, such as a WebUI suppress, has no section, so a step both arms ran reads so when only one wrote lines for it), and a changed header, are kinds of their own.
- **`describe`** says the kind in words, such as "`compile` lines whose `H p.C,` became `H L#(p.#), p.C`".
- **`places`** lists each `{run, step, digest}` it occurs at, in `RUNS` order and then the record's; `count` is how many, and `runs` which runs. `digest` is the first 12 hex of the sha256 of the place's two sides, filled as the examples' are, so two entries whose places are the same have the same text at every place, not only at the first. Each place stands for one difference and carries its own digest, so merging the shares' entries by `id` and sorting their places stably by their run's position in `RUNS`, and by nothing else, gives the same list whatever the split, with the first example's place first.
- **`examples`** has one `{run, step, before, after}` for each run the entry occurs in, at that run's first place, in `RUNS` order: its two sides, whole, the record line or text before and after, empty where one arm has none. A template's text has each `#` filled with the number its first use on that side names, unless that use names another count of numbers, when it's left as written. One per run lets whoever shows an entry take its example from whichever of its runs it chooses, such as the first run it could compare. Merging the shares' entries concatenates the examples and sorts them by their run's position in `RUNS`, as it does places; with one example per run, that order is unique, so the examples, like the places, come out the same whatever the split.

Within each step, lines are paired by the harness's longest-common-subsequence diff: in each stretch of lines that differ, a removed line pairs with the first unpaired added line of its kind, and the rest are in one arm only. A template or head text is never paired across the arms: its key is a digest of its own text, so two texts of one role may be two different texts, such as two summaries, and the grouping doesn't claim one became the other. Each is in one arm only, and the reader, not the grouping, says which correspond. Every differing line is in exactly one entry: two records whose one key names two texts, which only a collision of the keys' digests could give, fail the run at the grouping stage, as two records that differ with no difference found do.

## What each run's checks judge

Each run's `report.txt` lists its flags and the checks' counts. A flag, a note or a reason the record or the
summary shows cut short, such as a thrown error, a command's output or a long
list of names, has its whole text on the line under it, `  whole: …`; a run
that couldn't run has its reason there, whole the same way. Two reasons are
exceptions: a failed read's, of a store, a strategy or pins, shows its first
200 characters, with no whole in `report.txt`, though the run's `log.jsonl`
keeps the whole of the test module's own reads of a store's messages, its
summary listing, its receipt and its quarantine, and a self-check's that couldn't run is in the summary and the job's
log but not `report.txt`, with no whole where it was cut. A host's whole
output is each boot's `host-N.log`, in the run's directory, or in
`checkpoints/RUN/` for the drive that writes RUN's checkpoint; a failure that
shows the host's last lines names that file.

- **Check 1: every turn answers.** It flags a request the stand-in refused or
  couldn't classify, an inference that failed or was exhausted, an operator
  alert the host raised, a step that didn't settle, and a turn whose answer
  reached no channel. The driver waits for each turn's speech
  (`inference:speech`) to end in its agent's `inference:published_complete`,
  `mcpl:speech-route-failed` or `prose:drafts-held`, or in a `[delivered]`
  receipt (`message:added` from `delivery-receipt`), which is all that a turn
  that kept its speech private, or left it unrouted, writes, and whose trace
  names no agent, so the first receipt after the speech ends the wait only
  where no other agent's turn was alive from the speech to the receipt, and
  otherwise the run fails, saying the receipt can't be told apart; or in a
  bounce notice (`message:added` from `prose-bounce`), which is all that a
  private turn's bounced words write at agent-framework#190's head, where a
  bounce at `main` that holds a draft holds it first, and which names no
  agent either, so it ends the wait under the receipt's rule;
  a turn whose `inference:started` says `silent` it doesn't wait for, and
  logs as `kept`; speech nothing ends, such as whitespace alone, fails the run
  at the wait's bound. From connectome-host#555 on, headless traces
  `inference:speech` with `""` for a round that ended without tool calls and
  held no text, where a host before it traced none; such a frame isn't speech,
  so the driver waits for no end of it, and a step whose script has its turn
  speak waits on past it for a frame that spoke, since a rewind's or an
  `unstick`'s retry can still speak in the same step, and fails at the wait's
  bound, naming the wait, where none comes. A step marked
  `ends: 'unspoken'`, whose script ends its turn with no speech, such as one
  the model refuses that nothing retries, waits for the turn's
  `inference:completed` instead, settles, and fails the run if the turn spoke
  after all; one marked `ends: 'contained'`, a reply
  agent-framework's tool-wrapper guard contains, waits for the speech alone,
  since the guard sends, holds and receipts none of it. Under `conversations`
  a fork answers, and connectome-host's headless traces `inference:speech`
  for its primary agent alone (`headless.ts`), so the driver derives a fork's
  as headless does: a round of the fork's that completed after tokens, with
  no tool calls yielded since it started. A route failure flags unless the step that woke the
  turn is marked `addressed: false` and the host's reason says the turn had
  no locus, which agent-framework keeps in that reason for connectome-doctor
  to read (`channel-registry.ts`); drafts held for an `explicit-send` or a
  `bounced` prefix flag on any step, and those held for `no-destination`
  unless the step is marked so, but a step that names the reason its script
  has its speech held, `drafts: 'bounced'` or `drafts: 'no-destination'`, as
  W13's do under explicit and hybrid routing and under a lock to drafts, owns drafts
  held for that reason; and a request flags whenever an agent's
  count of receipts saying speech was "suppressed and NOT held as drafts"
  rises above its count in that agent's previous request, which the
  stand-in's record marks from the receipt's words as agent-framework 0.32.0
  and 0.33.0 write them. Those words give only the lost segments' count and
  the draft store's error, and the rest of a receipt needn't differ from
  another's, so check 1 can't tell two such receipts apart: a new one
  arriving in the request where an older one leaves the window isn't
  flagged. A workload marks a step `addressed: false`
  when no message it addressed to the resident wakes the turn: W12's timers,
  the reminder and the tick, the watched file's change, the ambient and
  judged batches, the review's notice and its console input. A step marked
  `failsPublish` scripts a reply whose post fails, one the fixture server
  refuses, as W16's does, or one the host won't publish into an inbound-only
  channel, as W13's turn moved to `w13-feed` does, so check 1 owns a route
  failure at that step other than one with no locus, which still flags
  there. A step a workload
  marks `mayFail` may fail by design: its failure and its context refusal are
  its workload's property to judge. Workloads mark the turns a budget cut
  can make fail: W8's and H4's reader's from the first cut through the two
  turns after the restore, which W8's property allows, and W11's from its cut
  to its restore. W16 marks the three turns it has fail so that
  agent-framework's breaker trips. A turn that starts after a failure at such
  a step, such as the breaker's retry, has its answer judged as a
  gate-started turn's is.
  A step marked `retries` meets a scripted error that
  agent-framework retries, so check 1 owns only that `inference:failed`, and
  the turn must still answer. Check 1 also flags a step that leaves a scripted
  reply unused, its agent's or its subagent's, since a run that doesn't use
  its script hasn't exercised what the script sets up, such as W9's fork. A
  step marked `mayFail` whose failure check 1 owns is exempt: its host
  refused before asking for the rest.
- **Check 2: declared products.** A continuation segment that declares a
  product exists to produce it, such as a merge, a request carrying both
  results with one an image, or a thinking-led call. Check 2 fails a segment
  that didn't. A configuration can declare no product for a segment, as one
  that doesn't summarise does for its merges, and check 2 then judges nothing
  there. P5 and P4 declare no thinking-call product, since neither OpenAI's
  Chat Completions nor membrane's OpenRouter adapter brings reasoning back,
  and declare tool-round's as both results with the image as membrane's text
  in its place (`imagesNotShown`), since a tool message there carries text
  only. H6, on the prefill formatter, declares its tool rounds' products in
  the transcript's XML (`xmlResults`, `xmlPlaceheld` and `xmlThoughtCalls`, with
  the stand-in's prefill reply above): both results with the image as a user
  message of its own right after its call's result, the three results, the
  image's placeholder in its call's result with no image sent, and
  a call literal thinking led with its result. A setup without adaptive
  resolution (C12h, C20h) declares no long message stored in parts, since
  context-manager stores one so only under adaptive resolution
  (`chunkIngressMessage`, `autobiographical.js`). C19h, whose merge threshold
  is 0, declares no merge: context-manager 0.25.0 queues an empty group there
  and refuses it, a record that keeps the group from being queued again
  (`mergeRecordStands`, #285), so nothing merges. A product that needs the final store,
  where the run has none, is counted beside the judged.
- **Check 3: budgets.** It holds each request the run's agent sent, as the
  stand-in received it, to the bound that governs it. Under `conversations`
  the run's agent is the one fork that answers, which the host makes at its
  channel's first message, after the boot's `/budget`, so the driver reads
  `/budget` again after each step, waiting for the fork's line, and a report
  from before the fork's first compile isn't held to list it; with no report
  after it that lists the fork, the check judges nothing for it, as below. The
  stand-in counts
  tokens by its own model, several percent from context-manager's estimate
  either way, so it holds requests to the provider's window; context-manager's
  own count against its budget is check 11's.
  - **A compiled request**, a turn's first or a stream restart's, is held to the
    model's window by the stand-in's count of its whole input.
  - **A continuation round** is held to agent-framework's stream bound by its
    stream's fresh input before it, the `input_tokens` summed from the turn's
    compiled request onward, as membrane sums its usage. On the Chat
    Completions API that's each round's whole `prompt_tokens`, since membrane's
    OpenAI-compatible adapter reads no cache count, so each round counts its
    cached prefix again, where an Anthropic run's rounds count only uncached
    input. On OpenRouter's
    dialect it's `prompt_tokens` less `cached_tokens`, which membrane's
    OpenRouter adapter reads as a cache-inclusive count, so check 3 reads the
    record's dialect to tell the two apart. A subagent's bound is
    the one its launch notice states.
  - **Where the host reports, for a binding model, that the agent's window and
    not its stream bound breaks its stream,** rounds aren't held to the stream
    bound, and the report's notes say so.
  - **A request answered with a provider error, or cut by its client before
    any answer, isn't judged,** and its retry or fresh call is.
  - **It can't judge** a request with no usage, a host report of a bound other
    than the one it holds, or an agent with requests and no compile line. Each
    is a flag of its own.
  - **Where a `/budget` report has no line for the run's agent,** or writes it
    in neither of the two forms the host writes, its budget and last use alone
    or followed by the window clause, which bound governs can't be read, so the
    check judges nothing and the run can't be compared. A subagent, launched
    after the boot's report, isn't looked for in it.
- **Check 4: coverage.** Every stored input and reply goes out in each request,
  raw or inside a summary sent, once for each stored row that carries its
  canary, and in order within its window: where
  the final store's window is presented (context-manager's `windowMode()`
  reads `'presented'`, as it does once the host first presents a row or
  takes one out of the window, read from the store itself, so a presented
  window that holds no row still counts), the order its rows entered that
  window (`ordinalOf`), and store order otherwise. A row that window doesn't
  hold has no ordinal, and isn't judged for order; the report counts such rows,
  each once whether it went out raw or under a summary, beside check 4's
  judged requests, and counts apart a canary no row the final store holds
  carries. A flag of either order names which it is
  (`window-order` or `store-order`).
  A row that quotes a message, as connectome-host's knowledge retrieval stores
  one after it ("## Retrieved Knowledge, for the message beginning" and its
  text), carries the message's canary too, so the canary is owed once for each
  row; `more-than-once` names a canary a request carries more often, with its
  count and its rows. Check 4 can't tell which row a canary that went out came
  from, so one carried at all isn't `not-reached`; check 11 judges each row the
  window holds, and none it reads `'out'`.
  A row a suppress rule hid, which agent-framework stamps
  `metadata.suppressed` and never renders (read-store's `suppressed`), is owed
  to no request; its suppression review is a row of its own and is owed.
  A block that carries both summaries and canaries is read in the order it
  carries them (its record's `marks`): on the Chat Completions API membrane
  joins a message's text blocks into one, so a summary and the reply after it
  can share a block.
  It applies where the run's store was read and holds a summary: a run that
  completed under a configuration that compresses (`judge.ts`), so not H3's
  passthrough runs. A store with no summaries is check 5's `no-summaries`
  flag, and checks 4 and 5 judge nothing of it, as in
  C3h/W7/fable-no-tools, which raises that flag at context-manager 0.24.0, since with a Fable-family compression model and no tools declared every L1 is deferred. A request
  whose own input the final store doesn't hold isn't judged, and the report's
  judged line counts those beside what it judged. A subagent's inputs carry
  canaries of their own rather than a step's `.in`, so a subagent request's
  own input is the newest stored message it carries, and a message stored
  after it isn't asked for. Of a primary agent request's own turn, it asks
  for the scripted replies answered before it by the canaries their own text carries: a reply
  of tool calls alone carries none, a scripted error or refusal is no reply,
  and the replies of a step the host contains (`ends: 'contained'`) are
  stored nowhere, so none of them is asked for. A spare reply, which the
  stand-in gives only once a step's scripted replies are used up, isn't
  asked for. A step the script gives no replies is asked for its replies by
  number.
  A summary context-manager 0.25.0's split-stitch
  rung made (its stored `stitched`) is its fold parts' texts joined, so it
  carries one summary mark per fold part: the first is its number, which
  carries its coverage, and each later one is one of its parts, which maps to
  it and adds nothing (`summaryMarks`, `read-store.ts`), where a
  summariser answer wrote that mark and the request carries it in the same
  block as the summary's number.
  A message the script delivers on a channel its tune-out holds (a step's
  `tunedOut`) isn't asked of the resident's requests, since agent-framework
  holds it from the resident's view. No workload's script ends a tune-out, so
  it isn't asked for through the run's end. Nor is a reply an operator's
  `/undo` took out of the resident's window asked of any request after it,
  where the script says what it took out (an undo step's `undoes`): under
  reader forks, the `/undo` before the fourth look takes out the third wake
  turn's note. One that goes out raw after it anyway is an `undone-sent`
  flag, so a `/undo` that stopped taking it out shows: a part of check 4 of
  its own, "undone replies" (`undoneSent`), which reads each request after
  the `/undo` on its own, whether or not a store was read. A script that says
  an `/undo` took a reply out, with no request after it, is a couldn't-judge
  flag.
  Under reader forks (`H4b`), each fork is shown in its framing what was held
  since the last look, and its view filter keeps the held rows themselves out
  of its compiles (agent-framework 0.33.0, `invokeReaderFork`). So a part of
  check 4 of its own, "held messages framed" (`heldFramed`), asks each held
  message of the requests at the step that delivered it that a reader fork
  owns (a sub-side request placed with a fork, as check 13 places it). A held
  message none of them carries is a `held-unframed` flag, and so is each held
  message of a step where no fork made a request. It judges one per held
  message, and applies wherever a step's reader is forks and it holds a
  message, whether or not a store was read. Where check 13 can't place the
  sub side, it judges nothing, which is a couldn't-judge flag. A persistent
  reader's view of held messages is check 11's, which owes them to its
  compiles.
- **Check 5: bookkeeping.** Every summary declares only sources its
  compression request showed: the inputs and replies it covers, or the
  summaries it merges. For a subagent, whose inputs and replies carry canaries
  of their own, every source it covers. For the primary agent, a summary of
  tool results alone holds nothing to its request, and isn't counted as
  judged; nor is a merge of such a summary when neither its number nor its
  sources' numbers were sent, since a merge can carry it as its sources raw.
  Where the store holds a summary a summariser request wrote and check 5
  judged none, that's a couldn't-judge flag. A summariser answer whose summary
  the final store doesn't hold, and a source nothing of which carries a canary
  to tell by, are counted beside the judged. A source the store read doesn't
  hold is a flag. A summary context-manager wrote with no summariser request,
  such as a quiet stretch's, carries no stand-in mark, so check 5 can't judge
  it, and the report's notes name it. A stitched summary is judged once, at
  its first fold part's request, against what all its fold parts' requests
  showed. A message its split left out as a placeholder is a source it
  declares on purpose, as context-manager designs it, and passes where its
  text carries the placeholder naming that message's id, the note
  context-manager writes: "one preserved message ... (message id N) was not
  summarized in this entry".
- **Check 6: windows raw.** Each request carries raw the two turns before its
  own, less what an operator suppressed before it, what an `/undo` the
  script says took it out (`undoes`) took out before it, and what the script's
  tune-out holds, as for check 4, and each segment's last
  request the head and the raw tail the host reported at its checkpoint. A
  message of those two turns that the final store doesn't hold isn't asked
  for, and the judged line counts those. A turn the script says
  agent-framework sheds, as its refusal rewind sheds W16's refused turn, owes
  its message to no later request. Of a turn, it asks for the scripted
  replies by the canaries their own text carries: a reply of tool calls alone
  carries none, a scripted error or refusal is no reply, and the replies of a
  step the host contains (`ends: 'contained'`) are stored nowhere, so none of
  them is asked for. A spare reply, which the stand-in gives only once a
  step's scripted replies are used up, isn't asked for. A step the script
  gives no replies is asked for its replies by number. With no final store read, as under
  H3, whose judge reads no store, a message that a `/branchto` scripted before
  the request rolled back isn't asked for either, and the judged line counts
  it as not judged. Each checkpoint tail judged counts
  as judged, and one whose last input the final store doesn't hold is counted
  beside. Judging none is a flag only for the primary agent's requests. For
  H2 it runs on the knowledge subagent's requests, which its checks judge, and
  judges none of them, since the subagent's store holds no turn the window
  asks for.
- **Check 10: calibration edge.** A calibration multiplier at the clamp's edge
  (0.6 or 1.8) makes the run invalid, since its folds are clamped. It reads
  the multipliers in the host's health panel, at each checkpoint and at the
  run's end, and applies to an adaptive configuration whose panel reports a
  context composition. A read that failed, the panel answering `ok: false`
  or naming a `contextComposition` read failure, is a couldn't-judge flag,
  and so is a completed adaptive run that logged no end-of-run read, read or
  skipped. A panel that reports none holds nothing it could
  judge: the host's panel gives an agent's composition from its last live
  compile, and context-manager keeps none after a branch switch until the
  next one. On a host whose `/undo` branches the store back, as
  connectome-host's did before its #485, H4/W1's `/undo` switches the resident's
  branch while it's tuned out, so its end panel reports none.
- **Check 11: compile invariants.** What the test module found wrong with each
  compile context-manager made, judged on what it sent against the store it
  compiled from, as it stands when the compile returns: the agent's own slot,
  and for an agent whose view merges another's, such as the Subconscious
  reader, the members of its view that slot holds. Each flag is named
  `agent:kind:invariant`.
  - **`coverage`:** where the strategy compresses, every stored shard goes out,
    raw or under a summary sent, and no stored message goes out under two. A
    body every stored shard of which context-manager's presented window reads
    `'undone'` or `'out'` at the compile (`windowStatusOf`), as an `/undo`
    leaves an agent's last turn until a redo or its next turn, agent-framework's
    shed leaves a turn it sheds, a row that arrived during a turn is until the
    turn's end or a tool boundary presents it, which a compile inside the
    agent's call (a fork's, or a dry one) meets, and a row taken out of the
    window without an undo is, is out of the view the compile read, and isn't
    owed a message. The invariant judges that a compile sends
    its window; when the window presents a row is checks 4's and 6's, for
    scripted inputs and replies, and the arrival rules'. No check judges a row
    with no scripted canary (a receipt, a notice), or one whose canary another
    row carries too (a retrieval row), that a window wrongly reads `'out'`, nor
    what a dry compile leaves out; a pull
    request that caused either shows in the view's difference between arms.
    A summary sent in more than one message counts once: context-manager's
    autobiographical strategy sends a summary as a recall pair, a question and
    its answer. A raw copy of a body holds a shard when it carries every shard,
    which context-manager says by not marking it `!shards`, or when it carries
    that shard's text. Text is matched among the shards context-manager's
    layout sends raw, where it names any of that body's, and a shard with no
    text is held by any raw copy of its body.
    Each message covers nothing earlier than the one before it, in order: for
    an agent whose window is presented (`windowMode()` reads `'presented'`),
    the order its rows entered that window (`ordinalOf`), since
    agent-framework presents a row that arrives during a turn only at the
    turn's end or at a tool boundary, after rows the turn stored after it;
    and store order otherwise. After a head-window reset the head, which
    starts at the newest topic transition, goes first and the history from
    before it follows. A message is placed by the earliest stored message it
    carries: a raw copy by
    the earliest shard whose text it holds, among those context-manager's
    layout sends raw, each occurrence of a shard's text taken once, in order,
    so a repeated copy takes its own; or, where it holds none, by the first of
    those shards if it is the body's one copy and carries every shard.
  - **`beside-sources`:** no stored message goes out raw beside a summary of it.
  - **`suppressed`:** a stored message a suppress rule hid, which agent-framework
    stamps `metadata.suppressed` and never renders, goes out neither raw nor
    under a summary, and isn't held to `coverage`.
  - **`tuned-out`:** in a compile of the script's own agent, the resident, or
    of one of its reader forks, a message the script delivered on a channel it
    had tuned out, which agent-framework leaves out of every resident's view
    while a persistent reader's keeps it (`residentViewFilter` and
    `subconsciousViewFilter`, `context-options.ts`), and which a fork, whose
    view filter is its resident's, is shown in its framing instead, goes out
    neither raw nor under a summary, and isn't held to `coverage`. All are told
    by the script, not by the code under test: the resident by the name the
    harness gives it, the fixture's agent, a fork by its name,
    `reader/<resident>/…` (`readerForkOf`), and each such message by the
    canary the script gave it and the author it sent it under, from the steps
    that deliver it (each step's `tunedOut`, which the driver hands the test
    module, with each message's author, as `FIXTURE_TUNED_OUT`). A stored row
    is that message where its text opens with the canary, or with that
    author's line, `<author>: `, and then the canary. So a fork's framing row,
    which quotes each held message after a header of its own, isn't it. A held
    message the host showed the resident or a fork is flagged whether or not
    it stamped it `metadata.tuneOut`, and a message it stamped that the script
    didn't tune out is owed as any other. A persistent reader, and any other
    agent, is owed every such message as any other row.
  - **`budget`:** a compile that enforces its budget sends no more than its
    input budget plus the strategy's grace, or refuses. A compile given no
    budget is held to context-manager's own default. A compile is judged on
    its own render stats, a dry one's included, never the manager's last live
    compile's. A compile whose strategy gives no render stats, such as
    passthrough, isn't judged for its budget: the report counts those
    compiles beside check 11's judged ones, by strategy, and so does the
    record's `totals` line.
  - **`shape`:** a call and its result that the store holds together aren't
    sent apart. A passthrough's promise is narrower: no request opens with a
    result whose call lies before its start.
  - **`thinking`:** a stored body's thinking goes out with its calls, or not at
    all.
  - **`pins`:** a summary sent over pinned messages is at a level the pin
    allows.
  - **Couldn't-judge flags,** which say what wasn't judged rather than that
    context-manager broke something:
    - **`unplaced`:** what the order couldn't place: a raw copy that holds
      none of its shards' text, where the body goes out in several messages or
      its one copy doesn't carry every shard; a copy of a body no
      slot read holds, or, for an agent whose window is presented, that its
      window doesn't hold; or a summary none of whose messages a slot read
      holds, or that window holds.
      The order is judged without it, and the report counts what it couldn't
      place beside check 11's judged compiles.
    - **`unreadable`:** a read an invariant needs failed, so that invariant
      wasn't judged, and the report counts it beside check 11's judged
      compiles as a read that failed. Two are judgements of what was read
      rather than failed reads, and aren't counted so: a compile whose
      strategy gives render stats gave none, and a pin names a message the
      compile's view doesn't hold.
  - **`unrecordable`:** the module couldn't record the compile at all.
- **Check 12: reloads.** At a restart with a reload check, the dry compile
  after the boot matches the one before the shutdown: the same outcome, the
  same messages from the same stored sources with the same content, the same
  system injections. Two dry compiles that refused alike show no compile on
  either side, so that reload is couldn't-judge.
- **Check 13: pairing.** Every request compile reached a request: the first of
  its agent's requests to arrive at the stand-in after it, before the agent
  compiled again. The module stamps each request compile as it hands it back,
  and the stand-in each request as it arrives, both from the machine's
  monotonic clock on Linux, so the order is what happened. Any other request
  is a round. This rests on one agent's requests going one at a time, and on
  where agent-framework 0.32.0 makes a request compile, one made through the
  agent's `compileWithInjections` or `compileContext`: only at a stream's
  start, a restart included (at the context budget, or the tool-result guard's
  retry), with a compile refused and repeated within one start counted once.
  A compile is the request's only while agent-framework's call that assembles
  the request is open; one that work the call started makes after the call
  settles isn't the request's.
  Nothing in agent-framework's or connectome-host's own code calls
  `compileContext` or the direct inference API. A request compile that didn't
  go out while the agent's stream still had a round to send would pair with
  that round, as a restart's compile does. It judges
  each agent that compiles, its subagents and readers included, with a count of
  its own. It can't judge an agent where a compile or request carries no
  stamp, as on another platform, or where a pair's request doesn't end on its
  compile's last canary, which a clock the two processes don't share would
  show. The stand-in tells the configuration's own agent's requests, and
  those of a subagent its script labels by the name it's spawned with
  (connectome-host's `spawn-<name>-<stamp>`), from the rest. Where several
  other agents compile, as reader forks do, each in a step of its own, a
  request of the rest belongs to the one of them that compiled in its step
  (`subOwners`), and each is judged on its own requests.
  Where the run's judged agent is one of them, the checks of its side read
  only the requests placed with it.
  Where two of them compile in one step, or a request of the rest comes in a
  step where none compiled, each gets a couldn't-judge flag instead, and the
  run's record isn't written. Each of these judges nothing of that agent, so
  the run doesn't measure.
- **Check 14: the workload's own property,** which `workloads.ts` states for
  each workload. A property either counts what it judged or names the check
  that judges it, and is then held to that check's count. A completed run
  whose property does neither, or names a check that judged nothing, is a
  couldn't-judge flag. The continuation names check 2, W7's variants but
  merges-refused and chunk-refused check 1, which flags every alert not
  owned, and W9 check 12. W7's
  chunk-refused puts a mark in its third turn's message, and the stand-in
  refuses every summariser request that carries the mark, wherever it sits:
  its system prompt, its tools, or any block of any message.
  The property judges each such request, those the stand-in refuses for
  another reason first included: an L1 request may carry it only in its
  messages after context-manager's notice that opens the slice to remember,
  and a merge not at all. context-manager sends that notice once, and a
  slice may quote it, so an L1 request that carries the mark in its messages
  with no notice, or with more than one, can't be judged, and the run can't be
  compared. One that carries it outside them is ahead of the slice. As merges-refused does
  for its merges, it also takes
  check 1's off-path refusal alerts and holds each step to one per refused
  request. W5
  takes each body from every messages read, so a body removed before the
  run's last read is still judged in the requests that sent it. W4 judges
  each of its own calls: its script gives each reply one call with its
  thinking ahead of it, and membrane merges two replies left adjacent, as
  when the result between them and the second's thinking are both dropped,
  into one message, so each call needs a thinking block between the call
  before it and itself. W11 judges each pin it adds, the first included, by
  the panel's list after it: exactly one new pin, and none of the earlier
  ones gone. W13 judges each turn's fate from what the requests after its
  first add to the window of the request before each, up to the next step's
  first request: W13's windows are never compressed, so they only grow, but
  the last message of the request before can gain blocks, as a row of the
  same role joins it, and lose its cache marker, so its blocks are compared by
  kind, size and marks, and every message before it by its digest. A turn's
  receipt is the first `[delivered]` row among them, which the stand-in's
  record reads into where the speech landed, what it held and what it kept
  in the transcript, and a turn whose fate is a refused post must have
  exactly one `[discord-send-failed]` row among them; a turn whose window
  isn't carried so can't be judged, and says so. W14 judges each arrival its setup scripts by the agent's
  requests: the first that carries its canary must be the one its point gives,
  the first after the held final request for one at a turn's end, and the
  first that carries the held call's result for one at a boundary, and must
  carry the final reply's canary or the result's, and the arrival after it,
  and, for one addressed from another channel, a `[routing]` notice after it,
  ahead of the next block that carries a canary, a notice that quotes a
  message not counting as one.
  It can't judge an arrival no request carries, or one the run's log doesn't
  show stored between its delivery and its hold's release: for a message, a
  `message:added` from `mcpl:channel-incoming`, taken as its own since a hold's
  acts deliver one message at a time; for a subagent's result, the end the
  driver logged. W15 judges the reader's requests, each of its reads by the
  canaries it carries: its read after `/restore` mustn't carry h2, stored
  between the checkpoint and the restore; its read
  after the restart must carry h2 and mustn't carry h3; none of its requests
  after the suppression may carry h1; and its read after the restart must
  start, at the first block that carries a canary, with the canary its read
  after `/restore` starts with. A read the reader didn't make can't be judged,
  nor can the suppression where the reader's last request before it doesn't
  carry h1, nor h3's absence after the restart where the read after `/restore`
  doesn't carry h3.
  W17 judges each step that names what it carries by the step's own
  requests: its first request's last message for the step's message and its
  notice, read by the notice's opening tag, and, for the call the step names
  as its result, the request after the one the stand-in answered with it,
  whose last message must hold a result with that call's id. A step with no
  request is a couldn't-judge flag.
  W17 also judges each arrival its holds script by W14's rule, a message
  typed at the console included: its sending must be followed by the host's
  storing it as console input (`message:added` from `external-message`)
  before the hold's release.
  W18 judges the removal its hold makes by every request the stand-in
  records after the removal lands: none may carry a removed canary, in an
  agent request's blocks or anywhere in a summariser request. A removal that
  didn't land before the held request's release, with no request after it,
  or with a request the stand-in recorded between the driver's `remove` send
  and its `remove` line, which may have been built before the removal or
  after, is a couldn't-judge flag, and the requests after the `remove` line
  are still judged. A step that logs more than one removal is a
  couldn't-judge flag too, since W18 judges a step's one removal.
  W19 judges each step whose round of words and a call fails past the round,
  named by its `w19` field (`{ call, round }`, the call's canary and the
  words'): the first agent request after the one the stand-in answered with
  the step's error must carry a `[speech-not-posted]` notice after the call's
  canary, read by its tag from the request's marks in order (`xmlMarks`, or a
  block's canaries when it has none), and no `inference:published` or
  `mcpl:speech-routed` text may carry the words' canary. A step with no request
  answered with an error, or none after it, is a couldn't-judge flag.
- **Check 15: binding control.** On a model that binds thinking and takes the
  drop control, every agent request to such a model carries
  `thinking.block_binding.prefix_mismatch_behavior: drop_block`, the host's
  own rule, and asks for the `thinking-binding-controls-2026-08-01` beta that
  control needs, which membrane adds whenever it sends `block_binding`.
  Without them an enforcing account refuses a request carrying a changed
  block.

Each check reports how many items it judged, on the report's `judged` line.
A count shown as `?` is one the check couldn't establish, and its own flag
says why. Where a check applies to a run and judged nothing, that's a
couldn't-judge flag, never a pass.

## Flags across the arms

With `--against`, each run's flags are compared with the base arm's, one for one: each flag the head raises is paired with a flag the base raises alike that isn't paired yet, where there is one, and its result in `run.json` lists the paired flags as `kept`, the head's left unpaired as `new` and the base's left unpaired as `gone`. So a `new` flag says the head raised it more times than the base, and a `gone` flag that the base raised it more times than the head, not that the other arm never raised it. Each is the flag's check, its step (`the run` for a run-level flag, a segment's name for a missing product), its kind (`what`, where it has one), its detail as the report shows it, cut where the report cuts it (its message, for a flag with no detail), and, where that was cut, `whole`, the first 12 hex of the sha256 of the whole text. Flags are compared by those five, counted one for one, so two flags that differ only past the cut are two flags, and a flag the head raises once more than the base is `new` once. A check 11 flag is compared by its detail, not its message, since its message names its compile by number, which a change earlier in the run can move. A check 10 clamp edge and check 2's missing products are compared as flags too, though the report counts them apart from its flags. With no `--against`, every flag is `new`. A run the base arm couldn't run, or the head couldn't, has no `flags`.

A flag both arms raise is the stack's before the change as much as after it, so it moves nothing: a known finding shows as `kept` until a change fixes it, when it shows as `gone`. A `gone` flag beside a `new` one at the same check and step usually means a flag's detail moved, such as a count or a message index that changed. Read the two details to tell a finding that moved from one that went and another that came.

A run that didn't measure is another matter, kept or not, since a base arm that didn't measure doesn't make the head's run a measurement. Each result lists in `unmeasured` how its run didn't: "the run failed", "its folds were clamped (check 10)", or "check N (NAME) judged nothing" for each check that applies to the run and judged nothing, a completed run's workload property among them whenever its count is 0, whether or not the property also says why. Its summary row says so after its outcome, as "didn't measure: …", each of the base arm's marked "(base arm)", and so does the invocation's output. With `--against`, `baseUnmeasured` lists the base arm's. A run with either list non-empty can't be compared, and the invocation exits 2. The same holds for a run whose `readsFailed` or `baseReadsFailed` names a failed read, said in its row as "a read failed: …", since a broken read on either arm shows as a difference between them, through a record line, a check 11 flag or an unknown count, and none of those is the change's. A run that stops the same way in both arms would otherwise give the same record up to the stop, and a kept flag, for a run that never reached the rest of its script.

## When the format changes

A change to what a record writes changes the records of both arms alike, so it adds no difference of its own to a view of a pull request, though it can change which of the pull request's differences a view can show; it updates this file in the same change.
