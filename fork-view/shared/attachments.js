/**
 * What may be attached to a prompt, and what the prompt says about it.
 *
 * Shared so the browser and the server agree by construction. The browser's
 * copy is a courtesy -- it refuses a file before spending a round trip on it --
 * and the server's is the one that decides, because the browser can send
 * anything.
 */

/** 20MB. Large enough for a screenshot or a paper, small enough to hold in
 *  memory while it is written. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * Extensions an attachment may have.
 *
 * An allowlist rather than a denylist, and matched on the extension rather than
 * on the browser-reported MIME type: the type is whatever the client says it
 * is, while the extension is what the file is written as and what Claude Code
 * will open it by.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf', 'gif', 'webp']

/** The subdirectory attachments land in, inside the run's working directory. */
export const UPLOAD_DIR_NAME = '.uploads'

/** Lower-case extension without the dot, or '' when there is none. */
export function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? '').trim())
  return match ? match[1].toLowerCase() : ''
}

export function isAllowedUpload(name) {
  return ALLOWED_UPLOAD_EXTENSIONS.includes(extensionOf(name))
}

/** Extensions the browser can draw a thumbnail of. */
const PREVIEWABLE = ['png', 'jpg', 'jpeg', 'gif', 'webp']

/**
 * Which of the two ways an attachment is shown: a thumbnail, or a chip.
 *
 * Only what the browser can actually render is an image. A PDF is a chip
 * because its first page is not worth fetching to draw at 34px -- and so is
 * anything unrecognised, which is what a refused file is.
 */
export function attachmentKind(name) {
  return PREVIEWABLE.includes(extensionOf(name)) ? 'image' : 'file'
}

/** The short label a chip carries when there is no thumbnail to show. */
export function attachmentLabel(name) {
  return extensionOf(name).toUpperCase() || 'FILE'
}

/**
 * A filename safe to write inside `.uploads/`.
 *
 * Everything outside a conservative set is replaced rather than rejected, so a
 * pasted screenshot called `Screen Shot 2026-09-20 at 10.14.png` still arrives
 * under a recognisable name. Any directory part is dropped first -- the name
 * comes from the client, so `../../etc/passwd` is a string this has to survive
 * rather than a path to be resolved.
 *
 * The extension is taken from the allowlist-checked original, so the sanitiser
 * cannot be talked into writing a different kind of file than the one that was
 * validated.
 */
export function safeUploadName(name, { now = Date.now, random = Math.random } = {}) {
  const raw = String(name ?? '').trim()
  const base = raw.split(/[\\/]+/).pop() ?? ''
  const ext = extensionOf(base)

  const stem = base
    .slice(0, base.length - (ext ? ext.length + 1 : 0))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 60)

  // A short unique prefix, so attaching two screenshots with the same name in
  // one session does not silently overwrite the first.
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const suffix = random().toString(36).slice(2, 8)

  return `${stamp}-${suffix}-${stem || 'file'}${ext ? `.${ext}` : ''}`
}

/**
 * The line that tells Claude Code an attachment exists.
 *
 * It names the path and the tool, because a run started with `-p` has no
 * channel for an image beyond the filesystem: the file is on disk in the
 * working directory and the agent has to be told to go and open it.
 */
export function attachmentPreamble(relPath) {
  return (
    `There is an attached file at ${relPath} — read it with the Read tool ` +
    'before proceeding with the rest of this request.'
  )
}

/**
 * The prompt actually sent to Claude Code: one line per attachment, then what
 * the reader typed.
 *
 * Returns the typed text unchanged when nothing is attached, so an ordinary run
 * is byte-for-byte what it always was.
 */
export function composePrompt(text, attachments = []) {
  const typed = String(text ?? '').trim()
  const paths = attachments.map((a) => a?.path).filter(Boolean)

  if (!paths.length) return typed

  const preamble = paths.map(attachmentPreamble).join('\n')
  return typed ? `${preamble}\n\n${typed}` : preamble
}
