# What a context view runs and checks

A context view runs the whole connectome-host, with its real agent-framework, context-manager, membrane and chronicle, through 31 scripted runs. It does this twice: once on the pull request's base, and once with its head merged onto the base. A stand-in answers for the model's API, Anthropic's, OpenAI's Responses API in P1's run, ChatGPT's Codex backend in P2's, Amazon Bedrock's in P3's, or the Chat Completions API as OpenAI documents it in P5's, so no model is called and every answer is the same each time. Each run records every request the host sends, and is judged by the checks below. The comment then says which runs' records changed between the two, and which flags one side raised more times than the other.

The harness that does this is in `harness/`. Its `README.md` gives each check's exact rules, in "What each run's checks judge".

## What a view's comment rests on

The pull request's own code runs in the job that makes these records, so everything a view reports from its runs rests on that code acting in good faith. A view isn't a security check.

A view speaks only for its runs: a case of the change that none of them reaches doesn't show in its records.

A record holds what each request carried, as its text and hashes, not how many tokens it held or what it would cost, so a view, which compares records, can't show what a change costs.

In P1's and P2's runs, on OpenAI's Responses API and ChatGPT's Codex backend, a record holds each item a request sent by its own digest. A reasoning item's content and a compaction item's are opaque, so a change to them shows as an item's digest moving, with no text to read. The values membrane draws at random on the Codex backend, its cache key and `session_id` header, are written by their shape and numbered by first appearance in the run, so they make neither two arms nor a run's self-check differ, while a change in which requests share a key does. In P5's runs, on the Chat Completions API, a record holds each message a request sent by its own digest, the system prompt among them, and an image in a tool result goes as membrane's text in its place, so a change to the image itself shows nowhere. P3's runs, on Amazon Bedrock, are recorded as the Messages API's, with the Bedrock model and route in each head. No P4 run exists yet. `harness/README.md`'s "Reading a record" says how each line reads.

Where records differ, a model reads the differences and writes the account at the top of the comment. Code checks that the account covers every difference between the records of the runs that could be compared, and that its quotes are copied from the records. It also checks that the account's prose has no numbers of two or more digits, decimals or hashes, no counts of runs, steps, compiles, requests or rounds, and none of the records' notation. The comment gives its own counts of runs, changes and steps. Nothing checks whether its sentences are true.

## How a run's name reads

A run's name is its setup and its workload, `SETUP/WORKLOAD`, with a variant after a second slash where there is one, as in `H1/W7/merges-refused`.

## The setups

| Setup | What it is |
|---|---|
| `H1` | The host's default context setup, on Claude Opus 4.6. |
| `H1b` | H1 on Claude Opus 5.5, a model that binds thinking, answering with thinking. |
| `H2` | H1 with subagents on, judged on its knowledge subagent. |
| `H3` | Passthrough, which sends the conversation as stored and never compresses its own agent. In H3/W9 the forked subagent compresses once. |
| `H4` | H1 with the subconscious reader, which reads what the agent has tuned out. |
| `C3h` | The default without adaptive resolution. |
| `C5h` | The default with flat-profile folding. |
| `C6h` | The default with kv-stable folding. |
| `C8h` | The default with oldest-first folding. |
| `P1` | H1 on OpenAI's Responses API (`openai-responses`), on GPT-6.1 Sol, which reasons on every reply, with the host's Responses settings away from their defaults: medium reasoning effort, reasoning over the current turn only, the flex service tier, and a compaction threshold each of the continuation's turns crosses. The stand-in renders a request that carries a compaction item from the latest one, its own reading of OpenAI's compaction and prompt-caching guides and unverified against the API: the guides say the items before it may be dropped, not that the server ignores them when they're sent (`harness/README.md`). Its continuation's debt segment comes within 1,099 tokens of agent-framework's 320,000-token stream bound (check 3): the compile after a compression reads nothing from the cache, and four rounds follow it, so a small change there can show as a check 3 flag. |
| `P2` | H1 on ChatGPT's Codex backend (`openai-codex`), on GPT-6.1 Sol, with fast mode on, which asks for the priority tier, and P1's reasoning effort and context. The host sends the Codex backend no service tier or compaction threshold from the recipe, since its `framework-agent-config.ts` gives both to `openai-responses` alone, so P2 sets neither. Its window is 872,000 tokens, the Codex client's `max_context_window` for the model (its `context_window` is 272,000), and an unverified assumption above 530,038: the backend has been seen answering requests of up to 530,038 tokens, and its own limit isn't documented (`harness/README.md` gives both figures' sources). Its continuation's debt segment comes within 7,992 tokens of agent-framework's 320,000-token stream bound (check 3), for the same reason as P1's. |
| `P3` | H1 on Amazon Bedrock (`bedrock`), on Claude Opus 4.6 by the US geo inference id AWS's model card gives it, `us.anthropic.claude-opus-4-6-v1`, read on Nov 7 2026, which membrane sends as it is. Bedrock's body is the Messages API's, with the model in the path, so its stand-in answers through the Messages one, with Anthropic's cache rule, which AWS gives for this model's explicit caching, and the model card's 4,096-token minimum. A request's record names its API `messages` and its dialect `bedrock`. |
| `P5` | H1 on the host's `openai-compatible` provider, which sends the Chat Completions API to any endpoint a recipe names. Its stand-in follows OpenAI's own documentation of that API, read on Nov 7 2026, since every such endpoint implements OpenAI's contract first. The host's README names Ollama, vLLM, Together, Groq and NanoGPT, with Ollama's `qwen3:32b` as its example, and which endpoint residents use isn't known. The model is GPT-5.6 Sol, which reasons on every reply but sends no reasoning on this API, so P5 doesn't reach membrane's reading of a reply's reasoning, or a reasoning sent back, and its call after thinking declares nothing. A tool message there carries text only, so its tool round's image goes as membrane's text in its place, which is what it declares. The stand-in's DeepSeek dialect, which sends reasoning as `reasoning_content`, covers those in unit tests only: by DeepSeek's documentation, read the same day and unverified live, membrane 0.8.0's second request in a conversation with tools is refused, since it sends a prior turn's reasoning back as `reasoning`. Each continuation round's whole `prompt_tokens` counts toward agent-framework's 320,000-token stream bound (check 3), cached prefix included, so the streams of all four of the continuation's stream segments (tool-round, parallel, thinking-call and debt) pass the bound, by 207,962 to 258,528 tokens through their last round. In the debt segment agent-framework breaks the stream there and compiles afresh, twice, where H1's stream runs four continuation rounds, so P5's continuation makes 10 compiles to H1's 8. Check 3 flags a round sent after its stream has passed the bound, and agent-framework sends a compile instead, so nothing is flagged; one more round in the other three streams would show as a check 3 flag. |

## Where runs start

W1 and W2 runs, H2's run and the two no-tools runs start empty. The continuation runs, and the rest, continue from a conversation the harness builds first, never a captured real session: the continuation from a conversation it builds for that purpose, and the rest from their own setup's W2 store, or W1's for H3, which doesn't summarise. The harness builds these with the fixed host release that `harness/stack.json` names, the same on both sides of a view, so a difference comes from the run, not from where it started.

## The workloads, and what each checks

Each workload is a scripted conversation with a property of its own, which is check 14.

### `continuation`

Five short stretches: summaries closing and merging; a tool round with an image; three calls at once; a call after thinking; and a long tool turn of four rounds, answered badly (with thinking only, empty, and cut at `max_tokens`). It checks that each stretch produces what it exists to produce, such as a merge or a request carrying both results with one an image (check 2). A setup that doesn't summarise declares nothing for the first stretch or the last.

### `W1`

70 ordinary turns, some with tool calls. It checks that the store's summaries reach level 3 by the end, for setups that summarise. Under H4, the agent then tunes its channel out and the reader reads six messages for it, with an `/undo` before the fourth.

### `W2`

70 turns heavy with reading-sized tool results, with an image attached every seventh turn and a long document pasted every tenth. It checks that the store's summaries still reach level 3 by the end.

### `W4`

Four turns that each think before a tool call. It checks that none of those calls goes out without the thinking that led to it, ahead of it in its message.

### `W5`

The tool-result guard is turned on, then twelve turns with tool results, every other one large and mixing text and an image, too large for one stored message. It checks that the store keeps both the call and the result of each, and that a message stored in parts never goes out whole without its tool blocks.

### `W6`

Twelve turns of awkward tool pairing: two calls at once, a call id reused across two rounds, a call the tool server never answers, which times out, and a suppressed message. It checks that no request carries membrane's repair mark for an unpaired call or result, which would mean context-manager handed one over unpaired, and that the held call did time out.

### `W7`

Summariser failures, over 21 turns, or 32 with no tools. Under H2, the knowledge subagent does the tool work in one long task. Its variants:

- **`merges-refused`:** the stand-in answers every merge with a refusal, as a model declining would. It checks that each refusal raises exactly one alert, and nothing else raises one.
- **`merges-rejected`:** the API rejects every merge with an error instead of a refusal. It checks that every turn still answers and the errors raise no alert (check 1).
- **`chunk-refused`:** the stand-in answers with a refusal every summariser request that carries one turn's marked content. It checks that the content reaches the summariser only in the slice it's asked to remember, never in a merge, and that each refusal raises one alert.
- **`no-tools`:** an agent with no tools, starting empty. Nothing is refused, and it checks that every turn answers and nothing raises an alert (check 1).
- **`fable-no-tools`:** the same, with a Fable-family model set to write the summaries. Where that model writes none, both sides carry a no-summaries flag.

### `W8`

Sixteen turns. Before turn 5 an operator cuts the budget to 60%, before turn 9 to the edge (the response reserve plus 1,000 tokens), and before turn 13 restores it. It checks that a setup that compiled every turn before the cut does so again within two steps of the restore. Under H4, the cuts apply to the reader while it reads tuned-out messages. Its variants:

- **`enforced`:** with budget enforcement on.
- **`unenforced`:** with budget enforcement off.

### `W9`

Twenty turns of lifecycle events: a close and reopen; pins listed, added and removed; the raw tail's size set; a restart that marks earlier turns as a record the agent inherited; a forked subagent; a changed system prompt; `/undo` and `/redo`; `/newtopic`; the tool-result guard turned on; a suppressed message; and a changed head window. It checks that the store, closed and reopened at turn 3, compiles what it compiled before closing (check 12). The other events are there for every check to judge across.

### `W11`

Fourteen turns. By turn 8 an operator has pinned older messages at several levels, pinned a tool result and marked a document. Before turn 9 the budget is cut to 35%, and before turn 13 it's restored. It checks that each pin, when added, lists exactly one new pin and none gone, and that every pin and mark placed by turn 8 is still there, unchanged, after turns 12 and 14. A compile that can't hold them must refuse instead. Under H1, the second turn first meets one overloaded error, which agent-framework retries.

## The checks every run is judged by

The checks are numbered 1–6 and 10–15, the numbers each run's report and a view's flags use; there are no checks 7–9. Each counts what it judged. Where a check applies to a run and judged nothing, that's a couldn't-judge flag, never a pass. A view sets each run's flags on the head against the base's: new, gone, or kept.

### Check 1: every turn answers

It flags a request the stand-in couldn't answer, which it names with its reason, or couldn't classify; an inference that failed; an alert the host raised; a step that didn't settle; an answer the host couldn't route to its channel; and a scripted reply left unused. Two things are left to a workload's own check: the turns W8 and W11 allow to fail under a budget cut, and the refusal alerts that W7's `merges-refused` and `chunk-refused` count for themselves.

### Check 2: declared products

Each continuation stretch produced what it declares: a summary, a merge, a request carrying both results with one an image, a call led by its thinking, and the like.

### Check 3: request shape and budgets

Every request is well formed: roles alternate, each result answers a call in the message before it, and each call before the last message has its result in the message after. Each request also fits the bound that governs it: the model's window for a compiled request (a turn's first, or a stream restart's), and agent-framework's stream bound for a later round.

### Check 4: coverage

For setups that compress, every stored input and reply goes out in each request, raw or inside a summary sent, once, and in store order.

### Check 5: bookkeeping

Every summary declares as its sources only what its summariser request showed: the messages it covers, or the summaries it merges. A store with no summaries, under a setup that compresses, is flagged.

### Check 6: windows raw

Each request carries raw the two turns before its own, less what an operator suppressed, and each stretch's last request carries the head and the raw tail the host reported.

### Check 10: calibration edge

For adaptive setups, a calibration multiplier at the clamp's edge (0.6 or 1.8) makes the run invalid, since its folds are clamped.

### Check 11: compile invariants

What the harness found wrong with each compile context-manager made, judged against the store it compiled from:
- everything stored goes out, raw or under a summary, and in order;
- nothing goes out raw beside its own summary;
- the compile keeps to its budget, or refuses;
- a call and its result aren't sent apart;
- a message's thinking goes out with its calls, or not at all;
- a summary over pinned messages is at a level the pin allows.

### Check 12: reloads

At a restart with a reload check, the compile after the boot matches the one before the shutdown: the same outcome, the same messages from the same stored sources, and the same system injections.

### Check 13: pairing

Every compile made for a request reached it: the agent's next request to arrive at the stand-in. It judges each agent that compiles, subagents and readers included.

### Check 14: the workload's own property

Each workload's property, as described above. A workload whose property is another check's, as the continuation's is check 2's, most W7 variants' check 1's, and W9's check 12's, is held to that check's count.

### Check 15: binding control

On a model that binds thinking and takes the drop control, every agent request carries the host's rule for a changed thinking block, `prefix_mismatch_behavior: drop_block`, and asks for the beta that control needs.

## The runs

| Run | What it does |
|---|---|
| `H1/continuation` | The continuation's stretches under the default setup. |
| `H3/continuation` | The same under passthrough. |
| `P1/continuation` | The same on OpenAI's Responses API. |
| `P2/continuation` | The same on ChatGPT's Codex backend. |
| `P3/continuation` | The same on Amazon Bedrock. |
| `P5/continuation` | The same on the Chat Completions API, as OpenAI documents it. |
| `H1/W1` | W1 under the default setup. |
| `H4/W1` | W1 with the reader on, then the agent tunes its channel out and the reader reads six messages for it, with an `/undo` midway. |
| `C3h/W2` | W2 without adaptive resolution. |
| `H1/W2` | W2 under the default setup. |
| `H1b/W2` | W2 on Claude Opus 5.5, answering with thinking. |
| `H3/W4` | W4 under passthrough. |
| `C5h/W5` | W5 under flat-profile folding. |
| `C8h/W6` | W6 under oldest-first folding. |
| `C3h/W7/merges-refused` | Every merge answered with a refusal, without adaptive resolution. |
| `C3h/W7/fable-no-tools` | 32 turns with no tools and a Fable-family model set to write the summaries, without adaptive resolution. |
| `C3h/W7/no-tools` | 32 turns with no tools and the usual summariser, without adaptive resolution. Nothing is refused. |
| `H1/W7/merges-refused` | Every merge answered with a refusal, under the default setup. |
| `H1/W7/merges-rejected` | Every merge rejected with an error instead of a refusal, under the default setup. |
| `H2/W7/merges-refused` | Every merge answered with a refusal, with subagents on, judged on the knowledge subagent. |
| `H1/W7/chunk-refused` | Every summariser request carrying one turn's content answered with a refusal, under the default setup. |
| `C3h/W8/unenforced` | The budget cuts, without adaptive resolution or budget enforcement. |
| `C6h/W8/enforced` | The budget cuts with enforcement on, under kv-stable folding. |
| `H1/W8/enforced` | The budget cuts with enforcement on, under the default setup. |
| `H4/W8/unenforced` | The budget cuts applied to the reader while it reads tuned-out messages. |
| `H3/W9` | W9 under passthrough. |
| `C3h/W9` | W9 without adaptive resolution. |
| `C6h/W9` | W9 under kv-stable folding. |
| `H1/W9` | W9 under the default setup. |
| `C6h/W11` | W11 under kv-stable folding. |
| `H1/W11` | W11 under the default setup, with one overloaded error at its second turn that agent-framework retries. |
