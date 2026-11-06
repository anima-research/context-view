# context-view

This repository holds the context view. For a pull request in context-manager, agent-framework, membrane or connectome-host, it shows what the change does to the requests a resident's host sends to the model. It runs the whole connectome-host against a stand-in for the model, once at the pull request's base and once with its head merged onto the base, and compares the two arms' records of every request. `CHECKS.md` says what is run and what each run checks.

In this file, "the house" is the Rookery, the household of AI agents that develops this repository and runs the view on its own machine, through its own GitHub App.

The pull request's code runs in the same job that writes those records, so what a view reports holds only if that code acts in good faith. A view isn't a security check.

## The parts, and where each runs

- **`harness/`** drives connectome-host through scripted runs, writes a record of every request, judges each run and compares two arms. It runs on GitHub's hosted runners, beside the pull request's code, and holds no credentials. It needs Linux, Node and Bun, as `harness/README.md` says.
- **`run/`** runs on the house's machine. For one pull request head it checks that the pull request can be viewed, starts the harness's jobs on GitHub's runners, and brings both arms' records home.
- **`view/`** runs on the house's machine, with the house's GitHub App credentials. It reads the records into one `view.json` and posts the comment, and its poll chooses which head is viewed next.

The house's context-view workflow, which runs these steps in order, and the model call that writes the comment's account live outside this repository, in the house's records. The workflow's tests are here, in `workflow/`, and read the workflow as committed at the git `HEAD` of those records: of `CONTEXT_VIEW_RECORDS`, or of `~/astra/data/records` without it.

A pull request's code runs only on GitHub's runners, never on the house's machine.

## What crosses between them

Only files, in the shapes the sections below give. `run/` writes `manifest.json` and brings home each share's records from the runners. `view/` reads the manifest, both arms' `run.json` from each share and the head arm's `entries.json`. `view/` imports nothing from `run/` or `harness/`. It checks every number it prints, treats a run whose outcome it doesn't know as not compared, fails the step on a file it can't read, and escapes the runner's text so GitHub makes nothing in it live, since those files were written on a runner beside the pull request's code. A change to a shape changes both sides in one commit here.

## Working here

- Work in a worktree of the house's working copy, not in a clone: the house's run guard refuses Node and Bun programs run from a clone of a GitHub repository outside `~/astra`.
- Changes go straight to `main`, after review, as fast-forwards; never force-push. Before running a commit fetched from GitHub that the house didn't push, read it.
- `bun run test` at the root runs every part's tests in turn, `run/`, then `harness/`, then `view/`, then `workflow/`, and stops at the first part that fails, naming it. Each part's own command is in its section, and `workflow/`'s is `bun test ./workflow`.
- **Releases.** A view runs the harness commit the house last installed, after its release review, so pushing to `main` changes no view. To try a harness change by hand, `run/` can run a branch's tip instead (below). `run/` and `view/` are installed by one promote from the repository root, each release in its own directory under `~/.local/lib/context-view/releases/`, with `current` naming the live one. The house's workflow resolves `current` once per view and runs every step from that release. Only this repository's promote prunes those releases, keeping any release an open view may still be reading, and any other pruner must keep the same releases. `view/` depends on the house's review-workflow at a pinned commit, so it builds only inside the house.

## harness/: the whole-host harness

`harness/run.mjs` drives a connectome-host checkout through the scripted runs in `harness/lib/strategies/workloads.mjs`, against a stand-in for Anthropic's API, and writes each run's record of every request the host sent. A view runs it on GitHub's runners, in the jobs `run/` starts. It needs no install of its own: it imports only Node's modules, and Bun's in the test module the host loads. No relative or `file:` import in it resolves outside `harness/`, which `harness/unit/imports.unit.mjs` holds. `CHECKS.md` says what the runs and checks are in plain words, and `harness/README.md` gives their exact rules.

**How it runs.** One invocation is one arm of one share:

```
node harness/run.mjs --host DIR [--overlay PACK.tgz,…] [--checkpoints DIR] [--shard I/N] [--against BASE] [--self-check] --out OUT
```

- `--host` is the connectome-host checkout to drive. `--overlay` lays packed packages over its install, for a package's pull request.
- The runs' starting conversations are built with the fixed host release `harness/stack.json` names, not the candidate, so both arms of a share start from the same stores. `--checkpoints` keeps them between invocations, so the head arm doesn't build them again.
- `--shard I/N` runs share I of N, split by `stack.json`'s seconds.
- `--against BASE` compares each run with the base arm's `OUT` in `BASE`. `--self-check` runs each run again with the test module's recording off, and compares the request bodies the stand-in received.
- **Exit codes:** `2` comes first, so a run that gives `2` makes the invocation's exit `2` whatever the others give.
  - `0` when every run's record is `same` as the base arm's, or `written` without `--against`, no flag is new or gone, and every self-check that ran is the same. Without `--against` every flag counts as new, so `0` there means no run raised one.
  - `1` when a record `differs` or is `missing` from the base arm, a flag is new or gone, or a self-check differs; also when a run's `report.txt` can't be written, which ends the invocation there as an uncaught error.
  - `2` when a run or its self-check couldn't run, a run didn't measure, a read failed on either arm, or the invocation stopped on its arguments or its setup, an install that failed included, before running anything.
  - A share that holds none of the runs asked for says so and exits `0`, writing nothing to `OUT`.

**`OUT/run.json`** is what `view/` reads of each arm:

- **Top-level fields:**
  - `lane`, a digest of `harness/lib/`, `harness/run.mjs`, and `harness/stack.json` less its `seconds`;
  - `runs`, the runs asked for, in order;
  - `runtime`;
  - `release`, the starting conversations' release, as `{tag, versions}`;
  - `candidate`, the installed candidate, as `{versions, overlays}`;
  - `seconds`;
  - `results`, one per run in the share.
- **Each result:**
  - `{run, outcome, reason?, record}`, where `outcome` is `pass`, `flags`, `invalid` or `couldnt-run`, and `record` is `same`, `differs`, `missing`, `written` or `null` when the run couldn't run;
  - `flags: {new, gone, kept}`, each a list of `{check, step, what?, detail?}`. With `--against`, these are set against the base arm's flags, and they're left out when the base has no record of the run. Without it, every flag is `new`;
  - for a run that ran:
    - `unmeasured` and `readsFailed`;
    - with `--against`, the base arm's `baseUnmeasured` and `baseReadsFailed`, and `baseReason` when the base couldn't run it;
    - `counts: {compiles, compressions, merges, quarantines}`, where `quarantines` is `{compression, merge}`, each a count or `'unreadable'`, or is `'not-reported'` when no compile reported one;
  - with `--self-check`, for a run that ran, `selfCheck`: `{outcome: 'same', requests}`, `{outcome: 'differs', at, files?, detail}` or `{outcome: 'couldnt-run', reason}`.

  A run with anything in `unmeasured` or `readsFailed`, on either arm, can't be compared.

**`OUT/entries.json`**, written with `--against`, is the head arm's differences from the base, grouped. It's a list of entries:
- `id`, a hash of the difference's kind;
- `describe`;
- `count`;
- `runs`;
- `places`, each `{run, step, digest}`;
- `examples`, one `{run, step, before, after}` for each run the entry is in, with `before` and `after` as the records' lines, their templates filled in.

`view/` merges the shares' entries in `RUNS` order.

**Tests:**

```
npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm --prefix harness test
```

The `ci` installs context-manager for `readStore`'s one test. `harness/unit/checks-md.unit.mjs` holds `CHECKS.md`'s runs, setups, workloads, variants and numbered checks equal to the code's.

## run/: the run side

`run/context-view-run.ts` runs one pull request's view on GitHub's hosted runners and brings the records home. It runs on the house's machine, from the install, and judges nothing: the harness's head-arm `run.json` holds the comparison.

```
bun run/context-view-run.ts --repo REPO --pr N --head SHA40 --out DIR
```

`REPO` is one of `context-manager`, `agent-framework`, `membrane` or `connectome-host`.

**Before any job,** it reads the pull request, its base tip and head (into a mirror under `~/.local/state/context-view/mirrors/`), the host's `main` for a candidate the harness overlays onto the host (a connectome-host pull request's host is its own base), and the harness release named in `~/.local/state/context-view/harness` (or, to try a harness change by hand, the tip of the branch `CONTEXT_VIEW_HARNESS_REF` names). It runs nothing, and exits 3, when:
- `closed`: the pull request isn't open;
- `moved`: its head isn't `--head`;
- `doesnt-merge`: the head conflicts with the base tip;
- `needs-companion`: for a candidate the harness overlays onto the host, either an arm asks for an `@animalabs/*` package the host holds at a range the host's version doesn't meet, or a package in the host's lockfile asks for the candidate at a range an arm's version doesn't meet. A spec that isn't a plain semver range (an alias, a git or file spec, a dist-tag) never meets. The harness would refuse that overlay only after the jobs had run.

**Otherwise** it starts 12 jobs through on-gh at the harness release, each running the harness on its share of the runs, `--shard i/12`, which the harness balances by `stack.json`'s seconds. Each job builds the base arm and the head arm (merged onto the base), runs the harness on the base and then on the head against it, and brings each arm's `run.json`, `summary.md`, records, reports and logs home, with the head arm's `entries.json`, which only the run against the base writes, under on-gh's size bounds.

**It writes `DIR/manifest.json`:** `repo`, `number`, `head`, `form`, `base`, `host`, `harness` (`{repo, sha}`), `outcome`, `detail` and `shares`, with each job's arms in `DIR/share-<i>/{before,after}/`. A run that ran no job writes what its reads reached, with `shares: []`. A run removes what an earlier run left in `DIR` before it starts.

**Exit codes and outcomes** (defined once in `run/interfaces.ts`):
- `0` `ran`: every job came home with both arms.
- `2` `couldnt-run`: a job failed (its setup, merge or install, its command, on-gh, or its evidence not coming home), the run side failed, it was stopped, or no harness release on this repository's `main` is named. `detail` is `{share, why}` for a job's failure, with `headNow` or `state` when the pull request moved or closed meanwhile without explaining it; `{why}` when no harness release is named, the one named isn't a commit on this repository's `main`, or the run side failed before any job; and `{why, shares}` after a stop, `shares` listing the jobs whose evidence isn't home. A usage error exits 2 with no manifest.
- `3` `arm-missing`: a job came home without an arm's `run.json`, or with the arm's harness killed by a signal. `detail` is `{share, arm, log}`, `log` being the arm's last log line, which the head's own code could have written. Also `3` for `closed`, `moved`, `doesnt-merge` and `needs-companion`.

**After the jobs** it reads the pull request again. A run whose only failures are head checks explained by a push or a close becomes `moved` (with `headNow`) or `closed`. Any other failure stays `couldnt-run`.

**A stop** (SIGTERM or SIGINT) asks GitHub to cancel every job still running whose run on-gh has named, then writes `couldnt-run` with the shares whose evidence isn't home. The caller owns the deadline. Each job's own limit is on-gh's, 350 minutes, under GitHub's six hours for a job.

**The harness release.** `~/.local/state/context-view/harness` names the commit every view's jobs run. `run/install-harness.ts C --go D` is its only writer: it refuses a C that isn't on this repository's `main` on GitHub, asks the release gate to install `context-view-harness` at C, and writes C only once that passes. When the release that file names isn't a commit on `main`, a run starts no job and says so, as `couldnt-run`.

## view/: the view's steps and its poll

`view/view.py` turns a run's records into the pull request's comment, and `view/poll.py` picks the next head to view. Both run on the house's machine, from the install, with the GitHub App's credentials. Their GitHub calls, the App's token and the escaping of an author's text come from review-workflow, pinned to one commit in `view/uv.lock`. Moving that pin is a change here, read like any other.

**The steps.** Each step reads one JSON object on stdin and prints one on its last line of stdout:

```
view/.venv/bin/python -I -m view STEP < input.json
```

- `facts` `{dir, repo}`: reads `DIR/manifest.json`, as the run side wrote it, each share's `run.json` for both arms and its head arm's entries, and the pull request's title and description from GitHub. It writes `DIR/view.json`, the one file the reader, its check and `post` read. It refuses a manifest whose `harness` isn't this repository at a full commit, unless the run stopped as `moved` or `closed`, when nothing posts.
- `post` `{dir, reader?, reads?, post?}`: posts the view's comment, one per head, in as many parts as GitHub's 65,536-character limit takes. Every word in it is fixed in `view.py`, taken from the run's manifest and records, or a head GitHub names (the pull request's head now, and the head a kept comment was first posted at), apart from the reader's account. The paragraph after its first line links `CHECKS.md` at the harness commit the view used. A later head with the same result keeps the comment and edits its first line. A posting that fails partway deletes the parts of its comment the pull request then lists, and says what became of them, a delete GitHub refused included. With `post: false` it posts nothing and writes the comment beside `view.json`. It posts nothing for a `closed` or `moved` view.
- `stopped` `{repo, number, head, post?}`: posts the stopped words for a head whose run failed: one line saying the view stopped, and a link to `CHECKS.md` on `main`. It posts nothing if a whole view of that head is already there, or if the head has moved or the pull request has closed.
- `rooms` `{}`: the rooms, each with its tender, where the workflow says what isn't for GitHub, such as a reader its provider refused.

**Exit codes:** `0` with the answer on the last line. `1` with why on stderr's last line, cut at its end to 1,500 characters, since the workflow keeps a step's last 1,500 characters of stderr. `2` for a repository the App is installed on that the view doesn't cover, and for a command line that names no step; a repository the App isn't installed on fails at its token, with exit 1.

**Run them from the install.** When its module is in the main working copy, `~/astra/context-view`, that copy's own `.venv` included, a step's command line refuses with exit 1 and the poll's with exit 2, each naming its installed form, since what they'd run there is whatever the copy holds, not the reviewed release. Another Python stops before anything acts too: at an import it can't satisfy, or, if it has review-workflow's modules, at that same refusal. A worktree outside the copy runs its own code.

**The poll** is a Jobs job's condition:

```
view/.venv/bin/python -I -m poll --job
```

- **What it prints:** at most one line, `{"key", "args"}`, while no view's run is unsettled when it lists them: again the line it printed before, while Jobs hasn't taken it and its head still waits, or else one for the open pull request head that has waited longest. The listing isn't a lock, so a view started by hand between it and Jobs' start runs beside the one Jobs starts. `args` is `{repo, number, head}`, the step input the workflow starts with.
- **Which heads:** while its pull request stays open, never a head it had when the poll first saw its repository, so such a pull request gets its first view at its next push, and never one whose view has run, an ask's view included. A pull request that a pass finds closed is new to the poll if it reopens, so its head gets a view, unless the workflows store still holds a run of that head's view (it clears a settled run a week after it settles). A draft waits until it's marked ready.
- **Exits:** `0` with a line, `1` with none, `2` on a failure, said on stderr.
- **State:** `~/.local/state/context-view/poll.json`, under its own lock. Jobs' cursor says which line it took.
- **Without `--job`,** as when it's run by hand to check it, a pass prints what it would and changes nothing: it keeps no line, queue or `seen`, gives no cursor and puts no 👀 on a comment. A line is out only because a job will take it, so only a job's pass puts one out.

**Its asks step** is another job's condition, a view of a pull request asked for by a comment:

```
view/.venv/bin/python -I -m poll asks --job
```

- **An ask:** a comment on a pull request in a covered repository whose text, leading blank lines aside, starts with a line holding `/context-deltas` alone, by an account in `poll.py`'s `ASKERS` that GitHub gives write access, and not the App's own. A repository's first pass starts from then, so no comment before it asks. A permission GitHub doesn't answer fails the pass, so the comment is read again.
- **What it prints:** the same line as the views' poll, under the same one-view-at-a-time rule, for each ask in the order the asks were made: `args` is the pull request's head as GitHub gives it in the pass that prints the line, and the key is that head's view key with `:ask-<comment id>` after it, so an earlier view of that head doesn't stand in for the ask. A newer ask on a pull request takes the place of one still queued there, and of its line where that's out and not yet taken.
- **👀:** each ask queued gets it, meaning a view is coming, unless GitHub refuses it, which is said on stderr. An ask leaves the queue once Jobs takes its line. A start that fails leaves Jobs' cursor where it was, so the line prints again.
- **An ask that waits or goes:** one whose repository a pass doesn't list, or whose pull request GitHub doesn't answer for, waits, said on stderr, and the next ask prints in its place. One whose pull request is closed, or that GitHub has no pull request for, is said on stderr and gets no view. A push before its view's runs finish ends the view as `moved`, posting nothing; one after them still posts the view of the head its line named, saying the pull request's head has since moved. Asking again views the new head.
- **Both steps:** a line either step has printed holds the other step until a run under its key shows in the workflows store, so one view at a time holds across the two jobs. A paused job's line holds the other step until the job resumes and takes it.
- **Why no step keeps a line Jobs took:** that line's run is already in the store. Jobs adopts a condition's cursor only once its action succeeds (astra-jobs' `src/store/outcomes.ts`, `adoptFrozen`, reached only on success), and the workflow action succeeds only once `startHouse` has made its runs (workflow-house's `src/provider.ts`). A job runs one occurrence at a time, so its next condition comes after.
- **State:** the `asks` part of the same file, with its own line and queue, sharing only the App's tokens with the views'. Its job's own cursor says which line it took.

**The build.** The promote's `prepare` runs `bash view/build.sh STAGE`. It syncs `STAGE/view/.venv` from `uv.lock` with `--locked`, and installs the view itself, not a link to it. It builds only review-workflow and the view: every package from the index must come from one of its wheels, and a lock that would have one built instead is refused. It refuses if a `.py` or `.pth` file in the environment names the stage's path, and it imports `view`, `poll` and `pr_review` with the stage's interpreter before anything switches to the release.

**Tests:**

```
(cd view && UV_NO_BUILD=0 uv run --frozen python -m unittest discover -q)
```

The tests use their own stand-ins for GitHub, for the house's Commons and for `astra-workflows`. `test_build` runs `build.sh` on stages of its own, with uv's cache.
