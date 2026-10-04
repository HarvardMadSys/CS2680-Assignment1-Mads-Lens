import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

export interface DirectoryCheckResult {
  ok: boolean
  resolved?: string
  error?: string
}

export async function checkDirectory(input: string): Promise<DirectoryCheckResult> {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: 'Path is required.' }
  const resolved = path.resolve(expandHome(trimmed))
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) {
      return { ok: false, error: `${resolved} is not a directory.` }
    }
    return { ok: true, resolved }
  } catch {
    return { ok: false, error: `${resolved} does not exist.` }
  }
}

/** Read-only directory navigation. Never creates folders or lists file contents. */
export async function browseDirectory(input: string) {
  const checked = await checkDirectory(input)
  if (!checked.ok || !checked.resolved) return { ...checked, directories: [] }
  try {
    const entries = await fs.readdir(checked.resolved, { withFileTypes: true })
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(checked.resolved as string, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return {
      ...checked,
      parent: path.dirname(checked.resolved),
      directories: directories.slice(0, 200),
      truncated: directories.length > 200,
    }
  } catch {
    return {
      ok: false,
      error: 'This directory could not be read. Check its permissions.',
      directories: [],
    }
  }
}
