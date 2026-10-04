# Mads Lens: CS 2680 Assignment 1

A showcase of student work from **Assignment 1** in Harvard's **CS 2680: Modern AI Systems**, Fall 2026.

This collection brings together seven student-built web interfaces for running Claude Code and
understanding its work: the tools it calls, the tasks it delegates, and the time and cost of a run.
Each project takes a different approach to making that activity easier to follow.

The creative ideas are a highlight. A conversation can fork into parallel columns, delegated agents
can become a cast of teammates, and model settings can become knobs and faders on a control board.
Together, these projects show the range of interfaces students imagined around the same agent workflow.

## Student projects

Explore the screenshots below, then open a project for its setup instructions and design details.
Every app includes recorded runs or a demo mode, so you can try it without installing Claude Code
or consuming Claude usage.

<table>
<tr>
<td width="50%" valign="top">
<a href="intent-timeline/"><img src="docs/gallery/intent-timeline.jpg" alt="Intent Timeline's 'where the time went' chart, with a main-agent lane holding two overlapping blue subagent bars and a lane of tool calls for each subagent, above a wall-time breakdown noting parallel calls saved 7.7 s and a run summary of cost by model, duration, tokens and subagent totals." width="100%"></a><br>
<b><a href="intent-timeline/">Intent Timeline</a></b>: Organizes activity around what the agent said it would do, then shows where the time and money went with per-agent timelines and cost breakdowns.<br>
<sub>Python standard library, vanilla JS · Created by Yide Bian</sub>
</td>
<td width="50%" valign="top">
<a href="patchwork/"><img src="docs/gallery/patchwork.jpg" alt="Patchwork's Lanes view with columns for Djordje, Haru, Inês, Camila and part of Irina, where Djordje's lane lists his Assigned cards, each subagent lane runs from 'Assigned by Djordje' to a dashed 'Result returned' card, and green arrows link Inês's assignment and returned result to Djordje." width="100%"></a><br>
<b><a href="patchwork/">Patchwork</a></b>: Turns delegation into a team at work: named characters, a lane for each agent, and handoff cards showing what was assigned and what came back.<br>
<sub>Vite + React, Express · Created by Djordje Ivanovic</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="fork-view/"><img src="docs/gallery/fork-view.jpg" alt="Fork View's log forked into two side-by-side columns for parallel Explore subagents, the left nesting a subagent whose own two subagents are stacked inside it and the right nesting one, followed by a green final-result card." width="100%"></a><br>
<b><a href="fork-view/">Fork View</a></b>: Makes parallelism part of the layout: the log splits into side-by-side columns when agents work concurrently, with further forks for nested delegation.<br>
<sub>Vite + React, Express · Created by Zoe Jingyi Liu</sub>
</td>
<td width="50%" valign="top">
<a href="sankey-flow/"><img src="docs/gallery/sankey-flow.jpg" alt="Sankey Flow's four-column Sankey linking one run to Claude and two Explore subagents, then to LLM turn, Agent, Read, Bash and Skill actions and a Completed outcome, with the LLM turn ribbons highlighted and a tooltip showing 7 calls (44% of column) and 51 s (70%)." width="100%"></a><br>
<b><a href="sankey-flow/">Sankey Flow</a></b>: Maps calls and time as flows between runs, agents, actions and outcomes. Live speed gauges and a cat whose animation follows the token rate add a playful touch.<br>
<sub>Python + Flask · Created by Ibrahim Khaliliya</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="swimlanes/"><img src="docs/gallery/swimlanes.jpg" alt="Swimlanes' dark Timeline view, with a zoom slider at 35 px/s, a 0 to 18 s ruler and seven agent lanes whose pink Agent bars and colored tool-call blocks sit at their real times across two consecutive replayed runs." width="100%"></a><br>
<b><a href="swimlanes/">Swimlanes</a></b>: Places each agent on a shared time axis, making overlapping tool calls and parallel work visible at a glance, with zoom and live following.<br>
<sub>Python standard library, single file · Created by Eric Gong</sub>
</td>
<td width="50%" valign="top">
<a href="controller/"><img src="docs/gallery/controller.jpg" alt="Controller's dark hardware-style board after a replayed run, with the effort knob at xhigh, the opus key pressed, the subagent fader at 4 with delegation required, nested subagent cards in the center and a radial scope of four subagents around the main agent." width="100%"></a><br>
<b><a href="controller/">Controller</a></b>: Reimagines agent controls as music hardware: an effort knob, model keys and a subagent fader, alongside a radial display of the agents at work.<br>
<sub>Node + TypeScript, no runtime dependencies · Created by Raul Romero</sub>
</td>
</tr>
<tr>
<td colspan="2" align="center" valign="top">
<a href="subagents-as-a-team/"><img src="docs/gallery/subagents-as-a-team.jpg" alt="Subagents as a team mid-run, with a main-session card and three Working subagent cards above a tool-call outline and three stacked Agent groups, the last expanded to show a nested subagent's navigate call." width="50%"></a><br>
<b><a href="subagents-as-a-team/">Subagents as a team</a></b>: Makes each subagent easy to inspect: its card opens a focused view of its task, activity and result, with a call inspector for the details.<br>
<sub>Next.js + tRPC + SQLite · Created by Saul Richardson</sub>
</td>
</tr>
</table>

## Try a project

Clone the collection:

```bash
git clone https://github.com/HarvardMadSys/CS2680-Assignment1-Mads-Lens.git
cd CS2680-Assignment1-Mads-Lens
```

Choose a project from the gallery and follow its README. Each app is self-contained, with its own
setup instructions and replay or demo walkthrough. Start with a bundled recording to explore the
interface and see its approach to subagents, tool calls and parallel work.

Or start any app with one command:

```bash
cd <app>
./start.sh
```

`start.sh` checks the app's requirements, installs its dependencies on the first run (and again only when
they change), and starts it the way its README does. In Sankey Flow and Subagents as a team,
`./start.sh --demo` starts with the bundled recordings instead of Claude.

The projects use Python or Node.js; check the chosen app's README for the required version and
package manager. Live mode also requires the `claude` CLI to be installed and logged in.

All apps use **port 8000** by default. Open [localhost:8000](http://localhost:8000) after starting one.
Run one app at a time, or change its `PORT` setting; apps with a separate API server may also need
a different `API_PORT`.

## Using live mode

These are student assignment projects. Before connecting one to a live agent, read its README for
its permission settings and behavior.

- **Use a disposable working directory.** Several apps bypass permission prompts, allowing Claude
  Code to edit files and run commands with your account's privileges. The working directory is not
  a sandbox.
- **Check network access.** The apps listen on all interfaces (`0.0.0.0`) by default. Anyone who can
  reach the app may be able to start live runs on your machine. Set `HOST=127.0.0.1` to restrict
  access to your machine.
- **Live runs consume Claude usage.** Bundled replays and demo mode do not.
