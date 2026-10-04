import { ChevronRight } from 'lucide-react'
import type { ReactElement } from 'react'
import { AGENT_NODE_STATUS_CONFIG, StatusIcon, TOOL_STATUS_CONFIG } from './statusConfig'
import type { TrajectorySelection } from './TrajectoryPanel'
import { toolKey } from '@/lib/timeline/execution'
import { deriveAgentNodeStatus } from '@/lib/timeline/selectors'
import { isSubagentTool, summarizeToolInput } from '@/lib/timeline/toolInputs'
import type { Run, TimelineNode } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'

/** A names-only table of contents. Navigation shares the same exact run/tool reveal used by
 * the task lanes; only the presentation changes. Branch folds are shared between both views. */
export function TrajectoryCallOutline({
  run,
  folded,
  selection,
  onFold,
  onJump,
}: {
  run: Run
  folded: Record<string, boolean>
  selection: TrajectorySelection | null
  onFold: (id: string) => void
  onJump: (id: string) => void
}) {
  function outline(nodes: TimelineNode[]): ReactElement[] {
    return nodes
      .filter((node) => node.kind === 'tool_call')
      .map((node) => {
        const nested = node.children.some((child) => child.kind === 'tool_call')
        const closed = Boolean(folded[toolKey(run.id, node.id)])
        const selected = selection?.runId === run.id && selection.toolId === node.id
        const description = summarizeToolInput(node.name, node.input)
        const status = isSubagentTool(node.name)
          ? AGENT_NODE_STATUS_CONFIG[deriveAgentNodeStatus(node, run)]
          : node.status === 'pending' && run.status !== 'running'
            ? AGENT_NODE_STATUS_CONFIG[run.status === 'interrupted' ? 'interrupted' : 'unknown']
            : TOOL_STATUS_CONFIG[node.status]
        return (
          <li key={node.id}>
            <div className="flex items-center gap-1">
              {nested ? (
                <button
                  type="button"
                  onClick={() => onFold(node.id)}
                  aria-label={`${closed ? 'Expand' : 'Collapse'} outline branch: ${description || node.name}`}
                  aria-expanded={!closed}
                  className="rounded p-1 hover:bg-accent focus-visible:outline-ring"
                >
                  <ChevronRight className={cn('size-3', !closed && 'rotate-90')} />
                </button>
              ) : (
                <span className="w-5" />
              )}
              <button
                type="button"
                onClick={() => onJump(node.id)}
                data-trajectory-tool={node.id}
                aria-label={`Open ${node.name}: ${description}`}
                aria-current={selected ? 'true' : undefined}
                title={`${node.name}: ${description} — ${status.label}`}
                className={cn(
                  'flex min-w-0 flex-1 items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-ring',
                  selected && 'bg-accent ring-1 ring-primary/40',
                )}
              >
                <span>{node.name}</span>
                <span role="img" aria-label={status.label}>
                  <StatusIcon config={status} className="size-3" />
                </span>
              </button>
            </div>
            {nested && !closed && (
              <ol className="ml-3 border-l border-border pl-2">{outline(node.children)}</ol>
            )}
          </li>
        )
      })
  }
  const calls = outline(run.timeline)
  return (
    <nav aria-label="Tool call outline" className="px-3 py-2">
      {calls.length > 0 ? (
        <ol>{calls}</ol>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">
          {run.status === 'running'
            ? 'Waiting for recorded activity…'
            : 'No tool calls recorded for this prompt.'}
        </p>
      )}
    </nav>
  )
}
