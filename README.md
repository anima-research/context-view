# context-view

A context view shows what a pull request changes in the requests that connectome-host sends to the model. It's for pull requests to context-manager, agent-framework, membrane and connectome-host: the parts whose changes reach what a model is given.

If you got here from a context view's comment on your pull request, this page says what the comment is and what it can and can't tell you.

## What a view does

A view runs the whole connectome-host, with its real agent-framework, context-manager, membrane and chronicle, through 77 scripted runs. It does this twice: once on the pull request's base, and once with its head merged onto the base, with everything else held the same where it can be. Where the releases connectome-host's own lockfile holds don't meet the version ranges a side's packages ask of each other, that side runs published releases that do where the view can choose them, and the comment says which. Where no release the view can choose admits the pull request's own package, it lays that package over the range all the same, a stack no resident runs, and the comment says so; where a range on another package can't be met, the view stops and says why. A stand-in answers for the model's API: Anthropic's, or OpenAI's Responses API in two runs, the Chat Completions API in two (OpenAI's own and OpenRouter's), and Amazon Bedrock's in one, so the runs call no model and every answer is the same each time. Each run records every request the host sends, and checks judge each run.

The view then compares the two sides' records, run by run, and the anima-review GitHub App posts what it finds as a comment on the pull request, for the head it ran on:

- which runs' records differ between the base and the head, and which runs couldn't be compared, with the reason;
- where the two sides ran different releases of another package, which, and what each was chosen for;
- a model's account of the differences, and how they bear on what the pull request's description says it does;
- each change, with record lines from one place where it occurs;
- the checks' flags that appear or go between the two sides;
- the agents' token figures, subagents' included, in the runs compared, base beside head, and the runs whose figures moved;
- each run from a store an older release wrote, beside the same work on a store the candidate wrote, where how they end differs, or where the change makes or stops a flag differing between them.

Code checks that the model's account covers every difference and that its quotes are copied from the records. It doesn't check what the account's sentences say, so read them as one reader's account, with the record lines beside them.

## What a view can't tell you

- **It speaks only for its runs.** A case of the change that none of the 77 runs reaches won't show.
- **It can't split a change from a release it needed.** Where the two sides ran different releases of another package, a difference may come from that package as well as from the pull request, and the view can't tell which.
- **It isn't a security check.** The pull request's own code runs in the job that makes the records, so what a view reports holds only if that code acts in good faith.
- **The stand-in isn't the model.** A view compares what the requests carried, and the answers are scripted, so it says nothing about how a real model would respond, and its token figures are its model of each provider's published caching and token rules, not a measurement.

## The checks

[CHECKS.md](CHECKS.md) lists every run, what each one drives, and what each check judges. Each comment links to it: at the harness commit the view used, or on `main` when a view stopped before it finished.

## The repository

- `harness/` drives connectome-host, records the requests, judges each run and compares two sides. It runs on GitHub's hosted runners.
- `run/` starts a view's jobs on those runners and brings their records back.
- `view/` turns the records into the comment and posts it.
- `workflow/` holds the tests of the workflow that runs those steps.

[AGENTS.md](AGENTS.md) is the contract between the parts, for the agents who work on them.

The Rookery, a household of AI agents, develops the context view, and nissa is its maintainer. Questions and reports go to this repository's issues.
