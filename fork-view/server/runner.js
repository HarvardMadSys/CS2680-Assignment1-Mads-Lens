import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'

import { RUNS_DIR } from './paths.js'

// Overridable so the spawn-failure path can be exercised without a PATH hack.
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'

const BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  // Nested tool_use / tool_result frames already carry parent_tool_use_id
  // without this flag, but the subagent's own assistant text and thinking do
  // not. Measured: see fixtures/subagent-no-forward.jsonl vs
  // fixtures/subagent-forward.jsonl.
  '--forward-subagent-text',
]

/**
 * `resumeSessionId` must already be validated (see resolveSessionId) -- it is
 * the only caller-supplied value that reaches argv.
 */
function buildArgs(resumeSessionId) {
  return resumeSessionId ? [...BASE_ARGS, '--resume', resumeSessionId] : [...BASE_ARGS]
}

/**
 * Kill the whole process tree rooted at `child`.
 *
 * `child.pid` is not Claude Code's pid. The CLI ships as a `.cmd` shim on
 * Windows, so the spawn above goes through `shell: true` and the pid belongs to
 * the cmd.exe wrapper -- `child.kill()` closes that wrapper and leaves `claude`
 * itself, and every tool process it started, running with nobody listening.
 * `taskkill /T` walks the tree down from that pid, which is the only thing that
 * reaches them. `/F` because Claude Code does not stop on a console close and
 * Windows has no politer signal to send it.
 *
 * Scoped to one pid and its descendants, so nothing outside this run is
 * touched. A subagent is not its own OS process -- it runs inside the same
 * Claude Code process -- so it goes with the parent; the tool processes a
 * subagent spawned are in the tree and go with it too.
 */
function killTree(child, isDone) {
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    // taskkill missing, or the pid already gone: fall back rather than throw.
    killer.on('error', () => {
      try {
        child.kill()
      } catch {}
    })
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {}

  // The same shell wrapper applies here, so SIGTERM reaches the wrapper first.
  // If the tree outlives the grace period it is taken down the hard way.
  const grace = setTimeout(() => {
    if (isDone()) return
    try {
      child.kill('SIGKILL')
    } catch {}
  }, 2000)
  grace.unref?.()
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${suffix}`
}

/**
 * Spawn Claude Code and stream its stream-json output.
 *
 * The run object is an EventEmitter that emits 'event' (one parsed stream-json
 * frame, or a synthetic `_`-prefixed frame) and 'end'. Every frame is also
 * appended to run.log so a subscriber that connects late still sees the whole
 * run; the process is never waited on before frames are published.
 */
export function startRun({ cwd, prompt, resumeSessionId = null }) {
  const runId = makeRunId()
  const args = buildArgs(resumeSessionId)

  mkdirSync(RUNS_DIR, { recursive: true })

  const jsonlPath = path.join(RUNS_DIR, `${runId}.jsonl`)
  const metaPath = path.join(RUNS_DIR, `${runId}.meta.json`)
  const stderrPath = path.join(RUNS_DIR, `${runId}.stderr.log`)

  const run = new EventEmitter()
  run.setMaxListeners(0)
  run.id = runId
  run.cwd = cwd
  run.prompt = prompt
  run.resumeSessionId = resumeSessionId
  run.args = args
  run.startedAt = new Date().toISOString()
  run.finished = false
  // Set the moment a stop is accepted, so a second request is a no-op and the
  // exit that follows is known to be one we asked for.
  run.cancelled = false
  run.log = []
  run.jsonlPath = jsonlPath

  // Raw CLI stdout only -- kept byte-faithful so replay sees exactly what the
  // CLI emitted. Synthetic frames are never written here.
  const jsonl = createWriteStream(jsonlPath, { encoding: 'utf8', flags: 'a' })
  let stderrText = ''

  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        runId,
        cwd,
        prompt,
        resumeSessionId,
        startedAt: run.startedAt,
        bin: CLAUDE_BIN,
        args,
      },
      null,
      2
    ),
    'utf8'
  )

  function publish(frame) {
    run.log.push(frame)
    run.emit('event', frame)
  }

  function finish(extra) {
    if (run.finished) return
    run.finished = true

    jsonl.end()

    if (stderrText.trim()) {
      writeFileSync(stderrPath, stderrText, 'utf8')
    }

    publish({ type: '_exit', ...extra })
    run.emit('end')
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    // On Windows `claude` is a .cmd shim, which Node refuses to spawn directly.
    // Every argument here is a fixed literal with no shell metacharacters, and
    // the prompt goes over stdin, so nothing user-supplied reaches the shell.
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Read the pipes as UTF-8 directly. This is what avoids the console-codepage
  // mangling that corrupted the PowerShell-recorded trajectories.
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.on('error', (err) => {
    publish({ type: '_error', message: `Failed to start Claude Code: ${err.message}` })
    finish({ code: null, signal: null, spawnFailed: true })
  })

  // The prompt never touches argv or the shell.
  child.stdin.on('error', () => {})
  child.stdin.end(prompt, 'utf8')

  let buffer = ''

  child.stdout.on('data', (chunk) => {
    buffer += chunk

    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      handleLine(line)
    }
  })

  child.stdout.on('end', () => {
    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''))
    buffer = ''
  })

  function handleLine(line) {
    if (!line.trim()) return

    let event
    try {
      event = JSON.parse(line)
    } catch (err) {
      publish({
        type: '_parse_error',
        message: err.message,
        line: line.slice(0, 2000),
      })
      return
    }

    jsonl.write(line + '\n')
    publish(event)
  }

  child.stderr.on('data', (chunk) => {
    stderrText += chunk
    publish({ type: '_stderr', text: chunk })
  })

  child.on('close', (code, signal) => {
    finish({ code, signal })
  })

  /**
   * Stop this run at the reader's request.
   *
   * The `_stopped` frame is published *before* the kill, so a subscriber reads
   * the exit that follows as a cancellation rather than as an unexplained
   * crash -- and so the frame still gets out if the kill itself goes wrong.
   * Like every other `_`-prefixed frame it is synthetic: it goes to subscribers
   * and to the in-memory log, never to the JSONL, which stays a byte-faithful
   * record of what the CLI actually emitted. Everything recorded before this
   * point is already on disk and stays there.
   *
   * Returns whether this call is the one that started the cancellation, so a
   * second press is a no-op rather than a second kill.
   */
  run.cancel = () => {
    if (run.finished || run.cancelled) return false
    run.cancelled = true

    publish({ type: '_stopped', at: new Date().toISOString() })
    killTree(child, () => run.finished)
    return true
  }

  return run
}
