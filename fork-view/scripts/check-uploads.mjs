/**
 * Prompt attachments: what may be attached, where it is allowed to land, and
 * what the prompt ends up saying.
 *
 * The filename and the working directory both arrive from the browser, and the
 * run they are for is spawned with --dangerously-skip-permissions, so these are
 * the checks that matter: a name is a string to survive, not a path to trust.
 *
 * Run with: node scripts/check-uploads.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  UPLOAD_DIR_NAME,
  attachmentKind,
  attachmentLabel,
  attachmentPreamble,
  composePrompt,
  extensionOf,
  isAllowedUpload,
  safeUploadName,
} = await import(new URL('../shared/attachments.js', import.meta.url))

const { HttpError, PROJECT_ROOT, resolveUploadTarget } = await import(
  new URL('../server/paths.js', import.meta.url)
)

let failures = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}${
      ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`
    }`
  )
}

/** The status a rejected input comes back with, or 'accepted'. */
function rejection(fn) {
  try {
    fn()
    return 'accepted'
  } catch (err) {
    return err instanceof HttpError ? err.status : `threw ${err.constructor.name}`
  }
}

// ---------------------------------------------------------------------------
console.log('\n== what may be attached ==')

check('the allowlist', ALLOWED_UPLOAD_EXTENSIONS, ['png', 'jpg', 'jpeg', 'pdf', 'gif', 'webp'])
check('the ceiling is 20MB', MAX_UPLOAD_BYTES, 20 * 1024 * 1024)

check('extension is taken from the end', extensionOf('a.b.c.png'), 'png')
check('extension is lower-cased', extensionOf('SHOT.PNG'), 'png')
check('no extension', extensionOf('README'), '')
check('a trailing dot is not an extension', extensionOf('weird.'), '')

for (const ext of ALLOWED_UPLOAD_EXTENSIONS) {
  check(`  ${ext} is allowed`, isAllowedUpload(`file.${ext}`), true)
}
check('  case does not matter', isAllowedUpload('Screenshot.PNG'), true)

// The point of matching on the extension rather than the reported MIME type:
// the extension is what the file is written as and what Read will open it by.
for (const bad of ['run.sh', 'x.exe', 'notes.md', 'archive.zip', 'page.html', 'noext']) {
  check(`  ${bad} is refused`, isAllowedUpload(bad), false)
}
check('  a double extension is judged by its last', isAllowedUpload('image.png.exe'), false)

check('a pdf shows as a chip', attachmentKind('paper.pdf'), 'file')
check('an image shows as a thumbnail', attachmentKind('shot.png'), 'image')
// A refused file is still drawn, so that it can say why it was refused -- and
// the browser cannot preview it, so it is a chip like any other non-image.
check('anything unpreviewable is a chip', attachmentKind('evil.sh'), 'file')
check('  including a file with no extension', attachmentKind('README'), 'file')
check('the chip is labelled by extension', attachmentLabel('paper.pdf'), 'PDF')
check('  and falls back when there is none', attachmentLabel('README'), 'FILE')

// ---------------------------------------------------------------------------
console.log('\n== the stored filename ==')

// Frozen clock and counter, so the unique prefix does not make these untestable.
const fixed = { now: () => Date.parse('2026-09-20T01:02:03.004Z'), random: () => 0.123456789 }
const STAMP = '2026-09-20T01-02-03-004-4fzzzz'
const named = (n) => safeUploadName(n, fixed)

check('the prefix is a timestamp and a suffix', named('shot.png').startsWith('2026-09-20T01-02-03-004-'), true)
check('the original name survives', named('shot.png').endsWith('-shot.png'), true)
check('spaces become hyphens', named('my shot.png').endsWith('-my-shot.png'), true)
check('the extension is kept', path.extname(named('paper.pdf')), '.pdf')

// Every one of these is a string the browser can send. None may produce a name
// with a separator in it, because the name is joined onto a directory.
const hostile = [
  '../../../etc/passwd.png',
  '..\\..\\windows\\system32\\a.png',
  '/etc/shadow.png',
  'C:\\Windows\\evil.png',
  'a/b/c.png',
  '....//....//x.png',
  '.png',
  '..png',
  '\u0000null.png',
  'con.png',
  '   .leading.png',
]

for (const name of hostile) {
  const out = named(name)
  const clean = !/[\\/]/.test(out) && !out.includes('..') && !out.startsWith('.')
  check(`  ${JSON.stringify(name)} sanitises to a bare name`, clean, true)
}

check('a nameless file still gets one', named('.png').endsWith('-file.png'), true)
check('a very long stem is bounded', named(`${'x'.repeat(400)}.png`).length < 120, true)

// Two files of the same name in one session must not overwrite each other.
const first = safeUploadName('shot.png')
const second = safeUploadName('shot.png')
check('two uploads of one name differ', first !== second, true)

// ---------------------------------------------------------------------------
console.log('\n== where it is allowed to land ==')

const target = resolveUploadTarget('claude-test', 'my shot.png', fs)
check('lands in .uploads/ inside the working directory',
  path.relative(PROJECT_ROOT, target.dir).split(path.sep).join('/'),
  `claude-test/${UPLOAD_DIR_NAME}`)
check('the prompt path is relative to the working directory',
  target.relPath.startsWith(`${UPLOAD_DIR_NAME}/`), true)
check('the prompt path names the stored file',
  target.relPath, `${UPLOAD_DIR_NAME}/${path.basename(target.abs)}`)
check('the file is inside the directory it reports',
  path.dirname(target.abs), target.dir)

// A traversing name is neutralised rather than refused -- it is a filename, and
// what matters is that it cannot leave `.uploads/`.
const traversed = resolveUploadTarget('claude-test', '../../../evil.png', fs)
check('a traversing name stays in .uploads/',
  path.dirname(traversed.abs), target.dir)
check('  and its reported path does too',
  traversed.relPath.startsWith(`${UPLOAD_DIR_NAME}/`), true)

check('a disallowed extension is refused',
  rejection(() => resolveUploadTarget('claude-test', 'evil.sh', fs)), 400)
check('an empty name is refused',
  rejection(() => resolveUploadTarget('claude-test', '   ', fs)), 400)
check('a missing name is refused',
  rejection(() => resolveUploadTarget('claude-test', undefined, fs)), 400)

// The working directory goes through the same gate a run does, so an upload
// can no more escape the project tree, or reach a denylisted directory, than a
// run can.
check('a working directory outside the project is refused',
  rejection(() => resolveUploadTarget('../../../tmp', 'a.png', fs)), 400)
check('a denylisted working directory is refused',
  rejection(() => resolveUploadTarget('sessions', 'a.png', fs)), 400)
check('  node_modules too',
  rejection(() => resolveUploadTarget('node_modules', 'a.png', fs)), 400)
check('a working directory that does not exist is refused',
  rejection(() => resolveUploadTarget('no-such-dir-xyz', 'a.png', fs)), 400)

// ---------------------------------------------------------------------------
console.log('\n== what the prompt says ==')

const PREAMBLE = (p) =>
  `There is an attached file at ${p} — read it with the Read tool before proceeding with the rest of this request.`

check('the preamble names the path and the tool',
  attachmentPreamble('.uploads/a.png'), PREAMBLE('.uploads/a.png'))

check('no attachments leaves the prompt alone',
  composePrompt('summarise the repo', []), 'summarise the repo')
check('  and the same with no list at all',
  composePrompt('summarise the repo'), 'summarise the repo')
check('  whitespace is trimmed either way',
  composePrompt('  padded  ', []), 'padded')

check('one attachment is announced before the text',
  composePrompt('what is in it?', [{ path: '.uploads/a.png' }]),
  `${PREAMBLE('.uploads/a.png')}\n\nwhat is in it?`)

check('several are announced one per line',
  composePrompt('compare them', [{ path: '.uploads/a.png' }, { path: '.uploads/b.pdf' }]),
  `${PREAMBLE('.uploads/a.png')}\n${PREAMBLE('.uploads/b.pdf')}\n\ncompare them`)

check('an attachment with no text is still a prompt',
  composePrompt('', [{ path: '.uploads/a.png' }]), PREAMBLE('.uploads/a.png'))

// An attachment still uploading has no path yet, and must not put a hole in
// the prompt.
check('attachments without a path are left out',
  composePrompt('go', [{ path: null }, { path: '.uploads/b.png' }]),
  `${PREAMBLE('.uploads/b.png')}\n\ngo`)
check('  and if none has one, the text goes out unchanged',
  composePrompt('go', [{ path: null }]), 'go')

console.log(failures === 0 ? '\nAll upload checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
