import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startClaudeRun } from './claudeRunner.js'

let child: EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
}
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => child) }))
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    kill: vi.fn(),
  })
})

describe('Claude result failures', () => {
  it('preserves error messages even when the last JSON line has no newline', async () => {
    const onEvent = vi.fn()
    const run = startClaudeRun({ cwd: '/scratch', prompt: 'test', onEvent })
    const result = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Authentication expired', 'Please sign in again'],
    }
    const encoded = JSON.stringify(result)
    child.stdout.write(encoded.slice(0, 15))
    child.stdout.write(encoded.slice(15))
    child.emit('close', 1, null)
    expect(await run.done).toEqual({
      kind: 'result',
      isError: true,
      message: 'Authentication expired\nPlease sign in again',
    })
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(result)
  })
  it('recognizes error subtypes and retains a fallback explanation', async () => {
    const run = startClaudeRun({ cwd: '/scratch', prompt: 'test', onEvent: () => {} })
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_max_turns' })}\n`)
    child.emit('close', 0, null)
    expect(await run.done).toMatchObject({
      isError: true,
      message: 'Claude reported a failed run (error_max_turns).',
    })
  })
})
