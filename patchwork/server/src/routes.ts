import { Router } from 'express'
import { browseDirectory, checkDirectory } from './paths.js'
import * as runRegistry from './runRegistry.js'
import {
  createChat,
  DEFAULT_SCRATCH_WORKSPACE,
  deleteChat,
  getChatMeta,
  listChats,
  listFixtureNames,
  readEvents,
  readFixture,
  saveChatMeta,
} from './storage.js'
import type { PersistedEvent } from './types.js'

export const router = Router()

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

router.post('/workspaces/check', async (req, res) => {
  const inputPath = typeof req.body?.path === 'string' ? req.body.path : ''
  const result = await checkDirectory(inputPath || DEFAULT_SCRATCH_WORKSPACE)
  res.json(result)
})

router.get('/workspaces/default', (_req, res) => {
  res.json({ path: DEFAULT_SCRATCH_WORKSPACE })
})

router.post('/workspaces/browse', async (req, res) => {
  const input = typeof req.body?.path === 'string' ? req.body.path : ''
  res.json(await browseDirectory(input || DEFAULT_SCRATCH_WORKSPACE))
})

router.post('/chats', async (req, res) => {
  const inputPath = typeof req.body?.cwd === 'string' ? req.body.cwd : DEFAULT_SCRATCH_WORKSPACE
  const check = await checkDirectory(inputPath)
  if (!check.ok || !check.resolved) {
    res.status(400).json({ error: check.error ?? 'Invalid directory.' })
    return
  }
  const meta = await createChat(check.resolved)
  res.status(201).json(meta)
})

router.get('/chats', async (_req, res) => {
  res.json(await listChats())
})

router.get('/chats/:id', async (req, res) => {
  const meta = await getChatMeta(req.params.id)
  if (!meta) {
    res.status(404).json({ error: 'Chat not found.' })
    return
  }
  const events = await readEvents(req.params.id)
  res.json({ chat: meta, events })
})

router.patch('/chats/:id', async (req, res) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid chat id.' })
    return
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  if (!title) {
    res.status(400).json({ error: 'Title cannot be empty.' })
    return
  }
  const meta = await getChatMeta(req.params.id)
  if (!meta) {
    res.status(404).json({ error: 'Chat not found.' })
    return
  }
  meta.title = title.slice(0, 200)
  meta.updatedAt = new Date().toISOString()
  await saveChatMeta(meta)
  res.json(meta)
})

router.delete('/chats/:id', async (req, res) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid chat id.' })
    return
  }
  const meta = await getChatMeta(req.params.id)
  if (!meta) {
    res.status(404).json({ error: 'Chat not found.' })
    return
  }
  if (meta.status === 'running') {
    res.status(409).json({ error: 'Stop the active run before deleting this chat.' })
    return
  }
  await deleteChat(req.params.id)
  res.status(204).end()
})

router.get('/fixtures', async (_req, res) => {
  res.json(await listFixtureNames())
})

router.get('/fixtures/:name', async (req, res) => {
  const events = await readFixture(req.params.name)
  if (!events) {
    res.status(404).json({ error: 'Fixture not found.' })
    return
  }
  res.json(events)
})

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Accel-Buffering': 'no',
} as const

router.post('/run', async (req, res) => {
  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : ''
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''

  if (!chatId || !prompt) {
    res.status(400).json({ error: 'chatId and prompt are required.' })
    return
  }

  const started = await runRegistry.startRun(chatId, prompt)
  if (!started.ok) {
    res.status(started.status).json({ error: started.error })
    return
  }

  res.writeHead(200, NDJSON_HEADERS)

  let ended = false
  const subscription = runRegistry.attach(chatId, started.since, (event: PersistedEvent) => {
    if (ended || res.writableEnded || res.destroyed) return
    res.write(`${JSON.stringify(event)}\n`)
    if (event.kind === 'run_end' && event.runId === started.runId) {
      ended = true
      subscription.unsubscribe()
      res.end()
    }
  })

  req.on('close', () => subscription.unsubscribe())
})

/** Reattaches to a chat's activity without starting a new run: replays events from `since`
 * onward, then (only if a run is actually in progress) keeps streaming live — this is what
 * lets a page refresh or a second tab observe an already-running chat without duplicating it. */
router.get('/chats/:id/stream', async (req, res) => {
  const chatId = req.params.id
  const meta = await getChatMeta(chatId)
  if (!meta) {
    res.status(404).json({ error: 'Chat not found.' })
    return
  }

  const sinceRaw = Number(req.query.since)
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0

  res.writeHead(200, NDJSON_HEADERS)

  if (meta.status !== 'running') {
    const events = await readEvents(chatId)
    for (const event of events.slice(since)) res.write(`${JSON.stringify(event)}\n`)
    res.end()
    return
  }

  let ended = false
  const subscription = runRegistry.attach(chatId, since, (event: PersistedEvent) => {
    if (ended || res.writableEnded || res.destroyed) return
    res.write(`${JSON.stringify(event)}\n`)
    if (event.kind === 'run_end' && event.runId === meta.activeRunId) {
      ended = true
      subscription.unsubscribe()
      res.end()
    }
  })

  req.on('close', () => subscription.unsubscribe())
})

/** Explicitly stops this chat's in-progress run, if any — scoped to this one chat only. */
router.post('/chats/:id/stop', async (req, res) => {
  const chatId = req.params.id
  const meta = await getChatMeta(chatId)
  if (!meta) {
    res.status(404).json({ error: 'Chat not found.' })
    return
  }
  res.json({ stopped: runRegistry.stopRun(chatId) })
})
