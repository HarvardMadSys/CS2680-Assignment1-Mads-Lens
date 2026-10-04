import { ArrowLeft, ArrowLeftRight, ArrowRight, ChevronRight } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AgentAvatar } from './AgentAvatar'
import { useAgentIdentities } from './AgentIdentityContext'
import { AGENT_NODE_STATUS_CONFIG, StatusIcon, TOOL_STATUS_CONFIG } from './statusConfig'
import { toolIcon } from './toolIcons'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import type { TrajectorySelection } from './TrajectoryPanel'
import { AGENT_CHARACTERS } from '@/lib/agentCharacters'
import { executionForRun, toolKey, type ExecutionStep } from '@/lib/timeline/execution'
import {
  activitySummary,
  groupLaneActivity,
  inputQuestion,
  isInputRequest,
  needsAttention,
  recordedResult,
  resultExcerpt,
  shortToolSummary,
} from '@/lib/timeline/trajectory'
import type { Run } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'

export function TrajectoryTimeline({
  run,
  folded,
  expandedGroups,
  selection,
  onFold,
  onGroupToggle,
  onJump,
}: {
  run: Run
  folded: Record<string, boolean>
  expandedGroups: Record<string, boolean>
  selection: TrajectorySelection | null
  onFold: (id: string) => void
  onGroupToggle: (id: string, open: boolean) => void
  onJump: (id: string) => void
}) {
  const execution = useMemo(() => executionForRun(run), [run])
  const identities = useAgentIdentities()
  const headerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [paths, setPaths] = useState<{ kind: string; d: string }[]>([])
  const markerId = useId()
  const identityFor = (id: string) => identities.get(toolKey(run.id, id))
  const characterFor = (id: string) => AGENT_CHARACTERS[identityFor(id)?.character ?? 'pip']
  const colorFor = (id: string) => {
    const identity = identityFor(id)
    return identity ? `oklch(0.64 0.17 ${identity.hue})` : 'var(--primary)'
  }
  const selectedStep =
    selection?.runId === run.id
      ? execution.steps.find((s) => s.node.id === selection.toolId)
      : undefined
  const selectedLane =
    selectedStep?.childLaneId ??
    selectedStep?.laneId ??
    (selection?.runId === run.id && selection.toolId === `main:${run.id}`
      ? selection.toolId
      : undefined)
  const hidden = new Set<string>()
  // Resolve ancestors explicitly: legacy recordings may not have creation sequence numbers.
  const isHidden = (id: string): boolean => {
    let parent = execution.lanes.find((lane) => lane.id === id)?.parentId
    const visited = new Set<string>()
    while (parent && !visited.has(parent)) {
      if (folded[toolKey(run.id, parent)]) return true
      visited.add(parent)
      parent = execution.lanes.find((lane) => lane.id === parent)?.parentId
    }
    return false
  }
  for (const lane of execution.lanes) if (isHidden(lane.id)) hidden.add(lane.id)
  const lanes = execution.lanes.filter((lane) => !hidden.has(lane.id))
  const gridStyle: CSSProperties = {
    gridTemplateColumns:
      lanes.length === 1 ? 'minmax(220px, 1fr)' : `repeat(${lanes.length}, 224px)`,
    width: lanes.length === 1 ? '100%' : undefined,
  }
  // Ordinals refer to the same observed events in every lane. Never invent positions when a
  // recording lacks ordering: those cards are explicitly marked as unnumbered instead.
  const order = new Map(execution.steps.map((step, index) => [step.id, index + 1]))
  const eventNumber = (step: ExecutionStep) =>
    execution.incomplete ? 'Order unavailable' : `#${order.get(step.id)}`
  const eventRange = (steps: [ExecutionStep, ...ExecutionStep[]]) => {
    const last = steps.at(-1)
    return steps.length === 1 || execution.incomplete || !last
      ? eventNumber(steps[0])
      : `${eventNumber(steps[0])}–${eventNumber(last)}`
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: Card positions can change without changing the board's overall size.
  useLayoutEffect(() => {
    const board = boardRef.current
    const scroller = scrollRef.current
    if (!board || !scroller) return
    const measure = () => {
      setOverflowing(scroller.scrollWidth > scroller.clientWidth + 1)
      const bounds = board.getBoundingClientRect()
      const points = new Map(
        Array.from(board.querySelectorAll<HTMLElement>('[data-handoff]')).map((el) => [
          el.dataset.handoff,
          el.getBoundingClientRect(),
        ]),
      )
      const next: { kind: string; d: string }[] = []
      if (selectedLane) {
        for (const kind of ['assign', 'return']) {
          const start = points.get(`${kind}-out:${selectedLane}`)
          const end = points.get(`${kind}-in:${selectedLane}`)
          if (!start?.width || !end?.width) continue
          const goesRight = start.x < end.x
          const x1 = (goesRight ? start.right : start.left) - bounds.left
          const x2 = (goesRight ? end.left : end.right) - bounds.left
          const y1 = start.top + 18 - bounds.top
          const y2 = end.top + 18 - bounds.top
          const bend = goesRight ? x1 + 9 : x1 - 9
          next.push({ kind, d: `M ${x1} ${y1} H ${bend} V ${y2} H ${x2}` })
        }
      }
      setPaths((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(board)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [execution, selectedLane, folded, expandedGroups])

  function toolCard(step: ExecutionStep) {
    const agent = execution.lanes.find((lane) => lane.id === step.childLaneId)
    const child = step.childLaneId ? characterFor(step.childLaneId) : undefined
    const parent = characterFor(step.laneId)
    const returned = step.kind === 'return'
    const summary = shortToolSummary(step.node)
    const config = agent
      ? AGENT_NODE_STATUS_CONFIG[agent.status]
      : step.node.status === 'pending' && run.status !== 'running'
        ? AGENT_NODE_STATUS_CONFIG[run.status === 'interrupted' ? 'interrupted' : 'unknown']
        : TOOL_STATUS_CONFIG[step.node.status]
    const Icon = returned ? ArrowLeft : toolIcon(step.node.name)
    const active =
      selectedLane && (step.laneId === selectedLane || step.childLaneId === selectedLane)
    const selected = selection?.runId === run.id && selection.toolId === step.node.id
    const excerpt = resultExcerpt(recordedResult(step.node, run))
    return (
      <button
        key={step.id}
        type="button"
        data-trajectory-tool={step.node.id}
        data-handoff={
          child ? `${returned ? 'return-in' : 'assign-out'}:${step.node.id}` : undefined
        }
        data-path-active={active || undefined}
        aria-label={
          returned
            ? `Reveal return: ${summary}`
            : child
              ? `Assigned ${summary} to ${child.shortName}`
              : `${step.node.name}: ${summary}`
        }
        aria-current={selected ? 'true' : undefined}
        onClick={() => onJump(step.node.id)}
        className={cn(
          'trajectory-tool',
          child && 'trajectory-handoff',
          selected && 'trajectory-selected',
          needsAttention(step.node) && 'trajectory-attention',
        )}
        style={child ? ({ '--lane-color': colorFor(step.node.id) } as CSSProperties) : undefined}
      >
        <span className="trajectory-card-meta">
          <span className="flex items-center gap-1">
            <Icon className="size-3" />
            {returned
              ? 'Result returned'
              : child
                ? 'Assigned'
                : isInputRequest(step.node)
                  ? 'Input requested'
                  : step.node.name}
          </span>
          <span>{eventNumber(step)}</span>
        </span>
        {child ? (
          <>
            <span className="block font-medium">
              {returned ? `From ${child.shortName}` : summary}
            </span>
            <span className="trajectory-connection">
              {returned ? <ArrowLeft className="size-3" /> : <ArrowRight className="size-3" />}
              {returned ? `Returned to ${parent.shortName}` : `Assigned to ${child.shortName}`}
            </span>
            {returned && (
              <span className="trajectory-excerpt">
                {excerpt || 'Result recorded. Open for details.'}
              </span>
            )}
          </>
        ) : (
          <span className="block truncate font-medium" title={summary}>
            {summary || step.node.name}
          </span>
        )}
        {isInputRequest(step.node) && (
          <span className="trajectory-excerpt">{inputQuestion(step.node) || summary}</span>
        )}
        {step.node.status === 'error' && (
          <span className="trajectory-excerpt text-destructive">
            {excerpt || 'This step failed. Open to inspect the error.'}
          </span>
        )}
        {!returned && !child && (
          <span className="trajectory-card-status">
            <StatusIcon config={config} className="size-3" />
            {config.label}
          </span>
        )}
        {child && agent?.status === 'error' && (
          <span className="text-destructive">Assignment failed</span>
        )}
      </button>
    )
  }

  return (
    <div className="trajectory-execution">
      <div className="trajectory-order-note">
        <span className="font-medium text-foreground">Observed event order</span>
        <span>Shared # numbers · compact lanes, not elapsed time</span>
        {execution.incomplete && (
          <span>
            Some ordering or parent information is missing. Only recorded calls are shown.
          </span>
        )}
        {overflowing && (
          <span className="flex items-center gap-1">
            <ArrowLeftRight className="size-3" />
            {lanes.length} agent lanes · scroll sideways to see every branch
          </span>
        )}
      </div>
      <div className="trajectory-sticky-headers">
        <div
          ref={headerRef}
          className="trajectory-header-scroll"
          onScroll={(e) => {
            if (scrollRef.current) scrollRef.current.scrollLeft = e.currentTarget.scrollLeft
          }}
        >
          <div className="trajectory-grid" style={gridStyle}>
            {lanes.map((lane) => {
              const character = characterFor(lane.id)
              const config = AGENT_NODE_STATUS_CONFIG[lane.status]
              const final =
                run.status !== 'running' ||
                ['returned', 'error', 'cancelled', 'interrupted'].includes(lane.status)
              const label = lane.status === 'returned' ? 'Completed' : config.label
              const closed = Boolean(folded[toolKey(run.id, lane.id)])
              const active = selectedLane === lane.id
              const count = execution.steps.filter(
                (step) => step.laneId === lane.id && step.kind === 'tool',
              ).length
              return (
                <div
                  key={lane.id}
                  className="trajectory-agent"
                  data-lane-header={lane.id}
                  data-path-active={active || undefined}
                  style={{ '--lane-color': colorFor(lane.id) } as CSSProperties}
                >
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      className="trajectory-agent-link"
                      aria-current={active ? 'true' : undefined}
                      aria-label={`Reveal agent: ${character.name} — ${lane.label}`}
                      onClick={() => onJump(lane.node?.id ?? lane.id)}
                    >
                      <span className="trajectory-task-title">
                        {lane.node ? lane.label : 'Coordinate & deliver'}
                      </span>
                      <span className="trajectory-agent-person">
                        <AgentAvatar
                          size={23}
                          identity={identityFor(lane.id)}
                          working={Boolean(config.spin)}
                        />
                        {character.shortName}
                        <span>· {count} steps</span>
                      </span>
                    </button>
                    {lane.node && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`${closed ? 'Expand' : 'Collapse'} branch: ${lane.label}`}
                        aria-expanded={!closed}
                        onClick={() => onFold(lane.id)}
                      >
                        <ChevronRight className={cn('size-3', !closed && 'rotate-90')} />
                      </Button>
                    )}
                  </div>
                  <span className="trajectory-card-status">
                    <StatusIcon config={config} className="size-3" />
                    {final ? `Final status: ${label.toLowerCase()}` : label}
                  </span>
                  {closed && (
                    <span className="text-[10px] text-muted-foreground">
                      {lane.hiddenCalls} hidden calls
                      {lane.attention > 0 ? ` · ${lane.attention} running / failed` : ''}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <section
        ref={scrollRef}
        className="trajectory-lane-scroll"
        aria-label={`Run ${run.id} execution branches`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys scroll this overflow region.
        tabIndex={0}
        onScroll={(e) => {
          if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft
        }}
      >
        <div ref={boardRef} className="trajectory-grid trajectory-board" style={gridStyle}>
          {selectedLane && (
            <svg className="trajectory-paths" aria-hidden="true">
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={colorFor(selectedLane)} />
                </marker>
              </defs>
              {paths.map(({ kind, d }) => (
                <path
                  key={kind}
                  d={d}
                  fill="none"
                  stroke={colorFor(selectedLane)}
                  strokeWidth="2"
                  markerEnd={`url(#${markerId})`}
                />
              ))}
            </svg>
          )}
          {lanes.map((lane) => {
            const closed = Boolean(folded[toolKey(run.id, lane.id)])
            const active = selectedLane === lane.id
            const assigned = execution.steps.find(
              (step) => step.childLaneId === lane.id && step.kind === 'tool',
            )
            const returned = execution.steps.find(
              (step) => step.childLaneId === lane.id && step.kind === 'return',
            )
            const parent = characterFor(lane.parentId ?? '')
            const groups = groupLaneActivity(execution.steps, lane.id)
            return (
              <div
                key={lane.id}
                className="trajectory-lane"
                data-lane={lane.id}
                data-path-active={active || undefined}
                style={{ '--lane-color': colorFor(lane.id) } as CSSProperties}
              >
                {!closed && (
                  <>
                    {assigned && (
                      <button
                        type="button"
                        className="trajectory-endpoint"
                        data-handoff={`assign-in:${lane.id}`}
                        onClick={() => onJump(lane.id)}
                      >
                        <span>
                          <ArrowRight className="size-3" />
                          Assigned by {parent.shortName}
                        </span>
                        <span>{eventNumber(assigned)}</span>
                      </button>
                    )}
                    {groups.map((group) => {
                      if (group.steps.length === 1) return toolCard(group.steps[0])
                      const key = toolKey(run.id, group.id)
                      const attention = group.steps.some((step) => needsAttention(step.node))
                      const containsSelection =
                        selection?.runId === run.id &&
                        group.steps.some((step) => step.node.id === selection.toolId)
                      const open = attention || containsSelection || Boolean(expandedGroups[key])
                      const pending = group.steps.some((step) => step.node.status === 'pending')
                      return (
                        <Collapsible
                          key={group.id}
                          className="trajectory-group"
                          open={open}
                          onOpenChange={(value) => onGroupToggle(group.id, value)}
                        >
                          <div className="trajectory-card-meta">
                            <span>{group.steps.length} steps</span>
                            <span>{eventRange(group.steps)}</span>
                          </div>
                          <div className="font-medium">{group.title}</div>
                          <p className="trajectory-group-summary" title={activitySummary(group)}>
                            {activitySummary(group)}
                          </p>
                          {pending && run.status === 'running' && (
                            <span className="trajectory-card-status">
                              <StatusIcon config={TOOL_STATUS_CONFIG.pending} className="size-3" />
                              In progress
                            </span>
                          )}
                          {pending && run.status !== 'running' && (
                            <span className="trajectory-card-status">
                              Completion not recorded for some steps
                            </span>
                          )}
                          <CollapsibleTrigger
                            className="trajectory-group-toggle"
                            disabled={attention || containsSelection}
                          >
                            <ChevronRight className={cn('size-3', open && 'rotate-90')} />
                            {attention
                              ? 'Steps needing attention'
                              : containsSelection
                                ? 'Selected step expanded'
                                : open
                                  ? 'Hide individual steps'
                                  : 'Show individual steps'}
                          </CollapsibleTrigger>
                          <CollapsibleContent className="trajectory-group-steps">
                            {group.steps.map(toolCard)}
                          </CollapsibleContent>
                        </Collapsible>
                      )
                    })}
                    {returned && (
                      <button
                        type="button"
                        className="trajectory-tool trajectory-result"
                        data-handoff={`return-out:${lane.id}`}
                        onClick={() => onJump(lane.id)}
                      >
                        <span className="trajectory-card-meta">
                          <span>Result returned</span>
                          <span>{eventNumber(returned)}</span>
                        </span>
                        <span className="trajectory-excerpt">
                          {resultExcerpt(recordedResult(returned.node, run)) ||
                            'Result recorded. Open for details.'}
                        </span>
                        <span className="trajectory-connection">
                          <ArrowLeft className="size-3" />
                          Returned to {parent.shortName}
                        </span>
                      </button>
                    )}
                    {lane.node && lane.hiddenCalls === 0 && (
                      <p className="trajectory-empty">No child steps recorded.</p>
                    )}
                    {lane.node && !returned && !AGENT_NODE_STATUS_CONFIG[lane.status].spin && (
                      <div
                        className={cn(
                          'trajectory-tool',
                          lane.status === 'error' && 'trajectory-attention',
                        )}
                      >
                        <p className="font-medium">
                          {lane.status === 'error' ? 'Task failed' : 'No completed return recorded'}
                        </p>
                        {lane.status === 'error' && (
                          <p className="trajectory-excerpt">
                            {resultExcerpt(recordedResult(lane.node, run)) ||
                              'Open the assignment to inspect the recorded error.'}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
                {closed && <p className="trajectory-empty">Branch collapsed</p>}
              </div>
            )
          })}
        </div>
      </section>
      {execution.steps.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {run.status === 'running'
            ? 'Waiting for recorded activity…'
            : 'No tool calls recorded for this prompt.'}
        </p>
      )}
    </div>
  )
}
