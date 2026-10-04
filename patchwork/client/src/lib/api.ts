import type { PersistedEvent, RunEndStatus } from './timeline/types'

export type ChatStatus = 'idle' | 'running'

export interface ChatSummary {
  id: string
  cwd: string
  title: string
  status: ChatStatus
  updatedAt: string
  lastRunStatus?: RunEndStatus | undefined
  lastError?: string | undefined
}

export interface ChatMeta extends ChatSummary {
  sessionId?: string
  activeRunId?: string
  createdAt: string
  lastRunStatus?: RunEndStatus | undefined
  lastError?: string | undefined
}

export interface DirectoryCheckResult {
  ok: boolean
  resolved?: string
  error?: string
}

export interface DirectoryListing extends DirectoryCheckResult {
  parent?: string
  directories: { name: string; path: string }[]
  truncated?: boolean
}

export async function browseWorkspace(path: string): Promise<DirectoryListing> {
  const res = await fetch('/api/workspaces/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Could not browse this folder.'))
  return asJson<DirectoryListing>(res)
}

async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

export async function checkWorkspace(path: string): Promise<DirectoryCheckResult> {
  const res = await fetch('/api/workspaces/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  return asJson<DirectoryCheckResult>(res)
}

export async function getDefaultWorkspace(): Promise<string> {
  const res = await fetch('/api/workspaces/default')
  const data = await asJson<{ path: string }>(res)
  return data.path
}

export async function createChat(cwd: string): Promise<ChatMeta> {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to create chat.'))
  return asJson<ChatMeta>(res)
}

export async function listChats(): Promise<ChatSummary[]> {
  const res = await fetch('/api/chats')
  return asJson<ChatSummary[]>(res)
}

export async function getChat(id: string): Promise<{ chat: ChatMeta; events: PersistedEvent[] }> {
  const res = await fetch(`/api/chats/${id}`)
  if (!res.ok) throw new Error(await errorMessage(res, 'Chat not found.'))
  return asJson<{ chat: ChatMeta; events: PersistedEvent[] }>(res)
}

export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to delete chat.'))
}

export async function renameChat(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/chats/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to rename chat.'))
}

export async function listFixtures(): Promise<string[]> {
  const res = await fetch('/api/fixtures')
  if (!res.ok) return []
  return asJson<string[]>(res)
}

export async function getFixture(name: string): Promise<PersistedEvent[]> {
  const res = await fetch(`/api/fixtures/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(await errorMessage(res, 'Fixture not found.'))
  return asJson<PersistedEvent[]>(res)
}

/** Reads an NDJSON response body, yielding each parsed `PersistedEvent` as it arrives and
 * buffering partial JSONL lines across chunk boundaries. Shared by `streamRun` and
 * `attachToRun` — both just point it at a different endpoint. */
async function* readNdjson(res: Response): AsyncGenerator<PersistedEvent> {
  if (!res.body) throw new Error('Response has no body to stream.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function* drain(chunk: string, isFinal: boolean): Generator<PersistedEvent> {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = isFinal ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) yield JSON.parse(trimmed) as PersistedEvent
    }
    if (isFinal) {
      const trimmed = buffer.trim()
      if (trimmed) yield JSON.parse(trimmed) as PersistedEvent
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        yield* drain(decoder.decode(), true)
        return
      }
      yield* drain(decoder.decode(value, { stream: true }), false)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Starts a run and yields each `PersistedEvent` as it streams in over the `POST /api/run`
 * response body. */
export async function* streamRun(chatId: string, prompt: string): AsyncGenerator<PersistedEvent> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, prompt }),
  })
  if (!res.ok || !res.body) {
    throw new Error(await errorMessage(res, `Failed to start run (${res.status}).`))
  }
  yield* readNdjson(res)
}

/**
 * Reattaches to a chat's activity without starting a new run: yields events from `since`
 * onward, replaying what was missed and then (only if a run is actually in progress)
 * continuing live — this is what lets a reload or a second tab observe an already-running
 * chat without duplicating its execution.
 */
export async function* attachToRun(chatId: string, since: number): AsyncGenerator<PersistedEvent> {
  const res = await fetch(`/api/chats/${chatId}/stream?since=${since}`)
  if (!res.ok || !res.body) {
    throw new Error(await errorMessage(res, `Failed to attach to chat (${res.status}).`))
  }
  yield* readNdjson(res)
}

/** Explicitly stops this chat's in-progress run, if any. Scoped to this one chat only. */
export async function stopChat(chatId: string): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/stop`, { method: 'POST' })
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to stop the run.'))
}
