import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RunIdentityContext } from '@/components/AgentIdentityContext'
import { AgentAvatar } from '@/components/AgentAvatar'
import { Markdown } from '@/components/Markdown'
import { CopyButton } from '@/components/CopyButton'
import { RUN_STATUS_CONFIG } from '@/components/statusConfig'
import type { OutlineRefMap, RunRevealMap } from '@/components/ToolCallRow'
import { TimelineNodeList } from '@/components/ToolCallRow'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { findToolPath, lastAssistantText, summarizeRun } from '@/lib/timeline/selectors'
import type { Run } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'
import { AGENT_CHARACTERS } from '@/lib/agentCharacters'

const LONG_PROMPT_THRESHOLD = 400

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`
}

function durationMs(run: Run): number | undefined {
  if (run.metrics) return run.metrics.durationMs
  if (!run.endedAt) return undefined
  const elapsed = Date.parse(run.endedAt) - Date.parse(run.startedAt)
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined
}

export function RunView({
  run,
  outlineRefs: suppliedOutlineRefs,
  runRevealRefs,
  selectedToolId,
  flashToolId,
}: {
  run: Run
  outlineRefs?: OutlineRefMap | undefined
  runRevealRefs?: RunRevealMap | undefined
  selectedToolId?: string | null | undefined
  flashToolId?: string | null | undefined
}) {
  const localOutlineRefs = useMemo<OutlineRefMap>(() => new Map(), [])
  const outlineRefs = suppliedOutlineRefs ?? localOutlineRefs
  const isLongPrompt = run.prompt.length > LONG_PROMPT_THRESHOLD
  const [promptExpanded, setPromptExpanded] = useState(!isLongPrompt)
  const isRunning = run.status === 'running'
  const [activityExpanded, setActivityExpanded] = useState(() => isRunning)
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [pendingRevealId, setPendingRevealId] = useState<string | null>(null)
  const summary = summarizeRun(run)
  const finalText = lastAssistantText(run)
  const runDurationMs = durationMs(run)

  const userToggledActivity = useRef(false)
  const wasRunning = useRef(isRunning)
  useEffect(() => {
    const transitionedToDone = wasRunning.current && run.status !== 'running'
    wasRunning.current = run.status === 'running'
    if (transitionedToDone && !userToggledActivity.current) {
      setActivityExpanded(false)
      setExpandedToolIds(new Set())
    }
  }, [run.status])

  const toggleTool = useCallback((toolId: string) => {
    setExpandedToolIds((current) => {
      const next = new Set(current)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }, [])

  const revealTool = useCallback(
    (toolId: string) => {
      const path = findToolPath(run.timeline, toolId)
      if (path.length === 0) return
      setActivityExpanded(true)
      setExpandedToolIds((current) => new Set([...current, ...path]))
      setPendingRevealId(toolId)
    },
    [run.timeline],
  )

  useEffect(() => {
    if (!runRevealRefs) return
    runRevealRefs.set(run.id, revealTool)
    return () => {
      if (runRevealRefs.get(run.id) === revealTool) runRevealRefs.delete(run.id)
    }
  }, [run.id, runRevealRefs, revealTool])

  useEffect(() => {
    if (!pendingRevealId || !activityExpanded) return
    const target = outlineRefs?.get(pendingRevealId)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPendingRevealId(null)
  }, [pendingRevealId, activityExpanded, outlineRefs])

  function toggleActivity() {
    userToggledActivity.current = true
    setActivityExpanded((v) => !v)
  }

  return (
    <RunIdentityContext.Provider value={run}>
      <div id={`run-${run.id}`} className="space-y-3 scroll-mt-4">
        <div className="ml-auto max-w-[85%] rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm text-secondary-foreground">
          <div className={cn('whitespace-pre-wrap', !promptExpanded && 'line-clamp-4')}>
            {run.prompt}
          </div>
          {isLongPrompt && (
            <button
              type="button"
              onClick={() => setPromptExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              {promptExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        <div className="flex gap-2.5">
          <AgentAvatar working={isRunning} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground">
              {AGENT_CHARACTERS.pip.name} <span className="font-normal">· Lead</span>
            </p>
            {run.timeline.length === 0 && isRunning && (
              <p className="text-sm text-muted-foreground">Working…</p>
            )}

            {activityExpanded ? (
              <TimelineNodeList
                nodes={run.timeline}
                depth={0}
                outlineRefs={outlineRefs}
                expandedToolIds={expandedToolIds}
                onToggleTool={toggleTool}
                selectedToolId={selectedToolId}
                flashToolId={flashToolId}
              />
            ) : (
              finalText && <Markdown text={finalText} />
            )}

            {run.status !== 'running' && (
              <button
                type="button"
                onClick={toggleActivity}
                className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {activityExpanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {RUN_STATUS_CONFIG[run.status].label}
                {runDurationMs !== undefined && ` · ${formatDuration(runDurationMs)}`}
                {run.metrics &&
                  ` · ${formatCost(run.metrics.costUsd)} · ${run.metrics.numTurns} turn${run.metrics.numTurns === 1 ? '' : 's'}`}
                {summary.toolCallCount > 0 &&
                  ` · ${summary.toolCallCount} tool call${summary.toolCallCount === 1 ? '' : 's'}`}
                {summary.filesEdited > 0 &&
                  ` · ${summary.filesEdited} file${summary.filesEdited === 1 ? '' : 's'} edited`}
              </button>
            )}

            {run.sessionId && (
              <div
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                data-run-session={run.sessionId}
              >
                <span>Session</span>
                <code title={run.sessionId}>{run.sessionId.slice(0, 12)}…</code>
                <CopyButton text={run.sessionId} className="size-5" />
              </div>
            )}

            {run.error && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertTitle>
                  Run {run.status === 'interrupted' ? 'interrupted' : 'failed'}
                </AlertTitle>
                <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                  {run.error}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </div>
    </RunIdentityContext.Provider>
  )
}
