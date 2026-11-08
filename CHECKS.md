# What a context view runs and checks

A context view runs the whole connectome-host, with its real agent-framework, context-manager, membrane and chronicle, through 37 scripted runs. It does this twice: once on the pull request's base, and once with its head merged onto the base. A stand-in answers for the model's API, Anthropic's, OpenAI's Responses API in P1's run, ChatGPT's Codex backend in P2's, Amazon Bedrock's in P3's, or the Chat Completions API as OpenAI documents it in P5's and as OpenRouter serves it in P4's, so no model is called and every answer is the same each time. Each run records every request the host sends, and is judged by the checks below. The comment then says which runs' records changed between the two, and which flags one side raised more times than the other.

The harness that does this is in `harness/`. Its `README.md` gives each check's exact rules, in "What each run's checks judge".

## What a view's comment rests on

The pull request's own code runs in the job that makes these records, so everything a view reports from its runs rests on that code acting in good faith. A view isn't a security check.

A view speaks only for its runs: a case of the change that none of them reaches doesn't show in its records.

Each run has one resident, since connectome-host runs one (`agents: [agentConfig]`), so a change to what residents sharing one slot are shown doesn't show in any run.

A record holds what each request carried, as its text and hashes, not how many tokens it held or what it would cost, so a view, which compares records, can't show what a change costs.

In P1's and P2's runs, on OpenAI's Responses API and ChatGPT's Codex backend, a record holds each item a request sent by its own digest. A reasoning item's content and a compaction item's are opaque, so a change to them shows as an item's digest moving, with no text to read. The values membrane draws at random on the Codex backend, its cache key and `session_id` header, are written by their shape and numbered by first appearance in the run, so they make neither two arms nor a run's self-check differ, while a change in which requests share a key does. In P5's runs, on the Chat Completions API, a record holds each message a request sent by its own digest, the system prompt among them, and an image in a tool result goes as membrane's text in its place, so a change to the image itself shows nowhere. P3's runs, on Amazon Bedrock, are recorded as the Messages API's, with the Bedrock model and route in each head. `harness/README.md`'s "Reading a record" says how each line reads.

Where records differ, a model reads the differences and writes the account at the top of the comment. Code checks that the account covers every difference between the records of the runs that could be compared, and that its quotes are copied from the records. It also checks that the account's prose has no numbers of two or more digits, decimals or hashes, no counts of runs, steps, compiles, requests or rounds, and none of the records' notation. The comment gives its own counts of runs, changes and steps. Nothing checks whether its sentences are true.

## How a run's name reads

A run's name is its setup and its workload, `SETUP/WORKLOAD`, with a variant after a second slash where there is one, as in `H1/W7/merges-refused`.

## The setups

In every setup the host has the modules a recipe that names none gets, the wake gate and the workspace among them, less subagents, which `H2`'s and `H5`'s setups and `W9`'s and `W14`'s workloads turn back on; `H5` also turns on lessons and retrieval, which such a recipe doesn't get. Its timers from 30 s up to 2^31−1 ms run on the workload's clock, so they fire only when a step moves that clock to or past them; its monotonic clocks read real time plus every move of the workload's clock, so a deadline it keeps on one passes in real time too, or at a step that moves the clock past it, as `harness/README.md` says.

| Setup | What it is |
|---|---|
| `H1` | The host's default context setup, on Claude Opus 4.6. |
| `H1b` | H1 on Claude Opus 5.5, a model that binds thinking, answering with thinking. |
| `H1r` | The setup `W16` runs under: H1 with agent-framework's refusal rewind on (`refusalHandling.autoRewind`) and no same-model retries, so membrane sends a refused request once and the refusal goes to agent-framework's handler, which sets the refused turn aside, stores a marker in its place and asks again. |
| `H2` | H1 with subagents on, judged on its knowledge subagent. |
| `H3` | Passthrough, which sends the conversation as stored and never compresses its own agent. In H3/W9 the forked subagent compresses once. |
| `H4` | H1 with the subconscious reader, which reads what the agent has tuned out. |
| `H5` | The setup `W12` runs under: H1 with every module a recipe can turn on that needs no outside service: subagents, lessons, retrieval with the module's own default model, history, activity, identity, MCPL administration, self-restart and fleet with no children; heartbeat ticking every 90 minutes, so no tick falls at the two hours the suppression review waits; the workspace with a read-only input mount, a products mount, a read-only instructions mount, a watched mount whose changes wake the agent and the gate's own `_config` mount; instructions read from that mount; notices with the instructions-unavailable alert in the reply tier; and the channel-mode module serving the fixture's MCPL server. W12 under it adds a second fixture MCPL server, `quiet`, where its agent-framework brings wake onboarding. |
| `C3h` | The default without adaptive resolution. |
| `C5h` | The default with flat-profile folding. |
| `C6h` | The default with kv-stable folding. |
| `C8h` | The default with oldest-first folding. |
| `P1` | H1 on OpenAI's Responses API (`openai-responses`), on GPT-6.1 Sol, which reasons on every reply, with the host's Responses settings away from their defaults: medium reasoning effort, reasoning over the current turn only, the flex service tier, and a compaction threshold each of the continuation's turns crosses. The stand-in renders a request that carries a compaction item from the latest one, its own reading of OpenAI's compaction and prompt-caching guides and unverified against the API: the guides say the items before it may be dropped, not that the server ignores them when they're sent (`harness/README.md`). Its continuation's debt segment comes within 1,099 tokens of agent-framework's 320,000-token stream bound (check 3): the compile after a compression reads nothing from the cache, and four rounds follow it, so a small change there can show as a check 3 flag. |
| `P2` | H1 on ChatGPT's Codex backend (`openai-codex`), on GPT-6.1 Sol, with fast mode on, which asks for the priority tier, and P1's reasoning effort and context. The host sends the Codex backend no service tier or compaction threshold from the recipe, since its `framework-agent-config.ts` gives both to `openai-responses` alone, so P2 sets neither. Its window is 872,000 tokens, the Codex client's `max_context_window` for the model (its `context_window` is 272,000), and an unverified assumption above 530,038: the backend has been seen answering requests of up to 530,038 tokens, and its own limit isn't documented (`harness/README.md` gives both figures' sources). Its continuation's debt segment comes within 7,992 tokens of agent-framework's 320,000-token stream bound (check 3), for the same reason as P1's. |
| `P3` | H1 on Amazon Bedrock (`bedrock`), on Claude Opus 4.6 by the US geo inference id AWS's model card gives it, `us.anthropic.claude-opus-4-6-v1`, read on Nov 7 2026, which membrane sends as it is. Bedrock's body is the Messages API's, with the model in the path, so its stand-in answers through the Messages one, with Anthropic's cache rule, which AWS gives for this model's explicit caching, and the model card's 4,096-token minimum. A request's record names its API `messages` and its dialect `bedrock`. |
| `P4` | H1 through OpenRouter (`openrouter`), on Claude Opus 4.6 by the id OpenRouter's public model list gives it, `anthropic/claude-opus-4.6`, with that list's 1,000,000-token window, read on Nov 7 2026. OpenRouter's caching guide says a Claude model caches by Anthropic's own rules, so the stand-in prices a request with the Messages API's cache, over the Messages body it maps the request to; what OpenRouter forwards to Anthropic isn't documented, so that map is the stand-in's own (`harness/README.md`). membrane's OpenRouter adapter reads no reasoning and sends a tool message as text, so, as on P5, no reasoning comes back, its call after thinking declares nothing, and its tool round's image goes as membrane's text in its place. Unlike the other four providers, its continuation starts empty and builds its own history first, with the host under test ("Where runs start", below). membrane's OpenRouter adapter sends a message's content as blocks only when one of them carries a cache marker, and as one joined string otherwise (`openrouter.js`, `useArray`). So as the host's 1-hour marker moves onto or off an early message between turns, that message's form changes: P4's 14th message, the history's turn 18 input, and at one turn its 16th, goes as blocks with the marker at some turn starts and as one string at others. membrane's Messages API adapter keeps a message's blocks whether a marker sits on them or not (`anthropic.ts`, `toAnthropicContent`), so on H1 a moving marker changes no message's form. Where the form changes, the request differs from that message on: the first requests of close-merge's third and fourth turns and of thinking-call read nothing from the cache, where H1's read 250,727 to 268,510 tokens, and parallel's first request, where the 14th message goes back to blocks, read 53,707. H1 building its own history the same way read the cache exactly as H1 does. Whether OpenRouter itself would miss there rests on what it forwards to Anthropic, which the stand-in's map only models. Each round's `prompt_tokens` less its `cached_tokens` counts toward agent-framework's 320,000-token stream bound (check 3), so a round's cache writes count, and its least stream headroom is 41,813 tokens, in thinking-call, where H1's is 206,943, in debt. Nothing is flagged. |
| `P5` | H1 on the host's `openai-compatible` provider, which sends the Chat Completions API to any endpoint a recipe names. Its stand-in follows OpenAI's own documentation of that API, read on Nov 7 2026, since every such endpoint implements OpenAI's contract first. The host's README names Ollama, vLLM, Together, Groq and NanoGPT, with Ollama's `qwen3:32b` as its example, and which endpoint residents use isn't known. The model is GPT-5.6 Sol, which reasons on every reply but sends no reasoning on this API, so P5 doesn't reach membrane's reading of a reply's reasoning, or a reasoning sent back, and its call after thinking declares nothing. A tool message there carries text only, so its tool round's image goes as membrane's text in its place, which is what it declares. The stand-in's DeepSeek dialect, which sends reasoning as `reasoning_content`, covers those in unit tests only: by DeepSeek's documentation, read the same day and unverified live, membrane 0.8.0's second request in a conversation with tools is refused, since it sends a prior turn's reasoning back as `reasoning`. Each continuation round's whole `prompt_tokens` counts toward agent-framework's 320,000-token stream bound (check 3), cached prefix included, so the streams of all four of the continuation's stream segments (tool-round, parallel, thinking-call and debt) pass the bound, by 207,962 to 258,528 tokens through their last round. In the debt segment agent-framework breaks the stream there and compiles afresh, twice, where H1's stream runs four continuation rounds, so P5's continuation makes 10 compiles to H1's 8. Check 3 flags a round sent after its stream has passed the bound, and agent-framework sends a compile instead, so nothing is flagged; one more round in the other three streams would show as a check 3 flag. |

## Where runs start

W1, W2, W12 and W16 runs, H2's run, the two no-tools runs, P4's continuation, `H1b/W14` and `H4/W15` start empty. W12, W16, `H1b/W14` and `H4/W15` are too short to compress, so their runs' stores hold no summaries, and checks 4 and 5 have none of their stores to judge. The other continuation runs, and the rest, continue from a conversation the harness builds first, never a captured real session: the continuation from a conversation it builds for that purpose, and the rest from their own setup's W2 store, or W1's for H3, which doesn't summarise. The harness builds these with the fixed host release that `harness/stack.json` names, the same on both sides of a view, so a difference comes from the run, not from where it started.

P4's continuation builds that conversation itself, in the same run and with the host under test, since the fixed release can't send OpenRouter requests to the stand-in: its OpenRouter adapter takes no base URL. Its host then stops and boots that conversation again a day later, as a run that continues a conversation the harness built boots it a day after its end. So P4's history is written by the host under test, unlike the other four providers', and its record holds that history's requests too: a change that moves them shows there.

A run that starts from a stored conversation also starts from the cache receipt its last request left. Under kv-unified folding, the default, the first compile weighs cache costs only while the tools in the agent's tool list and its system prompt are the ones that receipt was written for. So a change to a tool in the agent's tool list, though not to one inside a toolset, or to the system prompt, can change how such a run's first compile folds, as it would a resident's first compile after it takes such a change. A run's token calibration moves when the tools its requests carry change, as a resident's would, and so do the token counts it prices with it, such as the total a summariser is told it's reading; the size of that move here comes from the stand-in's own count of the tools.

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

Twenty turns of lifecycle events: a close and reopen; pins listed, added and removed; the raw tail's size set; a restart that marks earlier turns as a record the agent inherited; a forked subagent; a changed system prompt; `/undo` and `/redo`; `/newtopic`; the tool-result guard turned on; a suppressed message; a changed head window; and a rollback of the record to an earlier message with `/branchto`, before the last turn. It checks that the store, closed and reopened at turn 3, compiles what it compiled before closing (check 12). The other events are there for every check to judge across.

### `W11`

Fourteen turns. By turn 8 an operator has pinned older messages at several levels, pinned a tool result and marked a document. Before turn 9 the budget is cut to 35%, and before turn 13 it's restored. It checks that each pin, when added, lists exactly one new pin and none gone, and that every pin and mark placed by turn 8 is still there, unchanged, after turns 12 and 14. A compile that can't hold them must refuse instead. Under H1, the second turn first meets one overloaded error, which agent-framework retries.

### `W12`

The wake gate's paths, from empty, with the recipe's starting rules naming one channel each. The agent opens the host's built-in `settings` toolset and looks at each tool its listing names, so its own requests carry those tools' whole definitions, which the agent's tool list never does. Then: a message the `always` rule wakes it for; one the `defer` rule holds back; two messages in one `debounce` window, delivered as one batch at the step that moves the clock past it; the same window's message the agent has already read and answered in a turn another channel woke, before the window ends; a `rate_limit` bucket of one, whose second message is denied; a `passive_sample` of every second message, with `passthrough` and a `defer` rule after it; a `judge` rule's two batches of two messages each, the first carrying `[[wake]]`, which the stand-in's reply judge answers REPLY for, so the batch wakes the agent as a debounce's does, and the second without it, which the judge lets go by; where the host's agent-framework brings suppression, a `defer` rule with `suppress` over a muted channel and two messages there, the second carrying `[[flag]]`; where it brings wake onboarding, a `defer` rule that matches a message's text, `[[quiet]]`, and so names no server, channel or tag, letting by undecided a message addressed to the agent, so the fixture server's first such message brings the onboarding notice of what its tag ontology suggests and wakes the agent, which accepts it, after which a message carrying the suggested tag wakes the agent by the rule accepting wrote, and the second server's first such message brings the notice of the one rule the host offers a server that suggests nothing, which the agent declines, after which its next such message wakes nothing; the agent's `sleep`, through which a message on the `always` channel doesn't wake it and a privileged user's does, and a second `sleep` whose end wakes it; `skip_reply` with `wake_in_seconds`, which wakes it; a rule the agent adds through the toolset, which holds its channel's next message back, and removes, after which that channel's next message wakes it, beside a `gate_status` call; `set_channel_mode` setting another channel to debounced, so two ambient messages there come as one batch; a file written into the watched mount; `gate.json` rewritten through the `_config` mount and materialized, so that the `defer` rule's channel wakes the agent, a little later on the clock, since the gate rereads its file at most once a second by it; four lessons created, the fourth carrying `[[stale]]`; a message naming the first, whose one candidate the retrieval module injects without asking its relevance filter, so a threshold lowered below one candidate shows as a relevance request where there was none; a message naming all four, whose candidates go to the relevance filter, which the stand-in answers with all but the one carrying `[[stale]]`, so a threshold raised to four or more shows as that request gone and the stale lesson injected; a reminder, which fires at the step that moves the clock past it; the heartbeat's tick; with suppression, the step that moves the clock past two hours from the start, where the suppression review runs on its own timer and the stand-in's reviewer flags the message carrying `[[flag]]`, so the review's notice wakes the agent; the instructions file removed and put back, so the host raises its instructions-unavailable alert, which W12 owns, and the notices module tells the resident; a channel message that opens with `[Gate: 2 events matched]`, the gate's own batch line, which agent-framework marks with a backslash as text the server supplied, so it can't read as the framework's own; with suppression, a `defer` rule with `suppress` matching `[[mute]]` in a message's text, which hides a channel message carrying it; and three messages typed at the console through the host's headless `text` command, the second opening with `[Gate: 2 events matched]`, which agent-framework marks as it does a channel's, and, with suppression, carrying `[[mute]]`, which the text rule never meets, since console input is never suppressed, and the third bringing the host's one session naming request, which the stand-in answers with a fixed name. A turn a timer, a file's change, the review's notice or a console message wakes, and the ambient batch's and the judged batch's, speaks as a resident would, though no channel started it: the host reports its answer as having no channel to go to, or holds a reminder's or the tick's as a draft, and tells the resident so in its next request, which the record shows (check 1). A file the harness writes into the watched mount is followed by a second on the workload's clock once the watcher is seen checking the file: the watcher waits for a write to settle by the host's clock, which moves only at a step. It checks that each event meets its rule's fate: one its rule wakes starts a request whose last message carries it; one its rule holds back starts no request at its step, and the next request carries it; a batch starts one request whose last message carries every event in it and the gate's line counting them; a batch a `judge` rule holds goes to the reply judge in one request at the step that moves the clock past its window, listing every event in it and answered as its mark gives, and the batch it lets go by starts no request there, and the next request carries every event in it; a message the muted channel's rule suppresses reaches no request, and the one the review flags none before the review's notice; the review goes to the reviewer in one request listing every event the rule hid, and its notice starts one request, carrying the flagged event and not the other; each onboarding offer starts a request whose last message carries the message that brought it and the `[wake onboarding]` notice; the request each message naming lessons starts holds, as its newest retrieved lessons, those the message names less any the relevance filter drops, and the message naming one lesson brings no relevance request, while the one naming four brings one, listing all four; the already-answered batch starts one turn at most; a sleep's end, `skip_reply`'s wake, the watched file's change, the reminder and the tick each start a turn at their step; the request after the instructions come back carries the notices module's `[host-notice]` line; each message that opens with `[Gate: 2 events matched]` reaches the request it starts with the tag marked, after exactly the names the host writes before it, the console's participant and a channel message's author too, and not as the gate's line; the channel message carrying `[[mute]]` reaches no request, while the console message carrying it starts one; the third console message brings one session naming request, and no other step brings one; and the agent's look at the settings toolset names at least one tool.

Two of the ways a turn is woken or its speech ends under H5's modules aren't in W12: a subagent that ends while its task work still runs, whose orphan notice goes to the agent that adopts that work, and a reply held past agent-framework's inference bound. And of the tools the agent has under H5, W12 calls only these: it opens the `settings` toolset, looks at its tools and calls `wake_add_rule`, `wake_remove_rule`, `gate_status`, `wake_accept_suggestions` and `wake_decline` there, and it calls `sleep`, `skip_reply`, `set_channel_mode`, the workspace's `write` and `materialize`, the lessons module's `create` and the heartbeat's `reminder_add`. What calling any other does, such as one of subagents', history's, activity's, fleet's, self-restart's, identity's or MCPL administration's tools, isn't in W12.

A stretch that needs what not every agent-framework release brings names it: suppression needs `gate/suppression-review` and onboarding `gate/wake-onboarding` in the host's installed agent-framework, in its `src` or its `dist/src`, since no release exports either at run time. Each arm reads its own install before its recipe is built. Where the module isn't there, the stretch is absent: the run leaves it out, its rule and its review included, writes `absent suppression` or `absent onboarding` into its record, and the run's row in the harness's summary table names it as not run on that arm, as a line of the view's comment does above its fold for a run the view compares, so no reader takes it for a stretch that passed; check 14 neither judges nor flags it. An install whose agent-framework can't be read is never read as absent: the run can't run, naming why.

### `W14`

Messages, and a subagent's result, that arrive while the agent's turn is alive, at each point where agent-framework puts a row that arrived during a turn into the agent's window. The harness holds the turn at a request or a tool call while something arrives, waits until the host has stored it, then lets the turn go on. `H1/W14` continues H1's W2 conversation; `H1b/W14`, on a model that binds thinking, starts empty. In order:
- **At a turn's end** (both): while the request after the turn's one tool round, its last, is held, a message arrives in the same channel. It's stored during that request, so it enters the window after the turn's final reply, and its wake starts a turn of its own.
- **At a boundary that breaks the stream** (`H1`): `/budget` lowers the stream budget to one token, so the turn's second tool boundary breaks the stream and compiles afresh. agent-framework weighs a stream's uncached input against the budget, and by the stand-in's cache the turn's first request has none, so its first boundary doesn't break. While the second round's call is held a message arrives, and the continuation's first request carries it after that round's results. `/budget` then sets the budget back to the setup's bound.
- **A subagent's result** (`H1`): the turn's one round spawns a subagent beside a call held until the subagent's result is stored for the agent, and the request after that boundary carries the result after the round's results. The result's wake starts a turn of its own after the turn ends.
- **Addressed from another channel** (`H1b`): while the turn's call is held, a message addressed to the agent arrives on a second channel. The request after the boundary carries it after the round's results, with agent-framework's `[routing]` notice after it, and its wake starts a turn of its own on that channel.
- **A bare `/newtopic`** (`H1`), last: context-manager writes a transition summary from the agent's head window, which the stand-in answers with a fixed text, and connectome-host stores it as the topic's transition.

It checks that each arrival is first carried by the request its point gives, and by none before it, after what that point puts ahead of it: the turn's final reply for one at the turn's end, the held call's result for one at a boundary, and for the one addressed from another channel, the routing notice after it too. An arrival no request carries, or one the host hadn't stored before the harness let its turn go, can't be judged. A change to the words of agent-framework's `[routing]` notice, or of context-manager's transition summary prompt past its opening sentence, shows in the record, and no check judges it, since a check that pinned their words would flag every rewording made on purpose. A change to that opening sentence, by which the stand-in tells the request, leaves the request unclassified, which check 1 flags. Whether agent-framework's turn-opening pin reads the agent's window or its record isn't reached: with a pin planted to read the record, both W14 runs' requests were as they were.

### `W15`

The reader's window through an operator's moves and a restart, under `H4` from empty, with the Web UI and the history module on. After an ordinary turn the agent tunes `chat` out, and the reader reads what's addressed to the agent there. In order:
- h1, addressed, which the reader reads;
- `/checkpoint w15`; then h2, not addressed, which the tune-out holds with no reader turn; then `/restore w15`, which rolls the record back to the checkpoint on a new branch, so h2 leaves both windows;
- h3, addressed, which the reader reads on that branch;
- `/checkout main`, back to the branch the restore left: a store W15 starts empty is on `main`, and a host that names it otherwise fails the step;
- a suppression of h1 through the Web UI;
- a turn on a second channel whose first round sends into `chat` with the fixture server's `send_message`, whose answer agent-framework notes as `[tuned out]`, and whose second searches the history for h2, each call in a round of its own, since with both calls in one round agent-framework 0.33.0 sent their results in either order from one drive to the next;
- a restart with the tune-out still on, then h4, addressed.

The fixture server offers `send_message` in this workload only, so no other run's tool list changes. agent-framework notes a send into a tuned-out channel only on a server's own send tools, such as discord-mcpl's, whose answer the fixture's follows, less Discord's own id for the channel: `messageId`, `channelId` and `channelLabel`. As a resident's send does, it counts the channel among those the turn sent into. The fixture's send stores nothing in the channel.

It checks that the reader's read after the restore doesn't carry h2, the row stored after the checkpoint; that its read after the restart carries h2, which the branch `/checkout` went back to holds, and not h3, which only the restore's branch holds; that none of its reads after the suppression carries h1; and that its read after the restart starts at the row its read before it started at. A read that isn't there can't be judged, nor can the suppression where the reader's last read before it didn't carry h1, nor h3's absence after the restart where its read after the restore didn't carry h3. Whether the suppression takes h1 out of the reader's window isn't reached: agent-framework leaves a suppressed row out of the reader's compiles whatever its window holds, and the reader never compresses, so a window that kept h1 would send nothing more.

### `W16`

Six turns from empty, each addressed to the resident on a channel, then an operator's `unstick`, then two more such turns. The stand-in answers the second turn's first request with a refusal and no content. agent-framework's rewind then takes that turn's message out of the agent's window, stores its marker, `[refusal-rewind] The 1 most recent turn(s) were set aside …`, in its place, and asks again, and the stand-in, which knows that request by the marker, answers it as an ordinary turn. It checks that the refusal was answered once and the turn shed, not replayed: one request at the step was refused, and the next request at that step carries one more rewind marker than the refused one did, and not the refused turn's message. A run with no refused request at the step, or none after it, is a couldn't-judge flag. Check 6 owes the shed message to no later request, and asks for the step's replies by the canaries their own text carries, so not for the refusal, which has no text.

At agent-framework 0.33.0 the retry's turn has no channel to answer on, since the message that woke it was set aside: the host reports its answer as unroutable, which check 1 flags at the refused step, and the third turn's first request carries agent-framework's `[send-undeliverable]` notice that the previous reply had no channel to go to.

The fourth, fifth and sixth turns meet agent-framework's poison-history breaker. The stand-in answers each one's first request with a 400 `invalid_request_error` whose text reads as neither an account refusal nor a context overflow, which membrane passes on as an `invalid_request` that isn't retried, so each turn fails and agent-framework stores its `[inference-failed]` notice. Each of these steps may fail (`mayFail`). The third failure in a row raises agent-framework's hard-down alert, which W16 owns, and trips the breaker: it takes the newest message the agent was sent that isn't one of agent-framework's own notices, the sixth turn's, out of the window, stores a marker for the episode, `[refusal-rewind] The 1 most recent turn(s) were set aside because the model API kept refusing the requests that carried them …`, beside the second turn's, and asks again, and the stand-in answers that request, which it knows by a marker, as an ordinary turn. It checks that the breaker waits for the third failure: the fourth and fifth turns each have one request, answered with the 400, and none after it at their step, and the run's one hard-down alert comes at the sixth turn's step, which W16 owns for check 1 and judges by its step here. The stand-in knows a request at those two steps by a rewind marker too and keeps a spare ordinary reply for each, so a retry there would be answered and judged rather than failing the run as one it couldn't classify. And it checks the sixth as it checks the second: the next request at its step after the failed one carries one more rewind marker than the failed one did, and not the sixth turn's message. Check 6 owes the sixth turn's message to no later request, and owes the earlier two's. At 0.33.0 the breaker's retry has no channel either, and check 1 flags its answer at the sixth turn's step.

Then the fixture server sends agent-framework an operator's `unstick` command, naming the channel. agent-framework queues a turn on the agent's context as it stands, with no message of its own, and sheds only if the model refuses that turn. The stand-in, which knows the turn by a rewind marker an earlier step left, refuses it once, and agent-framework takes the newest message the agent was sent, whoever wrote it, that isn't one of its own notices, the breaker retry's reply, out of the window, stores a new marker and asks again, and the stand-in answers that request as an ordinary turn. It checks the unstick as it checks the second turn: the next request at its step after the refused one carries one more rewind marker than the refused one did, and not the breaker retry's reply. The unstick's turn has no channel of its own, so its retry has none either, and check 1 flags its answer at the unstick step.

Last, the stand-in answers a turn with a reply that ends with `[[fail-publish]]`, and the fixture server answers its publish as not delivered, with no message id. agent-framework reports the answer as not routed, `the "fixture" server said it didn't post the message`, which the step owns (`failsPublish`). Check 1 owns any route failure at that step but one with no locus: a publish to a channel the fixture doesn't hold is refused with the same reason and a notice of the same kind, so the step can't tell the two apart. agent-framework stores its notice for the resident, `[discord-send-failed] Your previous reply (N chars) could not be delivered to chat (…). Nothing was posted; it is saved in your archive.` An ordinary turn follows, and once the driver has heard a route failure at the failed turn other than one with no locus, the fixture's refusal or any other it can't tell from it, it checks that the next request carries one more such notice than the failed turn's request did, as agent-framework adds one for a route failure with a channel unless the words are held as a draft, whose own notice says so (explicit mode's sends and the `{{unsent}}` resend, which W16 doesn't use); without such a failure it can't judge.

## The checks every run is judged by

The checks are numbered 1–6 and 10–15, the numbers each run's report and a view's flags use; there are no checks 7–9. Each counts what it judged. Where a check applies to a run and judged nothing, that's a couldn't-judge flag, never a pass. A view sets each run's flags on the head against the base's: new, gone, or kept.

### Check 1: every turn answers

It flags a request the stand-in couldn't answer, which it names with its reason, or couldn't classify; an inference that failed; an alert the host raised; a step that didn't settle; an answer that reached no channel; and a scripted reply left unused.

The driver waits for each turn's spoken answer to end, and agent-framework ends one in one of four ways, at 0.32.0 and 0.33.0 alike: it publishes it to a channel; it can't route it, and says why; it holds it as drafts, and says why; or it keeps it private, as `skip_reply` asks, or leaves it unrouted where the recipe turns plain speech off, which only the turn's `[delivered]` receipt says. A turn whose trigger keeps it silent sends its answer nowhere by design, and the driver doesn't wait for it. Speech of whitespace alone, and the private envelope of a turn under explicit routing, end in none of those ways, so the driver's wait for them runs to its bound and the run fails, naming the wait.

Of those, check 1 flags: an answer the host couldn't route, whenever a message the script addressed to the resident woke the turn, since that turn had a channel to answer on, and whenever the host's reason is anything but that the turn had no locus; an answer held as drafts because an explicit send in its turn or a routing prefix held it back, on any turn, since no script speaks beside an explicit send and no setup turns on explicit routing, so a hold for either reason held what the host should have sent; an answer held as drafts for having no destination, whenever an addressed message woke the turn; and a receipt saying a turn's speech could be neither sent nor held as drafts, so the host lost it, which check 1 reads from the receipt's own words, as agent-framework 0.32.0 and 0.33.0 write them, in each request in which an agent's count of such receipts rises above its count in that agent's previous request. A turn no addressed message woke, such as one that console input, a timer, a reminder, an ambient or judged batch, the heartbeat or the suppression review's notice wakes, has no channel to answer on unless the recipe gives it one: the host can't route its answer, or holds a heartbeat's or a reminder's as a draft, and tells the resident so in its next request, whose record shows it. That isn't flagged. The script says which of its steps no addressed message wakes, so the check doesn't depend on how a host decides where a turn speaks. Two things are left to a workload's own check: the turns W8 and W11 allow to fail under a budget cut, and the refusal alerts that W7's `merges-refused` and `chunk-refused` count for themselves. And one such receipt can go unflagged: agent-framework's words for the lost speech give only how many segments it lost and the draft store's error, at 0.32.0 and 0.33.0 alike, and the rest of the receipt, the turn's other notes and where its speech went, needn't differ from another's, so check 1 can't tell two such receipts apart and counts them; a new one that arrives in the request where an older one leaves the window keeps the count where it was.

### Check 2: declared products

Each continuation stretch produced what it declares: a summary, a merge, a request carrying both results with one an image, a call led by its thinking, and the like.

### Check 3: request shape and budgets

Every request the stand-in answers is well formed: roles alternate, each result answers a call in the message before it, and each call before the last message has its result in the message after. A message here is a turn: on the Responses API, the items one side sends in a row; on the Chat Completions API, a wire message, with a `tool` message and the message after it joining their side's turn. Each request also fits the bound that governs it: the model's window for a compiled request (a turn's first, or a stream restart's), and agent-framework's stream bound for a later round.

### Check 4: coverage

For setups that compress, every stored input and reply goes out in each request, raw or inside a summary sent, once, and in order: where the host presents the agent's window, the order its rows entered that window, and store order otherwise. agent-framework presents a row that arrives during a turn at the turn's end or a tool boundary, after rows the turn stored after it, so the two orders differ there. A row the window doesn't hold when the run ends has no place in its order, and isn't judged for it; the run's report counts such rows beside what check 4 judged.

### Check 5: bookkeeping

Every summary declares as its sources only what its summariser request showed: the messages it covers, or the summaries it merges. A store with no summaries, under a setup that compresses, is flagged.

### Check 6: windows raw

Each request carries raw the two turns before its own, less what an operator suppressed or rolled back, and each stretch's last request carries the head and the raw tail the host reported.

### Check 10: calibration edge

For adaptive setups, a calibration multiplier at the clamp's edge (0.6 or 1.8) makes the run invalid, since its folds are clamped.

### Check 11: compile invariants

What the harness found wrong with each compile context-manager made, judged against the store it compiled from:
- everything stored goes out, raw or under a summary, and in order, the window's order where the host presents the agent's window, as for check 4, but a turn an `/undo` or agent-framework's shed took out of the agent's window, a message a suppress rule hid, which goes out in neither form, and, to the resident, a message the script delivered on a channel it had tuned out, which goes out to its reader alone, whatever the host stamped on it;
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
| `P4/continuation` | The same through OpenRouter, after building its own history. |
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
| `H5/W12` | W12 under H5. |
| `H1/W14` | W14 under the default setup, from its W2 conversation: a turn's end, a boundary that breaks the stream, a subagent's result, and a bare `/newtopic`. |
| `H1b/W14` | W14 on Claude Opus 5.5, which binds thinking, from empty: a turn's end, and a message addressed from another channel. It never reaches compression, so checks 4 and 5 judge nothing in it. |
| `H4/W15` | W15 under H4, from empty, with the Web UI and the history module on. Its `/checkout` assumes the store starts on `main`. It never reaches compression, so checks 4 and 5 judge nothing in it. |
| `H1r/W16` | W16 under H1r. |
