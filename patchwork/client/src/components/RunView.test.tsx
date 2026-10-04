import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunView } from './RunView'
import { TrajectoryPanel } from './TrajectoryPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Run, ToolCallNode } from '@/lib/timeline/types'

afterEach(cleanup)

function bashNode(id = 'bash-1'): ToolCallNode {
  return {
    kind: 'tool_call',
    id,
    parentId: null,
    name: 'Bash',
    input: { command: 'echo hello' },
    status: 'success',
    result: { content: 'hello', isError: false },
    children: [],
    startedAt: '2026-09-09T12:00:01.000Z',
    endedAt: '2026-09-09T12:00:01.500Z',
  }
}

function completedRun(timeline: Run['timeline'] = [bashNode(), textNode()]): Run {
  return {
    id: 'run-1',
    prompt: 'run the task',
    status: 'completed',
    startedAt: '2026-09-09T12:00:00.000Z',
    endedAt: '2026-09-09T12:00:02.500Z',
    timeline,
    metrics: { costUsd: 0.01, durationMs: 2500, numTurns: 2 },
  }
}

function textNode(): Run['timeline'][number] {
  return {
    kind: 'text',
    id: 'answer-1',
    parentId: null,
    role: 'assistant',
    text: 'Done.',
    createdAt: '2026-09-09T12:00:02.000Z',
  }
}

describe('RunView completion behavior', () => {
  it('collapses a completed run immediately, then toggles the full activity from its summary', () => {
    const running = { ...completedRun(), status: 'running' as const, endedAt: undefined }
    const { rerender } = render(<RunView run={running} />)

    expect(screen.getByRole('button', { name: /Bash/ })).toBeInTheDocument()

    rerender(<RunView run={completedRun()} />)

    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bash/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Completed.*2\.5s.*\$0\.010/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Completed/ }))
    const tool = screen.getByRole('button', { name: /Bash/ })
    expect(tool).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(tool)
    expect(tool).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('$ echo hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Completed/ }))
    expect(screen.queryByText('$ echo hello')).not.toBeInTheDocument()
  })

  it('restores completed runs collapsed while retaining manual expansion on later updates', () => {
    const run = completedRun()
    const { rerender } = render(<RunView run={run} />)

    expect(screen.queryByRole('button', { name: /Bash/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Completed/ }))
    expect(screen.getByRole('button', { name: /Bash/ })).toBeInTheDocument()

    rerender(
      <RunView
        run={{
          ...run,
          metrics: { costUsd: 0.01, durationMs: 2600, numTurns: 2 },
        }}
      />,
    )

    expect(screen.getByRole('button', { name: /Bash/ })).toBeInTheDocument()
  })

  it('opens the activity and the selected nested tool from the trajectory outline', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const nested = { ...bashNode('nested-bash'), parentId: 'agent-1' }
    const agent: ToolCallNode = {
      kind: 'tool_call',
      id: 'agent-1',
      parentId: null,
      name: 'Agent',
      input: { description: 'inspect the workspace' },
      status: 'success',
      result: { content: 'done', isError: false },
      children: [nested],
      startedAt: '2026-09-09T12:00:01.000Z',
      endedAt: '2026-09-09T12:00:02.000Z',
    }
    const run = completedRun([agent, textNode()])
    const outlineRefs = new Map<string, HTMLElement>()
    const runRevealRefs = new Map<string, (toolId: string) => void>()

    render(
      <TooltipProvider>
        <RunView run={run} outlineRefs={outlineRefs} runRevealRefs={runRevealRefs} />
        <TrajectoryPanel
          runs={[run]}
          chatId="nested-test"
          onSelectTool={() => {}}
          runRevealRefs={runRevealRefs}
          open
          onToggle={() => {}}
        />
      </TooltipProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Bash: echo hello' }))

    await waitFor(() => {
      const nestedTool = screen
        .getAllByRole('button', { name: /Bash/ })
        .find((button) => button.hasAttribute('aria-expanded'))
      expect(nestedTool).toHaveAttribute('aria-expanded', 'true')
    })
  })
})
