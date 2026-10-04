import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  UPLOAD_DIR_NAME,
  isAllowedUpload,
  safeUploadName,
} from '../shared/attachments.js'

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

export const SESSIONS_DIR = path.join(PROJECT_ROOT, 'sessions')

// Live runs started from the browser land here.
export const RUNS_DIR = path.join(SESSIONS_DIR, 'runs')

// Directories scanned for replayable .jsonl trajectories, project-root-relative.
// `fixtures` holds the verified subagent recordings used for deterministic
// replay testing (see scripts/record-subagent.mjs).
export const TRAJECTORY_ROOTS = ['sessions', 'claude-test', 'fixtures']

export const DEFAULT_WORK_DIR = 'claude-test'

// Directories under PROJECT_ROOT that Claude Code may never be pointed at.
const WORK_DIR_DENYLIST = ['node_modules', 'sessions', '.git']

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Resolve a user-supplied working directory.
 *
 * The browser can send anything, and the run is spawned with
 * --dangerously-skip-permissions, so the path is constrained to the project
 * tree rather than trusted. Returns an absolute path.
 */
export function resolveWorkDir(input, fsModule) {
  const raw = String(input ?? '').trim()

  if (!raw) {
    throw new HttpError(400, 'Working directory is required.')
  }

  const abs = path.resolve(PROJECT_ROOT, raw)
  const rel = path.relative(PROJECT_ROOT, abs)

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(
      400,
      `Working directory must stay inside the project root (${PROJECT_ROOT}).`
    )
  }

  const firstSegment = rel.split(path.sep)[0]

  if (WORK_DIR_DENYLIST.includes(firstSegment)) {
    throw new HttpError(400, `Working directory "${rel}" is not allowed.`)
  }

  let stat
  try {
    stat = fsModule.statSync(abs)
  } catch {
    throw new HttpError(400, `Working directory does not exist: ${rel || '.'}`)
  }

  if (!stat.isDirectory()) {
    throw new HttpError(400, `Working directory is not a directory: ${rel}`)
  }

  return abs
}

/**
 * Where an attachment for a run in `cwd` is written.
 *
 * The working directory goes through the same `resolveWorkDir` every run does,
 * so an upload can no more escape the project tree than a run can. The filename
 * is then sanitised rather than trusted -- it arrives from the browser, where a
 * drag-and-drop can carry any string at all -- and the result is re-checked
 * against the resolved directory, so even a sanitiser bug cannot write outside
 * `.uploads/`.
 *
 * Returns the absolute directory, the absolute file, and the path to put in the
 * prompt: relative to the working directory, because that is Claude Code's own
 * cwd and therefore what its Read tool resolves against.
 */
export function resolveUploadTarget(cwdInput, filename, fsModule) {
  const workDir = resolveWorkDir(cwdInput, fsModule)

  const raw = String(filename ?? '').trim()
  if (!raw) {
    throw new HttpError(400, 'A filename is required.')
  }

  if (!isAllowedUpload(raw)) {
    throw new HttpError(
      400,
      `Attachments must be one of: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}.`
    )
  }

  const dir = path.join(workDir, UPLOAD_DIR_NAME)
  const abs = path.join(dir, safeUploadName(raw))

  // Belt and braces: the sanitiser is what keeps the name harmless, and this is
  // what proves it did.
  const inside = path.relative(dir, abs)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new HttpError(400, 'Invalid attachment filename.')
  }

  return {
    dir,
    abs,
    relPath: `${UPLOAD_DIR_NAME}/${path.basename(abs)}`,
  }
}

export { MAX_UPLOAD_BYTES }

/**
 * Validate a Claude Code session id.
 *
 * This value is the only user-supplied string that reaches the child process
 * argv, and on Windows the child is spawned through a shell, so it is matched
 * against a strict UUID shape rather than merely escaped.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function resolveSessionId(input) {
  if (input == null || input === '') return null

  const raw = String(input).trim()
  if (!SESSION_ID_RE.test(raw)) {
    throw new HttpError(400, `Not a valid session id: ${raw.slice(0, 80)}`)
  }

  return raw
}

/**
 * Resolve a saved trajectory path (relative to sessions/) for replay.
 */
export function resolveTrajectoryPath(input, fsModule) {
  const raw = String(input ?? '').trim()

  if (!raw) {
    throw new HttpError(400, 'Trajectory path is required.')
  }

  const abs = path.resolve(PROJECT_ROOT, raw)
  const rel = path.relative(PROJECT_ROOT, abs)

  const inAllowedRoot = TRAJECTORY_ROOTS.some((root) => {
    const inside = path.relative(path.join(PROJECT_ROOT, root), abs)
    return inside && !inside.startsWith('..') && !path.isAbsolute(inside)
  })

  if (!inAllowedRoot) {
    throw new HttpError(
      400,
      `Trajectory must live under ${TRAJECTORY_ROOTS.map((r) => `${r}/`).join(' or ')}.`
    )
  }

  if (path.extname(abs).toLowerCase() !== '.jsonl') {
    throw new HttpError(400, 'Trajectory must be a .jsonl file.')
  }

  if (!fsModule.existsSync(abs)) {
    throw new HttpError(404, `Trajectory not found: ${rel}`)
  }

  return abs
}
