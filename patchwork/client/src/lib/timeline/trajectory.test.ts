import { describe, expect, it } from 'vitest'
import { executionForRun } from './execution'
import { activitySummary, groupLaneActivity, recordedResult, resultExcerpt } from './trajectory'
import type { Run, ToolCallNode } from './types'

function readStep(id: string, sequence: number, parentId: string | null = null): ToolCallNode {
  return {
    kind: 'tool_call',
    id,
    parentId,
    name: 'Read',
    input: { file_path: `/client/${id}.tsx` },
    status: 'success',
    result: { content: 'File contents', isError: false },
    children: [],
    startedAt: '2026-09-16T12:00:00Z',
    sequence,
  }
}

function reviewRun(): Run {
  return {
    id: 'review',
    prompt: 'Review the architecture',
    status: 'completed',
    startedAt: '2026-09-16T12:00:00Z',
    timeline: [
      {
        ...readStep('reviewer', 1),
        name: 'Agent',
        input: {
          description: 'Client architecture',
          prompt: 'Review the client state and component tree.',
        },
        children: [
          readStep('App', 2, 'reviewer'),
          readStep('ChatStore', 4, 'reviewer'),
          readStep('RunView', 6, 'reviewer'),
        ],
        resultSequence: 8,
        result: {
          content: 'The client shares a single event reducer. Details follow.',
          isError: false,
        },
      },
      readStep('README', 3),
      readStep('package', 5),
    ],
  }
}

describe('trajectory presentation', () => {
  it('groups adjacent work within its owner despite interleaved events in other lanes', () => {
    const run = reviewRun()
    const before = structuredClone(run)
    const execution = executionForRun(run)
    const groups = groupLaneActivity(execution.steps, 'reviewer')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.steps.map((step) => step.node.id)).toEqual(['App', 'ChatStore', 'RunView'])
    if (!groups[0]) throw new Error('Missing read group')
    expect(activitySummary(groups[0])).toBe('Read 3 files · App.tsx, ChatStore.tsx, …')
    expect(
      groupLaneActivity(execution.steps, 'main:review').map((group) => group.steps.length),
    ).toEqual([1, 2, 1])
    expect(run).toEqual(before)
  })
  it('never merges assignments or returns into a tool group', () => {
    const run = reviewRun()
    run.timeline.push(readStep('after', 9))
    const groups = groupLaneActivity(executionForRun(run).steps, 'main:review')
    expect(groups.map((group) => group.steps.map((step) => step.kind))).toEqual([
      ['tool'],
      ['tool', 'tool'],
      ['return'],
      ['tool'],
    ])
  })
  it('counts repeated reads separately from distinct files', () => {
    const execution = executionForRun({
      ...reviewRun(),
      timeline: [
        readStep('App', 1),
        { ...readStep('again', 2), input: { file_path: '/client/App.tsx' } },
      ],
    })
    const group = groupLaneActivity(execution.steps, 'main:review')[0]
    if (!group) throw new Error('Missing read group')
    expect(activitySummary(group)).toBe('Read 1 file · 2 reads · App.tsx')
  })
  it('does not use an async launch acknowledgement as a returned result', () => {
    const run = reviewRun()
    const node: ToolCallNode = {
      ...readStep('background', 1),
      name: 'Agent',
      backgrounded: true,
      result: { content: 'Async agent launched', isError: false },
    }
    expect(recordedResult(node, run)).toBeUndefined()
    expect(
      executionForRun({ ...run, timeline: [node] }).steps.some((step) => step.kind === 'return'),
    ).toBe(false)
    expect(
      recordedResult(
        {
          ...node,
          subagentUsage: { status: 'completed', summary: 'Review finished.' },
          notificationSequence: 10,
        },
        run,
      ),
    ).toBe('Review finished.')
  })
  it('counts files by their full paths, even when basenames match', () => {
    const execution = executionForRun({
      ...reviewRun(),
      timeline: [
        readStep('App', 1),
        { ...readStep('other', 2), input: { file_path: '/example/App.tsx' } },
      ],
    })
    const group = groupLaneActivity(execution.steps, 'main:review')[0]
    if (!group) throw new Error('Missing read group')
    expect(activitySummary(group)).toBe('Read 2 files · App.tsx')
  })
  it('extracts a bounded sentence from recorded output without inventing a finding', () => {
    expect(resultExcerpt('## Review\n\nThe **client** uses one reducer. More details.')).toBe(
      'The client uses one reducer.',
    )
    expect(resultExcerpt('x'.repeat(500))).toHaveLength(218)
    expect(resultExcerpt(undefined)).toBeUndefined()
    expect(
      resultExcerpt('I have enough to write a report.\n\n## Client architecture\n\n```\nApp\n…'),
    ).toBe('Client architecture')
    expect(resultExcerpt('[harness: internal recording metadata]…')).toBeUndefined()
  })
})
