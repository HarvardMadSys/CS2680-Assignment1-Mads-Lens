import { asRecord, asString, extractTextContent, stripLineNumbers } from './toolInputs'
import type { PersistedEvent, Run, TimelineNode, TimelineState, ToolCallNode } from './types'
import { createEmptyTimelineState } from './types'

function updateNode(
  nodes: TimelineNode[],
  id: string,
  updater: (node: ToolCallNode) => ToolCallNode,
): { nodes: TimelineNode[]; changed: boolean } {
  let changed = false
  const next = nodes.map((node) => {
    if (changed || node.kind !== 'tool_call') return node
    if (node.id === id) {
      changed = true
      return updater(node)
    }
    const childResult = updateNode(node.children, id, updater)
    if (childResult.changed) {
      changed = true
      return { ...node, children: childResult.nodes }
    }
    return node
  })
  return changed ? { nodes: next, changed } : { nodes, changed }
}

function appendNode(
  nodes: TimelineNode[],
  parentId: string | null,
  node: TimelineNode,
): TimelineNode[] {
  if (node.kind === 'tool_call') {
    const orphans = nodes.filter((child) => child.parentId === node.id)
    if (orphans.length) {
      nodes = nodes.filter((child) => child.parentId !== node.id)
      node = { ...node, children: [...node.children, ...orphans] }
    }
  }
  if (parentId === null) return [...nodes, node]
  const result = updateNode(nodes, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, node],
  }))
  // If the parent tool_use hasn't been seen yet, fall back to top-level so nothing is lost.
  return result.changed ? result.nodes : [...nodes, node]
}

function updateCacheForToolResult(
  cache: Record<string, string>,
  node: ToolCallNode,
  resultContent: unknown,
  isError: boolean,
): Record<string, string> {
  if (isError) return cache
  const input = asRecord(node.input)
  const path = asString(input.file_path)
  if (!path) return cache
  if (node.name === 'Read') {
    const text = extractTextContent(resultContent)
    return text === undefined ? cache : { ...cache, [path]: stripLineNumbers(text) }
  }
  if (node.name === 'Write') {
    const content = asString(input.content)
    return content === undefined ? cache : { ...cache, [path]: content }
  }
  return cache
}

function applyClaudeEvent(
  state: TimelineState,
  runId: string,
  ts: string,
  event: Record<string, unknown>,
): TimelineState {
  const idx = state.runs.findIndex((r) => r.id === runId)
  if (idx === -1) return state
  const run = state.runs[idx]
  if (!run) return state
  const type = event.type

  if (type === 'assistant' || type === 'user') {
    const message = asRecord(event.message)
    const content = Array.isArray(message.content) ? message.content : []
    const parentId = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null

    let timeline = run.timeline
    let cache = state.fileContentCache

    content.forEach((rawBlock: unknown, blockIndex: number) => {
      const block = asRecord(rawBlock)

      if (block.type === 'text') {
        const text = asString(block.text)
        if (text?.trim()) {
          timeline = appendNode(timeline, parentId, {
            kind: 'text',
            id: `${runId}:${run.eventCount}:${blockIndex}:text`,
            parentId,
            role: type === 'assistant' ? 'assistant' : 'user',
            text,
            createdAt: ts,
          })
        }
        return
      }

      if (block.type === 'thinking') {
        const text = asString(block.thinking)
        if (text?.trim()) {
          timeline = appendNode(timeline, parentId, {
            kind: 'thinking',
            id: `${runId}:${run.eventCount}:${blockIndex}:thinking`,
            parentId,
            text,
            createdAt: ts,
          })
        }
        return
      }

      if (block.type === 'tool_use') {
        const id = asString(block.id)
        const name = asString(block.name)
        if (!id || !name) return
        timeline = appendNode(timeline, parentId, {
          kind: 'tool_call',
          id,
          parentId,
          name,
          input: block.input,
          status: 'pending',
          children: [],
          startedAt: ts,
          sequence: (run.eventCount ?? 0) + blockIndex / 1000,
        })
        return
      }

      if (block.type === 'tool_result') {
        const toolUseId = asString(block.tool_use_id)
        if (!toolUseId) return
        const isError = Boolean(block.is_error)
        const resultContent = block.content
        const result = updateNode(timeline, toolUseId, (node) => {
          const path = asString(asRecord(node.input).file_path)
          const previousContent =
            !isError && node.name === 'Write' && path ? cache[path] : undefined
          cache = updateCacheForToolResult(cache, node, resultContent, isError)
          return {
            ...node,
            status: isError ? 'error' : 'success',
            result: { content: resultContent, isError },
            endedAt: ts,
            resultSequence: run.eventCount,
            agentId: asString(asRecord(event.tool_use_result).agentId) ?? node.agentId,
            previousContent,
          }
        })
        timeline = result.nodes
      }
    })

    if (timeline === run.timeline && cache === state.fileContentCache) return state
    const runs = state.runs.slice()
    runs[idx] = { ...run, timeline }
    return { ...state, runs, fileContentCache: cache }
  }

  if (type === 'result') {
    const costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0
    const durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : 0
    const numTurns = typeof event.num_turns === 'number' ? event.num_turns : 0
    const runs = state.runs.slice()
    const isError = Boolean(event.is_error) || asString(event.subtype)?.startsWith('error')
    const details = Array.isArray(event.errors)
      ? event.errors.filter((e): e is string => typeof e === 'string').join('\n')
      : asString(event.errors)
    const error = isError
      ? details ||
        asString(event.result) ||
        `Claude reported a failed run (${asString(event.subtype) ?? 'unknown error'}).`
      : run.error
    runs[idx] = { ...run, error, metrics: { costUsd, durationMs, numTurns } }
    return { ...state, runs }
  }

  if (type === 'system' && event.subtype === 'task_started') {
    const toolUseId = asString(event.tool_use_id)
    if (!toolUseId) return state
    const result = updateNode(run.timeline, toolUseId, (node) => ({
      ...node,
      backgrounded: Boolean(event.is_backgrounded),
      agentId: asString(event.agent_id) ?? node.agentId,
      taskId: asString(event.task_id) ?? node.taskId,
    }))
    if (!result.changed) return state
    const runs = state.runs.slice()
    runs[idx] = { ...run, timeline: result.nodes }
    return { ...state, runs }
  }

  if (type === 'system' && event.subtype === 'task_notification') {
    const toolUseId = asString(event.tool_use_id)
    if (!toolUseId) return state
    const usage = asRecord(event.usage)
    const summary = asString(event.summary)
    const status = asString(event.status)
    const result = updateNode(run.timeline, toolUseId, (node) => ({
      ...node,
      notificationSequence: run.eventCount,
      subagentUsage: {
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
        toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
        durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
        summary,
        status,
      },
    }))
    if (!result.changed) return state
    const runs = state.runs.slice()
    runs[idx] = { ...run, timeline: result.nodes }
    return { ...state, runs }
  }

  return state
}

/** Pure fold: (state, one envelope from the stream/history/fixture) -> next state. Used
 * identically for live streaming, chat restore, and recorded-fixture replay. */
export function applyEvent(state: TimelineState, evt: PersistedEvent): TimelineState {
  switch (evt.kind) {
    case 'run_start': {
      if (state.runs.some((r) => r.id === evt.runId)) return state
      const run: Run = {
        id: evt.runId,
        prompt: evt.prompt,
        status: 'running',
        startedAt: evt.ts,
        timeline: [],
      }
      return { ...state, runs: [...state.runs, run] }
    }
    case 'run_end': {
      const idx = state.runs.findIndex((r) => r.id === evt.runId)
      if (idx === -1) return state
      const run = state.runs[idx]
      if (!run) return state
      const runs = state.runs.slice()
      runs[idx] = {
        ...run,
        status: evt.status,
        endedAt: evt.ts,
        error: evt.error ?? (evt.status === 'error' ? run.error : undefined),
      }
      return { ...state, runs }
    }
    case 'claude': {
      let targetRunId = evt.runId
      let event = evt.event
      // A delayed background notification can be delivered during a later prompt's process.
      // Route by its recorded task/tool identity, retaining the original run's trajectory.
      if (event.type === 'system' && event.subtype === 'task_notification') {
        const toolId = asString(event.tool_use_id)
        const taskId = asString(event.task_id)
        function findTask(nodes: TimelineNode[]): ToolCallNode | undefined {
          for (const node of nodes) {
            if (node.kind !== 'tool_call') continue
            if ((toolId && node.id === toolId) || (taskId && node.taskId === taskId)) return node
            const child = findTask(node.children)
            if (child) return child
          }
          return undefined
        }
        const preferred = [...state.runs].sort(
          (a, b) => Number(b.id === evt.runId) - Number(a.id === evt.runId),
        )
        for (const run of preferred) {
          const node = findTask(run.timeline)
          if (node) {
            targetRunId = run.id
            event = { ...event, tool_use_id: node.id }
            break
          }
        }
      }
      // Preserve observation order separately from nesting. Sibling lanes must not imply
      // dependencies simply because their events arrived next to each other.
      const runs = state.runs.map((run) =>
        run.id === targetRunId
          ? {
              ...run,
              eventCount: (run.eventCount ?? 0) + 1,
              sessionId: !evt.event.parent_tool_use_id
                ? (asString(evt.event.session_id) ?? run.sessionId)
                : run.sessionId,
            }
          : run,
      )
      return applyClaudeEvent({ ...state, runs }, targetRunId, evt.ts, event)
    }
    default:
      return state
  }
}

export function buildTimeline(events: PersistedEvent[]): TimelineState {
  return events.reduce(applyEvent, createEmptyTimelineState())
}
