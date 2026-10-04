# Mission Control

A local web console for running Claude Code sessions and following what they and their subagents are doing.

![screenshot](screenshot.jpg)

Created by Saul Richardson.

## What it does

Pick a folder, give Claude a task, and watch the conversation, tool calls and delegated work stream in. Each session keeps its history, so you can follow up in the same conversation later, replay a run, or import one recorded elsewhere.

- **Agents strip.** Every subagent Claude spawns gets a card above the conversation showing its task, whether it is working or finished, its tool-call count and any subagents of its own. The main-session card sums it up ("3 subagents · 3 active").
- **Subagent view.** Click a subagent card and the conversation and tool outline narrow to that subagent: its assigned task, activity, duration, token and tool counts, and the report it returned. **‹ Conversation** or the **Main session** card takes you back.
- **Tool-call outline.** A compact list of every call beside the conversation, grouped under the prompt that caused it, colour-coded by tool, marked ✓/✗, with subagent calls indented under their `Agent` call. Click a row to jump to the call.
- **Call inspector.** Click a tool call to open a side panel with its status, start time, duration, parent tool-use id (for subagent calls), full input and result.
- **Readable runs.** Tool cards show the command, diffs for edits, line-numbered file reads and "Show N more lines" folds. Every run ends with its outcome, cost, duration and turn count, and the header tracks context size. A run that fails to start looks different from a tool that fails inside a run that finished.
- **Follow-ups.** The composer continues the same Claude session (`--resume`). You can also set max turns or stop a run.
- **History, replay, import, export.** Sessions and raw events are stored in SQLite. Any finished run can be replayed instantly, at recorded speed or at 4×. You can import a recorded `events.jsonl` (from this app or from `claude -p --output-format stream-json`) and download any run as `events.jsonl`. Playback is labelled and never starts an agent.
- **Files tab.** Browse and preview what the agent wrote (text, Markdown, images, sandboxed HTML/SVG) without leaving the page.
- **Projects and side by side.** Sessions are grouped by folder. A project view puts up to three sessions next to each other. **Bring together** starts a new session from what they produced: their prompts, final replies, subagent reports and files you pick. A new session can also run in its own isolated Git worktree.
- **Command palette** (Ctrl+K / ⌘K), light and dark themes, and toasts when a session finishes.

## Requirements

- **Node.js 22 or newer.**
- **pnpm 10.** No pnpm? Use `npx -y pnpm@10` wherever these instructions say `pnpm` (for example `npx -y pnpm@10 install`, then `npx -y pnpm@10 demo`).
- **Git**, only for the optional isolated-worktree sessions.
- **Claude Code** (`claude` on your `PATH`, signed in), only for live mode. Demo mode needs nothing else.

## Quick start

```bash
cd mission-control
pnpm install
pnpm demo
```

Open http://localhost:8000 (or `http://<your-machine-ip>:8000` from another machine).

`pnpm demo` starts the app with a bundled stand-in for the Claude CLI (see below), so you can try everything without Claude installed and without using any of your Claude usage. To run against the real Claude Code, use `pnpm dev` instead (see [Live mode](#live-mode-with-claude-code)).

For a production build:

```bash
pnpm build
pnpm start
```

## Try it without Claude (replay / demo)

`pnpm demo` points the app at `tests/fake-claude/claude`, a small script that answers like `claude -p --output-format stream-json` by playing a recording from `fixtures/` one event every 150 ms. It never calls Claude.

1. Run `pnpm demo` and open http://localhost:8000.
2. On the home screen, click **New folder**, then **Create**. This creates and selects an empty folder under `~/scratch/` (for example `~/scratch/scratch`). You can also type or browse to any existing folder; the fake CLI doesn't change anything in it.
3. Type a prompt and click **Start session** (or press Ctrl+Enter, ⌘↵ on macOS). The prompt decides which recording plays:
   - one containing `FIXTURE:team-cafe` plays a lead agent handing work to three parallel subagents, one of which delegates again (a synthetic recording);
   - one that mentions "subagent", e.g. `Use a subagent to survey this repository`, plays a real recorded run with one subagent;
   - one that asks for a change ("fix the bug…", "add…", "implement…") plays a real run that edits files;
   - one that mentions "max turns" plays a run that hits `--max-turns` and fails;
   - anything else plays a short real run without subagents.

   `FIXTURE:<name>` in a prompt plays `fixtures/<name>.jsonl`.
4. Once a session exists, press **Ctrl+K** (⌘K on macOS), choose **Import a recorded events.jsonl**, pick a file from `fixtures/` (for example `team-cafe.jsonl` or `subagent-forward.jsonl`) and click **Import**.
5. On any finished prompt, open its **…** menu and choose **Replay → Instantly**, **At recorded speed** or **At 4×**.

To run the production build with the fake CLI:

```bash
pnpm build
MISSION_CONTROL_CLAUDE_BIN=$PWD/tests/fake-claude/claude FAKE_CLAUDE_DELAY_MS=150 pnpm start
```

## Things to try

- Start `Plan the cafe fit-out with a team of subagents FIXTURE:team-cafe` in a new folder. Three subagent cards appear and work at the same time, then finish, and the main card counts them.
- Click a subagent card (e.g. **Zoning and use permits**) to see only its task, activity and report, with the outline narrowed to its calls. Click **Main session** to go back.
- Click a tool call's header, or a row in the outline, to open the inspector with status, timing, parent id, input and result.
- Send a follow-up from the composer at the bottom ("Follow up in this session…").
- Press Ctrl+K, import `fixtures/team-cafe.jsonl`, then use **…** → **Replay → At recorded speed**.
- Open the **Files** tab to browse the session's folder, and **Side by side** in the sidebar to put sessions next to each other.

## Live mode with Claude Code

1. Install Claude Code, sign in, and check that `claude --version` works in the same shell.
2. Start the app with `pnpm dev` (or `pnpm build && pnpm start`) and open http://localhost:8000.
3. Pick a **scratch folder** (**New folder** creates one under `~/scratch/`), never a folder with secrets or work you can't afford to lose, and submit a prompt.

Each run starts in the chosen folder as:

```
claude -p <prompt> --output-format stream-json --verbose --forward-subagent-text --chrome \
  --permission-mode acceptEdits \
  --allowedTools Bash,Read,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep,LS,Agent,Task,WebFetch,WebSearch,TodoWrite,Skill,mcp__claude-in-chrome
```

Follow-ups add `--resume <session id>`, and `--max-turns` is added when you set it. There are no permission prompts: file edits are accepted automatically, and **`Bash` is on the allowlist, so the agent can run any shell command as your user** without asking. The working folder is not a sandbox. You can change the tool list with `MISSION_CONTROL_ALLOWED_TOOLS`. Runs use your own CLI login, because `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are removed from the child's environment.

Every run asks for the [Claude in Chrome](https://code.claude.com/docs/en/chrome) browser tools (`--chrome`). If the extension isn't installed or Chrome isn't open, the session reports that the browser tools are unavailable and everything else works as usual.

### Example prompt

A prompt that makes Claude delegate, so there are subagents to follow:

```
Spawn subagents to explore the repo and report the most creative features
```

"The repo" is the session's folder. Mission Control takes any folder except your home folder and the filesystem root, so use a throwaway clone of the repository this app comes from, which gives the subagents seven apps to compare:

```bash
git clone --depth 1 https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git ~/scratch/mads-lens
```

On the home screen, type the clone's full path into **Folder** (`echo ~/scratch/mads-lens` prints it; the app doesn't expand `~`), or click **Browse**, which opens at your home folder, and pick `scratch`, then `mads-lens`. Paste the prompt and click **Start session**. Nothing needs enabling: the allowlist above includes both `Agent` and `Task` (the subagent tool's newer and older names), there is no budget cap, and turns are capped only if you fill in **max turns** in the composer. If you set `MISSION_CONTROL_ALLOWED_TOOLS`, keep both names in it.

Each subagent gets a card in the agents strip as it starts, showing its task, state and tool-call count, and the **Main session** card counts them and how many are still active. Click a card to follow one subagent on its own: the conversation and outline narrow to its calls, and its report appears there when it finishes.

## Configuration

Set these environment variables before starting the server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. `127.0.0.1` accepts connections from this machine only. |
| `MISSION_CONTROL_ALLOWED_HOSTS` | (none) | Extra hostnames the server answers to, comma-separated, for example `mc.example.org` (see [Security](#security)). Loopback names, IP addresses and this machine's hostname are always accepted. `*` accepts any hostname. |
| `MISSION_CONTROL_CLAUDE_BIN` | `claude` | The Claude Code executable. Use an absolute path if it isn't on `PATH`. |
| `MISSION_CONTROL_ALLOWED_TOOLS` | the list above | The `--allowedTools` list for runs (the Chrome tools are always added). |
| `MISSION_CONTROL_DATA_DIR` | `.data/` in this folder | SQLite database and Bring-together packages. |
| `MISSION_CONTROL_SCRATCH_ROOT` | `~/scratch` | Where **New folder** creates folders. |
| `FAKE_CLAUDE_DELAY_MS` | `2` (`150` in `pnpm demo`) | Delay between events for the fake CLI. |

For example: `PORT=9000 HOST=127.0.0.1 pnpm dev`.

## Security

Mission Control has **no authentication** and listens on **all interfaces (`0.0.0.0`)** by default. Anyone who can reach port 8000 can read your sessions and, in live mode, start Claude Code runs in any folder on your machine, with Bash allowed and no permission prompts. The API also has a comparison endpoint, not used by the UI, that can start runs with `--dangerously-skip-permissions`. On a network you don't fully trust, start it with `HOST=127.0.0.1`.

The server does check every request and WebSocket. The `Host` header must be a loopback name, an IP address, this machine's hostname or a name in `MISSION_CONTROL_ALLOWED_HOSTS`, which blocks DNS-rebinding attacks. A browser's `Origin` must match that host, which stops other web pages from driving the console. These checks protect you from malicious web pages, not from people on your network.

`MISSION_CONTROL_ALLOWED_HOSTS=*` accepts any hostname, which turns the DNS-rebinding protection off: a web page you visit could then drive the console through a hostname it controls. Use it for a console you are deliberately making public, where anyone who can reach it can use it anyway. Otherwise, list the names you use.

## Development

```bash
pnpm test        # unit tests (Vitest)
pnpm typecheck
pnpm lint        # Biome
```

The tests use the same fake CLI and fixtures. `pnpm fixtures:team` and `pnpm fixtures:synth` regenerate the two synthetic recordings.

| Area | Source |
| --- | --- |
| HTTP server, request checks, startup and shutdown | [server.ts](server.ts), [src/server/net/localOnly.ts](src/server/net/localOnly.ts) |
| Running the CLI and cancelling runs | [src/server/process/](src/server/process/) |
| Event reducer, tool pairing, subagents | [src/core/](src/core/) |
| UI | [src/app/](src/app/), [src/ui/](src/ui/) |
| API, storage, streaming | [tRPC router](src/server/trpc/router.ts), [SQLite/Drizzle](src/server/db/), [WebSocket hub](src/server/ws/hub.ts) |
| Recordings and the fake CLI | [fixtures/](fixtures/), [tests/fake-claude/](tests/fake-claude/) |

More detail: [architecture](docs/approach.md), [product intent](docs/product-intent.md), [engineering decisions](docs/records/README.md) and the [stream-json event reference](docs/reference/claude-stream-json-types.md).

## Known limitations

- An import needs an existing session to go into, and that session can't have a run in progress. On a fresh install, start one session first (in `pnpm demo` any prompt will do).
- Sessions are kept in `.data/`, and **New folder** creates `~/scratch/scratch*`. Delete them to reset.
- The **Files** tab shows the folder as it is now. Replaying a run rebuilds the conversation, not the files as they were.
- Archiving a session hides it but doesn't delete its files or Git worktrees.
- The server only answers to loopback names, IP addresses and this machine's hostname. Reaching it under another name (a reverse proxy, a DNS alias) needs that name in `MISSION_CONTROL_ALLOWED_HOSTS`, or `*` for any name. The port can differ, so a port forward such as `ssh -L 9000:localhost:8000` or `docker run -p 3080:8000` needs no setup.
- In `pnpm dev`/`pnpm demo`, Next.js also blocks its dev assets for addresses that aren't this machine's own (for example a Docker host's IP), and the page then doesn't load. Add the address to `MISSION_CONTROL_ALLOWED_HOSTS` (`*` covers any name with a dot in it), or use `pnpm build && pnpm start`.
- Process-group cancellation is built for macOS and Linux. Windows hasn't been tested, and the `pnpm` scripts use POSIX shell syntax.
