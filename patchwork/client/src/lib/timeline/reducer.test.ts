import { describe, expect, it } from 'vitest'
import { buildTimeline } from './reducer'
import { buildOutline, summarizeRun } from './selectors'
import type { PersistedEvent } from './types'

function claude(runId: string, ts: string, event: Record<string, unknown>): PersistedEvent {
  return { kind: 'claude', runId, ts, event }
}

describe('buildTimeline', () => {
  it('keeps the main session when forwarded subagent events carry another session', () => {
    const state = buildTimeline([
      { kind: 'run_start', runId: 'r1', ts: 't0', prompt: 'delegate' },
      claude('r1', 't1', { type: 'system', subtype: 'init', session_id: 'main-session' }),
      claude('r1', 't2', {
        type: 'assistant',
        session_id: 'child-session',
        parent_tool_use_id: 'delegation',
        message: { content: [{ type: 'text', text: 'Working' }] },
      }),
    ])
    expect(state.runs[0]?.sessionId).toBe('main-session')
  })

  it('builds a flat run from Write -> tool_result -> assistant text -> result -> run_end', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r1', ts: 't0', prompt: 'write a file' },
      claude('r1', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Write',
              input: { file_path: '/a.txt', content: 'hi' },
            },
          ],
        },
      }),
      claude('r1', 't2', {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'File created' }],
        },
      }),
      claude('r1', 't3', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Done.' }] },
      }),
      claude('r1', 't4', { type: 'result', total_cost_usd: 0.01, duration_ms: 500, num_turns: 1 }),
      { kind: 'run_end', runId: 'r1', ts: 't5', status: 'completed' },
    ]

    const state = buildTimeline(events)
    expect(state.runs).toHaveLength(1)
    const run = state.runs[0]
    if (!run) throw new Error('expected a run')
    expect(run.status).toBe('completed')
    expect(run.metrics).toEqual({ costUsd: 0.01, durationMs: 500, numTurns: 1 })
    expect(run.timeline).toHaveLength(2)

    const toolNode = run.timeline[0]
    expect(toolNode?.kind).toBe('tool_call')
    if (toolNode?.kind !== 'tool_call') throw new Error('expected tool_call')
    expect(toolNode.name).toBe('Write')
    expect(toolNode.status).toBe('success')
    expect(toolNode.result?.content).toBe('File created')

    expect(state.fileContentCache['/a.txt']).toBe('hi')

    const textNode = run.timeline[1]
    expect(textNode?.kind).toBe('text')

    const summary = summarizeRun(run)
    expect(summary).toEqual({ toolCallCount: 1, filesEdited: 1 })
  })

  it('nests subagent activity under the launching tool call via parent_tool_use_id', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r2', ts: 't0', prompt: 'delegate' },
      claude('r2', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'task_1', name: 'Agent', input: { description: 'sub task' } },
          ],
        },
      }),
      claude('r2', 't2', {
        type: 'assistant',
        parent_tool_use_id: 'task_1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'nested_write',
              name: 'Write',
              input: { file_path: '/nested.txt', content: 'nested' },
            },
          ],
        },
      }),
      claude('r2', 't3', {
        type: 'user',
        parent_tool_use_id: 'task_1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'nested_write', content: 'File created' }],
        },
      }),
      claude('r2', 't4', {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'task_1', content: 'done' }] },
      }),
      { kind: 'run_end', runId: 'r2', ts: 't5', status: 'completed' },
    ]

    const state = buildTimeline(events)
    const run = state.runs[0]
    if (!run) throw new Error('expected a run')
    expect(run.timeline).toHaveLength(1)
    const taskNode = run.timeline[0]
    if (taskNode?.kind !== 'tool_call') throw new Error('expected tool_call')
    expect(taskNode.status).toBe('success')
    expect(taskNode.children).toHaveLength(1)
    const nested = taskNode.children[0]
    if (nested?.kind !== 'tool_call') throw new Error('expected nested tool_call')
    expect(nested.name).toBe('Write')
    expect(nested.status).toBe('success')

    const outline = buildOutline(run)
    expect(outline).toEqual([
      { id: 'task_1', name: 'Agent', depth: 0, status: 'success' },
      { id: 'nested_write', name: 'Write', depth: 1, status: 'success' },
    ])
  })

  it('tracks a backgrounded subagent launch separately from its later completion notification', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r4', ts: 't0', prompt: 'delegate in the background' },
      claude('r4', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'task_bg', name: 'Task', input: { description: 'review' } },
          ],
        },
      }),
      claude('r4', 't2', {
        type: 'system',
        subtype: 'task_started',
        task_id: 'job-1',
        tool_use_id: 'task_bg',
        is_backgrounded: true,
      }),
      claude('r4', 't3', {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'task_bg', content: 'Async agent launched.' },
          ],
        },
      }),
      claude('r4', 't4', {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'job-1',
        tool_use_id: 'task_bg',
        status: 'completed',
        summary: 'Reviewed the module.',
        usage: { total_tokens: 100, tool_uses: 3, duration_ms: 4000 },
      }),
      { kind: 'run_end', runId: 'r4', ts: 't5', status: 'completed' },
    ]

    const state = buildTimeline(events)
    const run = state.runs[0]
    if (!run) throw new Error('expected a run')
    const taskNode = run.timeline[0]
    if (taskNode?.kind !== 'tool_call') throw new Error('expected tool_call')

    // The tool_result resolved immediately (a launch acknowledgment, not real completion) —
    // callers must consult `backgrounded`/`subagentUsage.status`, not `status` alone, to tell.
    expect(taskNode.status).toBe('success')
    expect(taskNode.backgrounded).toBe(true)
    expect(taskNode.subagentUsage).toEqual({
      totalTokens: 100,
      toolUses: 3,
      durationMs: 4000,
      summary: 'Reviewed the module.',
      status: 'completed',
    })
  })

  it('marks a run interrupted without a result event', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r3', ts: 't0', prompt: 'will be interrupted' },
      { kind: 'run_end', runId: 'r3', ts: 't1', status: 'interrupted', error: 'Server restarted' },
    ]
    const state = buildTimeline(events)
    expect(state.runs[0]?.status).toBe('interrupted')
    expect(state.runs[0]?.error).toBe('Server restarted')
  })
})
