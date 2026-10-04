import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Circle,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { DirectoryPicker } from '@/components/DirectoryPicker'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type { ChatSummary } from '@/lib/api'
import { useChatStore } from '@/state/ChatStore'
import { cn } from '@/lib/utils'

const GROUPS = ['Today', 'Yesterday', 'Older'] as const

function groupForDate(value: string): (typeof GROUPS)[number] {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Older'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const daysAgo = Math.floor((startOfToday - startOfDate) / 86_400_000)
  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  return 'Older'
}

function readableTitle(chat: ChatSummary): string {
  const title = chat.title.replace(/\s+/g, ' ').trim()
  return title || 'New chat'
}

function groupedChats(chats: ChatSummary[]): Record<(typeof GROUPS)[number], ChatSummary[]> {
  const groups: Record<(typeof GROUPS)[number], ChatSummary[]> = {
    Today: [],
    Yesterday: [],
    Older: [],
  }
  const sorted = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const chat of sorted) groups[groupForDate(chat.updatedAt)].push(chat)
  return groups
}

function ChatIndicator({ chat, isRunning }: { chat: ChatSummary; isRunning: boolean }) {
  if (isRunning || chat.status === 'running') {
    return <LoaderCircle aria-label="Running" className="size-3.5 animate-spin text-primary" />
  }
  if (chat.lastRunStatus === 'error' || chat.lastRunStatus === 'interrupted') {
    return <AlertCircle aria-label="Needs attention" className="size-3.5 text-destructive" />
  }
  return <Circle aria-hidden="true" className="size-1.5 fill-current text-muted-foreground/50" />
}

function SidebarContents({
  collapsed,
  onToggleCollapsed,
  onCloseMobile,
}: {
  collapsed: boolean
  onToggleCollapsed?: () => void
  onCloseMobile?: () => void
}) {
  const {
    chats,
    activeChat,
    selectChat,
    startNewChat,
    deleteChat,
    renameChat,
    isChatRunning,
    isRunning,
    isReplay,
  } = useChatStore()
  const groups = groupedChats(chats)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  function handleSelect(chatId: string) {
    selectChat(chatId)
    onCloseMobile?.()
  }

  async function handleNewChat(path: string) {
    const success = await startNewChat(path)
    if (success) onCloseMobile?.()
    return success
  }

  async function handleDelete(chat: ChatSummary) {
    const running = isChatRunning(chat.id) || chat.status === 'running'
    if (running || deletingId) return
    if (!window.confirm(`Delete “${readableTitle(chat)}” and its saved history?`)) return
    setDeletingId(chat.id)
    setDeleteError(null)
    try {
      await deleteChat(chat.id)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete chat.')
    } finally {
      setDeletingId(null)
    }
  }

  function startRename(chat: ChatSummary) {
    setRenameError(null)
    setRenamingId(chat.id)
    setRenameValue(readableTitle(chat))
    // The input isn't mounted yet on this render; focus once it is.
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  async function commitRename(chat: ChatSummary) {
    const nextTitle = renameValue.trim()
    setRenamingId(null)
    if (!nextTitle || nextTitle === readableTitle(chat)) return
    try {
      await renameChat(chat.id, nextTitle)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename chat.')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex items-center gap-2 px-3 py-3', collapsed && 'justify-center px-2')}>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Chat history</p>
            <p className="truncate text-[11px] text-muted-foreground">Your conversations</p>
          </div>
        )}
        {onToggleCollapsed && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand chat history' : 'Collapse chat history'}
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </Button>
        )}
        {onCloseMobile && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onCloseMobile}
            aria-label="Close chat history"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      <div className={cn('px-3 pb-3', collapsed && 'px-2')}>
        <DirectoryPicker
          initialPath={activeChat?.cwd ?? ''}
          recentPaths={[...chats]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((chat) => chat.cwd)}
          onConfirm={handleNewChat}
          trigger={
            <Button
              type="button"
              size={collapsed ? 'icon' : 'lg'}
              className={cn('w-full shadow-sm', collapsed && 'px-0')}
              disabled={isReplay}
              aria-label="New chat"
              title={collapsed ? 'New chat' : undefined}
            >
              <Plus className="size-4" />
              {!collapsed && 'New chat'}
            </Button>
          }
        />
      </div>

      <Separator />

      {(deleteError || renameError) && !collapsed && (
        <p className="px-3 pt-2 text-xs text-destructive" role="alert">
          {deleteError || renameError}
        </p>
      )}

      <ScrollArea className="min-h-0 flex-1 px-2 py-3">
        {chats.length === 0 ? (
          !collapsed && <p className="px-2 text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <div className="space-y-4">
            {GROUPS.map((group) => {
              const groupChats = groups[group]
              if (groupChats.length === 0) return null
              return (
                <section key={group} aria-label={group}>
                  {!collapsed && (
                    <h2 className="px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      {group}
                    </h2>
                  )}
                  <div className="space-y-0.5">
                    {groupChats.map((chat) => {
                      const selected = activeChat?.id === chat.id
                      const running = isChatRunning(chat.id)
                      const canDelete = !running && !isChatRunning(chat.id)
                      const isRenaming = renamingId === chat.id

                      if (isRenaming && !collapsed) {
                        return (
                          <div
                            key={chat.id}
                            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5"
                          >
                            <Input
                              ref={renameInputRef}
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void commitRename(chat)
                                else if (e.key === 'Escape') setRenamingId(null)
                              }}
                              onBlur={() => void commitRename(chat)}
                              className="h-7 flex-1 text-xs"
                              maxLength={200}
                              autoFocus
                            />
                          </div>
                        )
                      }

                      return (
                        <div
                          key={chat.id}
                          className={cn(
                            'group flex items-center gap-0.5 rounded-lg transition-colors',
                            selected && 'bg-secondary text-secondary-foreground shadow-sm',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => handleSelect(chat.id)}
                            aria-current={selected ? 'page' : undefined}
                            aria-label={collapsed ? readableTitle(chat) : undefined}
                            title={collapsed ? readableTitle(chat) : undefined}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                              'hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                              collapsed && 'justify-center px-0',
                            )}
                          >
                            {!collapsed && (
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium">
                                  {readableTitle(chat)}
                                </p>
                                <p className="truncate font-mono text-[10px] text-muted-foreground">
                                  {chat.cwd}
                                </p>
                              </div>
                            )}
                            <ChatIndicator
                              chat={chat}
                              isRunning={running || (selected && isRunning)}
                            />
                          </button>
                          {!collapsed && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Options for ${readableTitle(chat)}`}
                                  className="mr-1 shrink-0 text-muted-foreground hover:text-foreground"
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => startRename(chat)}>
                                  <Pencil className="size-3.5" />
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={!canDelete || deletingId === chat.id}
                                  onSelect={() => void handleDelete(chat)}
                                >
                                  <Trash2 className="size-3.5" />
                                  {canDelete ? 'Delete' : 'Stop the run to delete'}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

export function ChatHistorySidebar({
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onCloseMobile,
}: {
  collapsed: boolean
  mobileOpen: boolean
  onToggleCollapsed: () => void
  onCloseMobile: () => void
}) {
  return (
    <>
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200 lg:flex',
          collapsed ? 'w-16' : 'w-72',
        )}
      >
        <SidebarContents collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close chat history"
            onClick={onCloseMobile}
            className="absolute inset-0 bg-foreground/20 backdrop-blur-[1px]"
          />
          <aside className="relative flex h-full w-[min(21rem,88vw)] flex-col border-r border-border bg-background shadow-xl">
            <SidebarContents collapsed={false} onCloseMobile={onCloseMobile} />
          </aside>
        </div>
      )}
    </>
  )
}
