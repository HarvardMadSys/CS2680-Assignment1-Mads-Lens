/**
 * One-line summaries for the compact trajectory rows.
 *
 * A row has space for a phrase, not a payload: enough to say which file, which
 * command, which pattern, and how it went. The full input and output are always
 * one click away, so nothing here has to be exhaustive -- an unrecognised tool
 * falls back to the generic label parse.js already derives.
 *
 * Presentation only. Nothing here is read by the reducer or the hierarchy.
 */

const TARGET_CHARS = 88
const PEEK_CHARS = 56

/** Tail of a path: the file name carries the meaning, the drive letter does not. */
export function shortPath(value, segments = 2) {
  if (typeof value !== 'string' || !value.trim()) return ''

  const parts = value.trim().split(/[\\/]+/).filter(Boolean)
  if (parts.length <= segments) return parts.join('/')

  return `…/${parts.slice(-segments).join('/')}`
}

/** Collapse to a single line and cap the length, with an explicit ellipsis. */
function oneLine(value, max = TARGET_CHARS) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value : ''
}

/**
 * The short target shown next to a tool name. The familiar file/shell tools get
 * a hand-picked field; everything else reuses the generic label.
 */
export function toolSummary(node) {
  const input = node?.input && typeof node.input === 'object' ? node.input : {}
  const label = str(node?.label)

  switch (node?.name) {
    case 'Read': {
      const file = shortPath(input.file_path)
      if (!file) break
      const from = Number.isFinite(input.offset) ? ` from line ${input.offset}` : ''
      return oneLine(`${file}${from}`)
    }

    case 'Write': {
      const file = shortPath(input.file_path)
      if (!file) break
      const size = str(input.content) ? ` · ${input.content.split('\n').length} lines` : ''
      return oneLine(`${file}${size}`)
    }

    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = shortPath(input.file_path ?? input.notebook_path)
      if (!file) break
      const edits = Array.isArray(input.edits) ? ` · ${input.edits.length} edits` : ''
      const all = input.replace_all ? ' · all matches' : ''
      return oneLine(`${file}${edits}${all}`)
    }

    case 'Bash':
    case 'BashOutput': {
      const command = str(input.command)
      if (command) return oneLine(command)
      break
    }

    case 'Grep': {
      const pattern = str(input.pattern)
      if (!pattern) break
      const scope = str(input.path)
        ? ` in ${shortPath(input.path, 1)}`
        : str(input.glob)
          ? ` in ${input.glob}`
          : ''
      return oneLine(`${pattern}${scope}`)
    }

    case 'Glob': {
      const pattern = str(input.pattern)
      if (!pattern) break
      return oneLine(str(input.path) ? `${pattern} in ${shortPath(input.path, 1)}` : pattern)
    }

    case 'Agent':
    case 'Task': {
      const type = str(input.subagent_type)
      const what = str(input.description) || str(input.prompt)
      const bits = [type, what].filter(Boolean).join(' · ')
      if (bits) return oneLine(bits)
      break
    }

    case 'WebFetch':
      if (str(input.url)) return oneLine(input.url)
      break

    case 'WebSearch':
      if (str(input.query)) return oneLine(input.query)
      break

    case 'TodoWrite':
      if (Array.isArray(input.todos)) {
        const done = input.todos.filter((t) => t?.status === 'completed').length
        return oneLine(`${done}/${input.todos.length} done`)
      }
      break

    default:
      break
  }

  return oneLine(label)
}

/**
 * What a collapsed row says about the outcome: a status word while the call is
 * unresolved, otherwise the first line of whatever it produced. Returns
 * `{ text, tone }` so the row can colour a warning differently from output.
 */
export function resultPeek(node) {
  if (node?.status === 'running') return { text: 'running…', tone: 'running' }
  if (node?.status === 'incomplete') return { text: 'no result', tone: 'warn' }

  const result = node?.result
  if (!result) return null

  if (result.interrupted) return { text: 'interrupted', tone: 'warn' }

  const source = result.stdout?.trim() || result.stderr?.trim() || result.text?.trim()
  if (!source) return { text: '(no output)', tone: 'muted' }

  const lines = source.split('\n')
  const head = oneLine(lines[0], PEEK_CHARS)
  const more = lines.length > 1 ? ` +${lines.length - 1} lines` : ''

  return { text: `${head}${more}`, tone: result.isError ? 'error' : 'default' }
}

