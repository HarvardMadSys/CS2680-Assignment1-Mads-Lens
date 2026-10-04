import { agentIdentityFor, type AgentVisualIdentity } from './agentIdentity'
import { buildAgentGraph, deriveAgentNodeStatus, type AgentNodeStatus } from './selectors'
import { asRecord, asString } from './toolInputs'
import type { Run, TimelineNode, ToolCallNode } from './types'

export const toolKey = (runId: string, toolId: string) => JSON.stringify([runId, toolId])

export function allTools(nodes: TimelineNode[]): ToolCallNode[] {
  return nodes.flatMap((node) =>
    node.kind === 'tool_call' ? [node, ...allTools(node.children)] : [],
  )
}

/** Identity is shared across presentations and resumed delegations, never derived from layout.
 * Traverse by first observation, not tree depth, so late nested work cannot recolor siblings. */
export function agentIdentities(runs: Run[]): Map<string, AgentVisualIdentity> {
  const identities = new Map<string, AgentVisualIdentity>()
  const known = new Map<string, AgentVisualIdentity>()
  let nextIdentity = 0
  for (const run of runs) {
    const graph = buildAgentGraph(run)
    const agentIds = new Set(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id))
    const tools = allTools(run.timeline)
      .filter((n) => agentIds.has(n.id))
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    for (const node of tools) {
      const resume = asString(asRecord(node.input).resume)
      const stableId = node.agentId ?? resume ?? toolKey(run.id, node.id)
      const identity =
        (resume ? known.get(resume) : undefined) ??
        known.get(stableId) ??
        agentIdentityFor(toolKey(run.id, node.id), nextIdentity++)
      known.set(stableId, identity)
      if (node.agentId) known.set(node.agentId, identity)
      identities.set(toolKey(run.id, node.id), identity)
    }
  }
  return identities
}

export interface ExecutionLane {
  id: string
  parentId?: string | undefined
  node?: ToolCallNode | undefined
  label: string
  status: AgentNodeStatus
  hiddenCalls: number
  attention: number
}
export interface ExecutionStep {
  id: string
  laneId: string
  sequence: number
  kind: 'tool' | 'return'
  node: ToolCallNode
  childLaneId?: string | undefined
}

/** Edges are ownership or recorded results. Sequence positions are observations, not a clock
 * or a claim that unrelated agents depend on each other. No synthetic join/barrier nodes. */
export function executionForRun(run: Run): {
  lanes: ExecutionLane[]
  steps: ExecutionStep[]
  incomplete: boolean
} {
  const graph = buildAgentGraph(run)
  const tools = allTools(run.timeline)
  const byId = new Map(tools.map((n) => [n.id, n]))
  const mainId = `main:${run.id}`
  const agents = graph.nodes
    .filter((n) => n.kind === 'agent')
    .sort((a, b) => (byId.get(a.id)?.sequence ?? 0) - (byId.get(b.id)?.sequence ?? 0))
  const lanes: ExecutionLane[] = [
    {
      id: mainId,
      label: 'Main agent',
      status: graph.nodes[0]?.status ?? 'unknown',
      hiddenCalls: 0,
      attention: 0,
    },
  ]
  for (const agent of agents) {
    const node = byId.get(agent.id)
    if (!node) continue
    const descendants = allTools(node.children)
    lanes.push({
      id: agent.id,
      parentId: graph.edges.find((e) => e.target === agent.id)?.source,
      node,
      label: agent.label,
      status: agent.status,
      hiddenCalls: descendants.length,
      attention: descendants.filter(
        (n) => n.status === 'error' || (n.status === 'pending' && run.status === 'running'),
      ).length,
    })
  }
  const agentIds = new Set(agents.map((a) => a.id))
  const steps: ExecutionStep[] = []
  let fallbackSequence = 0
  function visit(nodes: TimelineNode[], ownerId: string) {
    for (const node of nodes) {
      if (node.kind !== 'tool_call') continue
      const childLaneId = agentIds.has(node.id) ? node.id : undefined
      steps.push({
        id: `tool:${node.id}`,
        laneId: ownerId,
        sequence: node.sequence ?? ++fallbackSequence,
        kind: 'tool',
        node,
        childLaneId,
      })
      visit(node.children, childLaneId ?? ownerId)
      const returned = deriveAgentNodeStatus(node, run) === 'returned'
      const sequence = node.backgrounded ? node.notificationSequence : node.resultSequence
      if (childLaneId && returned && sequence !== undefined) {
        steps.push({
          id: `return:${node.id}`,
          laneId: ownerId,
          sequence,
          kind: 'return',
          node,
          childLaneId,
        })
      }
    }
  }
  visit(run.timeline, mainId)
  steps.sort((a, b) => a.sequence - b.sequence)
  return {
    lanes,
    steps,
    incomplete: tools.some(
      (n) => n.sequence === undefined || (n.parentId !== null && !byId.has(n.parentId)),
    ),
  }
}
