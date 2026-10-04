/// <reference types="node" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTimeline } from './reducer'
import { buildAgentGraph } from './selectors'
import type { PersistedEvent } from './types'

// Sanity-checks buildAgentGraph against a real recorded session with five concurrent,
// backgrounded subagent delegations (server/data/fixtures/subagent-concurrent-review.json) —
// not a hand-invented scenario, so this is the closest thing to an end-to-end regression test
// for the "5 reviewers, not 50 Read calls" and "background launch != finished" requirements.
const fixturePath = path.resolve(
  process.cwd(),
  '../server/data/fixtures/subagent-concurrent-review.json',
)
const events = JSON.parse(readFileSync(fixturePath, 'utf8')) as PersistedEvent[]

describe('buildAgentGraph against the real concurrent-review recording', () => {
  it('collapses five concurrent reviewers into five agent nodes, all returned by run end', () => {
    const run = buildTimeline(events).runs[0]
    if (!run) throw new Error('expected a run')

    const graph = buildAgentGraph(run)
    const agents = graph.nodes.filter((n) => n.kind === 'agent')
    expect(agents).toHaveLength(5)
    expect(agents.every((a) => a.status === 'returned')).toBe(true)
    // Every reviewer really did a meaningful amount of its own work, not zero.
    expect(agents.every((a) => a.toolCallCount > 0)).toBe(true)
    // All five were launched directly by the main agent, not nested under each other.
    expect(graph.edges.filter((e) => e.source === `main:${run.id}`)).toHaveLength(5)
  })

  it('shows a reviewer as working, not returned, at the moment its launch is only acknowledged', () => {
    const launchOnlyIndex = events.findIndex(
      (e) =>
        e.kind === 'claude' && (e.event as { subtype?: string }).subtype === 'task_notification',
    )
    expect(launchOnlyIndex).toBeGreaterThan(0)
    const run = buildTimeline(events.slice(0, launchOnlyIndex)).runs[0]
    if (!run) throw new Error('expected a run')

    const graph = buildAgentGraph(run)
    const agents = graph.nodes.filter((n) => n.kind === 'agent')
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((a) => a.status === 'working')).toBe(true)
  })
})
