import fs from 'node:fs'
import path from 'node:path'

import { PROJECT_ROOT, RUNS_DIR, TRAJECTORY_ROOTS } from './paths.js'

/**
 * Decode a saved trajectory.
 *
 * Existing recordings were written by PowerShell and carry either a UTF-16 LE
 * BOM or a UTF-8 BOM, so the encoding is sniffed rather than assumed.
 */
export function readTrajectory(absPath) {
  const raw = fs.readFileSync(absPath)

  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le').slice(1)
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    // UTF-16 BE: swap to LE before decoding.
    const swapped = Buffer.from(raw)
    swapped.swap16()
    return swapped.toString('utf16le').slice(1)
  }

  const text = raw.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Sidecar metadata written next to a live run's JSONL, if present. */
function readMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/i, '.meta.json')

  try {
    const { prompt, resumeSessionId, startedAt, cwd } = JSON.parse(
      fs.readFileSync(metaPath, 'utf8')
    )
    return { prompt, resumeSessionId: resumeSessionId ?? null, startedAt, cwd }
  } catch {
    return null
  }
}

export function listTrajectories() {
  const out = []

  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const stat = fs.statSync(full)
        out.push({
          path: path.relative(PROJECT_ROOT, full).split(path.sep).join('/'),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          // The JSONL never contains the prompt; the sidecar written by the
          // runner does, so replay can show what was asked.
          meta: readMeta(full),
        })
      }
    }
  }

  for (const root of TRAJECTORY_ROOTS) walk(path.join(PROJECT_ROOT, root))

  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

// ---------------------------------------------------------------------------
// resumable sessions
// ---------------------------------------------------------------------------

/** How much of the opening prompt names a session in the picker. */
const EXCERPT_CHARS = 60

/**
 * Trim to roughly `EXCERPT_CHARS`, on a word boundary where there is one close
 * enough, so the label reads as a phrase rather than a severed string.
 */
function excerpt(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!flat) return ''
  if (flat.length <= EXCERPT_CHARS) return flat

  const cut = flat.slice(0, EXCERPT_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > EXCERPT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * The working directory as the composer spells it: relative to the project
 * root, which is the only form the field and the server's own validation
 * accept. A directory from outside the project is passed through unchanged --
 * it will be rejected on submit, which is the honest outcome.
 */
function relativeCwd(absolute) {
  if (!absolute) return null

  const rel = path.relative(PROJECT_ROOT, absolute)
  // Empty means the project root itself, which the field spells as ".".
  if (!rel) return '.'
  if (rel.startsWith('..') || path.isAbsolute(rel)) return absolute

  return rel.split(path.sep).join('/')
}

// Reading every run's JSONL to find its session id is the expensive part of
// listing sessions, so each file's answer is kept until the file changes.
const sessionIdCache = new Map()

/**
 * The session id a run actually ran under.
 *
 * Not in the sidecar: that records the id we *asked* to resume, and Claude Code
 * does not promise to hand the same one back. The authoritative value is the
 * last `session_id` the run reported, which is the same rule the conversation
 * reducer follows.
 */
function observedSessionId(absPath) {
  let stat
  try {
    stat = fs.statSync(absPath)
  } catch {
    return null
  }

  const key = `${absPath}:${stat.size}:${stat.mtimeMs}`
  if (sessionIdCache.has(key)) return sessionIdCache.get(key)

  let found = null
  try {
    for (const line of readTrajectory(absPath).split('\n')) {
      if (!line.trim()) continue
      try {
        const id = JSON.parse(line).session_id
        if (typeof id === 'string' && id) found = id
      } catch {
        // A malformed line is not a reason to lose the ids around it.
      }
    }
  } catch {
    found = null
  }

  sessionIdCache.set(key, found)
  return found
}

/**
 * Past Claude Code sessions a follow-up can resume.
 *
 * A session is not one run: a conversation is a chain of runs, each resuming
 * the one before, and Claude Code may hand back a fresh id at any link. So the
 * runs are chained by "what this run resumed" -> "what that run reported", and
 * each chain contributes one entry: resumable under the id its most recent run
 * reported, labelled by the prompt that opened it.
 *
 * Only live runs count. A run is live if it has a sidecar next to its JSONL --
 * fixtures and hand-recorded trajectories have none, and resuming them would
 * mean resuming a session this machine never ran.
 */
export function listSessions() {
  let files
  try {
    files = fs
      .readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jsonl'))
      .map((e) => path.join(RUNS_DIR, e.name))
  } catch {
    return []
  }

  const runs = []
  for (const abs of files) {
    const meta = readMeta(abs)
    if (!meta) continue

    const sessionId = observedSessionId(abs)
    if (!sessionId) continue

    runs.push({
      sessionId,
      resumed: meta.resumeSessionId ?? null,
      startedAt: meta.startedAt ?? null,
      prompt: meta.prompt ?? '',
      cwd: relativeCwd(meta.cwd),
      path: path.relative(PROJECT_ROOT, abs).split(path.sep).join('/'),
    })
  }

  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))

  // Chain id -> chain. A run joins the chain of whatever it resumed, and the
  // chain then answers to this run's id as well, so the next follow-up finds
  // it whichever id it was given.
  const chainOf = new Map()
  const chains = []

  for (const run of runs) {
    let chain = run.resumed ? chainOf.get(run.resumed) : null

    if (!chain) {
      chain = { runs: [], cwd: run.cwd }
      chains.push(chain)
    }

    chain.runs.push(run)
    chain.cwd = run.cwd ?? chain.cwd
    chainOf.set(run.sessionId, chain)
  }

  return chains
    .map((chain) => {
      const first = chain.runs[0]
      const last = chain.runs[chain.runs.length - 1]
      return {
        // Resume the id the most recent run reported, not the one it was asked
        // to resume -- that is the live end of the conversation.
        sessionId: last.sessionId,
        lastActivityTimestamp: last.startedAt,
        promptExcerpt: excerpt(first.prompt),
        cwd: chain.cwd,
        runCount: chain.runs.length,
      }
    })
    .filter((s) => s.sessionId && s.lastActivityTimestamp)
    .sort((a, b) => b.lastActivityTimestamp.localeCompare(a.lastActivityTimestamp))
}
