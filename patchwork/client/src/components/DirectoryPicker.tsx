import {
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  browseWorkspace,
  checkWorkspace,
  getDefaultWorkspace,
  type DirectoryListing,
} from '@/lib/api'

/** Turns an absolute path into clickable ancestor segments, root first — so picking a
 * different workspace is a matter of clicking a familiar breadcrumb, not remembering to hit an
 * "up" arrow repeatedly. */
function breadcrumbs(resolved: string): { name: string; path: string }[] {
  const parts = resolved.split('/').filter(Boolean)
  let acc = ''
  const crumbs = parts.map((part) => {
    acc += `/${part}`
    return { name: part, path: acc }
  })
  return [{ name: '/', path: '/' }, ...crumbs]
}

export function DirectoryPicker({
  trigger,
  initialPath,
  recentPaths = [],
  onConfirm,
}: {
  trigger: ReactNode
  initialPath: string
  recentPaths?: string[]
  onConfirm: (resolvedPath: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(initialPath)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const request = useRef(0)
  const inputId = useId()
  const recent = [...new Set(recentPaths)].filter((p) => p && p !== initialPath).slice(0, 4)

  function choose(path: string) {
    request.current++
    setValue(path)
    setListing(null)
    setError(null)
    setBrowsing(false)
  }

  async function browse(path: string) {
    const ticket = ++request.current
    setBrowsing(true)
    setError(null)
    setListing(null)
    try {
      const result = await browseWorkspace(path)
      if (ticket !== request.current) return
      if (!result.ok || !result.resolved) {
        setError(result.error ?? 'Could not browse this folder.')
        return
      }
      setValue(result.resolved)
      setListing(result)
    } catch (err) {
      if (ticket === request.current)
        setError(err instanceof Error ? err.message : 'Could not reach the local server.')
    } finally {
      if (ticket === request.current) setBrowsing(false)
    }
  }

  async function selectScratch() {
    const ticket = ++request.current
    setError(null)
    try {
      const path = await getDefaultWorkspace()
      if (ticket === request.current) await browse(path)
    } catch {
      if (ticket === request.current)
        setError('Could not reach the local server. Please try again.')
    }
  }

  async function handleConfirm() {
    if (checking || !value.trim()) return
    request.current++
    setBrowsing(false)
    setChecking(true)
    setError(null)
    try {
      const result = await checkWorkspace(value)
      if (!result.ok || !result.resolved) {
        setError(result.error ?? 'Invalid directory.')
        return
      }
      const confirmed = await onConfirm(result.resolved)
      if (confirmed === false) setError('Could not open this workspace. Please try again.')
      else setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the local server.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (checking) return
        request.current++
        setOpen(next)
        if (next) {
          choose(initialPath)
          void browse(initialPath)
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        aria-label="Choose workspace"
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl p-4 shadow-xl"
      >
        <div className="mb-1 flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderOpen className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Choose workspace</h2>
            <p className="text-xs text-muted-foreground">Where should Claude work?</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleConfirm()
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="text-xs font-medium">
              Folder path
            </label>
            <div className="flex gap-1.5">
              <Input
                id={inputId}
                value={value}
                onChange={(e) => choose(e.target.value)}
                disabled={checking}
                placeholder="/path/to/folder or ~/project"
                className="min-w-0 font-mono text-xs"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${inputId}-error` : undefined}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={checking || browsing}
                onClick={() => void browse(value)}
              >
                {browsing ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <FolderOpen className="size-3" />
                )}{' '}
                Browse
              </Button>
            </div>
          </div>
          {error && (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="rounded-md bg-destructive/5 p-2 text-xs text-destructive break-words"
            >
              {error}
            </p>
          )}
          {recent.length > 0 && (
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <History className="size-3" /> Recent workspaces
              </p>
              {recent.map((path) => (
                <button
                  type="button"
                  key={path}
                  disabled={checking}
                  title={path}
                  onClick={() => void browse(path)}
                  className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-secondary"
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {path.split('/').filter(Boolean).at(-1) ?? path}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {path}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {listing?.resolved && (
            <div className="overflow-hidden rounded-lg border bg-background/70">
              <div className="flex items-center gap-0.5 overflow-x-auto border-b px-2 py-1.5 whitespace-nowrap">
                {breadcrumbs(listing.resolved).map((crumb, i, arr) => (
                  <span key={crumb.path} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />}
                    {i === arr.length - 1 ? (
                      <span className="rounded px-1 py-0.5 text-[11px] font-semibold">
                        {crumb.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={checking}
                        onClick={() => void browse(crumb.path)}
                        className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        {crumb.name}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="max-h-36 overflow-y-auto p-1">
                {listing.directories.map((folder) => (
                  <button
                    type="button"
                    key={folder.path}
                    disabled={checking}
                    onClick={() => void browse(folder.path)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary focus-visible:outline-ring"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{folder.name}</span>
                    <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
                {listing.directories.length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    No subfolders. You can use this folder.
                  </p>
                )}
                {listing.truncated && (
                  <p className="p-2 text-xs text-muted-foreground">
                    First 200 folders shown. Type a path to select another.
                  </p>
                )}
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={checking}
            onClick={() => void selectScratch()}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed p-2.5 text-left hover:bg-secondary"
          >
            <ShieldCheck className="size-4 shrink-0 text-primary" />
            <span>
              <span className="block text-xs font-medium">Use scratch workspace</span>
              <span className="block text-[11px] text-muted-foreground">
                The app’s dedicated folder for experiments
              </span>
            </span>
          </button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Opens a new chat. Existing chats and active runs stay untouched. Claude can edit files
            and run commands here—choose a folder you trust it to change.
          </p>
          <div className="flex items-center justify-end gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checking}
              onClick={() => {
                request.current++
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={checking || !value.trim()}>
              {checking ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {checking ? 'Opening…' : 'Use workspace'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
