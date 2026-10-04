import { ArrowUpRight, X } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import { useAgentIdentity } from './AgentIdentityContext'
import { Button } from './ui/button'
import { AGENT_NODE_STATUS_CONFIG } from './statusConfig'
import { AGENT_CHARACTERS } from '@/lib/agentCharacters'
import { executionForRun } from '@/lib/timeline/execution'
import { lastAssistantText } from '@/lib/timeline/selectors'
import { asRecord, asString } from '@/lib/timeline/toolInputs'
import { recordedResult, resultExcerpt, shortToolSummary } from '@/lib/timeline/trajectory'
import type { Run } from '@/lib/timeline/types'

export function TrajectoryDetails({
  run,
  toolId,
  onClose,
  onReveal,
}: {
  run: Run
  toolId: string
  onClose: () => void
  onReveal: () => void
}) {
  const execution = executionForRun(run)
  const step = execution.steps.find((item) => item.node.id === toolId)
  const laneId = step?.childLaneId ?? step?.laneId ?? `main:${run.id}`
  const lane = execution.lanes.find((item) => item.id === laneId)
  const identity = useAgentIdentity(run.id, laneId)
  if (!lane || (!step && toolId !== `main:${run.id}`)) return null
  const character = AGENT_CHARACTERS[identity?.character ?? 'pip']
  const activity = execution.steps.filter((item) => item.laneId === laneId && item.kind === 'tool')
  const counts = new Map<string, number>()
  for (const item of activity) counts.set(item.node.name, (counts.get(item.node.name) ?? 0) + 1)
  const task = lane.node ? asString(asRecord(lane.node.input).prompt) || lane.label : run.prompt
  const pending = AGENT_NODE_STATUS_CONFIG[lane.status].spin
  const result = lane.node
    ? recordedResult(lane.node, run)
    : pending
      ? undefined
      : lastAssistantText(run)
  const excerpt = resultExcerpt(result)
  return (
    <section aria-label="Selected task details" className="trajectory-details">
      <div className="flex items-center gap-2">
        <AgentAvatar size={28} identity={identity} working={Boolean(pending)} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold">
            {lane.node ? lane.label : 'Coordinate & deliver'}
          </h3>
          <p className="text-[10px] text-muted-foreground">
            {character.name} ·{' '}
            {lane.status === 'returned' ? 'Completed' : AGENT_NODE_STATUS_CONFIG[lane.status].label}
          </p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close task details" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <dl className="trajectory-detail-sections">
        <div>
          <dt>Task</dt>
          <dd className="line-clamp-3" title={task}>
            {task || 'No assignment text recorded.'}
          </dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>
            {activity.length} recorded steps
            {counts.size > 0
              ? ` · ${[...counts].map(([name, count]) => `${count} ${name}`).join(' · ')}`
              : ''}
          </dd>
          {step && !step.childLaneId && (
            <dd className="mt-1 truncate" title={shortToolSummary(step.node)}>
              Selected: {step.node.name} · {shortToolSummary(step.node)}
            </dd>
          )}
        </div>
        <div>
          <dt>
            Result {excerpt && <span className="font-normal normal-case">· recorded excerpt</span>}
          </dt>
          <dd>
            {excerpt ||
              (result
                ? 'Result recorded. Open the assignment for full output.'
                : pending
                  ? 'Awaiting a recorded result.'
                  : 'No result text was recorded.')}
          </dd>
        </div>
      </dl>
      {step && (
        <button type="button" className="trajectory-detail-link" onClick={onReveal}>
          Open selected step in conversation
          <ArrowUpRight className="size-3" />
        </button>
      )}
    </section>
  )
}
