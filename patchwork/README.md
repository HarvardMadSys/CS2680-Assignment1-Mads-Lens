# Patchwork

An **Assignment 1** project by **Djordje Ivanovic** for **Harvard CS 2680: Modern AI Systems (Fall 2026)**.

Patchwork makes a Claude Code run look like a team working together. Its named characters, agent
lanes and handoff cards help readers follow who received a task, what each agent did and what came
back to the lead. The character designs give delegation a human reference point while the interface
keeps the underlying tool calls available to inspect.

![Patchwork interface](screenshot.jpg)

## Design and features

The app runs the `claude` CLI in a folder you choose. A three-column layout places chat history on
the left, the conversation in the middle and a collapsible **Trajectory** panel on the right.

### A cast of agents and visible handoffs

- **One lane per agent.** In **Lanes**, the lead's column lists assignments in order, such as
  "Assigned · Client app & state architecture → Assigned to Haru". Return cards include an excerpt
  of each answer, such as "Result returned · From Inês → Returned to Djordje". Each subagent's lane
  begins with "Assigned by Djordje" and ends with "Result returned", so the handoff is readable
  without opening a tool card.
- **Consistent characters.** The main agent is "Djordje Ivanovic · Lead". Subagents become Haru,
  Inês, Camila, Irina, Elliot and others: 13 characters in all, each with an avatar and colour that
  stay consistent across the conversation, lanes and resumed runs. Click the top-bar mascot to
  meet the crew. These identities are display elements only; they are never added to prompts or
  sent to the model.
- **Order without implying elapsed time.** Global `#` numbers connect events across lanes. The
  label "Observed event order · compact lanes, not elapsed time" makes the distinction explicit:
  the view shows interleaving, not a precise timeline.

### From an overview to individual steps

- **Grouped activity.** Adjacent reads, searches, edits and shell commands fold into a summary
  such as "13 steps · Inspecting files · Read 13 files · App.tsx, ChatStore.tsx…". **Show individual
  steps** opens the group. Failures appear separately under **Steps needing attention**.
- **Agent and step inspection.** Selecting an agent or step highlights its lane and opens a
  **Task / Activity / Result** inspector. From there, jump to the exact tool call in the
  conversation. **Call outline** offers a nested list of tool names with foldable branches.
- **Conversation details.** Replies stream as Markdown. Tool rows show Claude's description,
  input, output, a copy button and a ✓ / ✗ / spinner status. Edit and Write calls include diffs,
  and subagent calls nest under their Agent row. A run ends with its session ID and a footer such
  as "Completed · 16.9s · $0.090 · 6 turns · 5 tool calls".

### Continuing work across chats

- **Live status and control.** An active-run strip shows elapsed time and the current action,
  such as "Running · 14s · Read: …/game.js", alongside **Stop**. Follow-up prompts resume the same
  Claude session.
- **Independent chats.** Each chat keeps its workspace and session, and several chats can run
  at once. Refreshing or opening a second tab reattaches to the running process. Chats are saved
  to disk; after a server restart, orphaned runs are marked interrupted.
- **Workspace selection.** Paste a path, including `~/…`, browse folders, choose a recent
  workspace or use the bundled scratch workspace.
- **Read-only replay.** Recorded runs use the same display components as live runs. Replay also
  accepts raw `claude --output-format stream-json` captures.

## Requirements

- Node.js 20.19+ or 22.12+ (tested with Node 22.22), and npm 10+.
- For live mode only: the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`)
  on your `PATH`, already logged in. Replay does not require it.

## Quick start

From the collection's root directory:

```bash
cd patchwork
npm ci
npm run dev
```

Open http://localhost:8000, or `http://<your-machine-ip>:8000` from another machine.
`npm run dev` starts the Vite web server on port 8000 and an internal API server at
127.0.0.1:8001. Vite proxies requests to the API, so the browser only needs port 8000.
Press Ctrl+C to stop both processes.

## Explore a recorded run

Recordings live in `server/data/fixtures/`. With the development server running, add
`?replay=<name>` to the URL. There is no in-app picker; http://localhost:8000/api/fixtures lists the
available names. Replays are read-only and never start `claude`.

| URL | What to look for |
|---|---|
| http://localhost:8000/?replay=subagent-concurrent-review | A real architecture review with 54 tool calls: the lead assigns five parts of the codebase to five parallel subagents, collects their reports and writes one document. Start here to explore the lane design. |
| http://localhost:8000/?replay=trajectory-history | Three prompts in one session: a flat run, two concurrent reviewers with a nested delegation and one failed assignment, then a follow-up that resumes an earlier agent. |
| http://localhost:8000/?replay=subagent | A subagent writes a file, with its activity nested under the Agent row. |
| http://localhost:8000/?replay=basic | A flat Write → Bash → Read run. |
| http://localhost:8000/?replay=raw-stream | An unchanged raw `stream-json` capture. Its prompt was not recorded, which the viewer states explicitly. |

The trajectory panel starts closed in replay mode. To open the main showcase:

1. Visit http://localhost:8000/?replay=subagent-concurrent-review.
2. Click the panel icon at the top right of the conversation (**Show trajectory**).
3. Select **Lanes**, then click **Wide view**.

### Follow the team's work

- Read the lead's "Assigned → Assigned to …" cards, then scroll sideways through the six lanes:
  Djordje, Haru, Inês, Camila, Irina and Elliot. Compare the interleaved `#` numbers.
- Click an agent in a lane header, such as Haru, to highlight the lane and open the
  **Task / Activity / Result** inspector. **Open selected step in conversation** jumps to the call.
- Expand a "13 steps · Inspecting files" card with **Show individual steps**.
- Switch to **Call outline**, fold an Agent branch and click a nested Read to find it in the
  conversation. In the conversation itself, expand "Agent · Haru … 15 nested" to inspect the
  subagent's calls.
- Open `?replay=trajectory-history` to see three runs in one panel, including a red
  "Assignment failed" card.
- Click the mascot next to "Patchwork" to meet all 13 characters. Drag the panel's left edge to
  resize it, or narrow the window to see the mobile drawers.

## Run Claude Code live

Open http://localhost:8000 without `?replay`. On first load, the app creates a chat in
`server/data/scratch-workspace/`, whose contents are git-ignored. You can start prompting there or
choose another workspace.

### Start with the demo task

Prepare a disposable copy of the small project in `demo-project/`:

```bash
npm run demo:prepare
```

The command prints a new temporary folder, for example `/tmp/patchwork-linecount-XXXXXX`. Click
**Change** above the prompt box, paste the path and choose **Use workspace**. The demo is a tiny
line-count CLI with one intentionally failing test. Ask Claude to fix the trailing-newline bug and
rerun the tests, then send a follow-up or ask it to delegate a review. Each `demo:prepare` creates
a fresh copy.

### How live runs behave

Each prompt starts this command in the selected workspace:

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --permission-mode bypassPermissions --forward-subagent-text [--resume <session-id>]
```

- **Permission prompts are bypassed.** The headless child process cannot answer them, so every run
  uses `--permission-mode bypassPermissions`. Claude can read, write and run commands with your
  user's privileges. The workspace is a starting directory, not a sandbox. Use scratch folders;
  do not point Patchwork at your home folder or files you need to preserve.
- **Authentication comes from Claude Code.** Runs use your existing login. If
  `ANTHROPIC_API_KEY` is set in the environment that starts Patchwork, Claude Code may use that key
  instead; leave it unset to use your login.
- **Follow-ups resume the session.** A chat passes `--resume` with the previous run's session ID.
  Choosing a different workspace creates a new chat and leaves existing chats and runs alone.
- **Runs outlive browser tabs.** Closing or refreshing the tab does not stop a run. **Stop** sends
  SIGTERM to the `claude` process.
- **Startup failures are visible.** If `claude` is missing or cannot start, the run shows
  **Failed** and the error message.
- **Chats are stored locally.** Each lives under `server/data/chats/<id>/` in `meta.json` and
  `events.jsonl`. Delete a chat through its sidebar menu or by removing its folder.

### Try a delegation prompt

```
Spawn subagents to explore the repo and report the most creative features
```

Here, "the repo" means the chat's workspace. The picker accepts any existing folder. To give the
subagents six apps to compare, make a disposable clone of this collection:

```bash
git clone --depth 1 https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git ~/scratch/mads-lens
```

Click **Change**, paste `~/scratch/mads-lens`, choose **Use workspace** and send the prompt in the
new chat. Patchwork passes no `--allowedTools` or `--disallowedTools` list and sets no turn or
budget cap. With `bypassPermissions`, the subagent tool (`Agent`, called `Task` in older Claude
Code versions) is available without additional setup.

While the run is active, the Trajectory panel opens in **Lanes**. Watch the lead's assignment
cards appear as subagents receive named lanes, use **Wide view** to see more lanes together and
follow the "Result returned" cards. The panel closes when the run ends; reopen it with
**Show trajectory**.

## Configuration

Set options through environment variables, for example `PORT=9000 npm run dev`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Browser-facing port (Vite dev server). |
| `HOST` | `0.0.0.0` | Interface the browser-facing server binds to. Use `127.0.0.1` to keep it local. |
| `API_PORT` | `8001` | Internal API server port. Vite proxies `/api` to it. |
| `API_HOST` | `127.0.0.1` | Interface the internal API binds to. It does not need to be reachable from other machines. |
| `ALLOWED_HOSTS` | unset | Comma-separated extra hostnames the dev server accepts (for example `mybox.local`). `localhost` and IP addresses always work. |
| `PATCHWORK_DATA_DIR` | `server/data` | Where chats, fixtures (`fixtures/`) and the scratch workspace live. If you change it, copy the fixtures there to keep replays working. |
| `PATCHWORK_API_TARGET` | `http://127.0.0.1:$API_PORT` | Full URL Vite proxies `/api` to, if the API runs elsewhere. |

The dev server uses a fixed port. If 8000 is occupied, it exits with an error rather than choosing
another port.

## Security note

Patchwork has no authentication and listens on `0.0.0.0` by default. Anyone who can reach port 8000
can use it. In live mode, they can start Claude Code on your machine with permission prompts
bypassed, in any existing folder they choose. On untrusted networks, start it with
`HOST=127.0.0.1 npm run dev`.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Web server and API together, with auto-reload. |
| `npm run dev:client` / `npm run dev:server` | Only one side. |
| `npm test` | Vitest suites for client and server. |
| `npm run typecheck` | `tsc --noEmit` for both workspaces. |
| `npm run lint` / `npm run format:check` | Biome lint and format checks (`biome.json`). |
| `npm run build` | Production build of client and server. |
| `npm run check` | Format check, lint, typecheck, tests and build in one go. |

`scripts/verify-trajectory.mjs` checks the app end to end in a browser without calling Claude. It
puts a fixture-driven fake `claude` (`scripts/fixtures/claude.cjs`) on the `PATH`, starts temporary
servers on ports 3197 and 5197 with a throwaway data folder, and exercises prompt submissions,
refreshes, a server restart and the trajectory views. It requires Playwright with Chromium. With
a global installation, run:

```bash
npm run build
PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" node scripts/verify-trajectory.mjs
```

`scripts/verify-live.mjs` performs a similar check against the real CLI. It consumes Claude usage
and only runs when `PATCHWORK_LIVE_VERIFY=1` is set.

### Project layout

```
client/                 React 19 + TypeScript + Vite + Tailwind/shadcn UI
  src/state/            ChatStore: chats, active chat, live and replayed timelines
  src/lib/timeline/     event reducer, selectors, lanes and activity grouping (pure, tested)
  src/components/       conversation, tool rows, trajectory panel, agent characters
server/                 Express 5 + TypeScript API
  src/claudeRunner.ts   spawns `claude` and parses stream-json
  src/runRegistry.ts    keeps runs alive independently of HTTP connections
  src/routes.ts         /api/chats, /api/run, /api/fixtures, /api/workspaces
  data/fixtures/        recorded runs for replay
demo-project/           disposable demo task used by `npm run demo:prepare`
scripts/                demo preparation and browser verification
```

Live runs, restored chats and replays produce the same event envelope and pass through one reducer
to render identically. [architecture.md](architecture.md) describes the event model, API routes
and run lifecycle.

## Known limitations

- Replays open through URLs; there is no in-app picker.
- Opening the live page creates a git-ignored chat folder under `server/data/chats/`.
- Lanes show observed order. They do not provide per-tool durations, token counts or an
  elapsed-time view.
- Many subagents require sideways scrolling, even in **Wide view**.
- Background subagents' Agent rows show the raw "Async agent launched successfully…" tool result
  as their immediate output.

[Back to the Assignment 1 showcase](../README.md)
