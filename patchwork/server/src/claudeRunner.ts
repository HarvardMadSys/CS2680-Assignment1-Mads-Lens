import { spawn } from 'node:child_process'
import type { ClaudeStreamEvent } from './types.js'

export interface ClaudeRunOptions {
  cwd: string
  prompt: string
  sessionId?: string | undefined
  onEvent: (event: ClaudeStreamEvent) => void
}

export type ClaudeRunOutcome =
  | { kind: 'result'; isError: boolean; message?: string | undefined }
  | { kind: 'spawn_error'; message: string }
  | {
      kind: 'exit_without_result'
      code: number | null
      signal: NodeJS.Signals | null
      stderr: string
    }
  | { kind: 'killed' }

export interface ClaudeRunHandle {
  pid: number | undefined
  kill: () => void
  done: Promise<ClaudeRunOutcome>
}

/**
 * Spawns `claude -p <prompt> --output-format stream-json` in `cwd`, forwarding parsed JSONL
 * events as they arrive. Uses `bypassPermissions` because there is no TTY to answer permission
 * prompts from a headless child process, which is why the app defaults to a scratch workspace.
 * `--forward-subagent-text` is required to get nested subagent tool calls.
 */
export function startClaudeRun(options: ClaudeRunOptions): ClaudeRunHandle {
  const { cwd, prompt, sessionId, onEvent } = options
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--forward-subagent-text',
  ]
  if (sessionId) args.push('--resume', sessionId)

  let killedByUs = false
  let sawResult = false
  let sawResultIsError = false
  let resultMessage: string | undefined
  let stderrBuf = ''
  let lineBuf = ''

  const child = spawn('claude', args, { cwd })

  function consumeLine(line: string) {
    if (!line.trim()) return
    let parsed: ClaudeStreamEvent
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (parsed.type === 'result') {
      sawResult = true
      sawResultIsError =
        Boolean(parsed.is_error) ||
        (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error'))
      const details = Array.isArray(parsed.errors)
        ? parsed.errors.filter((e): e is string => typeof e === 'string').join('\n')
        : typeof parsed.errors === 'string'
          ? parsed.errors
          : undefined
      resultMessage = sawResultIsError
        ? details ||
          (typeof parsed.result === 'string' ? parsed.result : '') ||
          `Claude reported a failed run (${parsed.subtype ?? 'unknown error'}).`
        : undefined
    }
    onEvent(parsed)
  }

  const done = new Promise<ClaudeRunOutcome>((resolve) => {
    child.on('error', (err) => {
      resolve({ kind: 'spawn_error', message: err.message })
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      lineBuf += chunk
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        consumeLine(line)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk
    })

    child.on('close', (code, signal) => {
      consumeLine(lineBuf)
      lineBuf = ''
      if (killedByUs) {
        resolve({ kind: 'killed' })
      } else if (sawResult) {
        resolve({ kind: 'result', isError: sawResultIsError, message: resultMessage })
      } else {
        resolve({ kind: 'exit_without_result', code, signal, stderr: stderrBuf.trim() })
      }
    })
  })

  return {
    pid: child.pid,
    kill: () => {
      killedByUs = true
      child.kill('SIGTERM')
    },
    done,
  }
}
