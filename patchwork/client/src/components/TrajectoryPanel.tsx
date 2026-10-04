import {
  ArrowDown,
  ChevronRight,
  Info,
  Expand,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TrajectoryTimeline } from '@/components/TrajectoryTimeline'
import { TrajectoryDetails } from '@/components/TrajectoryDetails'
import { TrajectoryCallOutline } from '@/components/TrajectoryCallOutline'
import { RUN_STATUS_CONFIG, StatusIcon } from '@/components/statusConfig'
import type { RunRevealMap } from '@/components/ToolCallRow'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toolKey } from '@/lib/timeline/execution'
import type { Run } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'

export interface TrajectorySelection {
  runId: string
  toolId: string
}
interface ViewState {
  closedRuns: Record<string, boolean>
  folded: Record<string, boolean>
  expandedGroups: Record<string, boolean>
  selection: TrajectorySelection | null
  following: boolean
  scrollTop: number
  width: number
  mode: 'lanes' | 'outline'
}
function readView(key: string): ViewState {
  const defaults: ViewState = {
    closedRuns: {},
    folded: {},
    expandedGroups: {},
    selection: null,
    following: true,
    scrollTop: 0,
    width: 620,
    mode: 'lanes',
  }
  try {
    // `selection` drives the always-visible task/activity/result inspector, so it's deliberately
    // excluded from restoration — reopening it unasked on mount (e.g. after a refresh or
    // switching back to a chat) would obscure the trajectory before the user has clicked anything.
    return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? '{}'), selection: null }
  } catch {
    return defaults
  }
}

export function TrajectoryPanel({
  runs,
  chatId,
  runRevealRefs,
  open,
  onToggle,
  onSelectTool,
  mobileOpen,
  onCloseMobile,
}: {
  runs: Run[]
  chatId: string
  runRevealRefs: RunRevealMap
  open: boolean
  onToggle: () => void
  onSelectTool: (selection: TrajectorySelection | null) => void
  mobileOpen?: boolean | undefined
  onCloseMobile?: (() => void) | undefined
}) {
  const storageKey = `patchwork.trajectory.v1:${chatId}`
  const [view, setView] = useState(() => readView(storageKey))
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(view.scrollTop)
  const lastRun = runs.at(-1)
  const selectedRun = runs.find((run) => run.id === view.selection?.runId)
  const lastId = useRef(lastRun?.id)
  const selectionCallback = useRef(onSelectTool)
  selectionCallback.current = onSelectTool
  useEffect(() => {
    selectionCallback.current(view.selection)
  }, [view.selection])
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ...view, scrollTop: scrollPosition.current }),
      )
    } catch {
      /* Storage is optional. */
    }
  }, [storageKey, view])
  useLayoutEffect(() => {
    if ((open || mobileOpen) && scrollRef.current)
      scrollRef.current.scrollTop = scrollPosition.current
  }, [open, mobileOpen])
  useLayoutEffect(() => {
    if (view.following && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    if (lastId.current !== lastRun?.id && view.following && lastRun)
      setView((v) => ({ ...v, closedRuns: { ...v.closedRuns, [lastRun.id]: false } }))
    lastId.current = lastRun?.id
  }, [lastRun, view.following])
  function jump(runId: string, toolId: string) {
    setView((v) => ({ ...v, following: false, selection: { runId, toolId } }))
    runRevealRefs.get(runId)?.(toolId)
  }
  function jumpLive() {
    setView((v) => ({
      ...v,
      following: true,
      selection: null,
      closedRuns: { ...v.closedRuns, ...(lastRun ? { [lastRun.id]: false } : {}) },
    }))
  }
  function resize(width: number) {
    setView((v) => ({ ...v, width: Math.max(280, Math.min(1100, width)) }))
  }
  function fold(runId: string, id: string) {
    setView((v) => ({
      ...v,
      following: false,
      folded: {
        ...v.folded,
        [toolKey(runId, id)]: !v.folded[toolKey(runId, id)],
      },
    }))
  }
  return (
    <>
      {!open && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3 hidden lg:flex"
          onClick={onToggle}
          aria-label="Show trajectory"
        >
          <PanelRightOpen className="size-4" />
        </Button>
      )}
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-foreground/20 lg:hidden"
          aria-label="Close trajectory backdrop"
          onClick={onCloseMobile}
        />
      )}
      {(open || mobileOpen) && (
        <aside
          aria-label="Trajectory history"
          className={cn('trajectory-panel', mobileOpen && 'trajectory-mobile')}
          style={{ width: view.width }}
        >
          <hr
            tabIndex={0}
            aria-label="Resize trajectory"
            aria-orientation="vertical"
            aria-valuenow={view.width}
            aria-valuemin={280}
            aria-valuemax={1100}
            className="trajectory-resizer"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') resize(view.width + 40)
              if (e.key === 'ArrowRight') resize(view.width - 40)
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              const parent = e.currentTarget.parentElement
              if (parent && e.currentTarget.hasPointerCapture(e.pointerId))
                resize(parent.getBoundingClientRect().right - e.clientX)
            }}
          />
          <div className="flex items-center justify-between border-b px-3 py-3">
            <div>
              <h2 className="text-xs font-semibold">
                Trajectory{' '}
                <span className="font-normal text-muted-foreground">/ {runs.length} runs</span>
              </h2>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Select a task to trace its assignment, activity & result
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="hidden lg:inline-flex text-[11px]"
                aria-label={view.width > 700 ? 'Compact trajectory' : 'Widen trajectory'}
                title={view.width > 700 ? 'Compact trajectory' : 'Widen to see more branches'}
                onClick={() => resize(view.width > 700 ? 620 : 1100)}
              >
                <Expand className="size-3.5" />
                {view.width > 700 ? 'Compact' : 'Wide view'}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={mobileOpen ? onCloseMobile : onToggle}
                aria-label={mobileOpen ? 'Close trajectory' : 'Hide trajectory'}
              >
                {mobileOpen ? <X className="size-4" /> : <PanelRightClose className="size-4" />}
              </Button>
            </div>
          </div>
          <fieldset
            className="flex items-center gap-1 border-b px-3 py-1.5"
            aria-label="Trajectory view"
          >
            <Button
              variant={view.mode === 'lanes' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 text-[11px]"
              aria-pressed={view.mode === 'lanes'}
              onClick={() => setView((v) => ({ ...v, mode: 'lanes', following: false }))}
            >
              Lanes
            </Button>
            <Button
              variant={view.mode === 'outline' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 text-[11px]"
              aria-pressed={view.mode === 'outline'}
              onClick={() => setView((v) => ({ ...v, mode: 'outline', following: false }))}
            >
              Call outline
            </Button>
          </fieldset>
          {!view.following && (
            <Button
              variant="secondary"
              size="sm"
              onClick={jumpLive}
              className="m-2 justify-between"
            >
              <span>{lastRun?.status === 'running' ? 'A run is active' : 'Viewing history'}</span>
              <span className="flex items-center gap-1">
                <ArrowDown className="size-3" />
                {lastRun?.status === 'running' ? 'Jump to live' : 'Jump to latest'}
              </span>
            </Button>
          )}
          <div
            ref={scrollRef}
            data-trajectory-scroll
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget
              scrollPosition.current = el.scrollTop
              if (view.following && el.scrollHeight - el.scrollTop - el.clientHeight > 80)
                setView((v) => ({ ...v, following: false }))
              try {
                localStorage.setItem(
                  storageKey,
                  JSON.stringify({ ...view, scrollTop: el.scrollTop }),
                )
              } catch {
                /* Storage is optional. */
              }
            }}
          >
            {runs.length === 0 && (
              <p className="p-4 text-xs text-muted-foreground">
                Each prompt will add its own trajectory here.
              </p>
            )}
            {runs.map((run, index) => (
              <Collapsible
                key={run.id}
                data-trajectory-run={run.id}
                open={!view.closedRuns[run.id]}
                onOpenChange={(expanded) =>
                  setView((v) => ({
                    ...v,
                    following: false,
                    closedRuns: { ...v.closedRuns, [run.id]: !expanded },
                  }))
                }
                className="border-b"
              >
                <div className="flex items-center gap-1 bg-secondary/40 px-2 py-2">
                  <CollapsibleTrigger
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-label={`Run ${index + 1}: ${run.prompt}`}
                  >
                    <ChevronRight
                      className={cn('size-3 shrink-0', !view.closedRuns[run.id] && 'rotate-90')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold text-muted-foreground">
                        RUN {index + 1} · {RUN_STATUS_CONFIG[run.status].label}
                      </span>
                      <span className="block truncate text-xs">
                        {run.prompt || 'Prompt unavailable in recording'}
                      </span>
                    </span>
                    <StatusIcon config={RUN_STATUS_CONFIG[run.status]} className="size-3" />
                  </CollapsibleTrigger>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Full prompt for run ${index + 1}`}
                      >
                        <Info className="size-3" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="left"
                      className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                    >
                      {run.prompt || 'Prompt unavailable in recording'}
                    </PopoverContent>
                  </Popover>
                </div>
                {run.error && <p className="px-3 py-2 text-xs text-destructive">{run.error}</p>}
                <CollapsibleContent>
                  {view.mode === 'outline' ? (
                    <TrajectoryCallOutline
                      run={run}
                      folded={view.folded}
                      selection={view.selection}
                      onJump={(id) => jump(run.id, id)}
                      onFold={(id) => fold(run.id, id)}
                    />
                  ) : (
                    <TrajectoryTimeline
                      run={run}
                      folded={view.folded}
                      expandedGroups={view.expandedGroups}
                      onGroupToggle={(id, expanded) =>
                        setView((v) => ({
                          ...v,
                          following: false,
                          expandedGroups: { ...v.expandedGroups, [toolKey(run.id, id)]: expanded },
                        }))
                      }
                      selection={view.selection}
                      onJump={(id) => jump(run.id, id)}
                      onFold={(id) => fold(run.id, id)}
                    />
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
          {selectedRun && view.selection && (
            <TrajectoryDetails
              run={selectedRun}
              toolId={view.selection.toolId}
              onClose={() => setView((v) => ({ ...v, selection: null }))}
              onReveal={() => {
                if (view.selection) runRevealRefs.get(view.selection.runId)?.(view.selection.toolId)
              }}
            />
          )}
        </aside>
      )}
    </>
  )
}
