import type { ClaudeStreamEvent, PersistedEvent } from './types.js'

/** Import raw CLI JSONL without inventing prompts or wall-clock timestamps. */
export function parseRecording(raw: string, name: string): PersistedEvent[] {
  const lines = raw.split('\n').filter((line) => line.trim())
  const result: PersistedEvent[] = []
  let runId = ''
  let count = 0
  let ended = true
  for (const [index, line] of lines.entries()) {
    const event: ClaudeStreamEvent = JSON.parse(line)
    if (!event || typeof event !== 'object' || typeof event.type !== 'string')
      throw new Error(`Invalid Claude event on line ${index + 1}`)
    const ts = typeof event.timestamp === 'string' ? event.timestamp : ''
    if (!runId || (ended && event.type === 'system' && event.subtype === 'init')) {
      runId = `recording:${name}:${++count}`
      ended = false
      result.push({
        kind: 'run_start',
        runId,
        ts,
        prompt: 'Imported Claude run — initiating prompt not recorded in JSONL',
      })
    }
    result.push({ kind: 'claude', runId, ts, event })
    if (event.type === 'result' && !event.parent_tool_use_id) {
      const failed =
        Boolean(event.is_error) ||
        (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
      const details = Array.isArray(event.errors)
        ? event.errors.filter((e) => typeof e === 'string').join('\n')
        : typeof event.errors === 'string'
          ? event.errors
          : ''
      result.push({
        kind: 'run_end',
        runId,
        ts,
        status: failed ? 'error' : 'completed',
        error: failed
          ? details ||
            (typeof event.result === 'string' ? event.result : 'Recorded Claude run failed.')
          : undefined,
      })
      ended = true
    }
  }
  if (runId && !ended)
    result.push({
      kind: 'run_end',
      runId,
      ts: '',
      status: 'interrupted',
      error: 'Incomplete recording: no final result event was saved.',
    })
  return result
}
