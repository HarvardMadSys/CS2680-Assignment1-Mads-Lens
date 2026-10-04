/**
 * Shared stream-json event model.
 *
 * `reduce(state, event)` takes one raw Claude Code stream-json frame (or a
 * synthetic `_`-prefixed frame from the runner / UI) and returns the next
 * state. Live runs and replayed trajectories both go through this function --
 * that is the whole point of keeping it separate from the event source.
 *
 * State holds an ordered, flat list of trajectory *nodes*. Every node carries
 * `parentToolUseId`, taken from the frame's `parent_tool_use_id`: null for the
 * main agent, or the id of the Agent/Task tool_use that spawned the subagent
 * the frame belongs to.
 *
 * The list stays flat on purpose. hierarchy.js derives a tree from it without
 * mutating anything, so this reducer remains usable on its own.
 */

/**
 * Frames that carry no trajectory meaning and are never turned into nodes.
 *
 * The `task_*` subtypes are subagent lifecycle chatter that duplicates what the
 * Agent tool card already shows (they carry `tool_use_id` but always have a
 * null `parent_tool_use_id`, so rendering them would put noise at the top
 * level). Observed in fixtures/subagent-forward.jsonl.
 */
const HIDDEN_SYSTEM_SUBTYPES = new Set([
  'commands_changed',
  'thinking_tokens',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
  // Same chatter as the top-level `tool_progress` frame below, for CLI
  // versions that nest it under `system` instead.
  'tool_progress',
])

/** Tools whose call spawns a subagent whose events nest beneath it. */
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/** Input fields worth showing verbatim rather than as JSON. */
const PRIMARY_INPUT_FIELDS = [
  'command',
  'prompt',
  'pattern',
  'query',
  'content',
  'new_string',
  'url',
]

export function initialState() {
  return {
    status: 'idle', // idle | running | stopping | stopped | completed | failed
    mode: null, // 'live' | 'replay'
    runId: null,
    sessionId: null,
    cwd: null,
    model: null,
    claudeCodeVersion: null,
    permissionMode: null,
    error: null,
    result: null, // the raw `result` frame
    nodes: [],
    toolIndex: {}, // tool_use.id -> index into nodes
    pendingToolIds: [],
    rawEvents: [],
    eventCount: 0,
    hiddenCount: 0,
    pendingThinkingTokens: 0,

    // Live spend, so a run can report what it is costing before it ends.
    // Keyed by assistant message id because one logical message is streamed as
    // several frames carrying the same id -- summing them would count it twice.
    // Subagent frames are included: their tokens are billed to this run.
    usageByMessage: {},
    seenAssistantIds: {},
    thinkingTokens: 0,
    assistantTurns: 0,
    startedAtMs: null,
    endedAtMs: null,
    // toolUseId -> a nested `result` frame, if the CLI ever emits one.
    subagentResults: {},
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function blocksOf(message) {
  const content = message?.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

/**
 * Pick the one input field worth rendering as plain text (a Bash command, a
 * file's new content) and leave the rest as JSON. Deliberately generic -- no
 * per-tool renderers yet.
 */
export function splitInput(input) {
  if (!input || typeof input !== 'object') {
    return { primary: null, rest: null }
  }

  const field = PRIMARY_INPUT_FIELDS.find((f) => typeof input[f] === 'string' && input[f])

  if (!field) return { primary: null, rest: input }

  const rest = {}
  for (const [k, v] of Object.entries(input)) {
    if (k !== field) rest[k] = v
  }

  return {
    primary: { field, text: input[field] },
    rest: Object.keys(rest).length ? rest : null,
  }
}

/** Short one-line label for a tool card header. */
function toolLabel(input) {
  if (!input || typeof input !== 'object') return ''

  const candidate =
    input.description ??
    input.file_path ??
    input.pattern ??
    input.path ??
    input.url ??
    input.command ??
    input.prompt ??
    ''

  return typeof candidate === 'string' ? candidate.split('\n')[0] : ''
}

/**
 * Normalise a tool_result block plus the richer sibling `tool_use_result`.
 * `content` is a string in every recorded trajectory, but the API also allows
 * an array of blocks, so both are handled.
 */
function normaliseToolResult(block, toolUseResult) {
  let text = ''
  let contentBlocks = null

  if (typeof block.content === 'string') {
    text = block.content
  } else if (Array.isArray(block.content)) {
    contentBlocks = block.content
    text = block.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    if (!text) {
      text = `[${block.content.map((b) => b?.type ?? 'unknown').join(', ')}]`
    }
  } else if (block.content != null) {
    text = JSON.stringify(block.content, null, 2)
  }

  const stdout = typeof toolUseResult?.stdout === 'string' ? toolUseResult.stdout : null
  const rawStderr = typeof toolUseResult?.stderr === 'string' ? toolUseResult.stderr : null

  // An Agent/Task result carries a subagent summary instead of stdout.
  const agent =
    toolUseResult && (toolUseResult.agentId || toolUseResult.agentType)
      ? {
          agentId: toolUseResult.agentId ?? null,
          agentType: toolUseResult.agentType ?? null,
          status: toolUseResult.status ?? null,
          totalDurationMs: toolUseResult.totalDurationMs ?? null,
          totalTokens: toolUseResult.totalTokens ?? null,
          totalToolUseCount: toolUseResult.totalToolUseCount ?? null,
          // The subagent reports no cost of its own, so keep what is needed to
          // price its tokens: see shared/pricing.js.
          usage: toolUseResult.usage ?? null,
          model: toolUseResult.resolvedModel ?? null,
        }
      : null

  return {
    isError: Boolean(block.is_error),
    text,
    contentBlocks,
    stdout,
    stderr: rawStderr && rawStderr.trim() ? rawStderr : null,
    interrupted: Boolean(toolUseResult?.interrupted),
    agent,
    structured: toolUseResult ?? null,
  }
}

function makeNode(draft, node) {
  const seq = draft.nodes.length
  draft.nodes.push({
    id: node.id ?? `n${seq}`,
    seq,
    parentToolUseId: node.parentToolUseId ?? null,
    ...node,
  })
  return draft.nodes[seq]
}

/** Statuses a run cannot be moved out of: it has already ended. */
const ENDED = new Set(['completed', 'failed', 'stopped'])

/** Nothing should stay visually "running" once the run is over. */
function settlePendingTools(draft) {
  if (!draft.pendingToolIds.length) return

  for (const toolId of draft.pendingToolIds) {
    const index = draft.toolIndex[toolId]
    if (index == null) continue
    draft.nodes[index] = { ...draft.nodes[index], status: 'incomplete' }
  }

  draft.pendingToolIds = []
}

// ---------------------------------------------------------------------------
// per-event handling
// ---------------------------------------------------------------------------

function handleAssistant(draft, event) {
  const parentToolUseId = event.parent_tool_use_id ?? null

  // Spend first, so it is recorded even for a frame whose blocks are all empty.
  const usage = event.message?.usage
  if (usage) {
    const id = event.message?.id ?? `anon-${draft.eventCount}`
    // Later frames for one message supersede earlier ones rather than adding
    // to them -- the usage on a frame is that message's total so far.
    draft.usageByMessage = { ...draft.usageByMessage, [id]: usage }
  }
  // "Turns" counts the run's own assistant messages, matching what the result
  // frame reports; a subagent's turns belong to that subagent's own metrics.
  if (!parentToolUseId && event.message?.id) {
    const already = Object.prototype.hasOwnProperty.call(
      draft.seenAssistantIds ?? {},
      event.message.id
    )
    if (!already) {
      draft.seenAssistantIds = { ...(draft.seenAssistantIds ?? {}), [event.message.id]: true }
      draft.assistantTurns += 1
    }
  }
  // Subagent-scoped frames also carry these, which makes branches self-describing.
  const subagentType = event.subagent_type ?? null
  const taskDescription = event.task_description ?? null

  // An assistant event can carry any mix of thinking / text / tool_use blocks.
  for (const block of blocksOf(event.message)) {
    switch (block?.type) {
      case 'text':
        // Skip empty text blocks; only real prose becomes a node.
        if (typeof block.text === 'string' && block.text.trim()) {
          makeNode(draft, {
            kind: 'text',
            text: block.text,
            parentToolUseId,
            subagentType,
            taskDescription,
            raw: event,
          })
        }
        break

      case 'thinking':
      case 'redacted_thinking':
        // stream-json exposes a signature but no thinking text, so this is a
        // marker only -- never rendered as assistant prose.
        makeNode(draft, {
          kind: 'thinking',
          tokens: draft.pendingThinkingTokens || null,
          redacted: block.type === 'redacted_thinking',
          parentToolUseId,
          subagentType,
          taskDescription,
          raw: event,
        })
        draft.pendingThinkingTokens = 0
        break

      case 'tool_use': {
        const node = makeNode(draft, {
          kind: 'tool',
          id: block.id,
          toolUseId: block.id,
          name: block.name ?? 'unknown',
          input: block.input ?? {},
          label: toolLabel(block.input),
          status: 'running',
          result: null,
          startedAt: event.timestamp ?? null,
          endedAt: null,
          durationMs: null,
          parentToolUseId,
          subagentType,
          taskDescription,
          // An Agent/Task call owns the subagent trajectory that follows it;
          // those nested frames carry this node's id as parent_tool_use_id.
          spawnsSubagent: SUBAGENT_TOOLS.has(block.name),
          spawnedAgentType: block.input?.subagent_type ?? null,
          raw: event,
        })

        if (block.id) {
          draft.toolIndex = { ...draft.toolIndex, [block.id]: node.seq }
          draft.pendingToolIds = [...draft.pendingToolIds, block.id]
        }
        break
      }

      default:
        if (block?.type) {
          makeNode(draft, {
            kind: 'unknown_block',
            blockType: block.type,
            parentToolUseId,
            raw: event,
          })
        }
        break
    }
  }
}

function handleUser(draft, event) {
  const parentToolUseId = event.parent_tool_use_id ?? null
  const subagentType = event.subagent_type ?? null
  const taskDescription = event.task_description ?? null
  const blocks = blocksOf(event.message)
  const results = blocks.filter((b) => b?.type === 'tool_result')

  // `tool_use_result` sits next to `message` and describes a single result, so
  // only trust it when the event carries exactly one.
  const sidecar = results.length === 1 ? event.tool_use_result : undefined

  for (const block of blocks) {
    if (block?.type !== 'tool_result') {
      if (block?.type === 'text' && block.text?.trim()) {
        // With parent_tool_use_id set this is the task prompt handed to a
        // subagent, not a message from the user.
        makeNode(draft, {
          kind: 'user_text',
          text: block.text,
          parentToolUseId,
          subagentType,
          taskDescription,
          raw: event,
        })
      }
      continue
    }

    const normalised = normaliseToolResult(block, sidecar)
    const index = draft.toolIndex[block.tool_use_id]

    if (index == null) {
      // Orphan: the matching tool_use lived in an earlier session (resume) or
      // the trajectory is truncated. Surfaced, never dropped, never a crash.
      makeNode(draft, {
        kind: 'orphan_tool_result',
        toolUseId: block.tool_use_id ?? null,
        result: normalised,
        parentToolUseId,
        subagentType,
        taskDescription,
        raw: event,
      })
      continue
    }

    const node = draft.nodes[index]
    const startedAt = node.startedAt ? Date.parse(node.startedAt) : NaN
    const endedAt = event.timestamp ? Date.parse(event.timestamp) : NaN

    draft.nodes[index] = {
      ...node,
      status: normalised.isError ? 'error' : 'completed',
      result: normalised,
      endedAt: event.timestamp ?? null,
      durationMs:
        Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : null,
    }

    draft.pendingToolIds = draft.pendingToolIds.filter((id) => id !== block.tool_use_id)
  }
}

function handleSystem(draft, event) {
  if (event.subtype === 'init') {
    draft.sessionId = event.session_id ?? draft.sessionId
    draft.cwd = event.cwd ?? draft.cwd
    draft.model = event.model ?? draft.model
    draft.claudeCodeVersion = event.claude_code_version ?? draft.claudeCodeVersion
    draft.permissionMode = event.permissionMode ?? draft.permissionMode
    return
  }

  if (event.subtype === 'thinking_tokens') {
    draft.pendingThinkingTokens = event.estimated_tokens ?? draft.pendingThinkingTokens
    // `estimated_tokens` is a running total for the run, so the largest one
    // seen is the count so far. Thinking is billed as output.
    draft.thinkingTokens = Math.max(draft.thinkingTokens, event.estimated_tokens ?? 0)
    draft.hiddenCount += 1
    return
  }

  if (HIDDEN_SYSTEM_SUBTYPES.has(event.subtype)) {
    draft.hiddenCount += 1
    return
  }

  makeNode(draft, {
    kind: 'notice',
    level: 'info',
    text: `system: ${event.subtype ?? 'unknown'}`,
    parentToolUseId: event.parent_tool_use_id ?? null,
    raw: event,
  })
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

export function reduce(state, event) {
  if (!event) return state

  if (event.type === '_reset') {
    return { ...initialState(), mode: event.mode ?? null }
  }

  const draft = {
    ...state,
    nodes: state.nodes.slice(),
    rawEvents: [...state.rawEvents, event],
    eventCount: state.eventCount + 1,
  }

  if (draft.status === 'idle') {
    draft.status = 'running'
    // Wall-clock start, for the live duration read-out. The run's own
    // `duration_ms` replaces it once the result frame lands.
    draft.startedAtMs = Date.now()
  }

  try {
    switch (event.type) {
      case '_run_started':
        draft.runId = event.runId ?? draft.runId
        draft.cwd = event.cwd ?? draft.cwd
        draft.mode = 'live'
        break

      case 'system':
        handleSystem(draft, event)
        break

      case 'assistant':
        handleAssistant(draft, event)
        break

      case 'user':
        handleUser(draft, event)
        break

      case 'result':
        // A result frame carrying a parent_tool_use_id is a subagent finishing,
        // not the run. Treating it as the run's own result would end the whole
        // trajectory early and overwrite its metrics with the subagent's. No
        // recorded trajectory carries one today, but the shape is documented,
        // so it is routed to the spawning call instead of being mistaken.
        if (event.parent_tool_use_id) {
          draft.subagentResults = {
            ...(draft.subagentResults ?? {}),
            [event.parent_tool_use_id]: event,
          }
          draft.hiddenCount += 1
          break
        }

        draft.result = event
        draft.endedAtMs = Date.now()
        draft.sessionId = event.session_id ?? draft.sessionId
        // A result that lands after the reader stopped the run does not undo
        // the stop: the run did not finish, it was cancelled, and reporting it
        // as a clean success is the one thing the frames do not support. The
        // frame itself is still recorded and still rendered.
        if (!ENDED.has(draft.status)) {
          draft.status = event.is_error || event.subtype !== 'success' ? 'failed' : 'completed'
        }
        if (event.is_error) draft.error = event.result ?? 'Run reported an error.'
        settlePendingTools(draft)
        makeNode(draft, {
          kind: 'result',
          text: typeof event.result === 'string' ? event.result : '',
          isError: Boolean(event.is_error),
          subtype: event.subtype ?? null,
          raw: event,
        })
        break

      case 'tool_progress':
        // A running tool reporting that it is still working. Routine progress,
        // not trajectory content -- and it carries the running tool's own id in
        // `parent_tool_use_id`, so turning it into a node would both add noise
        // and make an ordinary Bash call look like it owned a subagent.
        draft.hiddenCount += 1
        break

      case 'rate_limit_event':
        // Only worth showing when it is not the routine "allowed" heartbeat.
        if (event.rate_limit_info?.status && event.rate_limit_info.status !== 'allowed') {
          makeNode(draft, {
            kind: 'notice',
            level: 'warn',
            text: `rate limit: ${event.rate_limit_info.status}`,
            raw: event,
          })
        } else {
          draft.hiddenCount += 1
        }
        break

      case '_stderr':
        makeNode(draft, {
          kind: 'notice',
          level: 'warn',
          text: 'stderr',
          detail: event.text ?? '',
          raw: event,
        })
        break

      case '_parse_error':
        makeNode(draft, {
          kind: 'notice',
          level: 'warn',
          text: 'unparseable stdout line',
          detail: `${event.message ?? ''}\n${event.line ?? ''}`,
          raw: event,
        })
        break

      case '_stopping':
        // The reader has asked for this run to stop and the request is in
        // flight. Only a run that is still going can enter it -- a run that has
        // already landed keeps the outcome it landed on, which is what makes
        // pressing stop as a run finishes harmless.
        if (draft.status === 'running') draft.status = 'stopping'
        break

      case '_stopped':
        // The server has accepted the cancellation. Deliberately not `failed`:
        // nothing went wrong, the run was ended on purpose.
        if (ENDED.has(draft.status)) break
        draft.status = 'stopped'
        draft.endedAtMs = Date.now()
        settlePendingTools(draft)
        makeNode(draft, {
          kind: 'notice',
          level: 'stopped',
          text: 'Run stopped. Everything recorded before this point is kept.',
          raw: event,
        })
        break

      case '_error':
        draft.status = 'failed'
        draft.error = event.message ?? 'Unknown error.'
        settlePendingTools(draft)
        makeNode(draft, {
          kind: 'notice',
          level: 'error',
          text: event.message ?? 'Unknown error.',
          raw: event,
        })
        break

      case '_exit':
        settlePendingTools(draft)
        // The process exiting because we killed it is not a failure, and the
        // missing result is the point of a cancellation rather than evidence of
        // one going wrong. `_stopped` is published before the kill, so this is
        // the branch a stopped run always takes.
        if (draft.status === 'stopping' || draft.status === 'stopped') {
          draft.status = 'stopped'
          break
        }
        // A result frame is authoritative; only a missing result means failure.
        if (!draft.result) {
          draft.status = 'failed'
          draft.error =
            draft.error ??
            `Claude Code exited with code ${event.code ?? 'null'} before returning a result.`
          makeNode(draft, {
            kind: 'notice',
            level: 'error',
            text: `Claude Code exited with code ${event.code ?? 'null'} before returning a result.`,
            raw: event,
          })
        }
        break

      case '_replay_end':
        settlePendingTools(draft)
        // Same reasoning as `_exit`: a stream that already reported a
        // cancellation ended because it was cancelled, and the missing result
        // is the point rather than evidence of something going wrong.
        if (draft.status === 'stopping' || draft.status === 'stopped') {
          draft.status = 'stopped'
          break
        }
        if (!draft.result) {
          draft.status = 'failed'
          draft.error = draft.error ?? 'Trajectory ended without a result event.'
          makeNode(draft, {
            kind: 'notice',
            level: 'error',
            text: 'Trajectory ended without a result event.',
            raw: event,
          })
        }
        break

      default:
        // Unknown frame types are surfaced, not dropped, and never fatal.
        if (event.session_id && !draft.sessionId) draft.sessionId = event.session_id
        makeNode(draft, {
          kind: 'unknown',
          text: `unhandled event type: ${event.type ?? '(none)'}`,
          parentToolUseId: event.parent_tool_use_id ?? null,
          raw: event,
        })
        break
    }
  } catch (err) {
    // A malformed frame must never take the whole viewer down.
    makeNode(draft, {
      kind: 'notice',
      level: 'error',
      text: `Failed to process a ${event.type} event: ${err.message}`,
      raw: event,
    })
  }

  return draft
}
