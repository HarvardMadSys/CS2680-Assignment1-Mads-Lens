# proto/: how the server and the page work

The server spawns `claude -p … --output-format stream-json --verbose` and pushes every JSON line
to the browser over SSE; it can also replay `fixtures/*.jsonl`. Setup, configuration and a tour
are in the [top-level README](../README.md); this file is about the internals.

## Architecture (the whole page)

```
browser app.js                        server.py                              claude -p
──────────────                        ──────────                             ─────────
POST /api/run {mode,prompt,cwd,…} ──▶ Run object + background thread ──────▶ spawn subprocess / read fixture
GET  /api/events/<id>  (SSE)   ◀───── publish each stdout line as JSON   ◀── one event per stdout line
                                      + events the server adds: server/spawn|exit|error
EventSource.onmessage
  └▶ run.apply(event)   updates the plain-JS model (items[] / calls Map / messages Map)
  └▶ scheduleRender()   next frame, repaint this whole run from the model + the outline on the right
```

Other routes: `GET /api/config`, `GET /api/fixtures` (the replay picker), `GET /api/runs`
(restore after a reload), `POST /api/stop/<id>`, `POST /api/clear`.

Three design decisions:
1. **The server does not understand events**, it only forwards them. The one thing it adds is a few events of `type:"server"`, so the page can tell "the process never started" from "the agent is still working".
2. **The front end repaints the whole "model → view"**. Fold state (`call.open / resultOpen / subOpen`) lives in the model, so a repaint does not lose it.
   One frame per event, and a few hundred events are no strain at all; the cost is that a text selection is lost.
3. **Replay and live go down the same SSE path**, and the front end has no idea which is which.

## Visual vocabulary

Tool names are colored pills (Bash/Edit red, Read/Grep pink, Task blue, You gray), arguments are monospace, status sits on the right as `✓` / `● pending` / `✕ failed` / `⊘ refused`;
the numbers are a quiet line of small monospace text under the You line; an old run folds itself into `▸ N events, folded` and keeps only the answer; the input box is pinned to the bottom; subagents are a tree hanging under the Task line;
the outline is steps + pills strung along a vertical line on the left.

## The unit of rendering is the "step", not the "tool call"

One step = one intention the model states (an assistant `text` block) + every tool call after it, up to the next intention.
The messages where the model says nothing and only works are merged into the previous step. A step has a number, a status dot, and that sentence as its title; tool calls are one line each under the step:
`name · label (Bash uses input.description, with the command on a separate line in small type) · result summary · duration`, with a 4-line preview below it (the last 6 lines on an error),
expandable to see everything. The outline lists the step titles, with tool names and result summaries indented underneath. Code: `deriveSteps()` splits the steps, and the two pure functions `callLabel()` /
`callOutcome()` are responsible for "saying in one line what was done / what came back" (for pytest output it grabs pytest's own `1 failed, 3 passed`).

## Features → where the code is

| Feature | Where |
|---|---|
| Submit a prompt / choose a directory / run again after one finishes | `index.html` `#composer`; `app.js onSubmit()`; `server.py run_live()` |
| Live trajectory + markdown | `Run.onAssistant()` groups by `message.id` → `deriveSteps()` → `renderStep()`; text goes through marked + DOMPurify |
| Folded tool results | `callOutcome()` one-line summary + `renderPreview()` 4-line preview (last 6 lines on an error) + `renderFullText()` truncated at 60 lines |
| Status per call / per run | call: `call.status` = pending/ok/error/denied (`onUser` `onSystem`); step: `stepStatus()`; run: `run.status` (`onResult` `onServer` `streamEnded`); bad directory → `server/error` red box |
| Resume | `lastSessionId()` takes `result.session_id` from the last finished live run; when the box is checked the server adds `--resume` |
| Numbers | `renderRunHead()` reads `result.total_cost_usd / duration_ms / num_turns / usage`; `renderSummary()` adds cost by model, cache share, calls by status, files changed and subagent totals |
| Timeline "where the time went" | `timelineModel()` (one lane per agent, critical path, overlap) → `drawTimeline()` (SVG; click a bar to jump to its call) |
| Tree + outline | `bucketOf(parent_tool_use_id)` decides where a call hangs; `renderSubagent()` nests (a subagent's insides are steps too); `outlineChain()` recurses; on a narrow screen (<900px) it folds into a button |
| Stop | `POST /api/stop/<id>` → `proc.terminate()` |
| Partial tokens | check "stream partial tokens" → `--include-partial-messages`; `onStream()` manages the drafts, `renderDraft()` draws them |
| Follow-scrolling | `FOLLOW` follows the user's intent and is off by default: once the page is taller than the viewport, "↓ latest · N new" appears at the bottom right; only clicking it or scrolling to the bottom starts following, and scrolling up stops it; `proto/tests/scroll-check.js` |

## Reusing the event model

- The most valuable parts are the 100 lines of `Run.apply()` (how each kind of event enters the model) and `deriveSteps()` (how events turn into steps a human can read).
- Four pure functions you can lift straight out: `callLabel()` (what was done), `callOutcome()` (what came back), `normalizeResult()` (unifies strings/arrays/images), `firstSentence()`.
- Three rules are all you need to remember: group by `message.id`, pair by `tool_use_id`, bucket by `parent_tool_use_id`.
- Two pitfalls on the server side: use `stdin=DEVNULL` when spawning (otherwise you wait 3 seconds for nothing every time), and pass the permission flags explicitly (headless inherits the default mode from your settings).
- The detailed event fields and the evidence for each of these points are in [`../fixtures/ANALYSIS.md`](../fixtures/ANALYSIS.md).

## Known limitations

- No access token or login: anyone who can reach the port can start runs. Bind to `127.0.0.1` (`HOST=127.0.0.1`) unless you trust the network.
- Run events are written to `proto/runs/<port>/` (git-ignored) and survive a restart; a run cut short by a restart is marked interrupted, and the page reconnects automatically when it loses the connection.
- The per-message token count is only accurate in partial mode (see point 7 in `fixtures/ANALYSIS.md`); outside partial mode only the run total is shown.
- An agent's hand-back text carries a preamble from the harness ("[Subagent hand-back] …"); it is shown as is.
- The outline lists only tool calls, not text messages; there is no diff view; stop is a SIGTERM, and once it ends the run is marked stopped, not failed.
- Replay uses a fixed interval; it does not use the `timestamp` in the events to reconstruct the real pacing.
