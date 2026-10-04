# Mads Lens

Seven small web apps for driving [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and watching it work.

Each app runs `claude -p … --output-format stream-json` against a directory you choose and turns the event
stream into something you can read while it happens: tool calls, subagents working in parallel, failures,
time and cost. They all solve the same problem, but each takes a different idea and builds the whole app
around it.

Every folder is a self-contained app with its own README. Each one bundles recorded runs, so you can try it
without installing Claude Code or spending any usage.

| App | The idea | Stack | Created by |
|---|---|---|---|
| [Intent Timeline](intent-timeline/) | Steps headed by what the agent said it would do, plus a "where the time went" timeline and cost split by model | Python standard library, vanilla JS | Yide Bian |
| [Patchwork](patchwork/) | Delegation as a team at work: named subagents, one lane per agent, handoff cards | Vite + React, Express | Djordje Ivanovic |
| [Fork View](fork-view/) | Parallel work forks the log into side-by-side columns, nested recursively | Vite + React, Express | Zoe Jingyi Liu |
| [Sankey Flow](sankey-flow/) | A Sankey of where a run's calls and time went (agent → tool → outcome), plus speed gauges and an animated cat | Python + Flask | Ibrahim Khaliliya |
| [Swimlanes](swimlanes/) | A real time axis: one swimlane per agent, with zoom and follow-live | Python standard library, single file | Eric Gong |
| [Controller](controller/) | A hardware-style control surface (effort knob, model keys, subagent fader) with a radial scope of agents | Node + TypeScript, no dependencies | Raul Romero |
| [Mission Control](mission-control/) | Sessions you manage, with a card per delegated subagent, a view scoped to each one and a call inspector | Next.js + tRPC + SQLite | Saul Richardson |

## Getting started

```bash
git clone https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git
cd CS2680-Assignment1-Mads-Lens/<app>
./start.sh
```

`start.sh` checks the app's requirements, installs its dependencies on the first run (and again only when they
change), and starts it the way that app's README does. In Mission Control and Sankey Flow, `./start.sh --demo`
starts with the bundled recordings instead of Claude. The app's README covers the rest.

Every app serves on **port 8000** and listens on all interfaces (`0.0.0.0`), so
you can open it at http://localhost:8000 or, from another machine, at `http://<your-machine-ip>:8000`. Set
`PORT` (and `HOST`) to change this.

Because they share a port, run one app at a time.

**Requirements:** Node.js 22 and Python 3.9+ cover every app (individual READMEs list exact versions). Live
mode also needs the `claude` CLI, installed and logged in.

## Before you use live mode

- **Point the app at a scratch directory.** Several of these apps run Claude Code with permission prompts
  turned off (`--dangerously-skip-permissions` or `bypassPermissions`). The agent can then edit files and run
  commands in that directory without asking.
- **Mind the network.** The apps listen on `0.0.0.0`, so anyone who can reach port 8000 on your machine can use
  them. In live mode, that means they can run Claude Code on your machine with your account. On a network you
  don't trust, start the app with `HOST=127.0.0.1`.
- Live runs use your Claude usage. The bundled replays don't.

## Credits

These apps were built by students in Harvard's CS 2680 (Modern AI Systems) in Fall 2026, and were chosen from
the class's projects for their designs. Each app's README names its author.
