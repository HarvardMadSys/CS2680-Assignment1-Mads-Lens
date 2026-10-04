/** Renders `fullPath` relative to `cwd` when it's inside the workspace, so long absolute
 * paths don't crowd out the filename. Falls back to the full path when it isn't (or `cwd`
 * isn't known yet). */
export function relativizePath(fullPath: string, cwd: string | undefined): string {
  if (!cwd) return fullPath
  if (fullPath === cwd) return '.'
  const normalizedCwd = cwd.endsWith('/') ? cwd : `${cwd}/`
  return fullPath.startsWith(normalizedCwd) ? fullPath.slice(normalizedCwd.length) : fullPath
}
