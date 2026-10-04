import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/lib/api'
import type { ChatMeta, ChatSummary } from '@/lib/api'
import { applyEvent, buildTimeline } from '@/lib/timeline/reducer'
import { createEmptyTimelineState } from '@/lib/timeline/types'
import type { PersistedEvent, TimelineState } from '@/lib/timeline/types'

const EMPTY_TIMELINE = createEmptyTimelineState()
const ACTIVE_CHAT_STORAGE_KEY = 'patchwork.activeChatId'

function getStoredActiveChatId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY)
  } catch {
    return null
  }
}

/** A fixture's own `system/init` event carries the cwd it was recorded against — using it
 * (instead of a placeholder) lets replay demonstrate workspace-relative paths too. */
function extractCwdFromEvents(events: PersistedEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'claude') continue
    const raw = event.event
    if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.cwd === 'string') {
      return raw.cwd
    }
  }
  return undefined
}

interface ChatStoreValue {
  chats: ChatSummary[]
  activeChat: ChatMeta | null
  timeline: TimelineState
  isRunning: boolean
  isLoading: boolean
  loadError: string | null
  sendError: string | null
  clearSendError: () => void
  isReplay: boolean
  replayName: string | null
  isChatRunning: (chatId: string) => boolean
  draft: string
  setDraft: (value: string) => void
  selectChat: (id: string) => void
  startNewChat: (cwd: string) => Promise<boolean>
  sendPrompt: (prompt: string) => Promise<void>
  stopChat: (chatId: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  renameChat: (chatId: string, title: string) => Promise<void>
}

const ChatStoreContext = createContext<ChatStoreValue | null>(null)

export function useChatStore(): ChatStoreValue {
  const ctx = useContext(ChatStoreContext)
  if (!ctx) throw new Error('useChatStore must be used within a ChatStoreProvider')
  return ctx
}

function getReplayNameFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('replay')
}

export function ChatStoreProvider({ children }: { children: ReactNode }) {
  const replayName = useMemo(getReplayNameFromUrl, [])
  const isReplay = replayName !== null

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChat, setActiveChat] = useState<ChatMeta | null>(null)
  const [timelines, setTimelines] = useState<Record<string, TimelineState>>({})
  const [runningChatIds, setRunningChatIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [replayCwd, setReplayCwd] = useState<string | null>(null)
  const didInit = useRef(false)
  const loadRequest = useRef(0)
  /** Chat ids with a live subscription (via `sendPrompt` or `attachChat`) currently applying
   * events to `timelines` — guards against attaching to the same chat's run twice. */
  const attachedChatIds = useRef<Set<string>>(new Set())

  const activeChatId = activeChat?.id ?? (isReplay ? 'replay' : null)
  const timeline = activeChatId ? (timelines[activeChatId] ?? EMPTY_TIMELINE) : EMPTY_TIMELINE
  const isRunning = activeChatId ? runningChatIds.has(activeChatId) : false

  const refreshChats = useCallback(async () => {
    try {
      setChats(await api.listChats())
    } catch {
      // Chat list is a convenience for the selector; failing to refresh it isn't fatal.
    }
  }, [])

  /** Folds one event into a specific chat's timeline and keeps its running/status bookkeeping
   * in sync — shared by a freshly-started run (`sendPrompt`) and a reattached one
   * (`attachChat`), so both update state identically regardless of which chat is on screen. */
  const applyChatEvent = useCallback((chatId: string, event: PersistedEvent) => {
    setTimelines((current) => ({
      ...current,
      [chatId]: applyEvent(current[chatId] ?? EMPTY_TIMELINE, event),
    }))
    if (event.kind === 'run_start') {
      setRunningChatIds((current) => new Set([...current, chatId]))
      setChats((current) =>
        current.map((chat) => (chat.id === chatId ? { ...chat, status: 'running' } : chat)),
      )
    }
    if (event.kind === 'run_end') {
      setRunningChatIds((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
      setChats((current) =>
        current.map((chat) =>
          chat.id === chatId
            ? { ...chat, status: 'idle', lastRunStatus: event.status, lastError: event.error }
            : chat,
        ),
      )
    }
  }, [])

  /** Reattaches to a chat that's already running (a reload, another tab, or one this session
   * knows is running in the background) — replays what's missing from `since` onward and
   * keeps applying events live, without starting a second `claude` process. Safe to call
   * more than once for the same chat; only the first call actually subscribes. */
  const attachChat = useCallback(
    (chatId: string, since: number) => {
      if (attachedChatIds.current.has(chatId)) return
      attachedChatIds.current.add(chatId)
      setRunningChatIds((current) => new Set([...current, chatId]))
      setChats((current) =>
        current.map((chat) => (chat.id === chatId ? { ...chat, status: 'running' } : chat)),
      )
      void (async () => {
        try {
          for await (const event of api.attachToRun(chatId, since)) {
            applyChatEvent(chatId, event)
          }
        } catch {
          // A dropped connection just stops us watching; the server's own state (picked up by
          // the next load/attach or refreshChats below) is what's authoritative.
        } finally {
          attachedChatIds.current.delete(chatId)
          setRunningChatIds((current) => {
            const next = new Set(current)
            next.delete(chatId)
            return next
          })
          void refreshChats()
        }
      })()
    },
    [applyChatEvent, refreshChats],
  )

  const loadChat = useCallback(
    async (id: string) => {
      const requestId = loadRequest.current + 1
      loadRequest.current = requestId
      setIsLoading(true)
      setLoadError(null)
      try {
        const { chat, events } = await api.getChat(id)
        if (requestId !== loadRequest.current) return
        setActiveChat(chat)
        const alreadySubscribed = attachedChatIds.current.has(id)
        setTimelines((current) => {
          // A connected stream owns the current timeline. Otherwise reload the entire
          // snapshot before subscribing at its cursor, including events missed offline.
          if (current[id] && alreadySubscribed) return current
          return { ...current, [id]: buildTimeline(events) }
        })
        if (chat.status === 'running') attachChat(id, events.length)
      } catch (err) {
        if (requestId !== loadRequest.current) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load chat.')
      } finally {
        if (requestId === loadRequest.current) setIsLoading(false)
      }
    },
    [attachChat],
  )

  const selectChat = useCallback(
    (id: string) => {
      if (id === activeChat?.id) return
      void loadChat(id)
    },
    [activeChat, loadChat],
  )

  const startNewChat = useCallback(
    async (cwd: string) => {
      loadRequest.current += 1
      setIsLoading(true)
      setLoadError(null)
      try {
        const meta = await api.createChat(cwd)
        setActiveChat(meta)
        setTimelines((current) => ({ ...current, [meta.id]: createEmptyTimelineState() }))
        await refreshChats()
        return true
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to create chat.')
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [refreshChats],
  )

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (isReplay || !activeChat || runningChatIds.has(activeChat.id) || !prompt.trim()) return
      const chatId = activeChat.id

      attachedChatIds.current.add(chatId)
      setRunningChatIds((current) => new Set([...current, chatId]))
      setChats((current) =>
        current.map((chat) => (chat.id === chatId ? { ...chat, status: 'running' } : chat)),
      )
      setSendError(null)
      let sawRunId: string | null = null
      let sawRunEnd = false
      try {
        for await (const event of api.streamRun(chatId, prompt)) {
          if (event.kind === 'run_start') sawRunId = event.runId
          if (event.kind === 'run_end') sawRunEnd = true
          applyChatEvent(chatId, event)
        }
        if (sawRunId && !sawRunEnd) {
          applyChatEvent(chatId, {
            kind: 'run_end',
            runId: sawRunId,
            ts: new Date().toISOString(),
            status: 'interrupted',
            error: 'The connection ended before the run finished.',
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The run failed unexpectedly.'
        if (sawRunId && !sawRunEnd) {
          applyChatEvent(chatId, {
            kind: 'run_end',
            runId: sawRunId,
            ts: new Date().toISOString(),
            status: 'error',
            error: message,
          })
        } else {
          setSendError(message)
        }
      } finally {
        attachedChatIds.current.delete(chatId)
        setRunningChatIds((current) => {
          const next = new Set(current)
          next.delete(chatId)
          return next
        })
        setChats((current) =>
          current.map((chat) => (chat.id === chatId ? { ...chat, status: 'idle' } : chat)),
        )
        void refreshChats()
      }
    },
    [isReplay, activeChat, runningChatIds, applyChatEvent, refreshChats],
  )

  const stopChat = useCallback(async (chatId: string) => {
    try {
      await api.stopChat(chatId)
    } catch {
      // Best-effort — the run's own terminal event (or the next status refresh) reflects
      // whatever actually happened server-side.
    }
  }, [])

  const deleteChat = useCallback(
    async (chatId: string) => {
      if (runningChatIds.has(chatId)) {
        throw new Error('Stop the active run before deleting this chat.')
      }
      const nextChat = chats.find((chat) => chat.id !== chatId)
      await api.deleteChat(chatId)

      loadRequest.current += 1
      setChats((current) => current.filter((chat) => chat.id !== chatId))
      setTimelines((current) => {
        const next = { ...current }
        delete next[chatId]
        return next
      })

      if (activeChat?.id !== chatId) return

      try {
        window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY)
      } catch {
        // Local storage can be unavailable in privacy-restricted browser contexts.
      }
      setActiveChat(null)
      if (nextChat) await loadChat(nextChat.id)
    },
    [activeChat, chats, loadChat, runningChatIds],
  )

  const renameChat = useCallback(async (chatId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    await api.renameChat(chatId, trimmed)
    setChats((current) =>
      current.map((chat) => (chat.id === chatId ? { ...chat, title: trimmed } : chat)),
    )
    setActiveChat((current) =>
      current && current.id === chatId ? { ...current, title: trimmed } : current,
    )
  }, [])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    if (isReplay && replayName) {
      setIsLoading(true)
      api
        .getFixture(replayName)
        .then((events) => {
          setReplayCwd(extractCwdFromEvents(events) ?? null)
          setTimelines((current) => ({ ...current, replay: buildTimeline(events) }))
        })
        .catch((err: unknown) =>
          setLoadError(err instanceof Error ? err.message : 'Failed to load fixture.'),
        )
        .finally(() => setIsLoading(false))
      return
    }

    void (async () => {
      setIsLoading(true)
      try {
        const existing = await api.listChats()
        setChats(existing)
        if (existing.length > 0 && existing[0]) {
          const storedId = getStoredActiveChatId()
          const preferred = existing.find((chat) => chat.id === storedId) ?? existing[0]
          // Chats other than the one we're about to open still need their running state (and
          // eventual completion) observed so the sidebar reflects reality without opening
          // each one — `loadChat` below handles reattaching the preferred chat itself.
          for (const chat of existing) {
            if (chat.id !== preferred.id && chat.status === 'running') attachChat(chat.id, 0)
          }
          await loadChat(preferred.id)
        } else {
          const defaultPath = await api.getDefaultWorkspace()
          const meta = await api.createChat(defaultPath)
          setActiveChat(meta)
          setTimelines((current) => ({ ...current, [meta.id]: createEmptyTimelineState() }))
          await refreshChats()
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load the app.')
      } finally {
        setIsLoading(false)
      }
    })()
  }, [isReplay, replayName, loadChat, refreshChats, attachChat])

  useEffect(() => {
    if (isReplay || !activeChat) return
    try {
      window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChat.id)
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [activeChat, isReplay])

  const value: ChatStoreValue = {
    chats,
    activeChat: isReplay
      ? {
          id: 'replay',
          cwd: replayCwd ?? `replay:${replayName}`,
          title: `Replay · ${replayName}`,
          status: 'idle',
          updatedAt: '',
          createdAt: '',
        }
      : activeChat,
    timeline,
    isRunning,
    isLoading,
    loadError,
    sendError,
    clearSendError: () => setSendError(null),
    isReplay,
    replayName,
    isChatRunning: (chatId: string) => runningChatIds.has(chatId),
    draft,
    setDraft,
    selectChat,
    startNewChat,
    sendPrompt,
    stopChat,
    deleteChat,
    renameChat,
  }

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>
}
