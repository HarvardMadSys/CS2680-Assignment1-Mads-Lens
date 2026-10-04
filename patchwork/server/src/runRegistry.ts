import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type ClaudeRunHandle, type ClaudeRunOutcome, startClaudeRun } from './claudeRunner.js'
import { checkDirectory } from './paths.js'
import { appendEvent, getChatMeta, readEvents, saveChatMeta, titleFromPrompt } from './storage.js'
import type { ChatMeta, PersistedEvent, RunEndStatus } from './types.js'

/**
 * Registry of runs whose child `claude` process is currently alive, keyed by chat id.
 *
 * This is what lets a run's process lifetime outlive the single HTTP connection that started
 * it: `startRun` registers the run here before the request handler ever streams a byte, and
 * `attach` lets *any* connection (the original one, a reconnect, another browser tab) observe
 * the same run's events — past (from `events.jsonl`) and future (from the live emitter) —
 * without spawning a second process or missing/duplicating an event. See CLAUDE.md.
 */

export type EmitPayload = { event: PersistedEvent; count: number }

interface ActiveRun {
  chatId: string
  handle: ClaudeRunHandle | undefined
  emitter: EventEmitter
  eventCount: number
  /** Serializes append-then-emit per event so persistence and delivery never race each other. */
  queue: Promise<void>
}

const activeRuns = new Map<string, ActiveRun>()

function enqueue(active: ActiveRun, event: PersistedEvent): Promise<void> {
  active.queue = active.queue.then(async () => {
    await appendEvent(active.chatId, event)
    active.eventCount += 1
    active.emitter.emit('event', { event, count: active.eventCount } satisfies EmitPayload)
  })
  return active.queue
}

/**
 * A reconnecting client buffers live events while it snapshots the persisted log, then must
 * discard whichever of those buffered events the snapshot already contains (they'd otherwise
 * be delivered twice). An event belongs to the snapshot iff it was appended at or before the
 * snapshot's length — i.e. its 1-based append count is `<= snapshotLength`.
 */
export function partitionPendingAfterSnapshot(
  pending: readonly EmitPayload[],
  snapshotLength: number,
): PersistedEvent[] {
  return pending.filter((p) => p.count > snapshotLength).map((p) => p.event)
}

function outcomeToStatus(outcome: ClaudeRunOutcome): {
  status: RunEndStatus
  error: string | undefined
} {
  switch (outcome.kind) {
    case 'result':
      return {
        status: outcome.isError ? 'error' : 'completed',
        error: outcome.isError ? (outcome.message ?? 'Claude reported a failed run.') : undefined,
      }
    case 'killed':
      return { status: 'interrupted', error: undefined }
    case 'spawn_error':
      return { status: 'error', error: `Could not start claude: ${outcome.message}` }
    case 'exit_without_result':
      return {
        status: 'error',
        error: outcome.stderr || `claude exited with code ${outcome.code ?? 'unknown'}.`,
      }
  }
}

export type StartRunResult =
  | { ok: true; runId: string; since: number }
  | { ok: false; status: number; error: string }

export async function startRun(chatId: string, prompt: string): Promise<StartRunResult> {
  const meta = await getChatMeta(chatId)
  if (!meta) return { ok: false, status: 404, error: 'Chat not found.' }
  if (meta.status === 'running') {
    return { ok: false, status: 409, error: 'A run is already in progress for this chat.' }
  }

  const runId = randomUUID()
  const since = (await readEvents(chatId)).length
  const dirCheck = await checkDirectory(meta.cwd)
  if (!dirCheck.ok) {
    const error = dirCheck.error ?? 'Workspace directory is no longer valid.'
    const ts = new Date().toISOString()
    await appendEvent(chatId, { kind: 'run_start', runId, ts, prompt })
    await saveChatMeta({
      ...meta,
      updatedAt: ts,
      lastRunStatus: 'error',
      lastError: error,
      title: meta.title === 'New chat' ? titleFromPrompt(prompt) : meta.title,
    })
    await appendEvent(chatId, { kind: 'run_end', runId, ts, status: 'error', error })
    // It is still a submitted run, even though no process could be started.
    return { ok: true, runId, since }
  }
  const emitter = new EventEmitter()
  emitter.setMaxListeners(50)
  const active: ActiveRun = {
    chatId,
    handle: undefined,
    emitter,
    eventCount: since,
    queue: Promise.resolve(),
  }

  await enqueue(active, { kind: 'run_start', runId, ts: new Date().toISOString(), prompt })

  meta.status = 'running'
  meta.activeRunId = runId
  meta.updatedAt = new Date().toISOString()
  await saveChatMeta(meta)

  const handle = startClaudeRun({
    cwd: meta.cwd,
    prompt,
    sessionId: meta.sessionId,
    onEvent: (event) => {
      if (
        (event.type === 'result' || (event.type === 'system' && event.subtype === 'init')) &&
        !event.parent_tool_use_id &&
        typeof event.session_id === 'string'
      ) {
        meta.sessionId = event.session_id
        void saveChatMeta(meta)
      }
      void enqueue(active, { kind: 'claude', runId, ts: new Date().toISOString(), event })
    },
  })
  active.handle = handle
  activeRuns.set(chatId, active)

  meta.activePid = handle.pid
  await saveChatMeta(meta)

  void handle.done.then(async (outcome) => {
    const { status, error } = outcomeToStatus(outcome)
    const finalMeta: ChatMeta = {
      ...meta,
      status: 'idle',
      activeRunId: undefined,
      activePid: undefined,
      updatedAt: new Date().toISOString(),
      lastRunStatus: status,
      lastError: error,
      title: meta.title === 'New chat' ? titleFromPrompt(prompt) : meta.title,
    }
    await active.queue
    await saveChatMeta(finalMeta)
    await enqueue(active, { kind: 'run_end', runId, ts: new Date().toISOString(), status, error })

    activeRuns.delete(chatId)
  })

  return { ok: true, runId, since }
}

export function stopRun(chatId: string): boolean {
  const active = activeRuns.get(chatId)
  if (!active?.handle) return false
  active.handle.kill()
  return true
}

/**
 * Delivers every event this chat has produced from index `since` onward, then keeps delivering
 * new ones as they happen — replaying the persisted log first and, only if a run is currently
 * active, seamlessly continuing with its live stream. Safe to call for an idle chat (a plain
 * one-shot backlog read) or from multiple connections at once (each gets its own subscription).
 */
export function attach(
  chatId: string,
  since: number,
  onEvent: (event: PersistedEvent) => void,
): { unsubscribe: () => void } {
  const active = activeRuns.get(chatId)
  let closed = false
  let currentListener: ((payload: EmitPayload) => void) | undefined

  const unsubscribe = () => {
    closed = true
    if (active && currentListener) active.emitter.off('event', currentListener)
  }

  if (!active) {
    void (async () => {
      const persisted = await readEvents(chatId)
      if (closed) return
      for (const event of persisted.slice(since)) onEvent(event)
    })()
    return { unsubscribe }
  }

  const buffering: EmitPayload[] = []
  currentListener = (payload) => buffering.push(payload)
  active.emitter.on('event', currentListener)

  void (async () => {
    const persisted = await readEvents(chatId)
    active.emitter.off('event', currentListener as (payload: EmitPayload) => void)
    if (closed) return

    for (const event of persisted.slice(since)) onEvent(event)
    for (const event of partitionPendingAfterSnapshot(buffering, persisted.length)) onEvent(event)
    if (closed) return

    currentListener = (payload) => onEvent(payload.event)
    active.emitter.on('event', currentListener)
  })()

  return { unsubscribe }
}
