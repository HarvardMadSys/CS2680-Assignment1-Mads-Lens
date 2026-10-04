import { Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { RUN_STATUS_CONFIG, StatusIcon } from '@/components/statusConfig'
import { Button } from '@/components/ui/button'
import { latestObservedAction } from '@/lib/timeline/selectors'
import type { Run } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/state/ChatStore'

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Always-visible run status near the composer — distinct from any individual tool's own
 * pending/success/error state, which lives on that tool's row instead. */
export function RunStatusBar({ run, onStop }: { run: Run; onStop?: (() => void) | undefined }) {
  const [, forceTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run the ticking clock only while this run is active
  useEffect(() => {
    if (run.status !== 'running') return
    const id = setInterval(() => forceTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [run.status, run.id])

  const config = RUN_STATUS_CONFIG[run.status]
  const endedMs = run.endedAt ? Date.parse(run.endedAt) : Date.now()
  const elapsedMs = endedMs - Date.parse(run.startedAt)
  const action = latestObservedAction(run)

  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <StatusIcon config={config} className="size-3.5" />
      <span className={cn('shrink-0 font-medium', config.className)}>{config.label}</span>
      <span className="shrink-0 text-muted-foreground">· {formatElapsed(elapsedMs)}</span>
      {action && <span className="min-w-0 flex-1 truncate text-muted-foreground">· {action}</span>}
      {onStop && run.status === 'running' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onStop}
          className="ml-auto h-6 shrink-0 gap-1 px-2 text-muted-foreground hover:text-destructive"
        >
          <Square className="size-3" />
          Stop
        </Button>
      )}
    </div>
  )
}

export function ActiveRunStatusBar() {
  const { timeline, isRunning, activeChat, isReplay, stopChat } = useChatStore()
  const run = timeline.runs[timeline.runs.length - 1]
  if (!run || !isRunning || run.status !== 'running' || !activeChat) return null
  return (
    <RunStatusBar run={run} onStop={isReplay ? undefined : () => void stopChat(activeChat.id)} />
  )
}
