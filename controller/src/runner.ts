import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { StreamEvent } from './types.ts'

export interface RunOptions {
  prompt: string
  cwd?: string
  model?: string
  fallbackModel?: string
  /** low | medium | high | xhigh | max — routes how hard the model works. */
  effort?: string
  /** Built-in or custom agent driving the main loop. */
  agent?: string
  /** Custom agent definitions, keyed by name. */
  agents?: Record<string, unknown>
  /** Cap on subagents running at once. 0 withholds the Agent tool entirely. */
  maxSubagents?: number
  disallowedTools?: string[]
  appendSystemPrompt?: string
  addDirs?: string[]
  permissionMode?: string
  allowedTools?: string[]
  /** Bypass every permission check. Only sane against a scratch directory. */
  skipPermissions?: boolean
  resume?: string
  /** Ignore user/project MCP servers so only built-in tools are in play. */
  strictMcpConfig?: boolean
  /** Include subagent text/thinking so nested runs can be reconstructed. */
  forwardSubagentText?: boolean
  bin?: string
  /** Keep stdin open so further user messages can arrive mid-run. */
  streaming?: boolean
  /** Handed controls for the live session: send a follow-up, end input, or
   *  interrupt the turn in flight. */
  onSend?: (send: (text: string) => void, close: () => void, interrupt: () => void) => void
  onLine?: (line: string) => void
  signal?: AbortSignal
}

export function buildArgs(o: RunOptions): string[] {
  // In streaming mode the prompt arrives over stdin rather than argv, which is
  // what lets a second message join a turn already in flight.
  const args = o.streaming
    // --replay-user-messages echoes our prompts back into the stream, so the
    // recorded transcript holds both sides and can be restored later.
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages']
    : ['-p', o.prompt, '--output-format', 'stream-json', '--verbose']
  if (o.strictMcpConfig !== false) args.push('--strict-mcp-config')
  if (o.forwardSubagentText !== false) args.push('--forward-subagent-text')
  if (o.model) args.push('--model', o.model)
  if (o.fallbackModel) args.push('--fallback-model', o.fallbackModel)
  if (o.effort) args.push('--effort', o.effort)
  if (o.agent) args.push('--agent', o.agent)
  if (o.agents && Object.keys(o.agents).length) args.push('--agents', JSON.stringify(o.agents))
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt)
  if (o.addDirs?.length) args.push('--add-dir', ...o.addDirs)
  if (o.skipPermissions) args.push('--dangerously-skip-permissions')
  else if (o.permissionMode) args.push('--permission-mode', o.permissionMode)
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','))
  if (o.disallowedTools?.length) args.push('--disallowedTools', ...o.disallowedTools)
  if (o.resume) args.push('--resume', o.resume)
  return args
}

/** Identity and messaging variables of whatever Claude Code session launched the
 *  server. Inheriting them would tie every driven run to that conversation — it
 *  would be marked a child session and share its messaging bus. Each run should
 *  be its own conversation, so they are dropped. */
const SESSION_ENV = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
]

function childEnv(o: RunOptions): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of SESSION_ENV) delete env[key]
  if (o.maxSubagents !== undefined) {
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(Math.max(1, o.maxSubagents))
  }
  return env
}

export async function* runClaude(o: RunOptions): AsyncGenerator<StreamEvent> {
  const child = spawn(o.bin ?? 'claude', buildArgs(o), {
    cwd: o.cwd ?? process.cwd(),
    stdio: [o.streaming ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: childEnv(o),
  })

  if (o.streaming) {
    // If claude exits early (missing, logged out) writes hit a closed pipe.
    // The exit code reports that failure; an unhandled EPIPE would crash the server.
    child.stdin?.on('error', () => {})
    const send = (text: string) => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
      }
    }
    send(o.prompt)
    // SIGINT ends the turn in progress; SIGTERM would leave it unfinished.
    o.onSend?.(send, () => child.stdin?.end(), () => child.kill('SIGINT'))
  }

  // The stdio tuple is conditional, so these are typed as nullable even though
  // both are always piped.
  if (!child.stdout || !child.stderr) throw new Error('claude produced no output streams')
  const { stdout, stderr: errStream } = child

  let stderr = ''
  errStream.setEncoding('utf8')
  errStream.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new Error(`${o.bin ?? 'claude'} CLI not found on PATH`) : error))
    child.on('close', (code) => resolve(code ?? -1))
  })
  // A failed spawn rejects before the stream loop below reaches `await exited`;
  // without a handler that rejection would take the whole server down.
  exited.catch(() => {})

  const onSignal = () => child.kill('SIGINT')
  process.once('SIGINT', onSignal)

  const onAbort = () => child.kill('SIGTERM')
  o.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const lines = createInterface({ input: stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      o.onLine?.(trimmed)
      try {
        yield JSON.parse(trimmed) as StreamEvent
      } catch {
        yield { type: 'parse_error', raw: trimmed }
      }
    }

    const code = await exited
    if (code !== 0 && !o.signal?.aborted) {
      throw new Error(`claude exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`)
    }
  } finally {
    process.off('SIGINT', onSignal)
    o.signal?.removeEventListener('abort', onAbort)
  }
}
