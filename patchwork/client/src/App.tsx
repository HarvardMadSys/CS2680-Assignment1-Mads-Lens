import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { ChatHistorySidebar } from '@/components/ChatHistorySidebar'
import { RunView } from '@/components/RunView'
import type { RunRevealMap } from '@/components/ToolCallRow'
import { TopBar } from '@/components/TopBar'
import { TrajectoryPanel, type TrajectorySelection } from '@/components/TrajectoryPanel'
import { AgentIdentityProvider } from '@/components/AgentIdentityContext'
import { useTrajectoryVisibility } from '@/lib/useTrajectoryVisibility'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatStoreProvider, useChatStore } from '@/state/ChatStore'

const STICK_TO_BOTTOM_THRESHOLD_PX = 80

/** The conversation + composer column. Kept as one flex column (rather than a full-width
 * composer) so the composer's content lines up directly under the conversation above it,
 * instead of centering in the whole window (which would drift left of true center once the
 * trajectory outline claims the right quarter of the screen). */
function ChatColumn({
  runRevealRefs,
  selectedToolId,
  flashToolId,
}: {
  runRevealRefs: RunRevealMap
  selectedToolId: TrajectorySelection | null
  flashToolId: TrajectorySelection | null
}) {
  const { timeline, isLoading, loadError, activeChat } = useChatStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  useEffect(() => {
    if (selectedToolId) setStickToBottom(false)
  }, [selectedToolId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only to reset scroll when the chat changes
  useEffect(() => {
    setStickToBottom(true)
  }, [activeChat?.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every new timeline event to follow the stream
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom) return
    el.scrollTop = el.scrollHeight
  }, [timeline, stickToBottom])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickToBottom(distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX)
  }

  function jumpToLatest() {
    setStickToBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-3xl space-y-6">
            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {!isLoading && !loadError && timeline.runs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Send a prompt below to get started{activeChat ? ` in ${activeChat.cwd}` : ''}.
              </p>
            )}
            {timeline.runs.map((run) => (
              <RunView
                key={run.id}
                run={run}
                runRevealRefs={runRevealRefs}
                selectedToolId={selectedToolId?.runId === run.id ? selectedToolId.toolId : null}
                flashToolId={flashToolId?.runId === run.id ? flashToolId.toolId : null}
              />
            ))}
          </div>
        </div>
        {!stickToBottom && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={jumpToLatest}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </Button>
        )}
      </div>
      <Composer />
    </div>
  )
}

function ChatWorkspace({ chatId }: { chatId: string }) {
  const { timeline, isReplay } = useChatStore()
  const runRevealRefs = useMemo<RunRevealMap>(() => new Map(), [])
  const {
    open: trajectoryOpen,
    setOpen: setTrajectoryOpen,
    mobileOpen: trajectoryMobileOpen,
    setMobileOpen: setTrajectoryMobileOpen,
  } = useTrajectoryVisibility(timeline.runs.at(-1))
  const [historyCollapsed, setHistoryCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('patchwork.historySidebarCollapsed') === 'true'
    } catch {
      return false
    }
  })
  const [historyMobileOpen, setHistoryMobileOpen] = useState(false)
  const [selectedToolId, setSelectedToolId] = useState<TrajectorySelection | null>(null)
  const [flashToolId, setFlashToolId] = useState<TrajectorySelection | null>(null)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectTool = useCallback((toolId: TrajectorySelection | null) => {
    setSelectedToolId(toolId)
    setFlashToolId(toolId)
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setFlashToolId(null), 1200)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'patchwork.historySidebarCollapsed',
        historyCollapsed ? 'true' : 'false',
      )
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [historyCollapsed])

  return (
    <AgentIdentityProvider runs={timeline.runs}>
      <div className="flex h-svh flex-col bg-background">
        <div className="flex min-h-0 flex-1">
          {!isReplay && (
            <ChatHistorySidebar
              collapsed={historyCollapsed}
              mobileOpen={historyMobileOpen}
              onToggleCollapsed={() => setHistoryCollapsed((collapsed) => !collapsed)}
              onCloseMobile={() => setHistoryMobileOpen(false)}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar
              onOpenHistory={() => setHistoryMobileOpen(true)}
              onOpenTrajectory={() => setTrajectoryMobileOpen(true)}
            />
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              <ChatColumn
                runRevealRefs={runRevealRefs}
                selectedToolId={selectedToolId}
                flashToolId={flashToolId}
              />
              <TrajectoryPanel
                runs={timeline.runs}
                chatId={chatId}
                runRevealRefs={runRevealRefs}
                open={trajectoryOpen}
                onToggle={() => setTrajectoryOpen((open) => !open)}
                onSelectTool={selectTool}
                mobileOpen={trajectoryMobileOpen}
                onCloseMobile={() => setTrajectoryMobileOpen(false)}
              />
            </div>
          </div>
        </div>
      </div>
    </AgentIdentityProvider>
  )
}

function ChatPage() {
  const { activeChat, replayName } = useChatStore()
  const chatId = replayName ? `replay:${replayName}` : (activeChat?.id ?? 'empty')
  return <ChatWorkspace key={chatId} chatId={chatId} />
}

function App() {
  return (
    <TooltipProvider>
      <ChatStoreProvider>
        <ChatPage />
      </ChatStoreProvider>
    </TooltipProvider>
  )
}

export default App
