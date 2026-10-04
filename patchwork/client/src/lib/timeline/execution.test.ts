import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentIdentities, executionForRun, toolKey } from './execution'
import { applyEvent, buildTimeline } from './reducer'
import { deriveAgentNodeStatus, findToolCallNode } from './selectors'
import { createEmptyTimelineState, type PersistedEvent } from './types'

const events = JSON.parse(
  readFileSync('../server/data/fixtures/trajectory-history.json', 'utf8'),
) as PersistedEvent[]

describe('complete execution history', () => {
  it('routes a delayed task notification to its original run, not the follow-up', () => {
    const withoutReturn = events.filter(
      (e) =>
        !(
          e.kind === 'claude' &&
          e.event.subtype === 'task_notification' &&
          e.event.tool_use_id === 'client-agent'
        ),
    )
    const state = applyEvent(buildTimeline(withoutReturn), {
      kind: 'claude',
      runId: 'history-3',
      ts: '2026-09-09T12:00:00Z',
      event: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-client',
        status: 'completed',
      },
    })
    const original = state.runs[1]
    if (!original) throw new Error('Missing fixture run')
    expect(findToolCallNode(original.timeline, 'client-agent')?.subagentUsage?.status).toBe(
      'completed',
    )
    expect(executionForRun(original).steps.map((s) => s.id)).toContain('return:client-agent')
    expect(state.runs[2]).toEqual(buildTimeline(withoutReturn).runs[2])
  })
  it('reconstructs three separate runs sharing a session, identically to a live fold', () => {
    const restored = buildTimeline(events)
    expect(restored.runs).toHaveLength(3)
    expect(new Set(restored.runs.map((r) => r.sessionId)).size).toBe(1)
    expect(events.reduce(applyEvent, createEmptyTimelineState())).toEqual(restored)
    expect(
      restored.runs.map((r) =>
        executionForRun(r)
          .steps.filter((s) => s.kind === 'tool')
          .map((s) => s.node.id),
      ),
    ).toEqual(expect.arrayContaining([['first-read', 'first-bash']]))
  })
  it('keeps parent work before recorded returns and nests the actual ownership', () => {
    const run = buildTimeline(events).runs[1]
    if (!run) throw new Error('Missing fixture run')
    const execution = executionForRun(run)
    expect(execution.lanes.find((l) => l.id === 'nested-agent')?.parentId).toBe('client-agent')
    expect(execution.steps.find((s) => s.node.id === 'main-during')?.laneId).toBe(`main:${run.id}`)
    const order = execution.steps.map((s) => s.id)
    expect(order.indexOf('tool:main-during')).toBeLessThan(order.indexOf('return:client-agent'))
    expect(order).not.toContain('return:server-agent')
    expect(order.indexOf('tool:main-after')).toBeGreaterThan(order.indexOf('return:client-agent'))
  })
  it('does not mark a background launch returned; preserves failed, cancelled, interrupted and unknown lifecycle', () => {
    const before = events.findIndex(
      (e) => e.kind === 'claude' && e.event.subtype === 'task_notification',
    )
    const run = buildTimeline(events.slice(0, before)).runs[1]
    if (!run) throw new Error('Missing fixture run')
    const node = findToolCallNode(run.timeline, 'client-agent')
    if (!node) throw new Error('Missing fixture agent')
    expect(deriveAgentNodeStatus(node, run)).toBe('working')
    expect(deriveAgentNodeStatus(node, { ...run, status: 'interrupted' })).toBe('interrupted')
    expect(deriveAgentNodeStatus(node, { ...run, status: 'completed' })).toBe('unknown')
    expect(deriveAgentNodeStatus({ ...node, subagentUsage: { status: 'cancelled' } }, run)).toBe(
      'cancelled',
    )
    expect(deriveAgentNodeStatus({ ...node, subagentUsage: { status: 'failed' } }, run)).toBe(
      'error',
    )
    expect(
      deriveAgentNodeStatus({ ...node, subagentUsage: { status: 'future-status' } }, run),
    ).toBe('unknown')
  })
  it('keeps faces stable during streaming, replay, nested creation and a resumed agent', () => {
    const firstAgent = events.findIndex(
      (e) => e.kind === 'claude' && JSON.stringify(e.event).includes('client-agent'),
    )
    const early = agentIdentities(buildTimeline(events.slice(0, firstAgent + 1)).runs)
    const final = agentIdentities(buildTimeline(events).runs)
    expect(final.get(toolKey('history-2', 'client-agent'))).toEqual(
      early.get(toolKey('history-2', 'client-agent')),
    )
    expect(final.get(toolKey('history-3', 'client-resumed'))).toEqual(
      final.get(toolKey('history-2', 'client-agent')),
    )
    expect(final.get(toolKey('history-2', 'server-agent'))).not.toEqual(
      final.get(toolKey('history-2', 'client-agent')),
    )
  })
})
