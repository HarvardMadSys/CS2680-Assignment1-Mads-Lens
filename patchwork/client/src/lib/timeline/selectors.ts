import { asRecord, asString, isSubagentTool, summarizeToolInput } from './toolInputs'
import type { Run, SubagentUsage, TimelineNode, ToolCallNode, ToolStatus } from './types'

function walkToolCalls(nodes: TimelineNode[], visit: (node: ToolCallNode) => void): void {
  for (const node of nodes) {
    if (node.kind === 'tool_call') {
      visit(node)
      walkToolCalls(node.children, visit)
    }
  }
}

export interface RunSummary {
  toolCallCount: number
  filesEdited: number
}

export function summarizeRun(run: Run): RunSummary {
  let toolCallCount = 0
  const editedFiles = new Set<string>()
  walkToolCalls(run.timeline, (node) => {
    toolCallCount += 1
    if ((node.name === 'Write' || node.name === 'Edit') && node.status === 'success') {
      const path = asString(asRecord(node.input).file_path)
      if (path) editedFiles.add(path)
    }
  })
  return { toolCallCount, filesEdited: editedFiles.size }
}

export interface OutlineEntry {
  id: string
  name: string
  depth: number
  status: ToolStatus
}

export function buildOutline(run: Run): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  function visit(nodes: TimelineNode[], depth: number) {
    for (const node of nodes) {
      if (node.kind === 'tool_call') {
        entries.push({ id: node.id, name: node.name, depth, status: node.status })
        visit(node.children, depth + 1)
      }
    }
  }
  visit(run.timeline, 0)
  return entries
}

/** Finds a single tool-call node anywhere in the tree by id — used to look up the real
 * `ToolCallNode` (for its own nested activity) behind an `AgentGraphNode.toolCallId`. */
export function findToolCallNode(nodes: TimelineNode[], id: string): ToolCallNode | undefined {
  for (const node of nodes) {
    if (node.kind !== 'tool_call') continue
    if (node.id === id) return node
    const found = findToolCallNode(node.children, id)
    if (found) return found
  }
  return undefined
}

/** Returns the tool and all of its ancestors, so an outline jump can reveal a nested tool. */
export function findToolPath(nodes: TimelineNode[], targetId: string): string[] {
  function visit(current: TimelineNode[], ancestors: string[]): string[] | undefined {
    for (const node of current) {
      if (node.kind !== 'tool_call') continue
      const path = [...ancestors, node.id]
      if (node.id === targetId) return path
      const childPath = visit(node.children, path)
      if (childPath) return childPath
    }
    return undefined
  }

  return visit(nodes, []) ?? []
}

/** The most recent top-level assistant text — what stays visible when a run's activity
 * collapses into its completion summary. */
export function lastAssistantText(run: Run): string | undefined {
  for (let i = run.timeline.length - 1; i >= 0; i -= 1) {
    const node = run.timeline[i]
    if (node?.kind === 'text' && node.role === 'assistant') return node.text
  }
  return undefined
}

function walkAll(nodes: TimelineNode[], visit: (node: TimelineNode, ts: string) => void): void {
  for (const node of nodes) {
    if (node.kind === 'tool_call') {
      visit(node, node.endedAt ?? node.startedAt)
      walkAll(node.children, visit)
    } else {
      visit(node, node.createdAt)
    }
  }
}

function describeToolCall(node: ToolCallNode): string {
  const summary = summarizeToolInput(node.name, node.input)
  const label = `${node.name}${summary ? `: ${summary}` : ''}`
  if (node.status === 'pending') return `Running ${label}`
  if (node.status === 'error') return `${label} failed`
  return label
}

/** The most recent thing that happened anywhere in the run's tree (including nested subagent
 * activity) — shown next to the always-visible run status indicator. */
export function latestObservedAction(run: Run): string | undefined {
  let best: { ts: string; label: string } | undefined
  walkAll(run.timeline, (node, ts) => {
    if (best && ts < best.ts) return
    if (node.kind === 'tool_call') {
      best = { ts, label: describeToolCall(node) }
    } else if (node.kind === 'thinking') {
      best = { ts, label: 'Thinking' }
    } else if (node.kind === 'text' && node.role === 'assistant') {
      best = { ts, label: 'Responding' }
    }
  })
  return best?.label
}

export type AgentNodeStatus =
  | 'delegated'
  | 'working'
  | 'returned'
  | 'error'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface AgentGraphNode {
  id: string
  kind: 'main' | 'agent'
  label: string
  status: AgentNodeStatus
  toolCallId?: string
  toolCallCount: number
  subagentUsage?: SubagentUsage | undefined
  /** 0-based order this agent first appeared in, among only the 'agent' nodes — used (not the
   * id hash) to pick a visually distinct color bucket, since several real agents' ids can hash
   * close together by chance. Stable across replay/refresh: it depends only on this run's fixed
   * event order, never on which other runs exist. Unset for the main node. */
  orderIndex?: number
}

export interface AgentGraphEdge {
  id: string
  source: string
  target: string
}

export interface AgentGraphData {
  nodes: AgentGraphNode[]
  edges: AgentGraphEdge[]
}

/** A Task's own `tool_result` only confirms a backgrounded launch, not real completion — real
 * completion is a later `task_notification` with a terminal status. Verified against a real
 * recorded session (`server/data/fixtures/subagent-concurrent-review.json`): a backgrounded
 * Task resolves its `tool_result` in milliseconds ("Async agent launched…"), with the actual
 * `task_notification.status: 'completed'` arriving tens of seconds afterward. */
export function deriveAgentNodeStatus(node: ToolCallNode, run?: Run): AgentNodeStatus {
  const status = node.subagentUsage?.status
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'canceled' || status === 'stopped') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'completed') return 'returned'
  if (status && status !== 'running' && status !== 'started') return 'unknown'
  if (node.status === 'error') return 'error'
  if (node.status === 'success' && !node.backgrounded) return 'returned'
  if (run && run.status !== 'running')
    return run.status === 'interrupted' ? 'interrupted' : 'unknown'
  if (node.status === 'pending') return node.children.length > 0 ? 'working' : 'delegated'
  if (node.backgrounded && node.subagentUsage?.status !== 'completed') return 'working'
  return 'returned'
}

function mainAgentStatus(run: Run): AgentNodeStatus {
  if (run.status === 'interrupted') return 'interrupted'
  if (run.status === 'error') return 'error'
  if (run.status === 'running') return 'working'
  return 'returned'
}

/** Derives a compact agent-and-delegation graph from a run's existing tool-call tree: one node
 * per subagent delegation (any `isSubagentTool` call, at any depth) plus one node for the main
 * agent, with every other tool call folded into its owning agent's `toolCallCount` instead of
 * becoming its own node — this is what keeps "5 reviewers" from turning into "50 Read calls".
 * Purely a read of the existing tree; `reducer.ts` is untouched. */
export function buildAgentGraph(run: Run): AgentGraphData {
  const mainId = `main:${run.id}`
  const nodes: AgentGraphNode[] = [
    {
      id: mainId,
      kind: 'main',
      label: 'Main agent',
      status: mainAgentStatus(run),
      toolCallCount: 0,
    },
  ]
  const edges: AgentGraphEdge[] = []
  const countByOwner = new Map<string, number>([[mainId, 0]])
  let nextOrderIndex = 0

  function visit(children: TimelineNode[], ownerId: string): void {
    for (const node of children) {
      if (node.kind !== 'tool_call') continue
      countByOwner.set(ownerId, (countByOwner.get(ownerId) ?? 0) + 1)
      if (isSubagentTool(node.name)) {
        nodes.push({
          id: node.id,
          kind: 'agent',
          label: summarizeToolInput(node.name, node.input) || node.name,
          status: deriveAgentNodeStatus(node, run),
          toolCallId: node.id,
          toolCallCount: 0,
          subagentUsage: node.subagentUsage,
          orderIndex: nextOrderIndex++,
        })
        countByOwner.set(node.id, 0)
        edges.push({ id: `${ownerId}->${node.id}`, source: ownerId, target: node.id })
        visit(node.children, node.id)
      } else {
        visit(node.children, ownerId)
      }
    }
  }
  visit(run.timeline, mainId)

  for (const graphNode of nodes) {
    graphNode.toolCallCount = countByOwner.get(graphNode.id) ?? 0
  }
  return { nodes, edges }
}
