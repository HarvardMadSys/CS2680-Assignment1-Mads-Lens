import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDirectory } from './paths.js'
import type { ChatMeta, PersistedEvent } from './types.js'

function makeMeta(id: string, overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    id,
    cwd: '/tmp/scratch',
    title: 'New chat',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    status: 'idle',
    ...overrides,
  }
}

let events: PersistedEvent[]
let meta: ChatMeta

vi.mock('./storage.js', () => ({
  appendEvent: vi.fn(async (_chatId: string, event: PersistedEvent) => {
    events.push(event)
  }),
  readEvents: vi.fn(async () => [...events]),
  getChatMeta: vi.fn(async () => meta),
  saveChatMeta: vi.fn(async (next: ChatMeta) => {
    meta = next
  }),
  titleFromPrompt: (prompt: string) => prompt,
}))

vi.mock('./paths.js', () => ({
  checkDirectory: vi.fn(async () => ({ ok: true, resolved: '/tmp/scratch' })),
}))

type FakeHandle = { pid: number; kill: () => void; done: Promise<unknown> }
let capturedOnEvent: ((event: Record<string, unknown>) => void) | undefined
let resolveDone: ((outcome: unknown) => void) | undefined
let killCallCount = 0

vi.mock('./claudeRunner.js', () => ({
  startClaudeRun: vi.fn(
    (options: { onEvent: (e: Record<string, unknown>) => void }): FakeHandle => {
      capturedOnEvent = options.onEvent
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })
      const kill = () => {
        killCallCount += 1
        resolveDone?.({ kind: 'killed' })
      }
      return { pid: 4242, kill, done }
    },
  ),
}))

const { startRun, attach, stopRun, partitionPendingAfterSnapshot } = await import(
  './runRegistry.js'
)

// This module-level `active runs` registry is a shared singleton across tests, so each test
// below uses its own chat id (see `chatId` in beforeEach) to avoid cross-test interference.
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

let chatId: string
let idCounter = 0

beforeEach(() => {
  idCounter += 1
  chatId = `chat-${idCounter}`
  events = []
  meta = makeMeta(chatId)
  capturedOnEvent = undefined
  resolveDone = undefined
  killCallCount = 0
})

describe('partitionPendingAfterSnapshot', () => {
  const eventA: PersistedEvent = { kind: 'claude', runId: 'r', ts: 't1', event: {} }
  const eventB: PersistedEvent = { kind: 'claude', runId: 'r', ts: 't2', event: {} }
  const eventC: PersistedEvent = { kind: 'claude', runId: 'r', ts: 't3', event: {} }

  it('drops buffered events already included in the snapshot and keeps the rest', () => {
    const pending = [
      { event: eventA, count: 3 },
      { event: eventB, count: 4 },
      { event: eventC, count: 5 },
    ]
    expect(partitionPendingAfterSnapshot(pending, 4)).toEqual([eventC])
  })

  it('keeps everything when the snapshot predates all buffered events', () => {
    const pending = [
      { event: eventA, count: 1 },
      { event: eventB, count: 2 },
    ]
    expect(partitionPendingAfterSnapshot(pending, 0)).toEqual([eventA, eventB])
  })

  it('drops everything when the snapshot already contains every buffered event', () => {
    const pending = [
      { event: eventA, count: 1 },
      { event: eventB, count: 2 },
    ]
    expect(partitionPendingAfterSnapshot(pending, 2)).toEqual([])
  })
})

describe('startRun + attach', () => {
  it('retains a failed prompt with no calls when its workspace disappeared', async () => {
    vi.mocked(checkDirectory).mockResolvedValueOnce({ ok: false, error: 'Directory unavailable' })
    const started = await startRun(chatId, 'Read the project')
    if (!started.ok) throw new Error(started.error)
    const received: PersistedEvent[] = []
    attach(chatId, started.since, (event) => received.push(event))
    await flush()
    expect(received.map((e) => e.kind)).toEqual(['run_start', 'run_end'])
    expect(received[1]).toMatchObject({ status: 'error', error: 'Directory unavailable' })
    expect(capturedOnEvent).toBeUndefined()
    expect(meta.lastRunStatus).toBe('error')
  })
  it('streams each follow-up from its own cursor and retains all three runs', async () => {
    const ids = new Set<string>()
    for (const prompt of ['ordinary', 'parallel', 'follow-up']) {
      const started = await startRun(chatId, prompt)
      if (!started.ok) throw new Error(started.error)
      ids.add(started.runId)
      const received: PersistedEvent[] = []
      const subscription = attach(chatId, started.since, (e) => received.push(e))
      capturedOnEvent?.({ type: 'system', subtype: 'init', session_id: 'shared' })
      await flush()
      resolveDone?.({ kind: 'result', isError: false })
      await flush()
      expect(received.map((e) => e.kind)).toEqual(['run_start', 'claude', 'run_end'])
      expect(received.every((e) => e.runId === started.runId)).toBe(true)
      subscription.unsubscribe()
    }
    expect(ids.size).toBe(3)
    expect(events.filter((e) => e.kind === 'run_start')).toHaveLength(3)
    const restored: PersistedEvent[] = []
    attach(chatId, 0, (e) => restored.push(e))
    await flush()
    expect(restored).toEqual(events)
  })
  it('delivers run_start, live claude events, and run_end exactly once each, in order', async () => {
    const started = await startRun(chatId, 'do something')
    expect(started.ok).toBe(true)

    const received: PersistedEvent[] = []
    const subscription = attach(chatId, 0, (event) => received.push(event))

    capturedOnEvent?.({ type: 'system', subtype: 'ping' })
    await flush()
    resolveDone?.({ kind: 'result', isError: false })
    await flush()

    expect(received.map((e) => e.kind)).toEqual(['run_start', 'claude', 'run_end'])
    expect(events.map((e) => e.kind)).toEqual(['run_start', 'claude', 'run_end'])
    subscription.unsubscribe()
  })

  it('a reattach with since skips events the client already has', async () => {
    const started = await startRun(chatId, 'do something')
    expect(started.ok).toBe(true)
    capturedOnEvent?.({ type: 'system', subtype: 'ping' })
    await flush()

    const received: PersistedEvent[] = []
    const subscription = attach(chatId, 1, (event) => received.push(event))
    await flush()
    resolveDone?.({ kind: 'result', isError: false })
    await flush()

    expect(received.map((e) => e.kind)).toEqual(['claude', 'run_end'])
    subscription.unsubscribe()
  })

  it('rejects starting a run for a chat that is already running', async () => {
    const first = await startRun(chatId, 'first')
    expect(first.ok).toBe(true)

    const second = await startRun(chatId, 'second')
    expect(second).toEqual({
      ok: false,
      status: 409,
      error: 'A run is already in progress for this chat.',
    })

    resolveDone?.({ kind: 'result', isError: false })
    await flush()
  })

  it('an idle chat with no active run just replays its backlog once', async () => {
    events = [{ kind: 'run_start', runId: 'old', ts: 't0', prompt: 'earlier' }]
    const received: PersistedEvent[] = []
    attach(chatId, 0, (event) => received.push(event))
    await flush()
    expect(received).toEqual(events)
  })
})

describe('stopRun', () => {
  it('kills only the targeted chat and marks that run interrupted', async () => {
    await startRun(chatId, 'do something')
    const received: PersistedEvent[] = []
    const subscription = attach(chatId, 0, (event) => received.push(event))

    expect(stopRun('some-unrelated-chat')).toBe(false)
    expect(stopRun(chatId)).toBe(true)
    expect(killCallCount).toBe(1)

    await flush()
    const runEnd = received.find((e) => e.kind === 'run_end')
    expect(runEnd && runEnd.kind === 'run_end' && runEnd.status).toBe('interrupted')
    subscription.unsubscribe()
  })
})
