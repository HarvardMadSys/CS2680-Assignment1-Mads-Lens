import { ListTree, Menu } from 'lucide-react'
import { AgentCrew } from '@/components/AgentCrew'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/state/ChatStore'

export function TopBar({
  onOpenHistory,
  onOpenTrajectory,
}: {
  onOpenHistory?: () => void
  onOpenTrajectory?: () => void
}) {
  const { isReplay, replayName } = useChatStore()

  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      {!isReplay && onOpenHistory && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onOpenHistory}
          aria-label="Open chat history"
          className="lg:hidden"
        >
          <Menu className="size-4" />
        </Button>
      )}
      <AgentCrew />
      <span className="shrink-0 text-sm font-semibold tracking-tight">Patchwork</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">
        The odd little hacker collective
      </span>
      {isReplay && (
        <span
          className="min-w-0 truncate rounded bg-secondary px-2 py-1 text-[10px] text-muted-foreground"
          title={replayName ?? ''}
        >
          Recorded replay · read-only
        </span>
      )}
      {onOpenTrajectory && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onOpenTrajectory}
          aria-label="Open trajectory"
          className="ml-auto lg:hidden"
        >
          <ListTree className="size-4" />
        </Button>
      )}
    </header>
  )
}
