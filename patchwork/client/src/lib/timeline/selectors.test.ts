import { describe, expect, it } from 'vitest'
import { buildTimeline } from './reducer'
import { buildAgentGraph } from './selectors'
import type { PersistedEvent } from './types'

function claude(runId: string, ts: string, event: Record<string, unknown>): PersistedEvent {
  return { kind: 'claude', runId, ts, event }
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }
}

describe('buildAgentGraph', () => {
  it('gives one agent node per delegation and folds nested non-subagent calls into its count', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r1', ts: 't0', prompt: 'review' },
      claude('r1', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [toolUse('task_client', 'Task', { description: 'Client review' })],
        },
      }),
      claude('r1', 't2', {
        type: 'assistant',
        parent_tool_use_id: 'task_client',
        message: { content: [toolUse('read_1', 'Read', { file_path: '/a.tsx' })] },
      }),
      claude('r1', 't3', {
        type: 'user',
        parent_tool_use_id: 'task_client',
        message: { content: [toolResult('read_1', 'contents')] },
      }),
      claude('r1', 't4', {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [toolResult('task_client', 'Reviewed the client.')] },
      }),
    ]
    const run = buildTimeline(events).runs[0]
    if (!run) throw new Error('expected a run')

    const graph = buildAgentGraph(run)
    expect(graph.nodes).toEqual([
      { id: 'main:r1', kind: 'main', label: 'Main agent', status: 'working', toolCallCount: 1 },
      {
        id: 'task_client',
        kind: 'agent',
        label: 'Client review',
        status: 'returned',
        toolCallId: 'task_client',
        toolCallCount: 1,
        subagentUsage: undefined,
        orderIndex: 0,
      },
    ])
    expect(graph.edges).toEqual([
      { id: 'main:r1->task_client', source: 'main:r1', target: 'task_client' },
    ])
  })

  it('edges a nested delegation from its launching agent, not from main', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r2', ts: 't0', prompt: 'review' },
      claude('r2', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [toolUse('task_outer', 'Task', { description: 'Outer' })] },
      }),
      claude('r2', 't2', {
        type: 'assistant',
        parent_tool_use_id: 'task_outer',
        message: { content: [toolUse('task_inner', 'Agent', { description: 'Inner' })] },
      }),
    ]
    const run = buildTimeline(events).runs[0]
    if (!run) throw new Error('expected a run')

    const graph = buildAgentGraph(run)
    expect(graph.nodes.map((n) => n.id)).toEqual(['main:r2', 'task_outer', 'task_inner'])
    expect(graph.edges).toEqual([
      { id: 'main:r2->task_outer', source: 'main:r2', target: 'task_outer' },
      { id: 'task_outer->task_inner', source: 'task_outer', target: 'task_inner' },
    ])
  })

  it('does not read a backgrounded launch as returned until a terminal task_notification arrives', () => {
    const events: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r3', ts: 't0', prompt: 'review' },
      claude('r3', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [toolUse('task_bg', 'Task', { description: 'Server review' })] },
      }),
      claude('r3', 't2', {
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'task_bg',
        is_backgrounded: true,
      }),
      claude('r3', 't3', {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [toolResult('task_bg', 'Async agent launched.')] },
      }),
    ]
    const withoutNotification = buildTimeline(events).runs[0]
    if (!withoutNotification) throw new Error('expected a run')
    expect(buildAgentGraph(withoutNotification).nodes[1]?.status).toBe('working')

    const withNotification = buildTimeline([
      ...events,
      claude('r3', 't4', {
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'task_bg',
        status: 'completed',
      }),
    ]).runs[0]
    if (!withNotification) throw new Error('expected a run')
    expect(buildAgentGraph(withNotification).nodes[1]?.status).toBe('returned')
  })

  it('reports delegated (no activity yet) and error statuses', () => {
    const delegatedOnly: PersistedEvent[] = [
      { kind: 'run_start', runId: 'r4', ts: 't0', prompt: 'review' },
      claude('r4', 't1', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [toolUse('task_pending', 'Task', { description: 'Pending' })] },
      }),
    ]
    const pendingRun = buildTimeline(delegatedOnly).runs[0]
    if (!pendingRun) throw new Error('expected a run')
    expect(buildAgentGraph(pendingRun).nodes[1]?.status).toBe('delegated')

    const failed: PersistedEvent[] = [
      ...delegatedOnly,
      claude('r4', 't2', {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [toolResult('task_pending', 'boom', true)] },
      }),
    ]
    const failedRun = buildTimeline(failed).runs[0]
    if (!failedRun) throw new Error('expected a run')
    expect(buildAgentGraph(failedRun).nodes[1]?.status).toBe('error')
  })
})
