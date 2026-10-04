# Controller

A hardware-style control surface for steering Claude Code (effort knob, model keys, subagent fader) with a radial scope of the agents at work.

![screenshot](screenshot.jpg)

Created by Raul Romero.

## What it does

Controller is a browser front end for the `claude` CLI, styled after a piece of music hardware.
Settings you would normally type into a prompt or pass as flags become physical-looking controls that
stay put between runs. The run streams into the middle of the board, and a radial "scope" shows how the
work is spread across the main agent and its subagents.

- **Router: effort knob and model keys.** Turn the knob (drag, scroll or arrow keys) through
  `low · medium · high · xhigh · max`, and press a model key (`opus`, `sonnet`, `haiku`, `fable`).
  These become `--effort` and `--model`. The `route` readout in the top bar shows the current pair.
- **Subagent fader.** An LED fader from 0 to 25 sets how many subagents may run at once (passed to the
  child as `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). At 0 the `Agent`/`Task` tools are withheld entirely.
- **Delegation switch.** "Delegation required" drives the main loop with a generated `orchestrator` agent
  that only has `Agent`, `Task`, `Read`, `Glob`, `Grep` and `TodoWrite`. It cannot edit files or run
  commands itself, so it has to delegate, and it is asked to split the work into as many pieces as the
  fader says. "Optional" leaves the choice to the model.
- **Custom agents.** `+ define agent` adds named agents (description, prompt, tool list) that are passed
  with `--agents`. The `main loop` selector picks which agent drives the session (`--agent`).
- **Capabilities.** The board asks your local Claude Code which tools, skills and MCP servers it has.
  Skill chips insert `/skill-name` into the prompt. The skills search queries the
  [skills.sh](https://skills.sh) registry, shows install counts, and has an **add** button. MCP servers
  are isolated (`--strict-mcp-config`) unless you flip "full environment".
- **Instructions.** Text in this module is appended to the system prompt on every run.
- **Version control.** `diff` and `commit` place a ready-made prompt in the command bar for you to run.
  The branch icon at the top right opens a merge panel (see [Live mode](#live-mode-with-claude-code)).
- **Trajectory.** Every tool call is a card: JSON input, line-numbered result, a `✓`/`✕` mark, and folds
  ("show 30 more lines"). Errors are outlined in red. Calls made by a subagent carry a `sub` badge and
  nest inside the `Agent` card that started them.
- **Scope.** A dial with the main agent as the hub and one satellite per subagent. Each node shows how
  many of its calls have finished and has a progress ring. Links to busy subagents are dashed and pulse,
  and a node turns red when one of its calls fails.
- **Outline.** A foldable tree of every call, nested by agent. Click a row to jump to its card.
- **Readouts.** LCD-style tiles for cost, time, turns, calls and route.
- **Follow-ups mid-turn.** A message sent while the agent is working joins the running session.
  Pressing the run key with an empty prompt stops the current turn. "Continue session" resumes the
  previous session with `--resume`; the circular-arrow button at the top right starts a fresh one.
- **Also:** attach text files as context (`file`), dictate with the mic (Web Speech API, where the
  browser supports it), `F` for full screen, and `C` / `S` to show the controls or scope on narrow screens.
- **Recording and replay.** Every live run is recorded to `runs/<timestamp>.jsonl`, and any recording can
  be replayed into the board without calling Claude.

## Requirements

- **Node.js 22.18 or newer.** The server is TypeScript run directly by Node, with no build step.
  On Node 22.6 to 22.17, start it with `node --experimental-strip-types src/server.ts` instead of
  `npm run serve`.
- npm. There are no runtime dependencies; `npm install` only fetches TypeScript and the Node types for
  `npm run typecheck`.
- For live mode only: the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
  on your `PATH` and logged in.
- Optional: network access for the skills.sh search, and `git` for the merge panel.

## Quick start

```bash
cd controller
npm install
npm run serve
```

Open http://localhost:8000 (or `http://<your-machine-ip>:8000` from another machine).

## Try it without Claude (replay)

Two recordings ship in `demo-runs/`. Replay one by naming it in the URL:

1. Start the server as above (`npm run serve`).
2. Open http://localhost:8000/?replay=subagent-forward.jsonl&delay=80
3. Then try http://localhost:8000/?replay=team-cafe.jsonl

How replay works:

- `replay=<file>.jsonl` is looked up in `runs/` first (your own recorded live runs), then in `demo-runs/`.
- `delay=<ms>` sets the pause between lines, so you can watch the run stream in. Leave it out to load
  the whole run at once.
- There is no in-app picker. To replay one of your own runs, use its file name from `runs/`.
- Without the `claude` CLI, the capabilities module shows "probe failed". That is expected, and
  everything else works in replay. With the CLI installed, see the capabilities note under Live mode.
- In a terminal, `npm run replay -- demo-runs/team-cafe.jsonl` prints the same run as a call tree.

The demo recordings are real Claude Code sessions from other projects, so they contain file paths from
the machines they were recorded on.

## Things to try

- **Subagent nesting.** Open `?replay=subagent-forward.jsonl&delay=80`. An `Agent` call appears, then its
  subagent's `Bash` and `Read` calls stream in nested under it with `sub` badges, while its satellite in
  the scope counts up to 11 beside the main hub's 6.
- **A team of agents.** Open `?replay=team-cafe.jsonl`. Four subagent satellites surround the main agent,
  including a subagent started by another subagent. The outline shows that nesting.
- **Work the controls.** Drag the effort knob up or down, scroll on it, or focus it and use the arrow
  keys, and watch the `route` readout. Press a model key. Drag or scroll the subagent fader; at 0 the
  delegation switch reads "delegation off". Flip "delegation required".
- **Skills search.** In *capabilities*, open the **skills** row (`+`) and type `frontend design` to see
  skills.sh results with install counts. This needs network access. **add** really installs the skill
  (see below), so don't press it just to look.
- **Navigate.** Click rows in the outline to jump to cards, fold subagent groups, and press `F` for
  full screen.

## Live mode with Claude Code

1. Install the `claude` CLI and log in.
2. Start the server (`npm run serve`) and open the page.
3. Press **+** (bottom left) to open the run settings: working dir, `--add-dir`, **bypass perms** and
   **continue session**.
4. Type in the command bar and press **run**.

**Working directory.** The default is `sandbox/` inside this folder. It is git-ignored and created on the
first run. Put a scratch copy of a project there, or point the working dir at another scratch directory.

**Permissions: dangerous default.** **Bypass perms is on by default**, which runs Claude Code with
`--dangerously-skip-permissions`. Every tool call is approved without asking: Claude can edit or delete
files and run any shell command as your user, and nothing keeps it inside the working directory
(`sandbox/` sits inside your clone of this repository). Only use it on a scratch directory, ideally in a
container or VM. With bypass perms off, runs use `--permission-mode acceptEdits` (file edits are
auto-approved; other tools that need approval are not).

**Command line.** Each run starts
`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --strict-mcp-config --forward-subagent-text --model <key>`
plus `--effort`, `--agent`, `--agents`, `--append-system-prompt`, `--add-dir`, `--resume` and the
permission flag, as set on the board. The prompt is sent over stdin, which is how follow-ups can join a
running turn. Every run is recorded to `runs/<timestamp>.jsonl`.

**Capabilities probe.** Each page load, and each flip of "full environment", briefly starts `claude -p`
in the directory the server was started from, to read its tools, skills and MCP servers. The process is
killed as soon as its `init` event arrives, which is meant to be before any model request.

**Merge button (branch icon, top right).** It finds the git repository containing the working dir and
shows a preview (branch, commits ahead of `main`). Pressing **merge** checks out `main`, runs
`git merge --no-ff <branch>`, and **pushes `main` to the first remote**. As a safeguard, Controller
refuses to merge in the repository that contains Controller itself, which is where the default
`sandbox/` resolves. To use it, make the working dir a separate repository (another project, or
`sandbox/` after running `git init` inside it), and remember that it pushes.

**Skills add.** **add** runs `npx -y skills@latest add <owner/repo> --project --yes` in the Controller
folder. It downloads third-party skill files from GitHub and installs them into this folder (for example
under `.claude/skills/`). Those paths are git-ignored here.

**Terminal driver.** `npm run drive -- --help` lists the options of a headless driver that runs one prompt
and prints the call tree. It defaults to `--permission-mode acceptEdits`; with `--skip-permissions` it
runs in `sandbox/` unless you pass `--cwd`.

**Example prompt.** A prompt that gets several subagents working at once:

```
Spawn subagents to explore the repo and report the most creative features
```

"The repo" is the working dir, and any existing directory is accepted. Use a throwaway clone of the app
collection Controller comes from, separate from the checkout you run it in; it gives the subagents eight
apps to compare:

```bash
git clone --depth 1 https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git ~/scratch/mads-lens
```

Press **+** and set **working dir** to the clone's full path, as printed by `echo ~/scratch/mads-lens` (the
server does not expand `~`). If you have already run something on this page, press the circular-arrow
button first, so the run starts a fresh session instead of resuming the last one. Nothing else needs
enabling, with **bypass perms** on or off: the server passes no `--allowedTools` or `--tools` list and no
turn or budget cap, so the subagent tool (`Agent`, or `Task` in older Claude Code versions) is available
as long as the subagent fader is above 0 (it starts at 4). "Delegation optional" is enough, since the
prompt asks for subagents; to ask for eight at once, set the fader to 8 and flip "delegation required".

While it runs, each subagent gets a satellite in the scope that counts its finished calls next to the main
hub, with a dashed, pulsing link while it is busy. In the middle of the board its calls arrive with `sub`
badges inside the `Agent` card that started it, and the outline nests them the same way, so you can fold
each subagent away.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` keeps it local) |

Example: `HOST=127.0.0.1 PORT=9000 npm run serve`.

Everything else is set on the board. Recordings go to `runs/`, the bundled recordings live in
`demo-runs/`, and the default working dir is `sandbox/`, all relative to this folder.

## Security note

The server listens on `0.0.0.0` by default, so anyone who can reach port 8000 can use it. In live mode that
means anyone on your network can run Claude Code on your machine, with permission checks bypassed by
default, and can trigger the merge-and-push and skill-install endpoints. There is no authentication. On an
untrusted network, start it with `HOST=127.0.0.1 npm run serve`.

## Project layout

```
src/server.ts     HTTP server: static files, run stream, follow-ups, replay, capabilities probe,
                  skills search/install, git merge
src/runner.ts     spawns `claude -p` and yields its stream-json events
src/cli.ts        terminal driver (npm run drive)
src/replay.ts     prints a recording as a call tree (npm run replay)
src/tree.ts       call-tree builder used by the terminal tools
src/types.ts      stream-json event types
public/           the board: index.html, app.js, style.css, Geist fonts
demo-runs/        two bundled recordings for replay
design/           Blender study the interface's look and palette were taken from
```

Type-check with `npm run typecheck`.

## Known limitations

- Final answers are shown as plain text; Markdown is not rendered.
- The time and turns readouts come from the latest `result` event, so in a long session they can
  describe only the last turn while the calls count covers everything.
- "Delegation required" relies on the orchestrator agent and the prompt, not a hard guarantee, and
  "optional" does not stop the model from delegating.
- The scope reads "done" when the main turn finishes, even if a background subagent is still streaming
  calls.
- There is no replay picker; recordings are chosen by URL.
