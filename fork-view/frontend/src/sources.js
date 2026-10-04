/**
 * Event sources.
 *
 * Both sources call `onEvent(frame)` with raw stream-json frames and nothing
 * else, so the state model and renderer never learn where events came from.
 */

async function readError(res) {
  try {
    const body = await res.json()
    return body.error ?? res.statusText
  } catch {
    return res.statusText || `HTTP ${res.status}`
  }
}

/**
 * Start a live Claude Code run and stream its frames over SSE.
 *
 * Passing `resumeSessionId` continues an existing Claude Code session instead
 * of starting a new conversation.
 * Returns { runId, cwd, resumeSessionId, args, jsonlPath, stop }.
 */
export async function startLiveRun({ cwd, prompt, resumeSessionId = null, onEvent, onDone }) {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, prompt, resumeSessionId }),
  })

  if (!res.ok) throw new Error(await readError(res))

  const run = await res.json()
  const es = new EventSource(`/api/runs/${run.runId}/events`)
  let ended = false

  const close = () => {
    if (ended) return
    ended = true
    es.close()
    onDone?.()
  }

  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data))
    } catch (err) {
      onEvent({ type: '_error', message: `Bad SSE frame: ${err.message}` })
    }
  }

  es.addEventListener('end', close)

  es.onerror = () => {
    if (ended) return
    onEvent({ type: '_error', message: 'Event stream disconnected.' })
    close()
  }

  return { ...run, stop: close }
}

/**
 * Upload one attachment for an upcoming prompt.
 *
 * The File goes up as the raw request body -- no FormData, because there is
 * nothing to multiplex: one request carries one file, and the two things the
 * server needs are short enough to be query parameters. The server decides
 * what is acceptable; the caller's own checks only save a round trip.
 *
 * Resolves to `{ path, name, bytes }`, where `path` is relative to the run's
 * working directory and is what goes in the prompt.
 */
export async function uploadAttachment({ cwd, file, signal }) {
  const query = new URLSearchParams({ cwd: cwd ?? '', name: file.name })
  const res = await fetch(`/api/upload?${query}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    signal,
  })

  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * Ask the server to stop a live run.
 *
 * The frames that follow -- `_stopped`, then the process's `_exit` -- arrive
 * over the run's existing SSE stream like any other, so cancellation needs no
 * second channel and the stream closes on its own `end` event as usual.
 *
 * Resolves to `{ stopped, state }`: `state` is `'stopping'` when this request
 * is the one that started it, `'already-stopping'` for a repeat, and
 * `'finished'` when the run had already ended before the request landed.
 */
export async function cancelRun(runId) {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
  })

  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * Replay a saved trajectory through the same onEvent callback.
 */
export async function replayTrajectory({ path, onEvent, onDone, delayMs = 0 }) {
  const res = await fetch(`/api/trajectory?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(await readError(res))

  const text = await res.text()
  const lines = text.split('\n').filter((line) => line.trim())

  let cancelled = false

  ;(async () => {
    for (const line of lines) {
      if (cancelled) return

      try {
        onEvent(JSON.parse(line))
      } catch (err) {
        onEvent({ type: '_parse_error', message: err.message, line: line.slice(0, 2000) })
      }

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      else await Promise.resolve()
    }

    if (!cancelled) {
      onEvent({ type: '_replay_end' })
      onDone?.()
    }
  })()

  return {
    stop: () => {
      cancelled = true
    },
  }
}

/** Past sessions a follow-up can resume, newest first. */
export async function fetchSessions() {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(await readError(res))
  const body = await res.json()
  return body.sessions
}

export async function fetchTrajectories() {
  const res = await fetch('/api/trajectories')
  if (!res.ok) throw new Error(await readError(res))
  const body = await res.json()
  return body.trajectories
}
