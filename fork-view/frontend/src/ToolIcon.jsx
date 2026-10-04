/**
 * A small glyph per tool type, drawn inline so it inherits the row's colour and
 * costs no network request.
 *
 * The icon is decoration, not information: every row still carries the tool's
 * name as text, and the SVG is `aria-hidden` so a screen reader is not read a
 * second, wordless copy of it. It also contributes no text content, which is
 * what lets the outline stay "step + glyph + name" when read as plain text.
 *
 * Unknown tools fall back to a neutral mark rather than disappearing, so a tool
 * this file has never heard of still lines up with its neighbours.
 */

/** Shared stroke geometry: one visual weight for the whole set. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

/* Drawn on a 16x16 grid. Each entry is the icon's body; the <svg> wrapper and
   stroke styling are shared, so a new tool is one short array away. */
const ICONS = {
  // A page with body text: something was taken in.
  read: (
    <>
      <path d="M4 2.5h4.6L12 5.9v7.6H4z" />
      <path d="M8.4 2.6v3.4h3.4" />
      <path d="M6 8.6h4M6 11h2.6" />
    </>
  ),

  // A page with a plus: something new was put down.
  write: (
    <>
      <path d="M4 2.5h4.6L12 5.9v7.6H4z" />
      <path d="M8.4 2.6v3.4h3.4" />
      <path d="M7.9 8.2v3.4M6.2 9.9h3.4" />
    </>
  ),

  // A pencil across an existing line: something already there was changed.
  edit: (
    <>
      <path d="M11.1 2.6 13.4 4.9 7 11.3l-3 .7.7-3z" />
      <path d="M9.6 4.1 11.9 6.4" />
      <path d="M3 14h10" />
    </>
  ),

  // A shell prompt. Deliberately unboxed: a rectangle this small with marks
  // inside it turns to mush at row height, where a bare `>_` stays legible.
  bash: (
    <>
      <path d="M2.8 3.9 7.4 8l-4.6 4.1" />
      <path d="M8.2 12.4h5" />
    </>
  ),

  // A plain magnifier. A line through the lens was meant to suggest matching
  // text and instead read as a zoom-out control, so the lens stays empty.
  grep: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M9.9 9.9 13.4 13.4" />
    </>
  ),

  // A wildcard asterisk: match by shape, not by name.
  glob: (
    <>
      <path d="M8 2.8v10.4" />
      <path d="M3.5 5.4l9 5.2" />
      <path d="M12.5 5.4l-9 5.2" />
    </>
  ),

  // A parent node branching into two children -- the same tree motif the
  // outline and the subagent branches are drawn with.
  task: (
    <>
      <rect x="2.2" y="1.8" width="3.4" height="3.4" rx="1" />
      <path d="M3.9 5.2v7.1" />
      <path d="M3.9 6.9h3.5M3.9 12.3h3.5" />
      <rect x="7.4" y="5.2" width="6.4" height="3.4" rx="1" />
      <rect x="7.4" y="10.6" width="6.4" height="3.4" rx="1" />
    </>
  ),

  // A checklist: the todo list, ticked.
  todo: (
    <>
      <path d="M2.6 4.6 3.8 5.8 6 3.6" />
      <path d="M2.6 11 3.8 12.2 6 10" />
      <path d="M8 4.7h5.4M8 11.1h5.4" />
    </>
  ),

  // A globe: the world outside this machine.
  web: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c1.7 1.8 2.6 3.6 2.6 5.5S9.7 12.2 8 13.5C6.3 12.2 5.4 10.4 5.4 8s.9-3.7 2.6-5.5z" />
    </>
  ),

  // Anything unrecognised: present, deliberately uninformative.
  generic: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.6" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
}

/**
 * Tool name -> icon key. Aliases are grouped by what the call does rather than
 * by what it is called, so MultiEdit reads as an edit and BashOutput as a shell.
 */
const BY_TOOL = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'task',
  Agent: 'task',
  TodoWrite: 'todo',
  WebFetch: 'web',
  WebSearch: 'web',
}

/** Which icon a tool name resolves to. Exported so tests can assert the map. */
export function iconKey(name) {
  return BY_TOOL[name] ?? 'generic'
}

/* --------------------------------------------------------------------------
   Status marks.

   Drawn on the same 16x16 grid and with the same stroke weight as the tool
   glyphs, so a row reads as one set rather than as an icon plus a character.
   They replace the ✓ / ✕ / ● the rows used to print: a tick set in the page's
   text font was being read as text, which is exactly the wrong thing for the
   mark a reader scans a column of.

   Each is a shape before it is a colour: a tick, a cross, a ring, an arc. A
   reader who cannot separate green from red still reads the column.
   -------------------------------------------------------------------------- */
const STATUS_ICONS = {
  completed: <path d="M3.4 8.4 6.3 11.3 12.6 5" />,
  error: (
    <>
      <path d="M4.4 4.4 11.6 11.6" />
      <path d="M11.6 4.4 4.4 11.6" />
    </>
  ),
  /* An open arc rather than a full ring: it has a head and a tail, so it reads
     as turning the moment it is spun. */
  running: (
    <>
      <circle cx="8" cy="8" r="5" opacity="0.28" />
      <path d="M13 8a5 5 0 0 0-5-5" />
    </>
  ),
  incomplete: <circle cx="8" cy="8" r="4.4" />,
  /* A filled square: the universal transport stop, and the one shape in the set
     that is neither a tick nor a cross -- a cancelled run did not succeed and
     did not fail. */
  stopped: <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" />,
  unknown: <circle cx="8" cy="8" r="1.6" />,
}

/**
 * How a call went, as a mark rather than a character.
 *
 * `aria-hidden` for the same reason the tool glyphs are: the row already
 * carries its outcome in the `title` the button puts on it, and a screen
 * reader being read a second, wordless copy of it helps nobody.
 */
export function StatusIcon({ status, className = 'status-icon' }) {
  const key = STATUS_ICONS[status] ? status : 'unknown'

  return (
    <svg
      className={`${className} status-${key}`}
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
      {...STROKE}
      strokeWidth={key === 'completed' || key === 'error' ? 1.9 : 1.5}
    >
      {STATUS_ICONS[key]}
    </svg>
  )
}

export default function ToolIcon({ name, className = 'tool-icon' }) {
  const key = iconKey(name)

  return (
    <svg
      className={`${className} icon-${key}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      {...STROKE}
    >
      {ICONS[key]}
    </svg>
  )
}
