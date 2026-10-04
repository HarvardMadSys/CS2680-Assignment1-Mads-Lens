import { FolderOpen, SendHorizontal } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useEffect, useRef } from 'react'
import { ActiveRunStatusBar } from '@/components/RunStatusBar'
import { DirectoryPicker } from '@/components/DirectoryPicker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useChatStore } from '@/state/ChatStore'

export function Composer() {
  const {
    activeChat,
    chats,
    draft,
    setDraft,
    sendPrompt,
    isRunning,
    isLoading,
    isReplay,
    startNewChat,
    sendError,
    clearSendError,
  } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to resize whenever the draft text changes
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  function handleSend() {
    if (!draft.trim() || isRunning || isLoading || isReplay) return
    const prompt = draft
    setDraft('')
    void sendPrompt(prompt)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!activeChat) return null

  return (
    <div className="border-t border-border bg-background/95 px-4 pt-2 pb-4 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <ActiveRunStatusBar />
        {sendError && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            <span>{sendError}</span>
            <button type="button" onClick={clearSendError} className="font-medium hover:underline">
              Dismiss
            </button>
          </div>
        )}
        <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="shrink-0">Workspace</span>
          <span
            title={activeChat.cwd}
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
          >
            {activeChat.cwd}
          </span>
          {isReplay ? (
            <span className="text-[10px]">Read-only</span>
          ) : (
            <DirectoryPicker
              initialPath={activeChat.cwd}
              recentPaths={[...chats]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((chat) => chat.cwd)}
              onConfirm={startNewChat}
              trigger={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isLoading}
                  aria-label="Change workspace"
                  className="h-7 shrink-0 rounded-md px-2.5 text-[11px]"
                >
                  Change
                </Button>
              }
            />
          )}
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-sm">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isReplay
                ? 'This is a replay — read-only.'
                : 'Ask Claude to do something in this workspace…'
            }
            disabled={isReplay || isLoading}
            rows={1}
            className="max-h-60 min-h-10 resize-none border-none shadow-none focus-visible:ring-0"
          />
          <Button
            type="button"
            size="icon"
            onClick={handleSend}
            disabled={isRunning || isLoading || isReplay || !draft.trim()}
            aria-label="Send"
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
