# stream-json event stream analysis (Claude Code 2.1.278, recorded 2026-09-19)

This document goes through every **real recording** in `fixtures/`: how it was recorded, what
shows up in it, and which common assumption about the event stream it confirms or corrects. Every
line number can be reproduced with `python3 fixtures/inspect.py fixtures/<file>` — inspect.py
prints the event type line by line, groups by `message.id`, buckets by `parent_tool_use_id`, and
pairs tool_use ↔ tool_result.

The recording commands are all in `fixtures/record.sh` (`bash fixtures/record.sh 03` re-records
the third one). Every run happens in `scratch/demo-repo` (a copy of demo-repo taken from git HEAD,
with test_parse still broken), so the real demo-repo is never touched. Permissions use the allowlist
`--permission-mode acceptEdits --allowedTools "Read,Glob,Grep,Task,Bash(python3 -m pytest:*),…"`,
not `--dangerously-skip-permissions`.

---

## 0. One summary table

| File | Events | Model | result.subtype | Cost | turns | Duration | What it shows |
|---|---|---|---|---|---|---|---|
| 01-fix-test | 39 | opus-5[1m] | success | $0.35 | 12 | 37 s | Recorded earlier by hand: Read/Edit/Bash + 3 permission_denied |
| 02-parallel-reads | 28 | fable-5-1 | success | $0.40 | 4 | 19 s | 3 parallel Reads in one message |
| 03-subagents-parallel | 61 | fable-5-1 | success | $0.59 | 5 | 50 s | 2 parallel subagents, interleaved events |
| 04-image-result | 22 | fable-5-1 | success | $0.35 | 2 | 13 s | tool_result.content is `[image]` |
| 05-partial-messages | 86 | fable-5-1 | success | $0.30 | 2 | 17 s | 61 `stream_event` fragments |
| 06-max-turns-error | 28 | fable-5-1 | **error_max_turns** | $0.30 | 2 | 17 s | A failed run, process exit code 1 |
| 06b-bad-resume | **1** | — | **error_during_execution** | $0 | 0 | 0 | The entire stream is a single result line |
| 07-resume-a | 29 | fable-5-1 | success | $0.38 | 6 | 28 s | Round one: asking where the CLI entry point is |
| 07-resume-b | 108 | fable-5-1 | success | $1.12 | 20 | 179 s | `--resume` picks up and implements `--json`, 5 denied |
| 09-compact | 47 | fable-5-1 | success | $0.47 | 9 | 46 s | Tried to trigger compaction, did not (threshold not reached) |
| 09b-compact-resumed | 27 | fable-5-1 | success | $1.71 | 2 | 79 s | **compact_boundary triggered** |

07-resume-a / 07-resume-b / 09b all have exactly the same `session_id` (`240308cf-…`): resume does not change the id.

---

## 1. Nine common assumptions about the stream, checked

### 1. One message ≠ one event — true, but not by the mechanism usually described

The usual description is "one assistant message stuffs several tool_use entries into its content array."
**That is not what the real stream looks like.** stream-json **splits each content block of an API
message into a separate `assistant` event**; every event's `message.content` has length 1, and they
are grouped by sharing the same `message.id`.

`02-parallel-reads.jsonl` lines 17–23, one and the same `message.id` (inspect.py labels it M1):

```
17 assistant M1 thinking
18 assistant M1 text      "Reading all three files now in one parallel step."
19 assistant M1 tool_use  Read parser.py
20 user         tool_result -> Read (line 19)      ← the first Read's result is already back
21 assistant M1 tool_use  Read cli.py              ← only now does the message's second block arrive
22 user         tool_result -> Read (line 21)
23 assistant M1 tool_use  Read test_parse.py
25 user         tool_result -> Read (line 23)
```

Two consequences:
- **The unit of rendering is the block, not the message** — that part holds; but grouping has to rely on `message.id`, not on the content array.
- **A tool_result can land between two tool_use blocks of the same message**: Claude Code executes each tool_use block the moment it finishes receiving it,
  without waiting for the whole message to stream. So "draw the whole message first, then wait for results" does not hold; you must pair by id.

The same phenomenon: 01 lines 10/12/14 (three Bash calls under one id), 03 lines 27/33 (two Agent calls under one id).

### 2. tool_result hides inside `type:"user"` — true

In every recording the tool_result sits in the `message.content[]` of a `user` event, with the
`tool_use_id` field matching `tool_use.id`. Three things to add:
- A `user` event can also carry a **`text` block** (not a tool_result): injected skill content (03 line 25, 06 line 24),
  a subagent's prompt (03 line 29, whose `parent_tool_use_id` points at the Agent call), or the post-compaction summary (09b line 18).
  Render these as "user-side messages," not as results.
- The `user` event also has a top-level `tool_use_result` carrying structured extra information: `{stdout, stderr, …}` for Bash,
  `{status, prompt, …}` for Agent, `{type:"image", file:{…dimensions}}` for an image. Use it if you want to show raw stdout and stderr separately.
- Across these 12 recordings **each user event carries exactly 1 tool_result**, but do not turn that into an assumption; just loop and match by id.

### 3. Arrival order is not tree order — true

`03-subagents-parallel.jsonl` lines 29–52: the events of the two subagents (parent `…zqby6n` and `…Xds1E5`) are completely interleaved:

```
29 parent=zqby6n user text   (subagent A's prompt)
31 parent=zqby6n assistant   Bash find src
33 main          assistant   Agent [Explore] Survey tests/     ← only now is the second Agent call emitted
35 parent=Xds1E5 user text   (subagent B's prompt)
36 parent=zqby6n user        tool_result -> Bash
38 parent=Xds1E5 assistant   Bash ls
40 parent=zqby6n assistant   Read __init__.py
41 parent=Xds1E5 user        tool_result -> Bash
…
```

The only way is to bucket by `parent_tool_use_id`. Bucket sizes: main 47 events, A 9, B 5.

### 4. A subagent has no result event of its own — true, and there is a whole set of helper events

A subagent's finish signal is the `tool_result` of the Agent call (03 lines 55 and 58), whose `content` is
`[{type:"text", text:"[Subagent hand-back] … report body"}]`.

**Less well known but very useful**: `system` events include a family of `task_*` subtypes whose `parent_tool_use_id` is null, but which all carry a
`tool_use_id`/`task_id` pointing back at that Agent call:

| subtype | When | Key fields |
|---|---|---|
| `task_started` | Immediately after the Agent tool_use | `tool_use_id, task_id, description, subagent_type, prompt, spawn_depth` |
| `task_progress` | Every step the subagent takes | `usage:{total_tokens, tool_uses, duration_ms}, last_tool_name, description` |
| `task_updated` | On a status change | `task_id, patch:{status:"completed", end_time}` |
| `task_notification` | At the end, immediately before the tool_result | `status:"completed", summary, usage, output_file` |

A live "subagent running" indicator can be driven straight off these four: `task_started` → start blinking, `task_progress` → update "now Reading …",
`task_notification` or tool_result → stop, `is_error` → red. That is exactly how `onSystem()` in `proto/static/app.js` is written.

### 5. `tool_use.input` looks different for every tool — true

The shapes that appear in this batch of recordings:

| Tool | input fields | Summary rule (`toolSummary()` in app.js) |
|---|---|---|
| Read | `file_path` | file name |
| Edit | `file_path, old_string, new_string` | file name; when expanded, draw a `-` block and a `+` block |
| Write | `file_path, content` | file name |
| Bash | `command, description` | `description · first 50 characters of command` (description is a label the model writes itself — very handy) |
| Agent | `description, subagent_type, model, run_in_background, prompt` | `[subagent_type] description` |
| Glob | `pattern, path` | `pattern in path` |
| Grep | `pattern, path, …` | `/pattern/ in path` |
| Skill | `skill` | skill name |

**Mind the naming**: the `tools` list in init calls it `Task`, but in tool_use the `name` is `Agent` (03 line 27).
Do not hard-code a name to decide "is this a subagent"; decide it by "does any other event have a `parent_tool_use_id` equal to its id" or by `task_started`.

### 6. `tool_result.content` may be a string or an array — true

- String: Read (text), Bash, Edit, Write, Glob, Grep, Skill.
- `[{type:"text"}]`: the Agent hand-back (03 line 55).
- `[{type:"image", source:{type:"base64", media_type:"image/png", data:"…"}}]`: Reading a PNG (04 line 19).
  Just render it as `<img src="data:image/png;base64,…">`. In app.js, `normalizeResult()` folds everything into one list.

### 7. Usage is on every assistant message — **needs correcting**

The `message.usage` on an `assistant` event **is a snapshot from the start of the message, not the final value**: in 01 the three split
events all have `output_tokens` 16; in 05 the assistant event on line 30 has `output_tokens: 2`, while the final value for the same message in
`message_delta` is 424. On top of that, the split events sharing one message.id repeat the identical usage, so summing them directly double-counts.

Reliable sources:
- **For the whole run**: `result.usage` (input/output/cache_read/cache_creation), `result.total_cost_usd`,
  `result.modelUsage` (broken down by model, including `costUSD` — in 01 you can see haiku also spent $0.001 as a helper model).
- **Per message**: only with `--include-partial-messages` on is the `usage` of the `stream_event` whose `event.type == "message_delta"`
  the final number for that message (05 line 49: 424 output, 300 of it thinking).
- **Per subagent**: the `usage` on `system/task_progress` and `task_notification`
  (`total_tokens, tool_uses, duration_ms`), plus `result.subagent_stats` (spawned/completed/failed counts).
  That is the right answer for "how much did each subagent spend," rather than summing assistant usage by parent.

### 8. `system/compact_boundary` marks a compaction — true, and reproduced

09 did not trigger it (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=5`; the threshold is roughly 5% of the context window ≈ 50k tokens, which the run never reached).
09b used `--resume` to pick up 07b's 45k-token session and pushed the threshold down to 3%; it compacted on the first round. The order (09b lines 16–19):

```
16 system/status            {status:null, compact_result:"success"}
17 system/compact_boundary  {compact_metadata:{trigger:"auto", pre_tokens:45494, post_tokens:6703,
                              cumulative_dropped_tokens:38791, duration_ms:65154, preserved_messages:{…}},
                             logical_parent_uuid:"…"}
18 user text                "This session is being continued from a previous conversation that ran out of context. Summary: …"
19 system/informational     {content:"SessionStart:compact says: …", level:"notice"}
```

Rendering: draw a divider at line 17 (the viewer shows "context compacted (auto)"); line 18 is the summary text, shown collapsed as a user-side message.
The price: the compaction itself took 65 seconds, and this run cost $1.71 — the most expensive of all the recordings.

### 9. `input_json_delta` under `--include-partial-messages` arrives in fragments — true

05 lines 13–50 are the complete fragment sequence of a single message:

```
message_start → content_block_start(index 0, thinking) → thinking_delta ×4 → signature_delta
  → [assistant event: thinking block]  → content_block_stop(0)
→ content_block_start(1, text) → text_delta ×3 → [assistant event: text block] → content_block_stop(1)
→ content_block_start(2, tool_use Read, input:{}) → input_json_delta ×14
  → [assistant event: complete tool_use] → content_block_stop(2)
→ message_delta(stop_reason, final usage) → message_stop
```

`input_json_delta.partial_json` splits `{"file_path": "/…/src/logparse/parser.py"}` into 14 fragments
(lines 33–46), and none of the individual pieces is valid JSON. **But the complete `assistant` event still arrives at the end of every block** (line 47,
just before `content_block_stop`). So the least-effort approach: use the fragments only to draw a "typing" indicator, and treat the `assistant` event as authoritative.
The viewer's `onStream()` does exactly this: fragments go into `drafts`, and when the real event arrives the matching draft is deleted.

---

## 2. Other findings (all of them affect a renderer)

1. **Every run opens with 10 hook events** (`system/hook_started` ×5, `hook_response` ×5), coming from the plugins installed on the recording machine
   (superpowers, claude-mem and so on). `hook_response.output` holds an entire block of skill text, and the 40–80 KB of a recording is mostly this.
   A resumed run has only 2. When rendering, just collapse them into a single line with a count.
2. **`system/thinking_tokens`** (`estimated_tokens, estimated_tokens_delta`) keeps arriving while the model thinks;
   the `thinking` field of a `thinking` block is an empty string, with only `signature` present (it has been redacted). The viewer does not draw these empty blocks; it shows a thinking counter instead.
3. **`rate_limit_event`**: `rate_limit_info.unifiedWindows.five_hour.utilization` (0.14 = 14% used). Make a little chip out of it.
4. **The permission_denied trio**: `system/permission_denied{tool_use_id, decision_reason, message}` →
   the `user` tool_result with `is_error:true` plus the top-level `tool_result_meta:[{non_execution_kind:"user-rejected"}]` →
   the `result.permission_denials[]` summary. Two pitfalls with the allowlist: a compound command like `git diff --stat && git status` does not match, and
   a command with an environment-variable prefix like `PYTHONPATH=src python3 -m logparse.cli` does not match `Bash(python3 -m logparse.cli:*)` either (all 5 denials in 07b are of these two kinds).
5. **Three shapes of failure**:
   - `--max-turns 1` → there is an init and there are events, and at the end `result{subtype:"error_max_turns", is_error:true, errors:["Reached maximum number of turns (1)"], terminal_reason:"max_turns"}`, the `result` text is empty, and the process exit code is 1.
   - A bad `--resume` id → **the whole stream is a single line**, `result{subtype:"error_during_execution", num_turns:0, errors:["No conversation found with session ID: …"]}`, with no init. The frontend cannot assume the first line is an init.
   - A nonexistent directory → the process never starts at all, and there is **not a single line of JSON**. At that layer the server has to supply the events itself (the viewer's server uses events of `type:"server"`, kept distinct from Claude's).
6. **The default permission mode comes from your settings**: headless inherits `~/.claude/settings.json`, which was `plan` on the recording machine —
   the smoke test's init says `permissionMode:"plan"`, and in that mode the agent refuses every edit. When the server spawns a run it must pass
   `--permission-mode` or `--allowedTools` explicitly.
7. **Close stdin when spawning**: if you do not, stderr shows `Warning: no stdin data received in 3s, proceeding without it`,
   and every run wastes 3 seconds. In Python that is `stdin=subprocess.DEVNULL`; in the shell, `</dev/null`.
8. `session_id`: `init.session_id == result.session_id`, and it does not change after a resume; if you need one to resume with, take it from result.
9. A few more system subtypes turn up occasionally: `status` (things like `{status:"requesting"}`, present in 05) and `informational`.
   The renderer needs a fallback for unknown `system.subtype` values (the viewer: count them, then fold them into that line of grey text at the top).

---

## 3. Field quick reference (2.1.278)

```
system/init        session_id cwd model permissionMode tools[] agents[] plugins[] claude_code_version
assistant          message{id model content[1 block] usage(snapshot)} parent_tool_use_id session_id uuid timestamp
  block: text{text} | thinking{thinking signature} | tool_use{id name input}
user               message{content: str | [tool_result{tool_use_id content is_error} | text{text}]}
                   parent_tool_use_id tool_use_result(structured) tool_result_meta(when denied)
system/permission_denied   tool_name tool_use_id decision_reason message
system/task_started        task_id tool_use_id description subagent_type prompt
system/task_progress       task_id tool_use_id usage{total_tokens tool_uses duration_ms} last_tool_name
system/task_notification   task_id tool_use_id status summary usage
system/compact_boundary    compact_metadata{trigger pre_tokens post_tokens duration_ms}
stream_event       event{type: message_start|content_block_start|content_block_delta|content_block_stop|message_delta|message_stop
                         index delta{type: text_delta|thinking_delta|signature_delta|input_json_delta}}
rate_limit_event   rate_limit_info{status rateLimitType unifiedWindows}
result             subtype is_error errors[] total_cost_usd duration_ms duration_api_ms num_turns session_id
                   result(the final block of text) usage modelUsage subagent_stats permission_denials terminal_reason
```

## 4. How to reproduce / re-record

```bash
python3 fixtures/inspect.py fixtures/03-subagents-parallel.jsonl   # explain one recording line by line
bash fixtures/record.sh 02 03                                      # re-record (costs money, $0.3–1.7 each)
bash fixtures/record.sh 09b                                        # needs 07-resume-b to exist first
```

`*.meta` records each one's exit code, elapsed time, full command line and prompt; `*.stderr` is not in git.
