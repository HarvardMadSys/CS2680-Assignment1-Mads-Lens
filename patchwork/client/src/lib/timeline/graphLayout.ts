import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

export const AGENT_NODE_WIDTH = 220
export const AGENT_NODE_HEIGHT = 96

/** Runs a fresh top-to-bottom Dagre pass over already-derived nodes/edges — positions are
 * always fully re-derived from the current graph, never user-dragged, so there's no state to
 * reconcile between layout passes. Dagre graph instances are mutable/stateful, so a new one is
 * built on every call rather than reused across renders. */
export function layoutGraph<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
): Node<T>[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64 })

  for (const node of nodes) {
    const height =
      typeof node.height === 'number' && node.height > 0 ? node.height : AGENT_NODE_HEIGHT
    const width = typeof node.width === 'number' && node.width > 0 ? node.width : AGENT_NODE_WIDTH
    g.setNode(node.id, { width, height })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const laidOut = g.node(node.id)
    if (!laidOut) return node
    // Dagre positions are centers; React Flow positions are top-left.
    return {
      ...node,
      position: { x: laidOut.x - laidOut.width / 2, y: laidOut.y - laidOut.height / 2 },
    }
  })
}
