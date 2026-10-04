# Fork View

An **Assignment 1** project by **Zoe Jingyi Liu** for **Harvard CS 2680: Modern AI Systems (Fall 2026)**.

Fork View uses the shape of a Claude Code log to explain parallel work. When agents work
concurrently, the log splits into columns; when a subagent delegates again, its column can fork
in turn. This design makes the structure of delegation visible within the conversation itself,
with a matching outline for navigation.

![Fork View interface](screenshot.jpg)

## Design and features

The app can run Claude Code from the browser or replay a saved trajectory. Both paths use the same
parser and display: a numbered activity log beside a forking outline.

### Parallelism as a layout

- **A log that forks.** Parallel subagents appear in side-by-side columns within the trajectory.
  Each branch includes the subagent's task brief, step count, duration and numbered calls.
  Delegation is recursive: a subagent's own subagents fork inside its column.
- **A matching outline.** The right rail represents calls as small pills (`TASK`, `READ`, `BASH`,
  ...), splitting for parallel branches and joining afterward. Click a pill to scroll to and
  highlight its call; hover to see the number, type, description and status.
- **Readable collapsed rows.** Each tool row shows a run-wide sequence number, icon, argument,
  one-line result preview, duration and status. Expand it for COMMAND / INPUT / OUTPUT / ERROR
  blocks. Long output folds behind "Show all (N more lines)".

### Metrics with visible limits

- **Cost during a run.** The header's live `≥$` value is a lower bound priced from token usage
  received so far. The final result replaces it with the run's exact reported cost. Subagent
  branches show their own token-priced `≥$` estimates, and hidden thinking appears as an estimated
  token count, such as `thinking · ~247 tokens`.
- **Clear end states.** A failed run says "no result event — metrics unavailable for this run".
  A stopped run marks pending calls "no result arrived before the run ended" and adds
  "Run stopped. Everything recorded before this point is kept."
- **Trace provenance.** Every run shows its recording location (`sessions/runs/...`) and whether
  it started or resumed a session. The raw event log and **Show raw JSON on each node** expose the
  underlying frames for inspection.

### Continuing and inspecting conversations

- **Session controls.** Send follow-ups with `--resume`, or choose an earlier session through
  **Continue from**, which shows its date, time and prompt preview. A runs list, collapsible runs,
  **expand all / collapse all**, **Stop** and **↓ Jump to latest** help navigate longer work.
- **Attachments.** Drag and drop or paste images (png, jpg, gif, webp) and PDFs up to 20 MB. The
  app saves them under `.uploads/` in the run's working directory and tells Claude to read them in
  the prompt.

## Requirements

- Node.js 22.12 or newer, and npm.
- For live runs only: the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`),
  installed and logged in. Replay works without it.

## Quick start

From the collection's root directory:

```bash
cd fork-view
npm ci
npm run dev
```

Open http://localhost:8000, or `http://<your-machine-ip>:8000` from another machine. The development
command starts Vite on port 8000 and an internal API server on port 8001, bound to loopback only.
Vite proxies `/api`, including live event streams, so the browser only needs port 8000.

For a single production process, build the UI and start the API server, which also serves the
built UI on port 8000:

```bash
npm run build
npm start
```

## Explore a recorded run

The `fixtures/` and `claude-test/` folders contain saved trajectories. Replays render instantly and
never start Claude Code.

1. Start the app with `npm run dev` and open http://localhost:8000.
2. In the **Replay** panel at the bottom, select `fixtures/parallel-deep.jsonl` under
   **Saved trajectory**.
3. Click **Replay**.

The picker lists every `.jsonl` file in `fixtures/`, `claude-test/` and, after you have made live
runs, `sessions/runs/`. Replayed runs cannot accept follow-ups. Click **New conversation** before
entering a new prompt.

### See how the design works

- **Nested delegation:** `fixtures/parallel-deep.jsonl` shows two subagents in parallel columns
  on windows about 1450 px wide or wider. The left branch has two subagents of its own. Those
  nested branches stack because each column needs about 30rem; the outline forks twice to match.
  This fixture was constructed to demonstrate the layout and is not a real trace.
- **Outline navigation:** click any outline pill to jump to its call and highlight the row.
- **Branch cost:** in `fixtures/subagent-forward.jsonl`, compare the branch header's token-priced
  `≥$` estimate with the exact run cost in RUN METADATA.
- **Long output:** open `fixtures/long-output.jsonl`, expand a tool row and use
  "Show all (N more lines)" to read the folded output.
- **A real run:** open `claude-test/events.jsonl`. Try **expand all**, open the **Raw event log**
  at the bottom or enable **Show raw JSON on each node** to compare the display with its source.

## Run Claude Code live

1. Ensure `claude` is on your `PATH` and logged in, or set `CLAUDE_BIN` as described below.
2. Under **New conversation**, choose a **Working directory**, enter a prompt and click **Run**.
3. Follow the header's `≥$` meter, the sticky "currently running" line and the forking outline.
   Press **Stop** to end the run early.
4. After the run finishes, send a follow-up in the same session, use **Continue from** to resume
   an earlier conversation or choose **New conversation** to start fresh.

### Choose a working directory

- Paths are relative to the project folder and must stay inside it. The app refuses
  `node_modules`, `sessions` and `.git`.
- The default, `claude-test/`, contains a tiny sample project (`main.py`).
- Sessions retain their working directory. Selecting one in **Continue from** also selects that
  directory. The page chooses your most recent session when it loads.
- For experiments, create a throwaway folder that git ignores, for example with
  `mkdir -p runs/scratch`, then enter `runs/scratch` in the working-directory field.

### How live runs behave

Each run starts:

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions --forward-subagent-text [--resume <session-id>]
```

The prompt is sent on stdin. **`--dangerously-skip-permissions` lets Claude Code edit files and
run shell commands without asking first.** The directory check controls where Claude starts; it
does not sandbox the process. Claude can still access anything your user account can, so use
prompts you are comfortable running unattended.

Live runs are saved to `sessions/runs/<timestamp>.jsonl`, with a `.meta.json` sidecar and a
`.stderr.log` when Claude writes to stderr. These git-ignored recordings appear in both the Replay
list and **Continue from**. If `claude` is missing or cannot start, the run is marked FAILED with
its error message; the rest of the app remains usable.

### Try a delegation prompt

```
Spawn subagents to explore the repo and report the most creative features
```

"The repo" means the selected working directory, which must remain inside the project folder.
To give the agents six apps to compare, clone this collection into the git-ignored `runs/`
folder:

```bash
git clone --depth 1 https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git runs/mads-lens
```

Set **Working directory** to `runs/mads-lens`. If the field is locked, click **New conversation**
first. If **Continue from** is visible, choose **Start a new conversation** so the run does not
resume your latest session.

No extra setting enables delegation: the command restricts no tools and sets no turn or budget
cap. The subagent tool is available as `Agent`, or `Task` in older Claude Code versions, and Fork
View recognizes both names.

Subagents launched in the same turn split the log into columns, side by side when the window is
wide enough, and the outline follows the same structure. Branch headers time each agent live and
add a `≥$` estimate when it reports back. Branches longer than six steps fold to their headers;
click a header to look inside.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8000` | Port the browser connects to: Vite under `npm run dev`, the Express server under `npm start`. |
| `HOST` | `0.0.0.0` | Interface to listen on. Use `127.0.0.1` to accept local connections only. |
| `API_PORT` | `8001` | `npm run dev` only: the internal API server port. It always listens on `127.0.0.1`. |
| `CLAUDE_BIN` | `claude` | Path or name of the Claude Code executable used for live runs. |

For example, `PORT=8130 API_PORT=8131 HOST=127.0.0.1 npm run dev` serves the app only at
http://127.0.0.1:8130. Vite uses the requested port without falling back to another one. If `PORT`
is occupied, it stops with "Port ... is already in use".

## Security note

The app has no authentication and listens on `0.0.0.0` by default. Anyone who can reach port 8000
can use it, including starting live Claude Code runs with `--dangerously-skip-permissions` as
your user. On shared or untrusted networks, start it with `HOST=127.0.0.1`.

## Tests

```bash
npm run check
```

These offline checks cover event parsing, conversation state, subagent hierarchy, upload
validation, rendering and the composer's **Continue from** picker. They require neither a running
server nor Claude Code.

The separate end-to-end suite, `scripts/check-browser.mjs`, drives the built app in a
Chromium-based browser using `CHROME_PATH` and `BASE_URL`. **It performs live Claude Code runs**,
requires a logged-in `claude` and uses API credits. `scripts/record-subagent.mjs`, which recorded
the `fixtures/subagent-*.jsonl` files, also runs Claude Code live.

## Project layout

| Path | Purpose |
| --- | --- |
| `server/` | Express API: starts Claude Code, streams frames over server-sent events, lists and serves trajectories, accepts uploads |
| `frontend/` | React UI (Vite) |
| `shared/` | Code shared by server, UI and checks: event parsing, conversation state, subagent hierarchy, pricing, attachment rules |
| `scripts/` | Dev launcher (`dev.mjs`) and the check suites |
| `fixtures/` | Recorded trajectories used for replay and by the checks |
| `claude-test/` | Default working directory for live runs, plus a sample recorded run (`events.jsonl`) |
| `sessions/runs/` | Recordings of your own live runs (created on first run, git-ignored) |

## Known limitations

- On Node versions older than 22.22.2, `npm ci` prints an `EBADENGINE` warning from `jsdom`, a
  development-only dependency used by the checks. The warning is harmless; the app and
  `npm run check` work on 22.22.0.
- The header's live `≥$` meter appears only during live runs. Replays show `≥$` estimates on
  subagent branch headers.
- Only subagents fork the view. Parallel ordinary tool calls, such as two simultaneous web
  searches, stack in the outline rather than appearing side by side.
- Side-by-side agent columns are narrow, so wide code blocks scroll horizontally.

[Back to the Assignment 1 showcase](../README.md)
