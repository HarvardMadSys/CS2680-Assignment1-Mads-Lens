/**
 * The composer's "Continue from" picker, driven in a DOM against a faked
 * server: what each run is actually sent to resume, and from where.
 *
 * '' in the picker means "Start a new conversation". It used to stand for
 * "nothing chosen yet" as well, so the refresh after every run swapped a fresh
 * start for the newest session, and New conversation kept whatever the picker
 * held: a run the page called new went out with --resume. None of that shows
 * in static markup, so this mounts the real App in jsdom, answers its requests
 * from memory and plays each run's frames through a fake EventSource.
 *
 * Run with: node scripts/check-composer.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { JSDOM } from 'jsdom'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.ssrtmp', 'composer')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== '' ? `  [${extra}]` : ''}`)
}

// build() leaves NODE_ENV set to production for the rest of the process, and
// act() only exists in React's development build, so the old value goes back.
const nodeEnv = process.env.NODE_ENV
await build({
  configFile: path.join(root, 'vite.config.js'),
  logLevel: 'error',
  build: { ssr: 'src/App.jsx', outDir, emptyOutDir: true },
})
if (nodeEnv === undefined) delete process.env.NODE_ENV
else process.env.NODE_ENV = nodeEnv

// A DOM must exist before React DOM and the bundle are imported: both look for
// one at module load.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// the server, faked

const NEWEST = '22222222-2222-4222-8222-222222222222'
const OLDER = '11111111-1111-4111-8111-111111111111'
const BAD_DIR = 'no-such-dir'

// Newest first, as /api/sessions answers. In different directories, so a
// resume that did not bring its own along would show.
const sessions = [
  { sessionId: NEWEST, lastActivityTimestamp: '2026-09-20T10:00:00.000Z', cwd: 'runs/other' },
  { sessionId: OLDER, lastActivityTimestamp: '2026-09-19T10:00:00.000Z', cwd: 'claude-test' },
]
const sent = [] // the body of every run request
const streams = [] // one per run the server accepted
let listings = 0 // how many times the session list was asked for
let listingHeld = null // while set, the session list waits for it to settle

const reply = (status, body) => ({
  ok: status < 400,
  status,
  statusText: '',
  json: async () => body,
})

globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/trajectories') return reply(200, { trajectories: [] })

  if (url === '/api/sessions') {
    listings += 1
    await listingHeld
    return reply(200, { sessions: structuredClone(sessions) })
  }

  if (url === '/api/runs' && options.method === 'POST') {
    const body = JSON.parse(options.body)
    sent.push(body)
    if (body.cwd === BAD_DIR) {
      return reply(400, { error: `Working directory does not exist: ${BAD_DIR}` })
    }
    const runId = `run-${sent.length}`
    return reply(200, { runId, cwd: body.cwd, jsonlPath: `sessions/runs/${runId}.jsonl` })
  }

  throw new Error(`unexpected request: ${options.method ?? 'GET'} ${url}`)
}

globalThis.EventSource = class {
  constructor() {
    this.endListeners = []
    streams.push(this)
  }
  addEventListener(type, listener) {
    if (type === 'end') this.endListeners.push(listener)
  }
  close() {}
}

// ---------------------------------------------------------------------------
// the page

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: App } = await import(pathToFileURL(path.join(outDir, 'App.js')).href)

const PANEL = '.composer .panel:first-child'
const picker = () => document.querySelector(`${PANEL} select`)
const heading = () => document.querySelector(`${PANEL} h2`).textContent
const cwdField = () => document.querySelector(`${PANEL} input`)
const lastRun = () => [...document.querySelectorAll('.run')].at(-1)
const button = (label) =>
  [...document.querySelectorAll('.composer-actions button')].find((b) => b.textContent === label)

// React ignores an input event whose value matches what it last rendered, and
// it learns about writes to `value` on the element itself -- so the new value
// goes in through the prototype's setter, the way typing puts it there.
async function type(field, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function pick(value) {
  await act(async () => {
    picker().value = value
    picker().dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

/** Type a prompt and press Run. Returns the request it sent, or null. */
async function run(prompt) {
  const before = sent.length
  await type(document.querySelector(`${PANEL} textarea`), prompt)
  await act(async () => button('Run').click())
  return sent.length > before ? sent.at(-1) : null
}

/**
 * Play the newest run to a clean finish under `sessionId`. The server lists
 * the session before the result lands, as it does for a real recording, so the
 * refresh that follows the run sees it as the newest.
 */
async function finish(sessionId, cwd) {
  if (!sessions.some((s) => s.sessionId === sessionId)) {
    sessions.unshift({ sessionId, lastActivityTimestamp: new Date().toISOString(), cwd })
  }

  const stream = streams.at(-1)
  const frames = [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId },
    { type: '_exit', code: 0 },
  ]
  await act(async () => {
    for (const frame of frames) stream.onmessage({ data: JSON.stringify(frame) })
    for (const listener of stream.endListeners) listener()
  })
}

const newConversation = () => act(async () => button('New conversation').click())

const reactRoot = createRoot(document.getElementById('root'))
await act(async () => reactRoot.render(createElement(App)))

// ---------------------------------------------------------------------------
console.log('\n== the default is the newest session, resumed from its own directory ==')

check('the newest session is preselected', picker()?.value === NEWEST, picker()?.value)
check('its working directory comes with it', cwdField().value === 'runs/other', cwdField().value)

let request = await run('carry on')
check(
  'the first run resumes it from there',
  request?.resumeSessionId === NEWEST && request?.cwd === 'runs/other',
  JSON.stringify(request)
)
await finish(NEWEST, 'runs/other')

// ---------------------------------------------------------------------------
console.log('\n== New conversation starts a new one ==')

await newConversation()
check('the picker is back on "Start a new conversation"', picker()?.value === '', picker()?.value)
check('and the panel says so', heading() === 'New conversation', heading())

request = await run('something new')
check(
  'Run asks for no session to resume',
  request !== null && request.resumeSessionId === null,
  JSON.stringify(request)
)
await finish('33333333-3333-4333-8333-333333333333', request?.cwd)

// ---------------------------------------------------------------------------
console.log('\n== choosing to start fresh survives the refresh after a run ==')

await newConversation()
await pick('')
await type(cwdField(), BAD_DIR)
let listed = listings
request = await run('refused before Claude Code starts')
check(
  'the run was refused',
  Boolean(lastRun()?.classList.contains('run-failed')),
  lastRun()?.className
)
check('and the session list was refreshed after it', listings === listed + 1, listings - listed)
check('"Start a new conversation" is still chosen', picker()?.value === '', picker()?.value)
check('and the panel still says so', heading() === 'New conversation', heading())

await type(cwdField(), 'claude-test')
request = await run('try again')
check(
  'the retry asks for no session to resume',
  request !== null && request.resumeSessionId === null,
  JSON.stringify(request)
)
await finish('44444444-4444-4444-8444-444444444444', 'claude-test')

// ---------------------------------------------------------------------------
console.log('\n== a picked session stays picked, and brings its directory ==')

await newConversation()
await pick(OLDER)
check(
  'picking a session brings its working directory',
  cwdField().value === 'claude-test',
  cwdField().value
)
check(
  'and the panel says it will be followed up',
  heading() === 'Follow up in the selected session',
  heading()
)

await type(cwdField(), BAD_DIR)
listed = listings
await run('refused again')
check(
  'the session list was refreshed after the refused run',
  listings === listed + 1,
  listings - listed
)
check('the refresh left the picked session in place', picker()?.value === OLDER, picker()?.value)

await type(cwdField(), 'claude-test')
request = await run('continue the older one')
check(
  'Run resumes the picked session from its directory',
  request?.resumeSessionId === OLDER && request?.cwd === 'claude-test',
  JSON.stringify(request)
)

// ---------------------------------------------------------------------------
console.log('\n== a default that arrives after the first run has gone out is dropped ==')

await act(async () => reactRoot.unmount())

// The newest session is in another directory, so a default that did land would
// show in the working directory.
sessions.unshift({
  sessionId: '55555555-5555-4555-8555-555555555555',
  lastActivityTimestamp: new Date().toISOString(),
  cwd: 'runs/other',
})
let releaseListing
listingHeld = new Promise((resolve) => (releaseListing = resolve))

const slowRoot = createRoot(document.getElementById('root'))
await act(async () => slowRoot.render(createElement(App)))

request = await run('straight away')
check(
  'a run sent before the list arrives starts fresh, where the field said',
  request !== null && request.resumeSessionId === null && request.cwd === 'claude-test',
  JSON.stringify(request)
)

await act(async () => releaseListing())
check(
  'the late list still fills the picker',
  picker()?.options.length === sessions.length + 1,
  picker()?.options.length
)
check(
  'but leaves the working directory alone',
  cwdField().value === 'claude-test',
  cwdField().value
)
check('and does not choose a session', picker()?.value === '', picker()?.value)

await act(async () => slowRoot.unmount())
dom.window.close()
fs.rmSync(outDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nAll composer checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
