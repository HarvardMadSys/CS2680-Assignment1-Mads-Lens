import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrajectoryPanel } from './TrajectoryPanel'
import { RunView } from './RunView'
import { AgentIdentityProvider } from './AgentIdentityContext'
import type { Run } from '@/lib/timeline/types'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

const makeRun = (id: string, status: Run['status'] = 'completed'): Run => ({
  id,
  prompt: `Prompt ${id}`,
  status,
  startedAt: '2026-09-09T12:00:00Z',
  timeline: [
    {
      kind: 'tool_call',
      id: 'same-tool-id',
      parentId: null,
      name: 'Bash',
      input: { command: `cat ${id}.txt` },
      status: 'success',
      result: { content: `contents of ${id}`, isError: false },
      children: [],
      startedAt: '2026-09-09T12:00:01Z',
      sequence: 1,
    },
  ],
})

describe('trajectory run history', () => {
  it('provides a names-only nested outline with branch folds and exact historical navigation', () => {
    const reveal = vi.fn()
    render(reviewPanel(review(), reveal))
    fireEvent.click(screen.getByRole('button', { name: 'Call outline' }))
    const outline = screen.getByRole('navigation', { name: 'Tool call outline' })
    const agent = within(outline).getByRole('button', { name: 'Open Agent: Client architecture' })
    expect(agent).toHaveTextContent(/^Agent$/)
    const nested = within(outline).getByRole('button', { name: 'Open Read: /client/ChatStore.tsx' })
    expect(nested).toHaveTextContent(/^Read$/)
    expect(nested.closest('ol')?.parentElement?.tagName).toBe('LI')
    fireEvent.click(nested)
    expect(reveal).toHaveBeenLastCalledWith('ChatStore')
    fireEvent.click(
      within(outline).getByRole('button', { name: 'Collapse outline branch: Client architecture' }),
    )
    expect(
      within(outline).queryByRole('button', { name: 'Open Read: /client/ChatStore.tsx' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }))
    expect(
      screen.getByRole('button', { name: 'Expand branch: Client architecture' }),
    ).toBeInTheDocument()
  })
  const review = (): Run => ({
    ...makeRun('review'),
    timeline: [
      {
        kind: 'tool_call',
        id: 'reviewer',
        parentId: null,
        name: 'Agent',
        input: { description: 'Client architecture', prompt: 'Review the client state.' },
        status: 'success',
        result: { content: 'The client shares one event reducer.', isError: false },
        sequence: 1,
        resultSequence: 10,
        startedAt: '2026-09-09T12:00:00Z',
        children: ['App', 'ChatStore', 'RunView'].map((file, index) => ({
          kind: 'tool_call',
          id: file,
          parentId: 'reviewer',
          name: 'Read',
          input: { file_path: `/client/${file}.tsx` },
          status: 'success',
          result: { content: `${file} contents`, isError: false },
          children: [],
          sequence: index + 2,
          startedAt: '2026-09-09T12:00:01Z',
        })),
      },
    ],
  })
  const reviewPanel = (run: Run, reveal = vi.fn()) => (
    <AgentIdentityProvider runs={[run]}>
      <TrajectoryPanel
        runs={[run]}
        chatId="review-chat"
        runRevealRefs={new Map([[run.id, reveal]])}
        open
        onToggle={() => {}}
        onSelectTool={() => {}}
      />
    </AgentIdentityProvider>
  )
  it('compacts repeated reads, selects the task and return path, and reveals an exact expanded step', () => {
    const reveal = vi.fn()
    const view = render(reviewPanel(review(), reveal))
    expect(screen.getByText('Read 3 files · App.tsx, ChatStore.tsx, …')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read: App.tsx' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Shared # numbers · compact lanes, not elapsed time'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Assigned Client architecture to Haru' }))
    const details = screen.getByRole('region', { name: 'Selected task details' })
    expect(within(details).getByText('Review the client state.')).toBeInTheDocument()
    expect(within(details).getByText('3 recorded steps · 3 Read')).toBeInTheDocument()
    expect(within(details).getByText('The client shares one event reducer.')).toBeInTheDocument()
    expect(view.container.querySelector('[data-lane="reviewer"]')).toHaveAttribute(
      'data-path-active',
      'true',
    )
    expect(view.container.querySelector('[data-handoff="return-in:reviewer"]')).toHaveAttribute(
      'data-path-active',
      'true',
    )
    expect(screen.getByText('Jump to latest')).toBeInTheDocument()
    expect(screen.queryByText('Jump to live')).not.toBeInTheDocument()
    expect(screen.getAllByText('Final status: completed')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Show individual steps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Read: ChatStore.tsx' }))
    expect(reveal).toHaveBeenLastCalledWith('ChatStore')
    expect(within(details).getByText('Selected: Read · ChatStore.tsx')).toBeInTheDocument()
  })
  it('opens a group when an error arrives and keeps input requests visible', () => {
    const run = review()
    const agent = run.timeline[0]
    if (agent?.kind !== 'tool_call') throw new Error('Missing test agent')
    const read = agent.children[1]
    if (read?.kind !== 'tool_call') throw new Error('Missing test read')
    const view = render(reviewPanel(run))
    expect(screen.queryByRole('button', { name: 'Read: ChatStore.tsx' })).not.toBeInTheDocument()
    const updated = {
      ...run,
      status: 'running' as const,
      timeline: [
        {
          ...agent,
          children: [
            agent.children[0],
            {
              ...read,
              status: 'error' as const,
              result: { content: 'Permission denied', isError: true },
            },
            agent.children[2],
            {
              ...read,
              id: 'question',
              sequence: 7,
              name: 'AskUserQuestion',
              status: 'pending' as const,
              input: { questions: [{ question: 'Which folder should I inspect?' }] },
            },
          ].filter((node) => node !== undefined),
        },
      ],
    }
    view.rerender(reviewPanel(updated))
    expect(screen.getByRole('button', { name: 'Read: ChatStore.tsx' })).toHaveTextContent(
      'Permission denied',
    )
    expect(screen.getByText('Steps needing attention')).toBeInTheDocument()
    expect(screen.getByText('Which folder should I inspect?')).toBeInTheDocument()
    expect(screen.getByText('Input requested')).toBeInTheDocument()
  })
  it('reveals the correct historical run even when tool IDs repeat, and keeps it selected as another run arrives', () => {
    const refs = new Map<string, (id: string) => void>()
    const runs = [makeRun('first'), makeRun('second'), makeRun('third', 'running')]
    const contents = (items: Run[]) => (
      <>
        <div>
          {items.map((run) => (
            <RunView key={run.id} run={run} runRevealRefs={refs} />
          ))}
        </div>
        <TrajectoryPanel
          chatId="history-test"
          runs={items}
          runRevealRefs={refs}
          open
          onToggle={() => {}}
          onSelectTool={() => {}}
        />
      </>
    )
    const { container, rerender } = render(contents(runs))
    const panel = screen.getByRole('complementary', { name: 'Trajectory history' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Bash: cat first.txt' }))
    expect(
      container.querySelector('#run-first [data-tool-call-id="same-tool-id"]'),
    ).toHaveTextContent('contents of first')
    expect(
      container.querySelector('#run-third [data-tool-call-id="same-tool-id"] .code-surface'),
    ).toBeNull()
    rerender(contents([...runs, makeRun('fourth', 'running')]))
    expect(within(panel).getByRole('button', { name: 'Bash: cat first.txt' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(panel).getByText('Jump to live')).toBeInTheDocument()
    expect(panel.querySelectorAll('[data-trajectory-run]')).toHaveLength(4)
  })
  it('persists independent folds per chat and keeps pre-execution errors visible when folded', () => {
    const runs = [
      makeRun('first'),
      { ...makeRun('failed', 'error'), timeline: [], error: 'Could not start claude' },
    ]
    const contents = (chatId: string) => (
      <TrajectoryPanel
        key={chatId}
        chatId={chatId}
        runs={runs}
        runRevealRefs={new Map()}
        open
        onToggle={() => {}}
        onSelectTool={() => {}}
      />
    )
    const first = render(contents('chat-a'))
    fireEvent.click(screen.getByRole('button', { name: 'Run 1: Prompt first' }))
    expect(screen.getByRole('button', { name: 'Run 2: Prompt failed' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('No tool calls recorded for this prompt.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run 2: Prompt failed' }))
    expect(screen.getByText('Could not start claude')).toBeInTheDocument()
    first.unmount()
    const second = render(contents('chat-a'))
    expect(screen.getByRole('button', { name: 'Run 1: Prompt first' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    second.rerender(contents('chat-b'))
    expect(screen.getByRole('button', { name: 'Run 1: Prompt first' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })
})
