import { describe, expect, it } from 'vitest'
import { parseRecording } from './recording.js'

describe('raw Claude JSONL replay', () => {
  it('preserves nested tool events and metrics without inventing a prompt or timestamps', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'session' },
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: {
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'main.ts' } },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session',
        total_cost_usd: 0.04,
        duration_ms: 500,
        num_turns: 2,
      },
    ]
    const replay = parseRecording(
      events.map((event) => JSON.stringify(event)).join('\n'),
      'raw-stream',
    )
    expect(replay[0]).toMatchObject({
      kind: 'run_start',
      ts: '',
      prompt: expect.stringContaining('not recorded'),
    })
    expect(
      replay.filter((e) => e.kind === 'claude').map((e) => e.kind === 'claude' && e.event),
    ).toEqual(events)
    expect(replay.at(-1)).toMatchObject({ kind: 'run_end', status: 'completed' })
  })
  it('marks truncated recordings interrupted and preserves recorded failures', () => {
    expect(parseRecording('{"type":"system","subtype":"init"}', 'partial').at(-1)).toMatchObject({
      status: 'interrupted',
    })
    expect(
      parseRecording('{"type":"result","is_error":true,"errors":["Denied"]}', 'failed').at(-1),
    ).toMatchObject({ status: 'error', error: 'Denied' })
  })
  it('separates concatenated runs even if they share a session', () => {
    const run =
      '{"type":"system","subtype":"init","session_id":"same"}\n{"type":"result","subtype":"success"}\n'
    const replay = parseRecording(run + run, 'two')
    expect(new Set(replay.map((e) => e.runId)).size).toBe(2)
  })
  it('rejects malformed input rather than silently dropping events', () => {
    expect(() => parseRecording('null', 'bad')).toThrow()
    expect(() => parseRecording('{"type":"assistant"}\nnot json', 'bad')).toThrow()
  })
})
