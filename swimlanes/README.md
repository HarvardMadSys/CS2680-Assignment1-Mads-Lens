# Swimlanes

A single-file Claude Code trajectory viewer with a real time axis: one swimlane per agent, zoom, and follow-live.

![screenshot](screenshot.jpg)

Created by Eric Gong.

## What it does

Swimlanes is a small web front end for headless Claude Code (`claude -p --output-format stream-json`). You type a prompt, the server runs Claude Code in a working directory you choose, and the page shows each event as it arrives. It is one Python file with the HTML and JavaScript inline, and it uses only the standard library. The page header reads "Claude Code · trajectory viewer".

The page has two views of the same session. You can switch between them at any time, including during a run.

**Timeline** (the signature view)
- A real time axis in seconds. Every tool call is drawn as a block that starts when the call was made and is as wide as the call took.
- One lane per agent: the main agent, plus a lane for each subagent (Task/Agent call). Each subagent lane is labelled with its task description and the model it ran on, e.g. `Survey src/ directory · sonnet-5`. Subagents running at the same time sit one above the other, so you can see the overlap at a glance.
- Calls that overlap inside one lane are packed into sub-rows. Blocks are coloured by tool. Pending calls show animated stripes, and failed calls get a red outline. Assistant text appears as grey blocks.
- Orange markers show where each prompt was submitted, and grey markers show where each run ended. Later runs land further along the same axis.
- A zoom slider runs from 4 to 400 px/s. With **follow live** on, the view keeps scrolling to the newest events. It switches off on its own when you scroll back to look at something.
- Click any block to open a dialog with the start time, duration, status, which agent made the call, the full input JSON and the full result. A **→ show in the conversation** link jumps to the same call in the other view.

**Conversation**
- One card per prompt. Assistant text is rendered as markdown. Each tool row shows the tool name, the command or path, a live duration, and ✓ / × error / pending. A short preview of the result sits under each row. Click the row to see the full input and result. Long output is folded after 12 lines, and you can unfold it.
- Subagent work is nested under its Agent row, with a provenance line such as `subagent · ran on sonnet-5 · 3 events`. When the agent sets a model on the call, the line also says which one it asked for: `subagent · asked for sonnet · ran on sonnet-5 · 4 events`.
- Each card shows chips for the working directory, model, subagent policy, resumed session and start time. A footer gives the cost, wall-clock time, number of turns and session id.
- An **Outline** rail on the left lists every prompt, tool call and subagent call. Click an entry to jump to it.
- A header pill shows the run status, with a count of pending calls while a run is going.

**Model controls**
- A **model** box sets the model for the main agent.
- A **subagents** box sets a policy for subagent models: *auto (agent picks per task)*, *always haiku / sonnet / opus*, or *inherit (no instruction)*. The policy is passed to Claude Code with `--append-system-prompt`, and it asks the agent to set the Task tool's `model` explicitly. If your prompt names a model for a piece of work, the prompt wins.

**Sessions and replay**
- A follow-up prompt resumes the last live session (`--resume`). Click **New session** to make the next prompt start fresh.
- **Replay…** plays back any saved stream-json recording through the same views, without starting Claude Code.

## Requirements

- Python 3.7 or newer (tested with 3.11). Nothing to install.
- For live mode only: the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on your `PATH`, already logged in.

## Quick start

```bash
cd swimlanes
python3 website.py
```

Open http://localhost:8000 (or `http://<your-machine-ip>:8000` from another machine).

The server does not need `claude` to start or to replay.

## Try it without Claude (replay)

Two Claude Code recordings with subagents are included in `recordings/`:

| File | What it is |
|---|---|
| `recordings/two-parallel-subagents.jsonl` | The main agent sends two *Survey* subagents (on sonnet) through a small Python project in parallel, then writes one combined summary (about 50 s, $0.59, 5 turns). |
| `recordings/team-cafe.jsonl` | A short planning run that delegates to three parallel subagents, one of which hands part of its work to a nested subagent. |

1. Start the server (see Quick start) and open the page.
2. Click **Replay…** at the bottom right. The dialog suggests `recordings/two-parallel-subagents.jsonl`. Click OK.
3. The recording plays at 4× its recorded speed, and no gap waits longer than 5 s. The header pill reads `running · N pending` while it plays and `finished` at the end.

A relative path is looked up first from the directory you started the server in, then from the `swimlanes/` folder, so `recordings/...` works wherever you start it from. Absolute paths work as well. To replay one of your own runs, save it with `claude -p "<prompt>" --output-format stream-json --verbose > my-run.jsonl` and enter that path.

## Things to try

- Start the `two-parallel-subagents.jsonl` replay and switch to **Timeline** while it plays. The main agent's lane and two subagent lanes (`Survey src/ directory · sonnet-5`, `Survey tests/ directory · sonnet-5`) fill in from left to right at the same time.
- Drag the zoom slider all the way left to fit the whole run on screen, then right to spread the blocks out and read their labels.
- Click a block, for example one of the pink `Agent` blocks or a yellow `Bash` block in a subagent lane, to see its full input and result. Then use **→ show in the conversation** to jump to the same call in the Conversation view.
- When the first replay has finished, replay `recordings/team-cafe.jsonl`. The second run gets its own prompt marker further along the same time axis and four new lanes: three parallel subagents (`Zoning and use permits`, `Accessible route and restrooms`, `Plumbing and electrical loads`) and the nested `Grease interceptor sizing`.
- In **Conversation**, click entries in the Outline, expand a tool row to see the full output, and look at the `subagent · ran on … · N events` line under each Agent call.
- Use the ☼ button to switch between the dark and light themes.

## Live mode with Claude Code

1. Install the `claude` CLI and log in. The server removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment it gives Claude Code, so live runs use your stored Claude Code login and not an API key.
2. Choose a working directory. It defaults to the bundled `claude_scratchpad/`, a toy Python project (`two_sum.py` plus tests). You can start the server with another one, `python3 website.py --dir ~/scratch/my-repo`, or change the **working dir** field before each run. If the directory does not exist, the run fails with a visible error.
3. Type a prompt and press Enter (Shift+Enter adds a newline). **Stop** ends the current run.

Each live run spawns:

```
claude -p "<prompt>" --output-format stream-json --verbose --forward-subagent-text \
       --dangerously-skip-permissions [--model <model>] [--resume <session>] \
       [--append-system-prompt <subagent model policy>]
```

**Every live run uses `--dangerously-skip-permissions`.** Claude Code will edit files and run shell commands in the working directory without asking first. Point it only at a scratch directory you don't mind changing, never at your home folder or a repository you care about. Live runs on the bundled `claude_scratchpad/` will change those files.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `PORT` env / `--port` | `8000` | Port to listen on. The flag overrides the env var. |
| `HOST` env / `--host` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to listen only on this machine. |
| `--dir` | `./claude_scratchpad` (next to `website.py`) | The working directory the page starts with. You can change it per run on the page. |
| `--model` | `sonnet` | The main-agent model selected when the page opens. The model box offers *default* (no `--model` flag), `opus`, `sonnet`, `haiku` and `fable`. |
| `CLAUDE_BIN` env | `claude` | The Claude Code executable to run. |

Examples:

```bash
PORT=9000 python3 website.py
HOST=127.0.0.1 python3 website.py
python3 website.py --port 9000 --host 127.0.0.1 --dir ./claude_scratchpad
python3 website.py --help
```

## Security note

By default the server listens on `0.0.0.0`, so anyone who can reach port 8000 can use the page, and there is no login. In live mode that means they can run Claude Code on your machine with `--dangerously-skip-permissions`, in any directory they type into the working-dir field. **Replay…** will also open any file path they enter that your user account can read. On a network you don't trust, start it with `HOST=127.0.0.1`.

## Project layout

```
website.py           the server (http.server + SSE) and the whole page, inline
claude_scratchpad/   toy project used as the default working directory for live runs
recordings/          two Claude Code stream-json recordings for Replay…
screenshot.jpg
```

There is no test suite.

## Known limitations

- One run at a time. Starting another while one is running gives "A run is already in progress."
- The event log is kept in memory. Reloading the page replays the whole session, and restarting the server gives you a clean page.
- After a replay, the header shows the recording's session id with "(follow-ups resume it)". Replayed sessions are never resumed, though: the next live prompt continues the last *live* session, or starts a new one if there wasn't one.
- When you zoom far out, prompt-marker labels can overlap. Short calls are too narrow to show more than a letter or two of their label, so click a block (or hover over it) to read it. Long subagent lane labels are cut off.
- In the short gap between a run's result event and the process exiting, the card footer can read "× failed" before it changes to "✓ finished".
- An Agent row launched in the background is marked done as soon as the launch returns, not when the subagent finishes. The subagent's lane shows when its work actually happened.
