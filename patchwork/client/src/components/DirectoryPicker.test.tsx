import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from './DirectoryPicker'
import { browseWorkspace, checkWorkspace, getDefaultWorkspace } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  browseWorkspace: vi.fn(),
  checkWorkspace: vi.fn(),
  getDefaultWorkspace: vi.fn(),
}))
afterEach(cleanup)
beforeEach(() => vi.resetAllMocks())

/** Opening the picker auto-browses `initialPath`, so every test needs a resolved response
 * ready before the click, and needs to wait for that initial listing to settle. */
async function openPicker() {
  const confirm = vi.fn().mockResolvedValue(true)
  vi.mocked(browseWorkspace).mockResolvedValue({ ok: true, resolved: '/scratch', directories: [] })
  render(
    <DirectoryPicker
      initialPath="/scratch"
      recentPaths={['/project', '/project', '/scratch']}
      onConfirm={confirm}
      trigger={<button type="button">Change workspace</button>}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change workspace' }))
  await waitFor(() => expect(browseWorkspace).toHaveBeenCalledWith('/scratch'))
  await screen.findByText('No subfolders. You can use this folder.')
  return confirm
}

describe('workspace selection', () => {
  it('validates a typed path and confirms only the resolved directory', async () => {
    const confirm = await openPicker()
    vi.mocked(checkWorkspace).mockResolvedValue({ ok: true, resolved: '/resolved/project' })
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '~/project' } })
    fireEvent.submit(
      screen.getByRole('button', { name: 'Use workspace' }).closest('form') as HTMLFormElement,
    )
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('/resolved/project'))
    expect(checkWorkspace).toHaveBeenCalledWith('~/project')
  })
  it('keeps validation and network failures visible without opening a chat', async () => {
    const confirm = await openPicker()
    vi.mocked(checkWorkspace)
      .mockResolvedValueOnce({ ok: false, error: 'Not a directory' })
      .mockRejectedValueOnce(new Error('Server offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Use workspace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a directory')
    fireEvent.click(screen.getByRole('button', { name: 'Use workspace' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server offline'))
    expect(confirm).not.toHaveBeenCalled()
  })
  it('keeps recents visible alongside the auto-opened folder browser', async () => {
    await openPicker()
    expect(screen.getAllByTitle('/project')).toHaveLength(1)
    vi.mocked(browseWorkspace).mockResolvedValue({
      ok: true,
      resolved: '/project',
      parent: '/',
      directories: [{ name: 'src', path: '/project/src' }],
    })
    fireEvent.click(screen.getByTitle('/project'))
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/project'))
    // The recents list stays visible next to the folder browser, not replaced by it.
    expect(screen.getByTitle('/project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src' })).toBeInTheDocument()
  })
  it('drills into a subfolder and jumps back up via a breadcrumb', async () => {
    await openPicker()
    vi.mocked(browseWorkspace)
      .mockResolvedValueOnce({
        ok: true,
        resolved: '/project',
        parent: '/',
        directories: [{ name: 'src', path: '/project/src' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        resolved: '/project/src',
        parent: '/project',
        directories: [],
      })
      .mockResolvedValue({ ok: true, resolved: '/', directories: [] })
    fireEvent.click(screen.getByTitle('/project'))
    await waitFor(() => expect(browseWorkspace).toHaveBeenCalledWith('/project'))
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await waitFor(() => expect(browseWorkspace).toHaveBeenCalledWith('/project/src'))
    // Root, and every ancestor in between, is one click away — not just the immediate parent.
    fireEvent.click(await screen.findByRole('button', { name: '/' }))
    await waitFor(() => expect(browseWorkspace).toHaveBeenCalledWith('/'))
  })
  it('offers the scratch shortcut', async () => {
    await openPicker()
    vi.mocked(getDefaultWorkspace).mockResolvedValue('/scratch')
    fireEvent.click(screen.getByRole('button', { name: /Use scratch workspace/ }))
    await waitFor(() => expect(getDefaultWorkspace).toHaveBeenCalled())
  })
  it('does not let an old browsing response overwrite a newly typed path', async () => {
    await openPicker()
    let finish: ((result: Awaited<ReturnType<typeof browseWorkspace>>) => void) | undefined
    vi.mocked(browseWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/new-choice' } })
    finish?.({ ok: true, resolved: '/old-choice', directories: [] })
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/new-choice'))
  })
})
