# AIPatrol

A window onto Claude Code while it works. You type a request, the agent works
in a directory of your choice, and the page shows the trajectory as it happens
— every message, every tool call, every task it breaks the work into.

React + TypeScript + Vite on the front, a zero-dependency Node server on the
back that spawns `claude -p` and streams its events to the browser.

## Run

One process. The run API is mounted inside Vite's dev server, so there is
nothing else to start and no proxy in between:

```
npm ci
npm run dev                 # http://localhost:8000
```

For a production build served from plain node:

```
npm run start               # build, then http://localhost:8000
```

## Replaying a recorded run

A live run takes a minute and spends real usage; a recording is instant and
free, and the same every time. That is the difference between a ten-second
edit-test loop and a one-minute one, so the rendering is developed against
recordings and only checked against live runs at the end.

Two ways in.

**From the command line.** Give the server one recording or several. Each run
takes the next one and then cycles, so a conversation replays a *different*
trajectory each round rather than the same stream repeatedly:

```
npm run replay                                         # everything.jsonl, then subagents-recombine.jsonl
REPLAY=fixtures/two-subagents.jsonl npm run dev
REPLAY=fixtures/tasks.jsonl,fixtures/with-failure.jsonl npm run dev
npm run dev -- -- --replay fixtures/*.jsonl
```

The flag needs the second `--`: the first ends npm's arguments, the second
ends Vite's, which would otherwise reject `--replay` as an unknown option.
`REPLAY` avoids the question. In replay mode nothing streams until you send a
prompt; any prompt will do.

**From the page.** The folder button in the top bar opens a `.jsonl` from your
own disk. It is parsed in the browser and pushed through the same code a live
run uses — no server, no agent, nothing leaves the machine — so any capture
from `claude -p --output-format stream-json` can be inspected by opening it.
Such a run is badged *recording* and cannot be continued, because there is no
session behind it.

Real captured runs are kept in `fixtures/` so the tree, the outline's fork and
the `Tasks` grouping can be exercised without spending tokens:

| Fixture | Shape it exercises |
| ------- | ------------------ |
| `everything.jsonl` | Nested tasks, two parallel subagents, a subagent inside a subagent, and a failed call — the Ctrl+B prompt's output. |
| `tasks.jsonl` | A task containing a delegation. |
| `demo-fix.jsonl` | The demo project's failing test found and fixed. |
| `two-subagents.jsonl` | Two subagents; the fork **ends the run**, so its lanes simply stop. |
| `subagents-recombine.jsonl` | Two subagents, then the main agent carries on — the lanes **merge back** into the spine. |
| `with-failure.jsonl` | A `Read` that really failed (`is_error: true`) beside one that succeeded. |

Capture your own the same way:

```
claude -p "…" --output-format stream-json --verbose > fixtures/mine.jsonl
```

### Server options

| Variable        | Effect                                                        |
| --------------- | ------------------------------------------------------------- |
| `PORT`          | Port to listen on (default 8000)                              |
| `HOST`          | Interface to bind (default `0.0.0.0`, all interfaces)         |
| `ALLOWED_HOSTS` | Extra hostnames Vite accepts, comma-separated (dev only)      |
| `REPLAY`        | Comma-separated recordings to stream instead of the agent     |
| `CLAUDE_BIN`    | Path to the CLI (default `claude`)                            |
| `DEFAULT_CWD`   | Directory the UI offers first (default `demo/workspace` if it exists, else the server's cwd) |
| `ALLOWED_TOOLS` | e.g. `"Edit Bash(pytest:*)"` — auto-approve only these        |
| `TASKS`         | `off` to run without the task-marker prompt                   |

By default the server passes `--dangerously-skip-permissions`, because a
headless run has nobody to answer a permission prompt and would otherwise
refuse the work. Point runs at a scratch directory, or set `ALLOWED_TOOLS` to
name what may run unattended. The server listens on all interfaces
(`0.0.0.0`) by default, and it grants tool access to whoever can reach it:
on a network you do not trust, start it with `HOST=127.0.0.1`. `/api/run`
refuses cross-origin browser requests, so another web page cannot start a run.

Authentication is whatever the CLI already has. The server passes its
environment through and never sets an API key — an exported `ANTHROPIC_API_KEY`
would take precedence over your login and bill a different account.

## Something for the agent to work on

`../demo/` holds a small real codebase — `logtool`, a command-line summariser
for access logs. A demo against an empty directory shows nothing worth
watching; this one has four modules, thirteen tests, and one that fails on
purpose.

```
npm run demo:reset      # put the workspace back, bug and all
```

`demo/pristine/` is committed and never worked in; `demo/workspace/` is the
disposable copy the agent edits, and is where runs land by default — runs
carry `--dangerously-skip-permissions`, so the default directory has to be one
that is safe to lose. See `demo/README.md` for tasks that demo well.

## Layout

```
src/
  App.tsx                  page shell: sidebar, top bar, transcript, composer
  App.css                  component styles
  index.css                design tokens (light + dark) and reset
  types.ts                 TrajectoryEvent, Round, Run, RunStatus, Theme
  agent/driver.ts          the UI/agent seam (AgentDriver, RunHandlers) + a mock
  agent/httpDriver.ts      talks to the server; reads the NDJSON response
  agent/parseEvent.ts      one stream-json event → handler calls
  hooks/useRuns.ts         run state; several runs may be in flight at once
  hooks/useTheme.ts        light / dark / system, persisted to localStorage
  lib/events.ts            sweepPending
  lib/tree.ts              buildTree, splitConclusion, outlineSections, groupSiblings
  lib/runs.ts              status and totals derived from a run's rounds
  lib/format.ts            relative time, duration, cost, basename, title
  lib/tools.ts             per-tool input summarization
  components/
    Sidebar.tsx            run history + "New run"
    RunHeader.tsx          title, directory, status, cost/duration/turns
    Composer.tsx           auto-growing prompt box; Enter sends
    CwdField.tsx           working directory: click to edit
    Trajectory.tsx         the rounds of one run
    Round.tsx              one prompt and everything the agent did about it
    EventNode.tsx          one node of the tree; nests a subagent's events
    Outline.tsx            table of contents for the run
    RoundOutcome.tsx       how the round ended, at its foot
    ToolCall.tsx           one tool call: name, target, status, detail
    Markdown.tsx           assistant text, rendered as markdown
    EmptyState.tsx         pre-first-run copy
    StatusDot.tsx          running / done / error
    ThemeToggle.tsx        sun/moon button
server/
  api.mjs                  spawns the CLI and streams its events
  index.mjs                production entry: api.mjs + static dist/
tools/
  cdp.mjs                  zero-dep Chrome DevTools Protocol client
  shoot.mjs                drive the page and screenshot it
  clip.mjs                 screenshot one element, scaled up
fixtures/                  captured runs, for replay
```

### Looking at the page

The UI is checked by driving headless Chrome rather than by eye:

```
google-chrome --headless=new --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cc-shot about:blank &

npm run start &                       # or a REPLAY server on another port
node tools/shoot.mjs http://127.0.0.1:8000/ out.png 1500 980 "a prompt"
node tools/clip.mjs ".outline" outline.png 3
```

Pointed at a replay server, this reproduces a specific trajectory — a subagent
fork, a failed call — on demand, which a live agent will not do twice the
same way.

`api.mjs` is a plain `(req, res, next)` handler, so the same code runs mounted
inside Vite in development and inside `node:http` in production. Nothing
proxies between the page and the agent in either mode.

### There is no Anthropic API here

`/api/` is just the URL namespace for this local server. The agent runs as a
subprocess — `spawn("claude", …)` — and authenticates with whatever credential
you already logged in with. The server passes its environment through and never
sets `ANTHROPIC_API_KEY`; setting one would take precedence over your login and
bill a different account.

A server is needed at all only because a browser cannot spawn a subprocess.
Something outside the sandbox has to run the CLI, and the page has to reach it.

## How a run flows

```
Composer ─▶ useRuns.startRun ─▶ httpDriver ─▶ POST /api/run
                                                   │
                                    api.mjs spawns `claude -p …` in cwd
                                                   │
                              NDJSON, one CLI event per line, forwarded as-is
                                                   │
                        parseEvent ─▶ onText / onToolUse / onToolResult / onDone
                                                   │
                                    useRuns appends to that run's events
                                                   │
                                            Trajectory renders
```

The server forwards the CLI's lines untouched rather than translating them.
That keeps event-shape knowledge in one place on the client, and it means a
saved `events.jsonl` replays through exactly the same code path as a live run.

Each run is its own POST, so concurrent runs are just concurrent fetches.
Cancelling aborts the fetch, which closes the response, which is what tells the
server to `SIGTERM` the subprocess.

### Event mapping

| stream-json                                    | handler        |
| ---------------------------------------------- | -------------- |
| `system` / `init` (`session_id`)                | `onSession`    |
| `assistant` → `text` block                      | `onText`       |
| `assistant` → `tool_use` block                  | `onToolUse`    |
| `user` → `tool_result` block                    | `onToolResult` |
| `result` (`total_cost_usd`, `num_turns`, …)     | `onDone`       |
| `result` with a non-success subtype             | `onError`      |
| `_error` (added by the server)                  | `onError`      |

The session id is taken from the `init` event rather than the final `result`,
so a run that fails partway is still resumable. A `tool_result`'s content
arrives as either a string or an array of blocks; both are handled.

## Conversations

A **round** is one prompt and everything the agent did about it, ending with
the final result event. A **run** is a conversation: several rounds sharing one
session.

The first round starts a session; the id arrives on the `init` event. Every
follow-up passes that id back as `--resume`, so the agent keeps its context
from the previous turn — ask it to "update the README for it" and it knows what
*it* is. The composer says which session a follow-up will resume before you
send it, and each resumed round is labelled with the session it continues.

### The numbers

Every finished round shows what it cost, how long it took, and how many turns
it ran — read straight off the final result event, no measurement of our own:

```
✓ finished
$0.06 · 2.8s · 2 turns · session 9cc3f365…
```

| Shown      | Field            |
| ---------- | ---------------- |
| `$0.06`    | `total_cost_usd` |
| `2.8s`     | `duration_ms`    |
| `2 turns`  | `num_turns`      |
| `9cc3f365…`| `session_id`     |

They are recorded **per round**, since that is how the CLI reports them; the
run header sums them for the whole conversation. Each carries a tooltip naming
its source field, because "turns" is jargon.

Formatting drops precision as numbers grow — tenths matter at `5.5s` and are
noise at `42s` — and `$0.00` is kept distinct from `<$0.01`, since free is not
the same as less than a cent.

### Folding a finished round

Once you move on, an earlier round folds to `▸ 23 events, folded` — but folding
keeps the *conclusion*, the closing run of assistant text. What you want back
from an old round is what it decided, not the 23 steps it took to decide it.

`splitConclusion` draws that line: only a trailing run of text blocks counts.
Text followed by more tool calls is commentary along the way, not a verdict.
The newest round never folds, and "Expand all" unfolds everything.

## Tasks

The agent is asked to break its work into logical tasks and bracket each one
with a marker in its own text:

```
[[task-start Read the parser]]
…work…
[[task-end]]
```

`server/agent-prompt.md` carries that instruction; the server appends it with
`--append-system-prompt` on every run. `TASKS=off` disables it.

**Tasks are not part of the protocol.** Subagents are — every event carries
`parent_tool_use_id`, and the CLI guarantees it. Tasks exist only because the
agent agrees to announce them, which has consequences the design has to absorb:

- Nesting comes from **order, not ids** — a start pushes, an end pops. The
  model's whole job is two literal lines, because every field it has to track
  is a field it can get wrong.
- Each agent context keeps **its own bracket stack**, so a subagent's markers
  cannot close the main agent's task.
- An unmatched `[[task-end]]` is ignored rather than allowed to pop a task it
  does not own.
- Any task still open when a round ends is **closed for it** — `done` if the
  round succeeded, `error` if it failed. A probe run confirmed this is needed:
  the agent closed its first task correctly and forgot the last one.
- A run whose agent ignored the instruction renders **exactly as it did before
  tasks existed**, flat. Nothing depends on compliance.

Tasks hold everything that happened inside them — calls, prose, subagents, and
further tasks. A task's container is its parent task if it has one, otherwise
the subagent that emitted it (`containerOf`), which is what makes tasks and
subagents nest through each other to any depth.

In the dialogue a task is a collapsible block; the running one stays open,
finished ones fold. In the outline a task opens a lane of its own — one branch,
not two, because tasks are sequential where parallel delegations are not.

## Subagents: the trajectory is a tree

The event stream is not always flat. When the agent delegates, every event the
subagent emits carries `parent_tool_use_id` — a **top-level field** naming the
tool call that spawned it. Main-agent events carry `null`.

`buildTree` groups events under that call. A run with no subagents produces
all-roots and renders exactly as it did before; the tree is only visible when
there is one. An event whose parent was never seen becomes a root rather than
disappearing — losing events is worse than showing them flat.

A subagent's work nests under its call behind a rail, and collapses to
`N events collapsed` above eight events, so a long delegation cannot bury the
main agent's trajectory. "Expand all" opens every one.

Two things the live stream taught, which guessing would have got wrong:

- The delegating tool is named **`Agent`** in this CLI version, not `Task`.
  Both are handled.
- `system` events interleave throughout, and the non-`init` subtypes
  (`task_started`, `task_progress`, …) repeat the same session id. Only
  `init` is treated as a session announcement now.

## The outline

Beside the dialogue on a wide window (≥1180px, which accounts for the history
sidebar), and a foldable strip above it on a narrow one.

It is drawn as a **flow graph**, not an indented list: a spine runs top to
bottom with one pill per call. A delegation opens a lane; several launched
together fork off the spine into parallel lanes and merge back when the main
agent resumes. A fork that ends the run has nothing to merge into, so its
lanes simply stop.

The fork bar is drawn as one segment per lane — the outer lanes stop at their
own centre — so any number of lanes works without CSS knowing the count. The
merge at the bottom is the same trick mirrored.

Two things the connectors depend on, both easy to get wrong:

- Every rule is scoped to a **direct child** (`.flow__lane > .flow__tail`).
  As descendant selectors they reached into nested forks, so an outer
  `:only-child` lane switched the merge off on every fork inside it — the
  lanes stopped dead and the next node appeared to descend out of blank space.
- A lane merges whenever anything follows it **anywhere**, not merely in its
  own list. A fork at the end of a task's lane still has to rejoin, because
  the run carries on after the task.
- A *single* lane — a task, or one subagent — merges too. Its pills sit half
  the indent right of the spine, so the merge drops and steps back by exactly
  that much. Nesting two deep gives a short staircase, one step per level.

It covers the **whole run**, round by round, with a `You` node marking each
round. Tasks and delegations are labelled by **what they were asked to do** —
a delegation's `description`, not the word "Agent", since two lanes both
reading "Agent" say nothing about which is which. Those labels wrap rather
than truncate. The **Names / Tools** switch in the outline header puts every
delegation back to its bare tool name, for when the shape of a run matters
more than the detail; the setting is remembered. Every other call shows **its tool name only**: text blocks are the dialogue, calls are
the structure, and names keep the pills narrow enough to sit two lanes wide in
a 240px column. Every pill carries its status as a dot — the same three-state vocabulary the
history list and run header use, so green/red/blue means the same thing
everywhere:

| Pill | Meaning |
| ---- | ------- |
| green dot | the call succeeded |
| red dot, red outline | the call failed |
| blue dot, blue ring | still running — the call you are watching |

A `You` node takes its round's status the same way. The header counts failures,
so a run that went wrong says so before you read any of it. Clicking a pill
scrolls to that call and flashes it; hovering names the call, its target and
its status in words.

### Sibling delegations

One agent can spawn several subagents. Consecutive delegating calls are wrapped
together under a `Tasks` heading in the dialogue, so two surveys launched for
one purpose read as one group rather than two unrelated calls. A lone
delegation stays a plain call — the heading earns its place at two.

Verified against three real captures: a flat run (no grouping), one subagent
(nested, no group heading), and two sibling subagents with three and four
nested calls respectively (grouped as `Tasks 2`).

## Status, at two levels

**Per tool call.** A call is pending from the moment its `tool_use` block
arrives until the matching `tool_result` attaches — the two share the call's
id. Pending shows a spinner and the word `running`; a result carrying
`is_error` shows `failed`, a red border, and its output inline rather than
folded away.

The edge case that matters: a run can die between a `tool_use` and its
`tool_result` (the CLI exits, the agent hits its turn limit, you press Stop).
Nothing is coming for that call, so leaving it pending would spin forever.
`sweepPending` closes out every open call whenever a run reaches a terminal
state, marking it failed with the reason.

**Per round and per run.** `running` / `done` / `error` shows in three places:
the status dot in the history list, the run header (whose status is the newest
round's), and `RoundOutcome` at the foot of each round — which is where you are
actually looking when a round ends. A failure renders as a bordered red block
with the message, not a line of small grey text you can scroll past.

A failed round does not end the conversation: the session id was captured from
the `init` event, so you can follow up and try again.

Every failure path terminates the stream rather than hanging:

| What went wrong                        | What the page shows                     |
| -------------------------------------- | --------------------------------------- |
| Directory does not exist                | 400 → `Not a directory: /bad/path`      |
| `claude` not on PATH                    | `_error` → "not found on PATH…"         |
| CLI exits nonzero with no result event  | `_error` carrying its stderr            |
| `result` with a non-success subtype     | `onError` with the result text          |
| Server unreachable                      | "server unreachable" pill in the top bar |

## The trajectory

A run renders as an ordered list of `TrajectoryEvent`s, appended as they
arrive rather than assembled at the end:

- `prompt` — what you asked
- `text` — an assistant text block, rendered as markdown (GFM)
- `tool` — one tool call: its name, its input, and its status

A tool call is appended the moment its `tool_use` block arrives, in `pending`
state with a spinner. The matching `tool_result` completes it *in place*,
matched on `tool_use_id`, flipping it to `ok` or `error`. So a call that is
still running is visible as such, which is the point of watching live.

Three display decisions worth spelling out:

- **Tool identity.** A row shows the tool name and the one field that says what
  it acted on — `file_path` for `Read`, `command` for `Bash` (`lib/tools.ts`).
  The rest of the input is one click away.
- **Result volume.** Every completed call shows its result inline. See below.
- **Scroll.** The view follows the tail only while you are already at the
  bottom. Scroll up to read an earlier event and it stops yanking you forward,
  offering a "jump to latest" affordance instead.

### Folding results

A result appears with its call, never behind a click — but a pytest log runs to
thousands of lines, and a page that buries the trajectory is a page nobody
reads. So results are folded, and the fold makes three choices:

**Head *and* tail, not head alone.** Head-only truncation is the obvious
approach and the wrong one: the most useful line of a test run is the last one
(`1 failed, 311 passed in 4.12s`), and head-only throws it away. The elision
band sits between them and is itself the control that expands it.

**Per-tool budgets.** A `Read` result is the file you just asked for, so
echoing it back earns four lines. A `Bash` result is the reason you ran the
command, so it earns eight and eight. An `Edit` diff is short and entirely
load-bearing, so it is barely folded at all.

**Failures earn more room.** A failed call gets a larger budget than a
successful one, because a failure is why you are looking in the first place.

Expanding one call also shows its full input. "Expand all" in the run header
does that for every call at once; expanded panes still scroll internally at
460px rather than pushing the trajectory thousands of lines tall.

## Runs

A `Run` is one `claude -p` subprocess: a prompt, the directory it was launched
against, the `session_id` needed to `--resume`, its messages, and the
cost/duration/turns from the final result event.

Runs are independent. Each driver invocation writes back by run id, so starting
a second run does not disturb the first, and switching runs in the sidebar does
not stop anything. The top bar shows a count while any are in flight.

A run's directory is fixed once it starts, because that is where the subprocess
was spawned. The editable directory control under the composer sets the
directory for the *next* run; a follow-up reuses the run's own.

Run state is in memory and resets on reload. Once the server owns the
subprocesses it should own this list too, so history survives a refresh.

## Appearance

Two independent axes.

**Theme** is light / dark / system. **Scheme** is one of five palettes:

| Scheme | |
| ------ | - |
| `slate` | Cool grey, indigo — the default |
| `ember` | Warm paper, terracotta |
| `forest` | Green-grey, deep teal |
| `plum` | Mauve grey, magenta |
| `mono` | No hue at all |

Each scheme declares both its palettes in one block as `--l-*` and `--d-*`;
three resolve blocks at the bottom of `index.css` pick a set. So a scheme is
written once instead of three times, and a missing token cannot silently fall
through to another scheme's value in one mode only.

Palettes are hand-tuned rather than hue-rotated — a green and a blue at the
same lightness do not read as equally heavy. Each accent is chosen not to
collide with the running/success/failed triad, which stays blue/green/red in
every scheme so status means one thing throughout.

The default scheme lives on bare `:root` and stamps no attribute, so a page
with no preference cannot flash the wrong palette.

## Parallel tool calls

Several `tool_use` blocks in one assistant message means the agent issued them
together — that is the only evidence the stream carries that calls ran at the
same time. Calls sharing a batch become parallel lanes in the outline and an
**In parallel** group in the dialogue, the same treatment two subagents get.

`server/agent-prompt.md` asks the agent to batch independent calls. **In
practice it does not comply** — asked to read four unrelated files, with a
directive instruction, it still issued four sequential calls on both attempts.
The rendering is correct when a batch arrives; producing one is not something
this CLI currently does on request. The mock driver contains a real batch so
the path stays exercised and demonstrable.

## The outline panel

Drag its left edge to resize (180–560px), double-click the edge to reset.
Every lane folds from its own caret, and a lane over eight pills arrives
folded — a thirty-call run is unreadable otherwise.
Close it from its own × or from **Outline** in the run header. Both the width
and the hidden state are remembered.

## Ctrl+B — the test prompt

Drops a canned prompt into the composer that exercises every shape the page
draws: nested tasks, two parallel subagents, a subagent inside a subagent,
several tools, and a deliberate tool failure. It is *loaded*, not sent — it
spawns an agent with tool access, so you see where it will run first.

`fixtures/everything.jsonl` is that prompt's captured output.

### How light and dark resolve

Dark values are applied twice on purpose: under `:root[data-theme="dark"]` for
an explicit choice, and under `prefers-color-scheme: dark` guarded by
`:root:not([data-theme="light"])` for the system default. A small inline script
in `index.html` stamps the saved theme *and* scheme before first paint, so
neither flashes.

## Working without the agent

`mockDriver` in `agent/driver.ts` replays a scripted trajectory on staggered
timers — read a test, run pytest, watch it fail, edit, re-run, pass — jittered
so concurrent runs drift apart. Swap it in for UI work:

```ts
useRuns(mockDriver)   // instead of the default httpDriver
```

`REPLAY=events.jsonl npm run dev` is the other option, and the more faithful
one, since it exercises the real parser on real events.

## Tests and tooling

```
npm test                # every test, once
npm run test:watch      # watch mode
npm run test:coverage   # text + html report under coverage/
npm run lint            # oxlint
npm run typecheck       # tsc -b, tests included
npm run check           # all three, in that order
```

Vitest, two projects, because the code wants two environments:

```
tests/
  helpers.ts             builders for events, rounds, runs; spy handlers
  unit/                  node — the pure logic
    format.test.ts         relative time, duration, cost, basename, title
    tools.test.ts          per-tool targets, verbs, input, result folding
    tree.test.ts           buildTree, splitConclusion, outline, grouping
    events.test.ts         sweepPending
    runs.test.ts           status, totals, error
    parseEvent.test.ts     one stream-json event → handler calls
  dom/                   jsdom — the parts that touch React or fetch
    httpDriver.test.ts     NDJSON over a stubbed fetch
    useRuns.test.tsx       run and round state, driven by a fake agent
    components.test.tsx    composer, directory field, tool call, round
  server/
    api.test.mjs           the handler, over a real http server
  fixtures/
    fake-claude.mjs        stands in for the CLI: reports its argv, then
                           succeeds, exits dirty, or hangs until signalled
```

Nothing here spawns a real agent or spends a token. The server tests run the
handler on a real `node:http` server and point `CLAUDE_BIN` at a fake CLI, so
argument construction, streaming, `~` expansion, permission flags, replay and
the failure paths are all exercised against actual sockets and subprocesses.

`vitest.config.ts` is separate from `vite.config.ts` on purpose: the dev
config mounts the run API into Vite's middleware, and a test run has no
business spawning agents.

### What the tests caught

- **A cancelled run left its subprocess alive.** The kill was hung off
  `req`'s `close` event, which fires as soon as the request *body* has been
  read — before the child is even spawned, so the listener was registered too
  late to ever fire. It is `res` that hears the browser go away.
- **`basename("/")` was empty**, so a run against the root directory had a
  blank label in the header and the directory field.

## Known limits

- Run state lives in the browser. Reloading the page abandons in-flight runs;
  the server kills their subprocesses when the response closes. Moving the run
  list server-side would fix both.
- `_stderr` lines are dropped from the trajectory. They are usually progress
  noise, and a run that dies without a result reports its stderr through
  `onError` anyway.
