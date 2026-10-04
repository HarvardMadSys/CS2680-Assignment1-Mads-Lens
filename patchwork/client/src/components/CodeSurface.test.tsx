import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeSurface, inferLanguage } from './CodeSurface'
import { Markdown } from './Markdown'

afterEach(cleanup)

describe('CodeSurface', () => {
  it('infers common languages from labels and filenames', () => {
    expect(inferLanguage('language-ts')).toBe('typescript')
    expect(inferLanguage(undefined, '/tmp/src/game.tsx')).toBe('tsx')
    expect(inferLanguage(undefined, 'notes.unknown')).toBe('plaintext')
    expect(inferLanguage()).toBe('plaintext')
  })

  it('lazy-highlights code and keeps raw ANSI output available to copy', async () => {
    const rawOutput = '\u001b[31mFAIL\u001b[0m\nplain'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { container } = render(
      <CodeSurface text={rawOutput} terminal label="output" lineNumbers={false} />,
    )

    await waitFor(() => expect(container.querySelector('.shiki')).toBeInTheDocument())
    expect(container.querySelector('.shiki')?.textContent).toContain('FAIL')
    expect(container.querySelector('.shiki')?.textContent).toContain('plain')

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawOutput))
  })

  it('uses the same surface for fenced Markdown code', async () => {
    const { container } = render(
      <Markdown text={'```typescript\nconst answer: number = 42\n```'} />,
    )

    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    await waitFor(() => expect(container.querySelector('.shiki')).toBeInTheDocument())
    expect(container.querySelector('.code-surface')).toBeInTheDocument()
  })
})
