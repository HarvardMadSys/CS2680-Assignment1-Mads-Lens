import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function ndjsonResponse(events: unknown[]): Response {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  })
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/workspaces/default')
          return Promise.resolve(jsonResponse({ path: '/tmp/scratch' }))
        if (url === '/api/chats' && init?.method === 'POST') {
          return Promise.resolve(
            jsonResponse({
              id: 'chat-1',
              cwd: '/tmp/scratch',
              title: 'New chat',
              status: 'idle',
              createdAt: 'now',
              updatedAt: 'now',
            }),
          )
        }
        if (url === '/api/chats') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(jsonResponse({ error: `unhandled fetch in test: ${url}` }, 500))
      }),
    )
  })

  it('boots by creating a chat in the default workspace and shows the empty state', async () => {
    render(<App />)

    expect(screen.getByText('Patchwork')).toBeInTheDocument()
    expect(await screen.findByText(/Send a prompt below to get started/)).toBeInTheDocument()
    expect(screen.getByText('/tmp/scratch')).toBeInTheDocument()
  })

  it('lets the trajectory outline collapse and reopen', async () => {
    render(<App />)

    await screen.findByText(/Send a prompt below to get started/)

    fireEvent.click(screen.getByRole('button', { name: 'Hide trajectory' }))
    expect(screen.getByRole('button', { name: 'Show trajectory' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show trajectory' }))
    expect(screen.getByRole('button', { name: 'Hide trajectory' })).toBeInTheDocument()
  })

  it('persists the history sidebar collapsed state across refreshes', async () => {
    const first = render(<App />)
    await screen.findByText(/Send a prompt below to get started/)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat history' }))
    expect(screen.getByRole('button', { name: 'Expand chat history' })).toBeInTheDocument()

    first.unmount()
    render(<App />)
    await screen.findByText(/Send a prompt below to get started/)

    expect(screen.getByRole('button', { name: 'Expand chat history' })).toBeInTheDocument()
  })

  it('deletes an idle chat after confirmation', async () => {
    const chat = {
      id: 'chat-1',
      cwd: '/tmp/scratch',
      title: 'Building a maze',
      status: 'idle' as const,
      createdAt: '2026-09-09T12:00:00.000Z',
      updatedAt: '2026-09-09T12:00:00.000Z',
    }

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/chats' && (!init || init.method === undefined))
          return Promise.resolve(jsonResponse([chat]))
        if (url === '/api/chats/chat-1' && (!init || init.method === undefined))
          return Promise.resolve(jsonResponse({ chat, events: [] }))
        if (url === '/api/chats/chat-1' && init?.method === 'DELETE')
          return Promise.resolve(new Response(null, { status: 204 }))
        return Promise.resolve(jsonResponse({ error: `unhandled fetch in test: ${url}` }, 500))
      }),
    )
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)

    const user = userEvent.setup()
    const optionsButton = await screen.findByRole('button', { name: 'Options for Building a maze' })
    await user.click(optionsButton)
    const deleteItem = await screen.findByRole('menuitem', { name: /Delete/ })
    await user.click(deleteItem)

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith('Delete “Building a maze” and its saved history?')
      expect(fetch).toHaveBeenCalledWith('/api/chats/chat-1', { method: 'DELETE' })
    })
    expect(await screen.findByText(/Send a prompt below to get started/)).toBeInTheDocument()
  })

  it('reattaches to a chat that was already running on load, without starting a new run', async () => {
    const runningChat = {
      id: 'chat-1',
      cwd: '/tmp/scratch',
      title: 'Building a maze',
      status: 'running' as const,
      updatedAt: 'now',
    }
    let runCalls = 0
    let streamCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/chats' && (!init || init.method === undefined))
          return Promise.resolve(jsonResponse([runningChat]))
        if (url === '/api/chats/chat-1') {
          return Promise.resolve(
            jsonResponse({
              chat: { ...runningChat, createdAt: 'now' },
              events: [{ kind: 'run_start', runId: 'r1', ts: 't0', prompt: 'build a maze game' }],
            }),
          )
        }
        if (url === '/api/run') {
          runCalls += 1
          return Promise.resolve(jsonResponse({ error: 'should not start a new run' }, 409))
        }
        if (url === '/api/chats/chat-1/stream?since=1') {
          streamCalls += 1
          return Promise.resolve(
            ndjsonResponse([{ kind: 'run_end', runId: 'r1', ts: 't1', status: 'completed' }]),
          )
        }
        return Promise.resolve(jsonResponse({ error: `unhandled fetch in test: ${url}` }, 500))
      }),
    )

    render(<App />)

    // The mocked reattach resolves near-instantly, so the run may already be "Completed" by
    // the first render we observe — what matters is that it got there via the reattach stream,
    // never by starting a second run.
    await screen.findByRole('button', { name: /Completed/ })
    expect(runCalls).toBe(0)
    expect(streamCalls).toBe(1)
  })
})
