# Sankey Flow

An **Assignment 1** project by **Ibrahim Khaliliya** for **Harvard CS 2680: Modern AI Systems (Fall 2026)**.

Sankey Flow explores a visual question: where do an agent's calls and time go? It maps a Claude Code
session into flows between runs, agents, actions and outcomes. Alongside that overview, live speed
gauges and a cat whose movements follow the token rate give the interface a playful sense of pace.

![Sankey Flow interface](screenshot.jpg)

## Design and features

The project pairs two views of the same session. **Flow** emphasizes how work is distributed;
**Timeline** lets you follow the individual steps. Both connect back to the transcript, so a diagram
can lead you to the tool call or agent activity behind it.

- **Flow: a Sankey diagram of the session.** Four columns connect **Runs → Actors → Actions → Outcomes**.
  Each prompt is a run; the actors are Claude and its subagents. The Actions column has a shared
  **LLM turn** node and a node for each tool, such as Read, Bash and Agent. Outcomes are Completed,
  Failed and Stopped, with In progress for a live run. The **Calls | Time** toggle changes ribbon
  thickness from call counts to time spent. Hover a node or ribbon for its calls, time and share of the
  column; click a node to trace it in the transcript; or use a legend chip to isolate a category.
- **Timeline: a graph of the steps.** A Cytoscape.js + dagre graph places runs, assistant messages,
  thinking, tool calls and results in time order. Dashed boxes group each subagent's steps. Search
  highlights matches, and Enter cycles through them. Zoom, fit, top-down / left-right layout and a
  **follow** switch help navigate the graph; follow keeps the newest step visible during a live run.
  Clicking a node jumps to its transcript card.
- **Trajectory card: a session overview.** A Flow thumbnail sits alongside counts of LLM turns, tool
  calls, subagents and failures, badges for the most-used tools such as `Read ×4`, and wall time.
  These update as the run streams. **Expand** opens the full-screen Flow / Timeline modal.
- **Pace strip and animated cat.** During live runs, token-level events provide **TTFT** (time to first
  token, per API request and as an average), **TPOT** (milliseconds per output token, with smoothed
  tokens/s), and **latency** for the last tool call and full API turn. The cat sleeps when idle, sits
  while waiting for a token or tool, walks below 25 tokens/s and runs at or above that rate. Its
  animation speed also follows the token rate. These features use `--include-partial-messages` and
  are available only during live runs.
- **Transcript with nested agent activity.** Assistant text renders as Markdown; thinking rows show a
  token estimate. Tool cards contain key inputs, results and a pending / completed / failed status.
  Subagent activity nests under the Agent call that started it. The decoded `init` event shows the
  model, permission mode, and tool and MCP server counts. Hooks, compaction, permission denials and
  API errors have their own lines. A completed run's footer includes cost, duration, API time, turns,
  input and output tokens, subagents, TTFT and TPOT.
- **Policy panel.** Set a per-run budget, choose allowed built-in tools and enter deny patterns. The
  server translates these settings into `--max-budget-usd`, `--tools` and `--disallowedTools`.
- **Sessions browser.** Reopen earlier Claude Code sessions, including those started in a terminal.
  Opening a session rebuilds its transcript and both trajectory views. The next prompt continues it
  with `--resume`, provided its original working directory still exists.

The app uses Flask to run `claude -p ... --output-format stream-json` in the selected working directory
and relay events to the browser through Server-Sent Events. Reading saved sessions from
`~/.claude/projects` does not start Claude.

## Requirements

- Python 3.9 or newer, tested with 3.11. Flask is the only dependency.
- No Node.js or build step is needed. daisyUI, the Tailwind browser runtime, Cytoscape.js and dagre are
  bundled in `static/vendor/`.
- **For live mode only:** the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
  (`claude`), installed and logged in. Saved sessions and the bundled demo work without it.

## Quick start

From the collection's root directory:

```bash
cd sankey-flow
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open [localhost:8000](http://localhost:8000), or `http://<your-machine-ip>:8000` from another machine.
With this command, **Sessions** reads your own Claude Code sessions from `~/.claude/projects`.

## Try the bundled demo without Claude

The recording in `demo/claude-projects/` uses Claude Code's transcript format. It follows one run in
which Claude invokes a Skill, then sends two Explore subagents in parallel to survey a small Python
project's `src/` and `tests/` directories. It contains 7 LLM turns and 9 tool calls.

1. Start the app with `--demo` to read the bundled sessions instead of `~/.claude/projects`:

   ```bash
   .venv/bin/python app.py --demo
   ```

   You can select the same store explicitly with
   `CLAUDE_PROJECTS_DIR=$PWD/demo/claude-projects .venv/bin/python app.py`.
2. Open [localhost:8000](http://localhost:8000) and click **Sessions** at the top right.
3. Tick **all directories**, then select the session. The initial list is filtered to your current
   working directory, while the demo was recorded in a different one.
4. Inspect the rebuilt transcript, where both subagents are nested under their Agent cards. The note
   below the prompt box explains that the original directory is missing on this machine: you can
   review this session but cannot continue it.
5. Click **Expand** on the Trajectory card at the left to open the Flow and Timeline tabs.

## Explore the design

- **Compare calls and time.** In **Flow → Calls**, the three actors are close in size. Switch to
  **Time** and LLM turn dominates the Actions column: 7 calls take about 51 seconds, compared with
  about a second each for Read and Bash. Hover a node or ribbon to inspect its share.
- **Follow a tool through the transcript.** Click the **Read** node to outline its four cards and fade
  the rest. **Clear highlight** or Escape resets the view. Clicking a Run node or subagent actor
  closes the modal and flashes its card.
- **Focus on one category.** Click the **Subagent** legend chip to fade other categories; click it
  again to restore them.
- **Search the steps.** In **Timeline**, search for `Read` to highlight matching steps ("5 of 16").
  Press Enter to cycle through them, then try **Top-down / Left-right** and **Fit**.
- **Change the theme.** The header's Auto / Light / Dark switch updates the Sankey palette and graph
  colours as well as the rest of the page.
- **Watch the live pace.** For a live run in a scratch folder, watch the cat wake up and the
  TTFT / TPOT / latency tiles populate. Replayed sessions have no token-level events, so those tiles
  show "—" and the cat stays asleep.

## Live mode with Claude Code

Install and log in to the `claude` CLI, and make it available on your `PATH` or set `CLAUDE_BIN`.
Live runs consume Claude usage.

For each prompt, the server starts this command in the selected working directory:

```
claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions \
    --include-partial-messages \
    [--resume <session_id>] [--max-budget-usd <amount>] [--tools <names>] [--disallowedTools <pattern>...]
```

> **Every run uses `--dangerously-skip-permissions`.** Claude can read, write and delete files and run
> shell commands in the chosen directory and beyond it, without asking. Use a scratch directory.

### Choose a working directory and start a session

On first launch, the picker starts in `workspace/`, a git-ignored scratch folder created next to
`app.py`. Set `CLAUDE_FRONTEND_WORKDIR=/path/to/scratch` to change that initial location.

The picker can browse any directory. **Jump to…** lists Home, the scratch workspace, the disk root and
folders from `CLAUDE_FRONTEND_DIRS`. You can also paste or type a path and press Enter, use **↑ Up**,
or select a subfolder. The browser remembers the last directory you used. Once a session begins, the
picker stays locked to that directory until you choose **New session**.

Press **Run** or ⌘/Ctrl + Enter to submit a prompt. Follow-up prompts continue the same session with
`--resume`. **Stop** terminates the running process.

### Set the policy for the next run

The collapsible **Policy panel** above the prompt box remembers its settings in the browser and applies
them to the next run.

| Control | Effect | Flag |
|---|---|---|
| Budget cap (USD), with 0.25 / 1 / 5 / none presets | Sets a per-run spending cap. Claude checks after each turn, so a single turn can overshoot a small cap. | `--max-budget-usd <amount>` |
| Allowed tools, with a checkbox per built-in tool and all / none / read-only presets | Restricts built-in tools. Checking everything omits the flag. MCP tools are unaffected. | `--tools <name,...>` |
| Deny patterns, comma-separated | Refuses matching rules even for allowed tools, such as `Bash(git push *)`, `Edit` or `mcp__server__tool`. Accepts up to 50 rules of 200 characters each. | `--disallowedTools <pattern> ...` |

The server validates these settings and returns HTTP 400 with a plain message for invalid input.

### Try a prompt with subagents

This prompt asks Claude to delegate work:

```
Spawn subagents to explore the repo and report the most creative features
```

Here, "the repo" means the selected working directory. Any existing directory is accepted. A
throwaway clone of this collection gives the subagents six apps to compare:

```bash
git clone --depth 1 https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git ~/scratch/mads-lens
```

Choose **New session** if a session is already open, then enter `~/scratch/mads-lens` in the
**Working directory** field and press Enter.

With every tool checked, the default, subagents require no extra setup: the server sets no turn cap
and omits `--tools`. Check any policy settings saved from earlier runs, though. Both **read-only**
and **none** omit **Task (subagents)**; choose **all** or check that box to enable delegation, and keep
`Task` and `Agent` out of the deny patterns. Newer Claude Code versions name the tool `Agent`, but the
**Task** checkbox still enables it. If you use a budget cap, allow for the additional cost of several
subagents.

During the run, open **Expand**. Each subagent joins the Flow's Actors column with its type and
description. Its Agent call stays **In progress** until the report returns, and **Time** shows which
agent Claude waited for longest. A background subagent is different: its Agent call completes at
launch. The cat and TTFT / TPOT tiles track only the main agent, so the cat sits in its waiting state
while Claude waits for subagents.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `PORT` / `--port` | `8000` | HTTP port |
| `HOST` / `--host` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to accept local connections only. |
| `--demo` | off | Read sessions from the bundled `demo/claude-projects/` instead of `~/.claude/projects` |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code transcript store read by the Sessions browser |
| `CLAUDE_FRONTEND_WORKDIR` | `./workspace` (next to `app.py`) | Initial directory-picker location; created if missing |
| `CLAUDE_FRONTEND_DIRS` | empty | Extra quick-jump folders, separated by `:` |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code executable |

For example, `HOST=127.0.0.1 PORT=8140 .venv/bin/python app.py` binds locally on port 8140. The
equivalent flags are `.venv/bin/python app.py --host 127.0.0.1 --port 8140`.

## Security note

The default address is `0.0.0.0:8000`, and the app has no authentication. Anyone who can reach that
port can browse directory names, read saved Claude Code sessions and, in live mode, run Claude Code
on your machine with `--dangerously-skip-permissions`. On an untrusted network, start the app with
`HOST=127.0.0.1`. It uses Flask's built-in development server, which is intended for local use.

## How the numbers are defined

- **TTFT** measures from the start of a request, either the run start or the last tool result returned
  to Claude, to the first streamed content in its reply. **TPOT** is the message's streaming time
  divided by `max(1, tokens − 1)`. The tokens/s value is `1000 / TPOT`, smoothed with an exponential
  moving average. **Latency** reports the last tool call (`tool_use` → `tool_result`) and the last
  full API turn.
- **Flow time measures resource time, not wall-clock time.** Parallel tool calls overlap, as do tools
  running while the model streams. Subagent time appears both in Claude's Agent wait and in the
  subagent's own lane. Consequently, Actors and Outcomes totals can exceed a run's wall time.
  Relevant tooltips mark this with "latencies overlap".
- **Trajectory counts cover the whole session, including subagents.** Its LLM turns can exceed the
  Turns count in a run footer, which counts only the main agent.

## Project layout

| Path | Role |
|---|---|
| `app.py` | Flask server: directory browsing, session store reader, run launcher, SSE stream and stop |
| `templates/index.html` | Page layout with daisyUI components, sessions and trajectory modals, and the inline-SVG cat |
| `static/app.js` | Event rendering, run and tool status, sessions, pace metrics and cat, trajectory tree and summary card, and Flow / Timeline wiring |
| `static/flow.js` | `CCFlow`: builds Runs → Actors → Actions → Outcomes data and draws a dependency-free SVG Sankey |
| `static/style.css` | Layout, pace strip and cat animation, Flow palette, graph tooltips and Markdown styles |
| `static/vendor/` | daisyUI 5, Tailwind 4 browser runtime, Cytoscape.js, dagre, cytoscape-dagre |
| `demo/claude-projects/` | One recorded session with two subagent transcripts for exploring the app without Claude |

## Known limitations

- Live runs are held in memory and are forgotten when the server restarts. Sessions that Claude Code
  saved in its transcript store remain available through **Sessions**.
- You can review a saved session whose original directory is missing, including the bundled demo,
  but you cannot continue it.
- Replayed sessions do not contain token-level stream events, so the pace tiles and animated cat work
  only in live mode.

[Back to the Assignment 1 showcase](../README.md)
