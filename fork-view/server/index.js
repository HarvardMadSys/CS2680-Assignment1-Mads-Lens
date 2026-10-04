import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_WORK_DIR,
  HttpError,
  MAX_UPLOAD_BYTES,
  PROJECT_ROOT,
  resolveSessionId,
  resolveTrajectoryPath,
  resolveUploadTarget,
  resolveWorkDir,
} from './paths.js'
import { startRun } from './runner.js'
import { listSessions, listTrajectories, readTrajectory } from './trajectories.js'

// `npm start` serves the built UI and the API from this one process on
// PORT/HOST. Under `npm run dev`, scripts/dev.mjs starts it on API_PORT
// (loopback only) behind the Vite dev server instead.
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8000)

const app = express()
app.use(express.json({ limit: '1mb' }))

/** @type {Map<string, import('node:events').EventEmitter>} */
const runs = new Map()

/**
 * Attach a file to an upcoming prompt.
 *
 * The body is the file's bytes and nothing else -- no multipart, so no parser
 * dependency: the browser already has the blob, and a `fetch` with the File as
 * the body is the whole of the client side. The two things the server needs to
 * know travel as query parameters, where they go through the same validation
 * any other path does.
 *
 * `express.raw` enforces the size ceiling before the body is buffered, so an
 * oversized file is refused rather than held in memory; the explicit check
 * below is for the empty case and for the message.
 */
app.post(
  '/api/upload',
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res, next) => {
    try {
      const target = resolveUploadTarget(req.query.cwd ?? DEFAULT_WORK_DIR, req.query.name, fs)

      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      if (!bytes.length) throw new HttpError(400, 'Attachment is empty.')
      if (bytes.length > MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `Attachments are limited to ${MAX_UPLOAD_BYTES} bytes.`)
      }

      fs.mkdirSync(target.dir, { recursive: true })
      fs.writeFileSync(target.abs, bytes)

      res.json({
        path: target.relPath,
        name: path.basename(target.abs),
        bytes: bytes.length,
      })
    } catch (err) {
      next(err)
    }
  }
)

app.get('/api/config', (req, res) => {
  res.json({ projectRoot: PROJECT_ROOT, defaultWorkDir: DEFAULT_WORK_DIR })
})

app.post('/api/runs', (req, res, next) => {
  try {
    const prompt = String(req.body?.prompt ?? '').trim()
    if (!prompt) throw new HttpError(400, 'Prompt is required.')

    const cwd = resolveWorkDir(req.body?.cwd ?? DEFAULT_WORK_DIR, fs)
    const resumeSessionId = resolveSessionId(req.body?.resumeSessionId)

    const run = startRun({ cwd, prompt, resumeSessionId })
    runs.set(run.id, run)

    res.json({
      runId: run.id,
      cwd: path.relative(PROJECT_ROOT, cwd) || '.',
      resumeSessionId,
      args: run.args,
      jsonlPath: path.relative(PROJECT_ROOT, run.jsonlPath).split(path.sep).join('/'),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Stop a run at the reader's request.
 *
 * Idempotent by construction: `run.cancel()` reports whether this call is the
 * one that started the cancellation, so pressing stop twice, or pressing it on
 * a run that has already exited, is answered rather than repeated. The run
 * stays in the map and its `log` stays intact, so a subscriber that reconnects
 * still replays everything the run emitted before it was stopped.
 *
 * What the server knows is whether the process is still alive; what the run
 * *ended up as* is decided by the reducer from the frames. So a run that had
 * already finished is reported as finished here and the client keeps the
 * outcome it already streamed, rather than being told it was stopped.
 */
app.post('/api/runs/:runId/stop', (req, res, next) => {
  try {
    const run = runs.get(req.params.runId)
    if (!run) throw new HttpError(404, 'Unknown run.')

    if (run.finished) {
      return res.json({ runId: run.id, stopped: false, state: 'finished' })
    }

    const stopped = run.cancel()
    res.json({ runId: run.id, stopped, state: stopped ? 'stopping' : 'already-stopping' })
  } catch (err) {
    next(err)
  }
})

app.get('/api/runs/:runId/events', (req, res, next) => {
  try {
    const run = runs.get(req.params.runId)
    if (!run) throw new HttpError(404, 'Unknown run.')

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()

    const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`)

    // Frames emitted between POST /api/runs and this subscription.
    const backlog = run.log.length
    for (let i = 0; i < backlog; i += 1) send(run.log[i])

    if (run.finished) {
      res.write('event: end\ndata: {}\n\n')
      res.end()
      return
    }

    const onEvent = (frame) => send(frame)
    const onEnd = () => {
      res.write('event: end\ndata: {}\n\n')
      res.end()
    }

    // Anything published while the backlog was flushing is still delivered:
    // listeners are attached synchronously in the same tick.
    run.on('event', onEvent)
    run.once('end', onEnd)

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

    res.on('close', () => {
      clearInterval(heartbeat)
      run.off('event', onEvent)
      run.off('end', onEnd)
    })
  } catch (err) {
    next(err)
  }
})

// Past conversations a follow-up can resume, newest first.
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: listSessions() })
})

app.get('/api/trajectories', (req, res) => {
  res.json({ trajectories: listTrajectories() })
})

app.get('/api/trajectory', (req, res, next) => {
  try {
    const abs = resolveTrajectoryPath(req.query.path, fs)
    res.type('text/plain; charset=utf-8').send(readTrajectory(abs))
  } catch (err) {
    next(err)
  }
})

// Serve the production build when it exists; in development Vite serves the UI.
const distDir = path.join(PROJECT_ROOT, 'frontend', 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
}

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` })
})

app.use((err, req, res, next) => {
  // body-parser refuses an oversized body itself, before the route runs, so the
  // size limit has to be reported from here as well as from the route.
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: `Attachments are limited to ${MAX_UPLOAD_BYTES} bytes.` })
  }

  const status = err instanceof HttpError ? err.status : 500
  if (status === 500) console.error(err)
  if (res.headersSent) return res.end()
  res.status(status).json({ error: err.message })
})

app.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}  (project root: ${PROJECT_ROOT})`)
})
