import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallRow } from './ToolCallRow'
import type { ToolCallNode } from '@/lib/timeline/types'
vi.mock('@/components/PathLabel', () => ({
  PathLabel: ({ path }: { path: string }) => <span>{path}</span>,
}))
vi.mock('@/components/CodeSurface', () => ({
  CodeSurface: ({ text }: { text: string }) => <pre>{text}</pre>,
}))
afterEach(cleanup)

describe('complete tool data', () => {
  it.each(['Write', 'Edit'])('shows the actual successful %s result beside its code', (name) => {
    const node: ToolCallNode = {
      kind: 'tool_call',
      id: 'tool',
      parentId: null,
      name,
      input: {
        file_path: '/scratch/a.ts',
        content: 'hello',
        old_string: 'before',
        new_string: 'after',
        replace_all: true,
      },
      status: 'success',
      result: { content: 'Actual tool acknowledgement', isError: false },
      children: [],
      startedAt: 'now',
    }
    const { container } = render(
      <ToolCallRow
        node={node}
        depth={0}
        expandedToolIds={new Set(['tool'])}
        onToggleTool={() => {}}
      />,
    )
    expect(screen.getByText('Complete input & result')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Complete input & result' }))
    expect(container.querySelector('[data-slot="collapsible-content"]')).toHaveTextContent(
      'replace_all',
    )
    expect(screen.getAllByText('Actual tool acknowledgement')[0]).toBeVisible()
  })
  it('keeps optional input fields and structured result blocks inspectable', () => {
    const node: ToolCallNode = {
      kind: 'tool_call',
      id: 'read',
      parentId: null,
      name: 'Read',
      input: { file_path: '/scratch/a.ts', offset: 5, limit: 20 },
      status: 'success',
      result: {
        content: [
          { type: 'text', text: 'line five' },
          { type: 'image', source: { type: 'base64', data: 'recorded-image' } },
        ],
        isError: false,
      },
      children: [],
      startedAt: 'now',
    }
    const { container } = render(
      <ToolCallRow
        node={node}
        depth={0}
        expandedToolIds={new Set(['read'])}
        onToggleTool={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Complete input & result' }))
    expect(container.querySelector('[data-slot="collapsible-content"]')).toHaveTextContent('offset')
    expect(container.querySelector('[data-slot="collapsible-content"]')).toHaveTextContent('limit')
    expect(container.querySelector('[data-slot="collapsible-content"]')).toHaveTextContent(
      'recorded-image',
    )
  })
})
