# Architecture

This document describes how Patchwork — a local web app for chatting with the `claude` CLI
against a chosen directory and rendering its full tool-use trajectory live — is put together. It
covers the client, the server, the shared event model that connects them, the process/run
lifecycle, and the tooling that builds and tests all of it.

## Overview

```
┌─────────────────────────────┐        NDJSON stream        ┌──────────────────────────────┐
│  Client (React 19 + Vite)   │ ───────────────────────────▶ │  Server (Express 5)          │
│                              │  POST /api/run               │                              │
│  ChatStore (context/state)  │  GET  /api/chats/:id/stream   │  routes.ts                   │
│  timeline reducer/selectors │ ◀─────────────────────────── │  runRegistry.ts              │
│  RunView / ToolCallRow /... │  restore: GET /api/chats/:id  │  claudeRunner.ts             │
└─────────────────────────────┘  replay: GET /api/fixtures/:n │  storage.ts (events.jsonl,   │
                                                                │              meta.json)      │
                                                                └──────────┬───────────────────┘
                                                                           │ spawn('claude', ...)
                                                                           ▼
                                                                 claude CLI child process
                                                                 (--output-format stream-json,
                                                                  --permission-mode bypassPermissions)
```

Five cross-cutting design principles hold this together (each is expanded in the sections below):

1. **One event model, three consumers.** A single `PersistedEvent` envelope shape and a single
   pure `applyEvent` reducer serve live streaming, chat restore, and fixture replay — no consumer
   gets special-cased logic.
2. **Nesting is structural, not tool-specific.** Subagent trees fall out of `parent_tool_use_id`
   matching a parent `ToolCallNode.id`; nothing in the reducer checks the tool's name.
3. **Permissions are intentionally wide open.** Every `claude` invocation runs with
   `--permission-mode bypassPermissions` because a headless child has no TTY to answer a prompt;
   this is only safe because the app targets scratch/sandbox directories.
4. **Persistence vs. resume are separate.** `events.jsonl` only restores what the UI displays;
   `ChatMeta.sessionId` only drives `--resume`. No code path conflates the two.
5. **A run outlives the connection that started it.** `runRegistry.ts` anchors a run's process
   lifetime to the chat, not to any HTTP request; only `POST /api/chats/:id/stop` ends a run early.

---

## Client Application & State

### Component tree

```
App
└─ TooltipProvider
   └─ ChatStoreProvider                       (client/src/state/ChatStore.tsx — context root)
      └─ ChatPage                              (client/src/App.tsx; keys a ChatWorkspace per chat)
         └─ ChatWorkspace
            └─ AgentIdentityProvider           (stable character/colour per subagent)
               ├─ ChatHistorySidebar           (hidden when isReplay)
               │   └─ SidebarContents (desktop <aside> + mobile drawer, same component twice)
               ├─ TopBar                       (title, AgentCrew mascot, mobile drawer buttons)
               ├─ ChatColumn                   (local component in App.tsx)
               │   ├─ RunView[]                (one per `timeline.runs[i]`)
               │   │   └─ TimelineNodeList → ToolCallRow (recursive, renders nested subagent children)
               │   └─ Composer
               │       ├─ ActiveRunStatusBar → RunStatusBar
               │       └─ DirectoryPicker (cwd picker / new-chat trigger)
               └─ TrajectoryPanel              (right panel / mobile drawer, every run of the chat)
                   ├─ TrajectoryTimeline       ("Lanes": one lane per agent)
                   ├─ TrajectoryCallOutline    ("Call outline": nested list of tool names)
                   └─ TrajectoryDetails        (Task / Activity / Result inspector)
```

`ChatColumn`, `ChatWorkspace` and `ChatPage` are private helper components defined inline in
`App.tsx`, not separate files. `ChatWorkspace` owns a `runRevealRefs: RunRevealMap` (run id → a
`revealTool(toolId)` callback registered by each mounted `RunView`) threaded down as a prop
rather than context, plus `selectedToolId`/`flashToolId` state used to highlight a tool row when
jumped to from the trajectory (`selectTool` sets both, then clears `flashToolId` after 1200ms).

### State layer — `ChatStore.tsx`

A single React Context (`ChatStoreContext`) + hook `useChatStore()` (throws outside its provider).
No external state library — plain `useState`/`useCallback`/`useRef` composed into one provider.

State held: `chats: ChatSummary[]`, `activeChat: ChatMeta | null`,
`timelines: Record<string, TimelineState>` (per-chat, so switching chats doesn't lose in-flight
state; `EMPTY_TIMELINE` is the shared default), `runningChatIds: ReadonlySet<string>` (drives
sidebar spinners and Composer disabling), `isLoading`, `loadError`, `sendError`, `draft`. Derived:
`activeChatId`, `timeline`, `isRunning`. Non-reactive refs: `didInit` (init-once guard),
`loadRequest` (monotonic counter discarding stale async loads), `attachedChatIds` (guards
double-subscribing a chat).

Actions on `ChatStoreValue`: `selectChat`, `startNewChat(cwd)`, `sendPrompt(prompt)`,
`stopChat(chatId)`, `deleteChat(chatId)`, `renameChat(chatId, title)`, `setDraft`, `clearSendError`, plus
`isChatRunning(chatId)`, `isReplay`, `replayName`.

Key internal functions:

- `applyChatEvent(chatId, event)` — the single fold point: calls the timeline reducer's
  `applyEvent` to update `timelines[chatId]`, and updates `runningChatIds`/`chats[].status` on
  `run_start`/`run_end`. Shared by `sendPrompt` (new run) and `attachChat` (reattach).
- `attachChat(chatId, since)` — idempotent (`attachedChatIds`-guarded) async loop over
  `api.attachToRun`, used both for the loaded chat when its persisted status is `'running'` and,
  in the init effect, for every other running chat (so sidebar spinners are accurate without
  opening each one).
- `loadChat(id)` — fetches `api.getChat(id)`, seeds `timelines[id]` via `buildTimeline(events)`
  only if not already present, calls `attachChat` if running.
- `sendPrompt(prompt)` — guards on `isReplay`/no active chat/already running/empty draft; streams
  `api.streamRun`, folds each event, and synthesizes a `run_end` (`interrupted`/`error`) if the
  stream ends or throws without one, so the UI never gets stuck "running" on a dropped connection.
- Init effect (once, `didInit`-guarded): branches on `isReplay` — if replay, fetches
  `api.getFixture(replayName)`, extracts cwd from the fixture's own `system/init` event, seeds
  `timelines.replay`; otherwise lists chats, restores the last-active id from `localStorage`
  (`patchwork.activeChatId`), attaches other running chats, loads the preferred chat, or creates one
  in the default workspace if none exist.

### `lib/api.ts` — server communication

Plain `fetch`-based REST wrappers, no client library. Ordinary JSON request/response helpers:
`checkWorkspace`, `getDefaultWorkspace`, `createChat`, `listChats`, `getChat`, `deleteChat`,
`listFixtures`, `getFixture` (each throws on non-OK via a shared `errorMessage()`/`asJson()`).

Streaming is **not** SSE/EventSource — it's raw NDJSON read via `res.body.getReader()`. The shared
generator `readNdjson(res)` buffers partial lines across chunk boundaries (splits on `\n`, keeps
the last incomplete fragment, flushes the remainder on `done`) and yields parsed `PersistedEvent`s.
`streamRun(chatId, prompt)` posts to `/api/run`; `attachToRun(chatId, since)` hits
`GET /api/chats/:id/stream?since=<n>` for reattach/replay-what-was-missed without spawning a
second CLI process; `stopChat(chatId)` posts to `/api/chats/:id/stop`.

### How live/restore/replay converge on one UI

- **Live run**: `sendPrompt` → `api.streamRun` → `applyChatEvent` per event.
- **Restore**: `loadChat` → `api.getChat` → `buildTimeline(events)` once, then `attachChat`
  continues live if still running.
- **Replay**: `?replay=<name>` (detected by `getReplayNameFromUrl()`) sets `isReplay`, which
  short-circuits all mutating actions (Composer disabled, sidebar hidden, "New chat" disabled) and
  seeds `timelines.replay` in one shot from `api.getFixture`. The synthetic `activeChat` for replay
  mode is fabricated inline (`id: 'replay'`, title `Replay · <name>`, cwd from the fixture's own
  init event or a placeholder).

All three converge on the same `applyEvent`/`buildTimeline` fold (see [Timeline Event Model](#timeline-event-model)).

### UI components

- **TopBar**: thin header — title, the `AgentCrew` mascot (click it to meet the characters), and
  two icon buttons that only render on mobile (`lg:hidden`) to open the history/trajectory
  drawers; no state of its own.
- **Composer**: owns the auto-growing textarea (capped at 240px), Enter-to-send
  (Shift+Enter for newline), renders `ActiveRunStatusBar` and a dismissible `sendError` banner.
  `DirectoryPicker` is reused both as the cwd-change trigger here and as "New chat" trigger in the
  sidebar.
- **RunStatusBar**: presentational `RunStatusBar({run, onStop})` plus an `ActiveRunStatusBar`
  wrapper rendering nothing unless the last run is actively running; ticks every second purely to
  keep an elapsed-time string live. Distinct from per-tool status, which `ToolCallRow` owns.
- **ChatHistorySidebar**: one `SidebarContents` implementation rendered twice — a collapsible
  desktop `<aside>` and a full-screen mobile drawer. Groups chats into Today/Yesterday/Older;
  `ChatIndicator` shows spinning/alert/dot based on chat status; delete requires
  `window.confirm` and is disabled while running.
- **ToolCallRow**: `ToolCallRow` is recursive — a node with
  `children: TimelineNode[]` renders its children via `TimelineNodeList` at `depth + 1`, indented
  per level. `isSubagentTool(node.name)` only changes the label (an "N nested" badge), not the
  recursion mechanism — confirming nesting is structural, not tool-specific. Per-tool detail
  rendering dispatches by `node.name` (`Read`/`Edit`/`Write`/`Bash` get dedicated components,
  everything else falls to `GenericToolDetail`). Each mounted `RunView` registers a
  `revealTool(toolId)` callback in `runRevealRefs` that expands a call's ancestors and scrolls it
  into view; the trajectory uses it to open the exact call in the conversation.

### Trajectory panel

`TrajectoryPanel` shows one collapsible section per run of the current chat. Its view state
(Lanes vs. Call outline, folded runs and branches, expanded activity groups, width, scroll
position) is saved per chat in `localStorage` under `patchwork.trajectory.v1:<chatId>`; the
current selection is deliberately not restored. `useTrajectoryVisibility` closes the panel once
when a run finishes and reopens it when the next prompt starts on desktop.

- **Lanes** (`TrajectoryTimeline`) is built from `executionForRun(run)` in
  `lib/timeline/execution.ts`: one lane for the main agent plus one per subagent-launching tool
  call found by `buildAgentGraph`, and a flat list of steps (tool calls and recorded returns), each
  carrying the shared observation `sequence` the reducer assigns. Those numbers are observed event
  order, not a clock. `groupLaneActivity` (`lib/timeline/trajectory.ts`) folds adjacent reads,
  searches, edits and shell commands in one lane into expandable groups; assignments and returns
  always stay separate cards.
- **Call outline** (`TrajectoryCallOutline`) is the nested list of tool names from
  `buildOutline`, with branch folding.
- Selecting an agent or a step opens `TrajectoryDetails` (Task / Activity / Result) and reveals the
  call in the conversation through `runRevealRefs`.
- Agent names and avatars come from `lib/agentCharacters.ts` via `agentIdentities(runs)`: identity
  follows first appearance in the chat (and survives `resume`), so the same event log always
  produces the same cast. Characters are presentation only and never reach the model.

### Vite config

`client/vite.config.ts` defines the `@` alias to `./src`, serves the dev server on `HOST`/`PORT`
(default `0.0.0.0:8000`), proxies `/api/*` to `http://127.0.0.1:${API_PORT}` (default 8001, or
`PATCHWORK_API_TARGET`) with `changeOrigin: true` (so Express routes work in dev without CORS),
and configures Vitest (`jsdom` environment, `./src/test/setup.ts`) in the same file.

### Tests

`App.test.tsx` covers the default-workspace chat bootstrap, the history sidebar, deleting a chat
and, notably, the **reattach-not-restart** guarantee — a chat loaded with `status: 'running'` must
hit `GET /api/chats/:id/stream?since=N` exactly once and never `POST /api/run`. Component tests
cover `RunView` (collapse on completion, revealing a nested call), `TrajectoryPanel`,
`DirectoryPicker`, `CodeSurface` and tool detail rendering; the reducer, selectors, agent
identities, lane construction and activity grouping have their own unit tests under
`lib/timeline/`, including one built from the bundled `subagent-concurrent-review` recording.

---

## Timeline Event Model

This is the central architectural idea in the project: live streaming, chat restore, and fixture
replay all produce the same `PersistedEvent` envelope shape and run through the same pure reducer
— no consumer is special-cased.

### `PersistedEvent` — the wire envelope

Defined identically in both `client/src/lib/timeline/types.ts` and `server/src/types.ts` (hand-kept
in sync — there's no shared package between the two npm workspaces):

```ts
export type PersistedEvent =
  | { kind: 'run_start'; runId: string; ts: string; prompt: string }
  | { kind: 'run_end'; runId: string; ts: string; status: RunEndStatus; error?: string | undefined }
  | { kind: 'claude'; runId: string; ts: string; event: ClaudeStreamEvent }
```

`RunEndStatus = 'completed' | 'error' | 'interrupted'`. `ClaudeStreamEvent = Record<string, unknown>`
— a single parsed line of `claude --output-format stream-json`, deliberately loosely typed and
narrowed on read since the CLI's JSON shape isn't a published schema. Every event carries a
`runId` and `ts`; the three variants bookend and carry a run: `run_start` (with the prompt),
`run_end` (terminal status + optional error), and `claude` (raw passthrough of one CLI stream
line). This is the only envelope shape anywhere in the app — live streaming appends it
incrementally, chat restore reads it back as a full array from `events.jsonl`, and fixture replay
loads it from `server/data/fixtures/*`.

### `applyEvent` reducer and `TimelineState`

`applyEvent(state: TimelineState, evt: PersistedEvent): TimelineState` is a pure switch on
`evt.kind`, plus `buildTimeline(events) = events.reduce(applyEvent, createEmptyTimelineState())`
as the batch entry point used by restore/replay.

`TimelineState = { runs: Run[]; fileContentCache: Record<string, string> }`.
`fileContentCache` maps absolute file path → last-known full content, populated from successful
`Read`/`Write` tool results, purely so a later `Write`'s detail view can render a diff
(`previousContent` on a `ToolCallNode`) instead of raw content.

Each `Run` holds `id`, `prompt`, `status: 'running' | RunEndStatus`, `startedAt`/`endedAt`, an
optional `RunMetrics` (`costUsd`, `durationMs`, `numTurns`, filled from the CLI's `type: 'result'`
event), optional `error`, and `timeline: TimelineNode[]` — the actual tree.

`TimelineNode = ToolCallNode | TextNode | ThinkingNode`. `ToolCallNode` is the interesting one:
`{ kind: 'tool_call', id, parentId, name, input, status: 'pending'|'success'|'error', result?, children: TimelineNode[], startedAt, endedAt?, subagentUsage?, previousContent? }`,
plus observation-order fields used by the trajectory lanes (`sequence`, `resultSequence`,
`notificationSequence`) and background-agent bookkeeping (`agentId`, `taskId`, `backgrounded`).
`TextNode`/`ThinkingNode` carry `id`, `parentId`, `createdAt`, `text` (plus `role` for text). All
three node kinds carry `parentId` even though only `ToolCallNode` has `children` — nesting always
targets a tool_call ancestor.

### Nesting via `parent_tool_use_id`

`applyClaudeEvent` reads `event.parent_tool_use_id` off each `assistant`/`user` stream event and
treats it as the `parentId` for every block that message produces. `appendNode(nodes, parentId, node)`
does the placement: if `parentId === null` it pushes to the run's top-level timeline; otherwise
`updateNode` recursively searches the existing tree for a `ToolCallNode` whose `id === parentId`
and splices the new node into its `children`. Crucially, if the parent tool_use hasn't been seen
yet (e.g. arrives out of order), `appendNode` falls back to appending at top level so nothing is
lost, rather than dropping the event or throwing.

`tool_result` blocks close the loop the same way: `applyClaudeEvent` finds the `ToolCallNode` by
`tool_use_id` via `updateNode` (searching the whole tree) and merges in `status`, `result`,
`endedAt`, and (for `Write`) `previousContent` pulled from `fileContentCache`.
`task_notification` system events likewise locate the launching tool_call by `tool_use_id` and
attach `subagentUsage` (`totalTokens`, `toolUses`, `durationMs`, `summary`).

`isSubagentTool` (checking tool name against `SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent'])`) is
used only for **display** (e.g. summarizing input via `description`/`subagent_type`) — the
reducer's nesting logic never checks the tool name at all. Any tool_use id that later appears as
some event's `parent_tool_use_id` becomes a parent, regardless of what it's named.

### `selectors.ts` — derived views

- `summarizeRun(run) → { toolCallCount, filesEdited }` — walks the tree, counting tool calls and
  distinct file paths touched by successful `Write`/`Edit`.
- `buildOutline(run) → OutlineEntry[]` (`{ id, name, depth, status }`) — flattens the tree
  depth-first, feeding `TrajectoryOutline`.
- `findToolPath(nodes, targetId) → string[]` — id chain from root to a target tool_call, letting
  an outline click reveal/expand nested ancestors.
- `lastAssistantText(run) → string | undefined` — last top-level assistant text, shown as the
  collapsed run summary.
- `latestObservedAction(run) → string | undefined` — walks the entire tree (including nested
  subagent children) comparing timestamps to find the most recent activity anywhere, rendered as
  e.g. `"Running Write: /a.txt"` for the always-visible run status indicator.

### Event kinds observed

Envelope kinds: `run_start`, `run_end`, `claude`. Inside `claude.event.type`: `assistant`/`user`
(each with `message.content[]` blocks of type `text`, `thinking`, `tool_use`, `tool_result`),
`result` (carries `total_cost_usd`, `duration_ms`, `num_turns`), and `system` with
`subtype === 'task_notification'` (carries `tool_use_id`, `usage.{total_tokens,tool_uses,duration_ms}`,
`summary`) for subagent completion stats, and `system/task_started` (`is_backgrounded`), which
marks a background agent whose own `tool_result` only confirms the launch. The reducer records each
run's top-level `session_id` purely for display; resuming a session is driven server-side by
`ChatMeta.sessionId`, reinforcing that persistence and resume are separate concerns.

### Edge cases covered by `reducer.test.ts`

(1) A flat run (`Write → tool_result → assistant text → result → run_end`), asserting metrics,
`fileContentCache`, and `summarizeRun`; (2) a nested subagent (an `Agent` tool_use at top level, a
nested `Write` carrying `parent_tool_use_id`, then the outer task's own `tool_result` at top
level), asserting tree shape and `buildOutline` depths; (3) a backgrounded subagent whose launch
result is tracked separately from its later completion notification; (4) forwarded subagent
events carrying another session id without replacing the main session; (5) an interrupted run
with no `result` event at all — only `run_start` then `run_end` with `status: 'interrupted'`.

---

## Server API & Persistence

### Routes (`server/src/routes.ts`, mounted at `/api/*`)

| Method & Path | Request | Response | Calls into |
| --- | --- | --- | --- |
| `GET /health` | — | `{status:'ok', timestamp}` | none |
| `POST /workspaces/check` | `{path}` | `DirectoryCheckResult` | `paths.checkDirectory`, defaults to `DEFAULT_SCRATCH_WORKSPACE` if empty |
| `GET /workspaces/default` | — | `{path}` | `storage.DEFAULT_SCRATCH_WORKSPACE` |
| `POST /workspaces/browse` | `{path}` | `{ok, resolved, parent, directories[]}` | `paths.browseDirectory` (read-only, non-hidden subfolders, max 200) |
| `POST /chats` | `{cwd?}` | `201 ChatMeta` / `400` | `paths.checkDirectory`, `storage.createChat` |
| `GET /chats` | — | `ChatSummary[]` | `storage.listChats` |
| `GET /chats/:id` | — | `{chat, events}` / `404` | `storage.getChatMeta`, `storage.readEvents` |
| `PATCH /chats/:id` | `{title}` | `ChatMeta` / `400`/`404` | renames a chat |
| `DELETE /chats/:id` | — | `204` / `400`/`404`/`409` | rejects with `409` if `status==='running'`; validates `:id` against `/^[a-zA-Z0-9_-]+$/` |
| `GET /fixtures` | — | `string[]` | `storage.listFixtureNames` |
| `GET /fixtures/:name` | — | `PersistedEvent[]` / `404` | `storage.readFixture` |
| `POST /run` | `{chatId, prompt}` | streamed NDJSON, one `PersistedEvent` per line | `runRegistry.startRun` then `runRegistry.attach(chatId, 0, cb)` |
| `GET /chats/:id/stream?since=<n>` | query `since` | same NDJSON shape | replays backlog if idle; `runRegistry.attach(chatId, since, cb)` if running — lets a reload/second tab rejoin without a second process |
| `POST /chats/:id/stop` | — | `{stopped}` / `404` | `runRegistry.stopRun` — the only intentional way to end a run early |

Streaming routes share `NDJSON_HEADERS` (`Cache-Control: no-cache`, `X-Accel-Buffering: no`). Both
`/run` and `/chats/:id/stream` unsubscribe on `req.on('close')` but never kill the process — only
`stop` does that.

### Persistence (`server/src/storage.ts`)

Layout under `server/data/` (override with `PATCHWORK_DATA_DIR`): `chats/<uuid>/{meta.json, events.jsonl}`,
`fixtures/<name>.json` or `<name>.jsonl`, `scratch-workspace/` as the default target.

- **`ChatMeta`** (full-rewrite via `saveChatMeta`): `id, cwd, title, sessionId?, activeRunId?, activePid?, createdAt, updatedAt, status ('idle'|'running'), lastRunStatus?, lastError?`.
- **`events.jsonl`**: append-only, one `PersistedEvent` per line (`fs.appendFile`); `readEvents`
  reads the whole file, splits on newline, filters blanks, parses each line — no
  truncation/compaction.
- **`ChatSummary`**: a narrowed `ChatMeta` projection (drops `sessionId`/`activeRunId`/`activePid`)
  for the chat list UI.
- **Fixtures**: `readFixture(name)` validates `name` against `/^[a-zA-Z0-9_-]+$/` (path-traversal
  guard) then reads either a full `PersistedEvent[]` JSON array (`<name>.json`) or a raw
  `claude --output-format stream-json` capture (`<name>.jsonl`), which `recording.ts` wraps in
  `run_start`/`run_end` envelopes without inventing a prompt or timestamps. This is what
  `?replay=<name>` maps to via `GET /api/fixtures/:name`.
- **`reconcileInterruptedChats`** (run once at server startup, before `app.listen`): for any chat
  orphaned mid-run by a server restart (`status === 'running'`), best-effort `SIGTERM`s
  `activePid`, appends a synthetic `run_end` (`status: 'interrupted'`), and rewrites `meta.json`
  back to `idle`.

### Path validation (`server/src/paths.ts`)

`checkDirectory(input)` trims, rejects empty, expands a leading `~`, resolves to absolute, then
`fs.stat`s it — `{ok:false, error}` if missing or not a directory, else `{ok:true, resolved}`. This
does **not** sandbox the path to any root — any existing directory is acceptable, which is why the
app leans on `DEFAULT_SCRATCH_WORKSPACE` as the safe default and pairs this permissive check with
`--permission-mode bypassPermissions` in `claudeRunner.ts` (see below).

### Types and client overlap

`server/src/types.ts` defines `ChatStatus`, `ChatMeta`, `ChatSummary`, `RunEndStatus`,
`ClaudeStreamEvent`, and `PersistedEvent`. `client/src/lib/timeline/types.ts` independently
redeclares `ClaudeStreamEvent`/`PersistedEvent` with identical shapes — a hand-maintained
duplicate with no shared package between workspaces; changing the envelope requires editing both
files in lockstep.

### Persistence-vs-resume separation, confirmed

`events.jsonl` (read via `readEvents`) is used purely for `GET /chats/:id` and the non-running
branch of `GET /chats/:id/stream` — restoring what the UI displays. `ChatMeta.sessionId` is set
only by `runRegistry.ts` when it observes the CLI's `system/init` event, and is read only to pass
`--resume` on a later `POST /run` for the same chat. No code path conflates the two.

---

## Run Lifecycle & Process Management

### `ClaudeRunOptions` / `ClaudeRunHandle`: the runtime boundary

`server/src/claudeRunner.ts` exposes one function, `startClaudeRun(options: ClaudeRunOptions): ClaudeRunHandle`
— the seam a different runtime would plug into.

```ts
interface ClaudeRunOptions {
  cwd: string
  prompt: string
  sessionId?: string | undefined
  onEvent: (event: ClaudeStreamEvent) => void
}
interface ClaudeRunHandle {
  pid: number | undefined
  kill: () => void
  done: Promise<ClaudeRunOutcome>
}
```

`ClaudeRunOptions` says "run this prompt in this directory, optionally resuming this session, and
call me back with events" — nothing about `spawn`, JSON parsing, or CLI flags. `ClaudeStreamEvent`
is the one CLI-shaped type baked into the signature, so it isn't total runtime-agnosticism, but the
transport/process mechanics are fully hidden. `ClaudeRunOutcome` is a closed union
(`result | spawn_error | exit_without_result | killed`) describing *why* a run ended, without
exposing exit codes/signals as the primary vocabulary. If `claude` were swapped for another
runtime, `runRegistry.ts` (the only caller) would need zero changes as long as the replacement
also exposes `startClaudeRun`-shaped options/handle.

### Spawning the CLI

```
claude -p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions --forward-subagent-text [--resume <sessionId>]
```
via `spawn('claude', args, { cwd })`. `--permission-mode bypassPermissions` matches the documented
rationale (a headless child has no TTY to answer a permission prompt; safe only because the app
targets scratch/sandbox directories). `--resume <sessionId>` is appended only if present, and that
`sessionId` comes from `ChatMeta.sessionId` — resume is driven by the persisted session id, not by
the events log. `--forward-subagent-text` is required to surface nested subagent tool calls in the
stream at all.

### Parsing stream-json into events

Stdout is buffered as a running string, split on `'\n'`, with the trailing (possibly incomplete)
fragment kept back for the next chunk. Complete lines are trimmed, skipped if empty, and
`JSON.parse`'d, with parse failures silently skipped (no crash on a malformed line). Each parsed
line is handed to `onEvent` verbatim — `claudeRunner.ts` does no `PersistedEvent` wrapping; that
happens one layer up in `runRegistry.startRun`'s `onEvent` callback (`{ kind: 'claude', runId, ts, event }`).
Separately, the runner watches for `parsed.type === 'result'` to distinguish a clean `result`
outcome from `exit_without_result` (process died without ever emitting a `result` line).

### `runRegistry.ts`: decoupling process from connection

Per chat, `activeRuns: Map<string, ActiveRun>` holds
`{ chatId, handle, emitter: EventEmitter, eventCount, queue: Promise<void> }`. `queue` chains
"append to `events.jsonl` then emit" so persistence and live delivery never race or interleave out
of order.

`startRun` registers the `ActiveRun` before returning to the caller, anchoring the run's lifetime
to the registry rather than the request. `attach(chatId, since, onEvent)` is what lets any number
of connections observe it: with no active run it just replays the backlog once from `since`; with
an active run it first subscribes a buffering listener (so nothing emitted mid-read is missed),
reads the persisted snapshot, drops the buffering listener, replays `persisted.slice(since)`, uses
`partitionPendingAfterSnapshot` to filter the buffered events down to only those after the
snapshot (avoiding duplicate delivery), replays those, then re-subscribes a live pass-through
listener. Each `attach` call gets an independent listener, so many connections (original tab,
reload, second tab) can watch the same in-flight process without a second one spawning.

`stopRun(chatId)` calls `handle.kill()` (SIGTERM) if a handle exists. `routes.ts` registers
`req.on('close', () => subscription.unsubscribe())` on both streaming routes, but this only
detaches that connection's listener — it never kills the process. Only `POST /api/chats/:id/stop`
can.

### Test coverage (`runRegistry.test.ts`)

`partitionPendingAfterSnapshot` (drop-already-included / keep-rest / drop-everything /
keep-everything edge cases); `startRun + attach` (delivers `run_start`/live `claude`/`run_end`
exactly once in order; reattach with `since` skips already-seen events; a second run on an already-
`running` chat is rejected `409`; an idle chat just replays backlog); `stopRun` (unrelated chat id
returns `false` untouched; target chat returns `true`, calls `kill` once, resulting `run_end`
carries `status: 'interrupted'`).

---

## Tooling, Build & Test Infrastructure

**Monorepo structure.** Root `package.json` declares `"workspaces": ["client", "server"]` and holds
no app code — only shared dev tooling (`@biomejs/biome`, `concurrently`, `jsdom`). Root scripts
mostly fan out rather than duplicate logic:

- `dev` → `concurrently -n client,server -c blue,green "npm:dev:client" "npm:dev:server"`.
- `dev:client` → `vite` (dev server, `0.0.0.0:8000` by default). `dev:server` →
  `tsx watch src/index.ts` (Express, `127.0.0.1:8001` by default, auto-restarts; no build step
  needed since `tsx` executes TS directly).
- `lint`/`lint:fix` → `biome lint .` / `biome lint --write .`; `format`/`format:check` →
  `biome format --write .` / `biome format .`.
- `typecheck` → `tsc -b --noEmit` in each workspace (project-reference build mode).
- `test` → `vitest run` in each workspace (client via jsdom, server against plain Node).
- `build` → client: `tsc -b && vite build`; server: `tsc -b` (emits to `server/dist`, run via
  `node dist/index.js`).
- `check` → `format:check && lint && typecheck && test && build`, in that exact order — formatting
  first, build last so a build failure is the final word.

**TypeScript strictness.** Both `client/tsconfig.app.json` and `server/tsconfig.json` set
`"strict": true` plus `noUncheckedIndexedAccess` (indexing an array/record yields `T | undefined`,
forcing explicit narrowing at every access) and `exactOptionalPropertyTypes` (an optional field
`foo?: T` can't be assigned `undefined` explicitly — only omitted — so any field that legitimately
needs an explicit `undefined` must be declared `foo?: T | undefined`). Both also enable
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`. Client
additionally sets `verbatimModuleSyntax`, `erasableSyntaxOnly`, `moduleResolution: "bundler"`,
`jsx: "react-jsx"`; server uses `module`/`moduleResolution: "nodenext"` targeting `es2023`.

**Biome (`biome.json`).** One config governs both workspaces, git-aware, excluding
`dist`/`build`/`node_modules`/`public`. Formatter: 2-space indent, 100-char line width, single
quotes, `"semicolons": "asNeeded"`. Linter uses the `recommended` preset. `assist.organizeImports`
auto-sorts imports alongside formatting. CSS parsing has `tailwindDirectives: true` for Tailwind v4.

**Testing setup.** Client tests run through Vitest configured inline in `client/vite.config.ts`
(`environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']`), reusing the same plugins and `@`
alias as dev/build — one config file serves dev server, production build, and test runner. Server
tests run under plain Vitest defaults (Node environment). Test files sit next to the code they
cover (`*.test.ts(x)` under `client/src/` and `server/src/`). `npm run check`
requires clean formatting and lint before typecheck even runs, and passing tests before the
production build is attempted.

**Dev workflow.** `npm run dev` runs the Vite client dev server and the `tsx watch`-driven Express
server side by side via `concurrently`, labeled and color-coded in one terminal; the Vite dev
server proxies `/api/*` to Express on `:8001` (`changeOrigin: true`, no CORS config needed), while
`tsx watch` gives the backend the same auto-reload-on-save experience Vite gives the frontend.
