import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChatMeta, ChatSummary, PersistedEvent } from './types.js'
import { parseRecording } from './recording.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.PATCHWORK_DATA_DIR ?? path.join(moduleDir, '..', 'data')
export const CHATS_DIR = path.join(DATA_DIR, 'chats')
export const FIXTURES_DIR = path.join(DATA_DIR, 'fixtures')
export const DEFAULT_SCRATCH_WORKSPACE = path.join(DATA_DIR, 'scratch-workspace')

function chatDir(chatId: string): string {
  return path.join(CHATS_DIR, chatId)
}

function metaPath(chatId: string): string {
  return path.join(chatDir(chatId), 'meta.json')
}

function eventsPath(chatId: string): string {
  return path.join(chatDir(chatId), 'events.jsonl')
}

export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine || 'New chat'
}

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(CHATS_DIR, { recursive: true })
  await fs.mkdir(FIXTURES_DIR, { recursive: true })
  await fs.mkdir(DEFAULT_SCRATCH_WORKSPACE, { recursive: true })
}

export async function createChat(cwd: string): Promise<ChatMeta> {
  const now = new Date().toISOString()
  const meta: ChatMeta = {
    id: randomUUID(),
    cwd,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    status: 'idle',
  }
  await fs.mkdir(chatDir(meta.id), { recursive: true })
  await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2))
  await fs.writeFile(eventsPath(meta.id), '')
  return meta
}

export async function getChatMeta(chatId: string): Promise<ChatMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(chatId), 'utf8')
    return JSON.parse(raw) as ChatMeta
  } catch {
    return null
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  await fs.rm(chatDir(chatId), { recursive: true, force: true })
}

export async function saveChatMeta(meta: ChatMeta): Promise<void> {
  await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2))
}

export async function listChats(): Promise<ChatSummary[]> {
  let ids: string[]
  try {
    ids = await fs.readdir(CHATS_DIR)
  } catch {
    return []
  }
  const metas = await Promise.all(ids.map((id) => getChatMeta(id)))
  return metas
    .filter((m): m is ChatMeta => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, cwd, title, status, updatedAt, lastRunStatus, lastError }) => ({
      id,
      cwd,
      title,
      status,
      updatedAt,
      lastRunStatus,
      lastError,
    }))
}

export async function appendEvent(chatId: string, event: PersistedEvent): Promise<void> {
  await fs.appendFile(eventsPath(chatId), `${JSON.stringify(event)}\n`)
}

export async function readEvents(chatId: string): Promise<PersistedEvent[]> {
  let raw: string
  try {
    raw = await fs.readFile(eventsPath(chatId), 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PersistedEvent)
}

/** On server startup, any chat left with status "running" belonged to a process that no
 * longer exists (the server restarted) — close it out as interrupted. */
export async function reconcileInterruptedChats(): Promise<void> {
  let ids: string[]
  try {
    ids = await fs.readdir(CHATS_DIR)
  } catch {
    return
  }
  for (const id of ids) {
    const meta = await getChatMeta(id)
    if (meta?.status !== 'running') continue
    if (meta.activePid) {
      try {
        process.kill(meta.activePid, 'SIGTERM')
      } catch {
        // Already gone — nothing to clean up.
      }
    }
    if (meta.activeRunId) {
      await appendEvent(id, {
        kind: 'run_end',
        runId: meta.activeRunId,
        ts: new Date().toISOString(),
        status: 'interrupted',
        error: 'Server restarted while this run was in progress.',
      })
    }
    meta.status = 'idle'
    meta.activeRunId = undefined
    meta.activePid = undefined
    meta.lastRunStatus = 'interrupted'
    meta.lastError = 'Server restarted while this run was in progress.'
    await saveChatMeta(meta)
  }
}

export async function listFixtureNames(): Promise<string[]> {
  let files: string[]
  try {
    files = await fs.readdir(FIXTURES_DIR)
  } catch {
    return []
  }
  return [
    ...new Set(files.filter((f) => /\.jsonl?$/.test(f)).map((f) => f.replace(/\.jsonl?$/, ''))),
  ].sort()
}

export async function readFixture(name: string): Promise<PersistedEvent[] | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null
  try {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')
    return JSON.parse(raw) as PersistedEvent[]
  } catch {
    try {
      const raw = await fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), 'utf8')
      return parseRecording(raw, name)
    } catch {
      return null
    }
  }
}
