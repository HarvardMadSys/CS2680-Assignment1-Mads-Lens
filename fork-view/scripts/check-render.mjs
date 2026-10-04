/**
 * Renders the trajectory components against real recorded data and checks the
 * resulting HTML. Uses jsdom so Markdown rendering and DOMPurify sanitisation
 * take exactly the same path they do in the browser.
 *
 * Run with: node scripts/check-render.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.ssrtmp')
const probeSrc = path.join(root, 'frontend', 'src', '__probe.jsx')

let failures = 0
const check = (name, ok) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

fs.writeFileSync(
  probeSrc,
  `import { renderToStaticMarkup } from 'react-dom/server'
import { initialState, reduce } from '@shared/parse.js'
import Run from './Run.jsx'
import App from './App.jsx'
import { conversationReducer, initialConversation } from '@shared/conversation.js'

export function renderTrajectory(frames, showRaw = false, expandAll = false) {
  let c = initialConversation('replay')
  c = conversationReducer(c, { type: 'conversation/startRun', key: 'k', mode: 'replay', prompt: 'p', cwd: 'claude-test' })
  for (const f of frames) c = conversationReducer(c, { type: 'conversation/event', key: 'k', event: f })
  c = conversationReducer(c, { type: 'conversation/event', key: 'k', event: { type: '_replay_end' } })
  const html = renderToStaticMarkup(<Run run={c.runs[0]} showRaw={showRaw} expandAll={expandAll} />)
  return { html, state: c.runs[0].trajectory }
}

export function renderApp() {
  return renderToStaticMarkup(<App />)
}

export function renderConversation(runSpecs) {
  let c = initialConversation('live')
  runSpecs.forEach((spec, i) => {
    const key = 'k' + i
    c = conversationReducer(c, {
      type: 'conversation/startRun', key, mode: 'live',
      prompt: spec.prompt, cwd: 'claude-test', resumeSessionId: spec.resumeSessionId ?? null,
    })
    for (const ev of spec.frames) {
      c = conversationReducer(c, { type: 'conversation/event', key, event: ev })
    }
  })
  const html = renderToStaticMarkup(
    <>{c.runs.map((r) => <Run key={r.key} run={r} showRaw={false} />)}</>
  )
  return { html, conversation: c }
}
`,
  'utf8'
)

try {
  await build({
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'error',
    build: { ssr: 'src/__probe.jsx', outDir, emptyOutDir: true },
  })
} finally {
  fs.rmSync(probeSrc, { force: true })
}

// A DOM must exist before the bundle is imported: DOMPurify binds to `window`
// at module load.
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const probe = await import(new URL('../.ssrtmp/__probe.js', import.meta.url))

function load(p) {
  const raw = fs.readFileSync(p)
  let txt
  if (raw[0] === 0xff && raw[1] === 0xfe) txt = raw.toString('utf16le').slice(1)
  else {
    txt = raw.toString('utf8')
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1)
  }
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

const toolUse = (id, name, input) => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id, content, extra = {}) => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
})

// ---------------------------------------------------------------------------
console.log('\n== real recorded trajectory (claude-test/events.jsonl) ==')

const sample = load(path.join(root, 'claude-test/events.jsonl'))
const { html, state } = probe.renderTrajectory(sample)
// The same trajectory with every tool row forced open, so the detail that is
// deliberately folded away by default can still be asserted on.
const opened = probe.renderTrajectory(sample, false, true).html
console.log(`  ${state.nodes.length} nodes -> ${html.length} chars of HTML`)

check('four tool calls', (html.match(/class="node tool/g) ?? []).length === 4)
check('all four completed', (html.match(/tool-completed/g) ?? []).length === 4)
check('tool name shown', html.includes('>Bash<'))
check('assistant text as markdown paragraph', html.includes('<div class="markdown"><p>'))
check('markdown code fence rendered', opened.includes('<pre><code'))
check('inline code rendered', html.includes('<code>'))
check('final result card', html.includes('final result'))
check('thinking marker present', html.includes('node thinking'))
check('duration displayed', /tool-duration">\d/.test(html))
check('raw hidden when toggle off', !html.includes('raw event'))
check('raw shown when toggle on', probe.renderTrajectory(sample, true).html.includes('raw event'))

// ---------------------------------------------------------------------------
console.log('\n== tool calls read as compact rows by default ==')

const rowDoc = new JSDOM(`<body>${html}</body>`).window.document.body

check('no tool detail rendered by default', rowDoc.querySelectorAll('.tool-body').length === 0)
check('no input block by default', !html.includes('block-input'))
check('no output block by default', !html.includes('>stdout<'))
check('every tool call is still a row', rowDoc.querySelectorAll('.tool-head').length === 4)
check('each row shows a status glyph', rowDoc.querySelectorAll('.tool-head .glyph').length === 4)
check('each row carries a derived one-line target',
  rowDoc.querySelectorAll('.tool-target').length === 4)
check('the derived target is not empty',
  [...rowDoc.querySelectorAll('.tool-target')].every((el) => el.textContent.trim().length > 0))
check('each row reports its outcome while folded',
  rowDoc.querySelectorAll('.tool-peek').length === 4)

// Everything folded away is reachable, unchanged, one click later.
const openDoc = new JSDOM(`<body>${opened}</body>`).window.document.body
check('expanding reveals every tool body', openDoc.querySelectorAll('.tool-body').length === 4)
check('expanded: command rendered as input block', opened.includes('block-input'))
check('expanded: stdout labelled', opened.includes('>stdout<'))
// Every output in this trajectory is under the truncation threshold (max 9
// lines), so nothing should be collapsed here. The expand control is covered
// by the dedicated long-output section below.
check('expanded: short output not truncated', !opened.includes('Show all ('))

// ---------------------------------------------------------------------------
console.log('\n== sanitisation (tool output is untrusted) ==')

const nasty = probe.renderTrajectory([
  toolUse('x', 'Bash', { command: 'echo hi' }),
  toolResult('x', '<script>alert(1)</script><img src=x onerror=alert(2)>'),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done <script>alert(3)</script>\n\n<img src=x onerror=alert(4)>',
  },
], false, true).html

// Parse the output as a real document: `onerror` appearing as escaped text
// inside a <pre> is harmless, a live attribute on an element is not.
const parsed = new JSDOM(`<body>${nasty}</body>`).window.document.body
const elements = [...parsed.querySelectorAll('*')]

check('no script element', parsed.querySelectorAll('script').length === 0)
// <img> is allowed through (assistant prose may legitimately contain one);
// what matters is that DOMPurify stripped its event handler.
check(
  'img kept but defanged',
  [...parsed.querySelectorAll('img')].every((el) => !el.hasAttribute('onerror'))
)
check(
  'no event-handler attribute on any element',
  elements.every((el) => [...el.attributes].every((a) => !a.name.startsWith('on')))
)
check('tool output escaped as literal text', nasty.includes('&lt;script&gt;'))
check('markdown result still rendered', nasty.includes('Done'))

// ---------------------------------------------------------------------------
console.log('\n== long output ==')

const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
const longFrames = [
  toolUse('y', 'Bash', { command: 'seq 500' }),
  { ...toolResult('y', many), tool_use_result: { stdout: many, stderr: '' } },
]
const long = probe.renderTrajectory(longFrames, false, true).html

// Folded by default -- and the row still says what came back.
const longRow = new JSDOM(`<body>${probe.renderTrajectory(longFrames).html}</body>`).window
  .document.body
check('long output is not rendered at all by default',
  longRow.querySelectorAll('.block-body').length === 0)
check('folded row still reports the output size',
  longRow.querySelector('.tool-peek')?.textContent.includes('+499 lines') === true,
)

// Scope to the rendered output block: the run's raw event log deliberately
// contains every frame in full, so a whole-document search would always match.
const longBody = [...new JSDOM(`<body>${long}</body>`).window.document.querySelectorAll('.block-body')]
  .map((el) => el.textContent)
  .join('\n')

check('preview shows early lines', longBody.includes('line 11'))
check('preview stops at 12 lines', !longBody.includes('line 400'))
check('expand control reports hidden lines', long.includes('488 more lines'))

// ---------------------------------------------------------------------------
console.log('\n== edge-case rendering ==')

const pendingFrames = [toolUse('p', 'Bash', { command: 'sleep' })]
const pending = probe.renderTrajectory(pendingFrames).html
check('unfinished tool is not left running', !pending.includes('tool-running'))
check('unfinished tool marked incomplete', pending.includes('tool-incomplete'))
check('folded row flags the missing result', pending.includes('>no result<'))
check('incomplete explained to the user',
  probe.renderTrajectory(pendingFrames, false, true).html.includes('no result arrived'))

// A cancelled run. The call it was interrupted at is still `incomplete` -- no
// result did arrive -- but it draws the stop mark rather than the generic "no
// result" ring, and everything that finished before it keeps its own outcome.
{
  const stopped = probe.renderTrajectory([
    toolUse('a', 'Read', { file_path: 'main.py' }),
    toolResult('a', 'contents'),
    toolUse('b', 'Bash', { command: 'sleep 999' }),
    { type: '_stopping' },
    { type: '_stopped' },
    { type: '_exit', code: null, signal: 'SIGTERM' },
  ]).html
  const doc = new JSDOM(`<body>${stopped}</body>`).window.document

  check('stopped run is classed stopped', stopped.includes('run-stopped'))
  check('stopped run shows a stop notice', stopped.includes('notice-stopped'))
  check('stopped run invents no result block', !doc.querySelector('.node.result'))

  const rows = [...doc.querySelectorAll('.node.tool')]
  check('stopped run kept both calls', rows.length === 2)
  check('the finished call is still completed', rows[0].classList.contains('tool-completed'))
  check(
    'the finished call still draws a tick',
    Boolean(rows[0].querySelector('.glyph .status-completed'))
  )
  check('the interrupted call is incomplete', rows[1].classList.contains('tool-incomplete'))
  check(
    'the interrupted call draws the stop mark',
    Boolean(rows[1].querySelector('.glyph .status-stopped'))
  )

  // The same row in a run that merely ended without a result keeps the ring:
  // the mark distinguishes "cancelled" from "never reported".
  const abandoned = probe.renderTrajectory([
    toolUse('b', 'Bash', { command: 'sleep 999' }),
    { type: '_exit', code: 1 },
  ]).html
  const adoc = new JSDOM(`<body>${abandoned}</body>`).window.document
  check('a crashed run is still failed', abandoned.includes('run-failed'))
  check(
    'its pending call keeps the no-result ring',
    Boolean(adoc.querySelector('.glyph .status-incomplete')) &&
      !adoc.querySelector('.glyph .status-stopped')
  )
}

const orphan = probe.renderTrajectory([toolResult('ghost', 'stray output')]).html
check('orphan result renders', orphan.includes('unmatched tool result'))
check('orphan keeps its id', orphan.includes('ghost'))

const errored = probe.renderTrajectory([
  toolUse('e', 'Bash', { command: 'false' }),
  toolResult('e', 'command failed', { is_error: true }),
]).html
check('errored tool styled as error', errored.includes('tool-error'))

const unknown = probe.renderTrajectory([{ type: 'brand_new_event_type', session_id: 's' }]).html
check('unknown event renders instead of crashing', unknown.includes('unhandled event type'))
check('unknown event always shows raw', unknown.includes('raw event'))

const empty = probe.renderTrajectory([
  toolUse('n', 'Bash', { command: 'true' }),
  { ...toolResult('n', ''), tool_use_result: { stdout: '', stderr: '' } },
], false, true).html
check('empty output labelled', empty.includes('(no output)'))

// ---------------------------------------------------------------------------
console.log('\n== multi-run conversation ==')

const SID1 = '11111111-1111-4111-8111-111111111111'
const SID2 = '22222222-2222-4222-8222-222222222222'

const initFrame = (sid) => ({
  type: 'system',
  subtype: 'init',
  session_id: sid,
  model: 'claude-opus-5',
})
const resultFrame = (sid, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done.',
  session_id: sid,
  total_cost_usd: 0.0825,
  duration_ms: 9123,
  num_turns: 2,
  ...extra,
})

const convo = probe.renderConversation([
  {
    prompt: 'Add a --help flag',
    frames: [
      initFrame(SID1),
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1', 'main.py'),
      resultFrame(SID1),
    ],
  },
  {
    prompt: 'Now add a --version flag',
    resumeSessionId: SID1,
    frames: [initFrame(SID1), toolUse('t2', 'Bash', { command: 'cat main.py' })],
  },
])

check('both runs rendered', (convo.html.match(/class="run run-/g) ?? []).length === 2)
check('run numbers shown', convo.html.includes('Run 1') && convo.html.includes('Run 2'))
check(
  'both prompts shown',
  convo.html.includes('Add a --help flag') && convo.html.includes('Now add a --version flag')
)
check(
  'run 1 completed while run 2 runs',
  convo.html.includes('run-completed') && convo.html.includes('run-running')
)
check(
  'run 1 trajectory survives above run 2',
  convo.html.indexOf('main.py') < convo.html.indexOf('Now add a --version flag')
)
check('first run labelled new session', convo.html.includes('new session'))
check('second run labelled resumed', convo.html.includes('resumed 11111111'))
check('cost rendered', convo.html.includes('$0.0825'))
check('duration rendered as wall clock', convo.html.includes('9.1 s'))
check('turns rendered', convo.html.includes('>turns<'))
check(
  'unfinished run shows no metrics block',
  (convo.html.match(/class="metrics"/g) ?? []).length === 1
)

const failed = probe.renderConversation([
  { prompt: 'bad', frames: [{ type: '_error', message: 'Working directory does not exist' }] },
])
check('failed run styled as failed', failed.html.includes('run-failed'))
check('failed run reports metrics unavailable', failed.html.includes('metrics unavailable'))
check('failed run invents no numbers', !/\$\d/.test(failed.html))

const changed = probe.renderConversation([
  { prompt: 'a', resumeSessionId: SID1, frames: [initFrame(SID2), resultFrame(SID2)] },
])
check('session id change surfaced', changed.html.includes('session id changed to 22222222'))

// ---------------------------------------------------------------------------
console.log('\n== subagent branches and outline (verified fixture) ==')

const sub = probe.renderTrajectory(load(path.join(root, 'fixtures/subagent-forward.jsonl')))
const subDoc = new JSDOM(`<body>${sub.html}</body>`).window.document.body

const agentId = sub.state.nodes.find((n) => n.kind === 'tool' && n.name === 'Agent').toolUseId
const readId = sub.state.nodes.find((n) => n.kind === 'tool' && n.name === 'Read').toolUseId

check('spawning card marked as a subagent host', sub.html.includes('tool-spawner'))
check('subagent badge on the parent tool', sub.html.includes('branch-badge'))
check('branch section rendered', sub.html.includes('subagent trajectory'))
check('branch names the agent type', sub.html.includes('Explore'))
check('branch reports its size', /\d+ steps?/.test(sub.html))
check('branch is collapsible', subDoc.querySelectorAll('.branch-head').length === 1)
check('short branch is expanded by default', subDoc.querySelectorAll('.branch-body').length === 1)

// Nesting is real DOM containment, not just indentation.
const agentCard = subDoc.querySelector(`#tool-k-${agentId}`)
const readCard = subDoc.querySelector(`#tool-k-${readId}`)
check('spawning card has a stable dom id', Boolean(agentCard))
check('nested card has a stable dom id', Boolean(readCard))
check('nested tool is inside the spawning card', agentCard?.contains(readCard) === true)
check('nested tool is inside the branch', Boolean(readCard?.closest('.branch')))
check('subagent task prompt labelled', sub.html.includes('subagent task'))
check('agent summary rendered', sub.html.includes('agent-summary'))

const outlineItems = [...subDoc.querySelectorAll('.outline .outline-item')]
check('outline rendered', outlineItems.length === 2)
// The token's whole text is the tool's name -- not a name plus a step number
// plus a glyph -- so `textContent` is the assertion rather than a lookup for
// the one span among several that happens to hold the name.
check(
  'outline shows tool names only',
  outlineItems.map((el) => el.textContent).join(',') === 'Agent,Read'
)
check(
  'outline nests the subagent tool',
  Boolean(subDoc.querySelector('.outline-list .outline-list'))
)
check(
  'outline carries no prose or result text',
  !subDoc.querySelector('.outline').textContent.includes('argparse')
)

// Every outline entry must target a DOM id that actually exists.
const outlineTargets = [agentId, readId].map((id) => `tool-k-${id}`)
check(
  'outline targets resolve to rendered tool cards',
  outlineTargets.every((domId) => Boolean(subDoc.querySelector(`[id="${domId}"]`)))
)
check('dom ids are derived from tool-use ids', outlineTargets.every((d) => d.includes('toolu_')))

// A large branch must default to collapsed.
const bigFrames = [
  { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'BIG', name: 'Agent', input: { subagent_type: 'Explore' } }] } },
  ...Array.from({ length: 10 }, (_, i) => ({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    parent_tool_use_id: 'BIG',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `n${i}`, name: 'Read', input: { file_path: `/f${i}` } }] },
  })),
]
const bigDoc = new JSDOM(`<body>${probe.renderTrajectory(bigFrames).html}</body>`).window.document.body
check('large branch starts collapsed', bigDoc.querySelectorAll('.branch-body').length === 0)
check('collapsed branch still shows its header', bigDoc.querySelectorAll('.branch-head').length === 1)
check('collapsed branch hides nested cards', !bigDoc.querySelector('[id^="tool-k-n"]'))
check('outline still lists the hidden nested tools',
  bigDoc.querySelectorAll('.outline .outline-item').length === 11)

// Orphaned parent.
const orphanDoc = probe.renderTrajectory([
  { type: 'assistant', parent_tool_use_id: 'GHOST', message: { role: 'assistant', content: [{ type: 'text', text: 'stranded' }] } },
]).html
check('orphaned node still rendered', orphanDoc.includes('stranded'))
check('orphaned node explains itself', orphanDoc.includes('detached from missing parent'))

// ---------------------------------------------------------------------------
console.log('\n== parallel subagents fan out instead of stacking ==')

// Two Task calls emitted in ONE assistant message: concurrent, not sequential.
// A column would put a number on each and imply an order the run never had, so
// the outline lays them side by side under a shared crossbar instead.
const par = probe.renderTrajectory(load(path.join(root, 'fixtures/parallel-tasks.jsonl')))
const parDoc = new JSDOM(`<body>${par.html}</body>`).window.document.body

const taskIds = par.state.nodes
  .filter((n) => n.kind === 'tool' && n.name === 'Task')
  .map((n) => n.toolUseId)
check('fixture really has two parallel Task calls', taskIds.length === 2)

const fork = parDoc.querySelector('.outline .outline-fork')
check('the two subagents are laid out as a fork', Boolean(fork))
check(
  'the fork holds exactly the two branches',
  fork?.querySelectorAll(':scope > .outline-branch').length === 2
)
check(
  'both fork branches are the Task calls',
  [...(fork?.querySelectorAll(':scope > .outline-branch > .outline-node > .outline-item') ?? [])]
    .map((el) => el.textContent)
    .join(',') === 'Task,Task'
)

// The fan-out is one slot in the column: the level above is otherwise untouched.
const parRoot = parDoc.querySelector('.outline .outline-root')
check(
  'the fork occupies a single slot in the parent column',
  parRoot?.querySelectorAll(':scope > li').length === 1
)
check('that slot is the fork slot', parRoot?.querySelector(':scope > li')?.classList.contains('outline-fork-slot') === true)

// Each branch keeps its own subtree -- a fan-out must not merge the columns.
const [branchA, branchB] = fork ? [...fork.querySelectorAll(':scope > .outline-branch')] : []
const namesIn = (el) =>
  [...el.querySelectorAll(':scope > .outline-list .outline-item')].map((n) => n.textContent).join(',')
check('first branch keeps its own children', namesIn(branchA) === 'Read,Grep')
check('second branch keeps its own children', namesIn(branchB) === 'Grep,Read')
check(
  'the branches do not share a subtree',
  !branchA.contains(branchB) && !branchB.contains(branchA)
)

// Every call still reaches its card, fan-out or not.
check(
  'every outline pill still targets a rendered tool card',
  [...parDoc.querySelectorAll('.outline .outline-item')].length === 6
)
check(
  'both Task cards rendered',
  taskIds.every((id) => Boolean(parDoc.querySelector(`[id="tool-k-${id}"]`)))
)

// Pills carry the tool's *kind*, and the connectors are drawn, never typed.
check('pills are classed by tool kind', parDoc.querySelectorAll('.outline-kind-task').length === 2)
check('read and grep pills differ in kind',
  parDoc.querySelectorAll('.outline-kind-read').length === 2 &&
  parDoc.querySelectorAll('.outline-kind-grep').length === 2)
check(
  'connectors are CSS, not box-drawing characters',
  !/[\u2500-\u257f\u2514\u251c\u2502]/.test(parDoc.querySelector('.outline').textContent)
)
check(
  'a fan-out still reads as bare tool names',
  [...parDoc.querySelectorAll('.outline-item')].every((el) => /^\w+$/.test(el.textContent))
)

// A single subagent has nothing to sit beside: it stays in the column.
check('one subagent alone does not fan out', !sub.html.includes('outline-fork'))

// A fan-out can itself be nested: a subagent that spawns two more. The fork
// slot then sits in a list that already draws a guide and elbows, so the two
// connector systems have to compose rather than double up.
const deep = probe.renderTrajectory([
  { type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'OUTER', name: 'Agent', input: { subagent_type: 'Explore' } }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', parent_tool_use_id: 'OUTER',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'IN0', name: 'Read', input: { file_path: '/a.js' } }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', parent_tool_use_id: 'OUTER',
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'IN1', name: 'Task', input: { subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'IN2', name: 'Task', input: { subagent_type: 'Explore' } },
    ] } },
  { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', parent_tool_use_id: 'IN1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'L1', name: 'Bash', input: { command: 'ls' } }] } },
]).html
const deepDoc = new JSDOM(`<body>${deep}</body>`).window.document.body
const deepFork = deepDoc.querySelector('.outline-fork')

check('a nested fan-out is rendered', Boolean(deepFork))
check('the nested fork sits inside the outer subagent\'s list',
  Boolean(deepFork?.closest('.outline-list .outline-list')))
check('the sequential sibling is not swept into the fan-out',
  deepFork?.querySelectorAll(':scope > .outline-branch').length === 2)
check('the sequential sibling stays in the column',
  deepDoc.querySelector('.outline-root > .outline-branch > .outline-list')
    ?.querySelectorAll(':scope > li').length === 2)
check('the fan-out still nests its own children',
  Boolean(deepFork?.querySelector('.outline-list .outline-item')))

// ---------------------------------------------------------------------------
console.log('\n== tool_progress never turns an ordinary tool into a spawner ==')

// Progress frames carry the RUNNING TOOL's id in parent_tool_use_id. Rendered
// as nodes they became children of that call, and any call with children drew a
// subagent trajectory -- so a plain Bash run grew a branch it never had.
const progressFrames = [
  toolUse('B', 'Bash', { command: 'npm run build' }),
  { type: 'tool_progress', parent_tool_use_id: 'B', tool_use_id: 'B', progress: { elapsed_ms: 1200 } },
  { type: 'system', subtype: 'tool_progress', parent_tool_use_id: 'B' },
  toolResult('B', 'built'),
  toolUse('A', 'Agent', { subagent_type: 'Explore', description: 'sub' }),
  { type: 'tool_progress', parent_tool_use_id: 'A', tool_use_id: 'A' },
  { type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', parent_tool_use_id: 'A',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'R', name: 'Read', input: { file_path: '/m.py' } }] } },
  { type: 'user', timestamp: '2026-01-01T00:00:04.000Z', parent_tool_use_id: 'A',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'R', content: 'ok' }] } },
  toolResult('A', 'agent done'),
]
const progressDoc = new JSDOM(`<body>${probe.renderTrajectory(progressFrames).html}</body>`).window
  .document.body
const bashRow = [...progressDoc.querySelectorAll('.node.tool')].find(
  (el) => el.querySelector('.tool-name')?.textContent === 'Bash'
)

check('no "unhandled event type" notice', !progressDoc.textContent.includes('unhandled event type'))
check('Bash row rendered', Boolean(bashRow))
check('Bash owns no subagent trajectory', !bashRow?.querySelector('.branch'))
check('Bash carries no subagent badge', !bashRow?.querySelector('.branch-badge'))
check('Bash is not styled as a spawner', !bashRow?.className.includes('tool-spawner'))
check('the Agent call in the same run still branches', progressDoc.querySelectorAll('.branch').length === 1)
check(
  'the surviving branch belongs to the Agent call',
  Boolean(progressDoc.querySelector('#tool-k-R')?.closest('.branch'))
)

// ---------------------------------------------------------------------------
console.log('\n== regression: no subagents means no tree chrome ==')

const flat = probe.renderTrajectory(load(path.join(root, 'claude-test/events.jsonl'))).html
check('no branch sections', !flat.includes('subagent trajectory'))
check('no subagent badges', !flat.includes('branch-badge'))
check('no spawner styling', !flat.includes('tool-spawner'))
check('no nested outline lists', !/outline-list[\s\S]{0,240}outline-list/.test(flat))
// The whole point of the fan-out is that it is invisible unless subagents ran
// in parallel. With no subagents at all the outline must be one plain column.
check('no fan-out anywhere', !flat.includes('outline-fork'))
check('no fork slots', !flat.includes('outline-fork-slot'))
check('outline is a single vertical column',
  (() => {
    const d = new JSDOM(`<body>${flat}</body>`).window.document
    const rootList = d.querySelector('.outline .outline-root')
    return (
      d.querySelectorAll('.outline .outline-list').length === 1 &&
      rootList?.querySelectorAll(':scope > li').length === 4
    )
  })())
check('outline shows no target text', !flat.includes('outline-target'))
// A token is its tool's name and nothing else: the step number, the outcome
// and the target all live on the tooltip, so anything else in `textContent`
// means the outline has started repeating the trajectory.
check('outline token is the tool name only',
  [...new JSDOM(`<body>${flat}</body>`).window.document.querySelectorAll('.outline-item')]
    .every((el) => /^\w+$/.test(el.textContent)))
check('outline still lists the four Bash calls',
  [...new JSDOM(`<body>${flat}</body>`).window.document.querySelectorAll('.outline-item')].length === 4)

console.log('\nApp shell renders:', probe.renderApp().length > 500 ? 'PASS' : 'FAIL')
if (probe.renderApp().length <= 500) failures += 1

fs.rmSync(outDir, { recursive: true, force: true })
// ---------------------------------------------------------------------------
console.log('\n== tool kinds are badged, and both views agree ==')
{
  const doc = new JSDOM(
    `<body>${probe.renderTrajectory(load(path.join(root, 'fixtures/parallel-deep.jsonl'))).html}</body>`
  ).window.document.body

  const kindOf = (el, prefix) =>
    el ? ([...el.classList].find((c) => c.startsWith(prefix))?.slice(prefix.length) ?? null) : null

  const rows = [...doc.querySelectorAll('.node.tool')].map((n) => {
    const badge = n.querySelector('.tool-badge')
    return {
      name: n.querySelector('.tool-name')?.textContent,
      kind: kindOf(badge, 'badge-'),
      glyphs: badge ? badge.querySelectorAll('svg').length : 0,
    }
  })
  const tokens = [...doc.querySelectorAll('.outline-item')].map((o) => ({
    name: o.querySelector('.outline-name')?.textContent,
    kind: kindOf(o, 'outline-kind-'),
    glyphs: o.querySelectorAll('svg').length,
  }))

  check('the fixture really exercises several kinds', rows.length === 10 && tokens.length === 10)
  check('every tool row carries a badge', rows.every((r) => r.kind != null))
  check('every badge carries exactly one glyph', rows.every((r) => r.glyphs === 1))
  check('every outline token carries exactly one glyph', tokens.every((t) => t.glyphs === 1))

  // The whole point of badging both views: a card in the trajectory and its
  // token in the sidebar have to be recognisably the same call.
  check(
    'both views list the same calls in order',
    rows.map((r) => r.name).join(',') === tokens.map((t) => t.name).join(',')
  )
  check(
    'each call resolves to the same kind in both views',
    rows.length > 0 && rows.every((r, i) => r.kind === tokens[i].kind)
  )
  check('the kinds really are distinguished', new Set(tokens.map((t) => t.kind)).size === 3)
  check('an Agent call badges as a task', rows.find((r) => r.name === 'Task')?.kind === 'task')
  check('a Read badges as a read', rows.find((r) => r.name === 'Read')?.kind === 'read')
  check('a Grep badges as a grep', rows.find((r) => r.name === 'Grep')?.kind === 'grep')

  // The token is still just its name as text -- the glyph adds no text content,
  // which is what keeps the outline readable as a list of tool names.
  check(
    'a token still reads as its bare name',
    [...doc.querySelectorAll('.outline-item')].every((el) => /^\w+$/.test(el.textContent))
  )
}

// ---------------------------------------------------------------------------
console.log('\n== an agent call is a card; parallel ones are separate cards ==')
{
  const doc = new JSDOM(
    `<body>${probe.renderTrajectory(load(path.join(root, 'fixtures/parallel-tasks.jsonl'))).html}</body>`
  ).window.document.body

  const row = doc.querySelector('.agent-row')
  const cards = row ? [...row.querySelectorAll(':scope > .node.tool.tool-spawner')] : []

  check('adjacent spawning calls are lifted into one row', Boolean(row))
  check('the row holds exactly the two Task cards', cards.length === 2)
  check(
    'neither card contains the other',
    cards.length === 2 && !cards[0].contains(cards[1]) && !cards[1].contains(cards[0])
  )
  check(
    'each card owns its own branch',
    cards.length === 2 && cards.every((c) => c.querySelectorAll(':scope > .branch').length === 1)
  )
  check(
    'each card keeps its own children',
    JSON.stringify(
      cards.map((c) => [...c.querySelectorAll('.branch .tool-name')].map((n) => n.textContent))
    ) === JSON.stringify([['Read', 'Grep'], ['Grep', 'Read']])
  )
  check('the row carries its card count for the layout',
    (row?.getAttribute('style') ?? '').includes('--cards'))

  // A lone spawner is not a fan-out: it stays in the vertical flow.
  const lone = new JSDOM(
    `<body>${probe.renderTrajectory(load(path.join(root, 'fixtures/subagent-forward.jsonl'))).html}</body>`
  ).window.document.body
  check('a single spawning call is not put in a row', lone.querySelectorAll('.agent-row').length === 0)
  check('it is still a card', lone.querySelectorAll('.node.tool.tool-spawner').length === 1)
  check('its children sit inside the card',
    Boolean(lone.querySelector('.node.tool.tool-spawner .branch .node.tool')))

  // A run with no subagents gains neither cards nor rows.
  const flat = new JSDOM(
    `<body>${probe.renderTrajectory(load(path.join(root, 'claude-test/events.jsonl'))).html}</body>`
  ).window.document.body
  check('a run with no subagents has no cards', flat.querySelectorAll('.tool-spawner').length === 0)
  check('and no parallel rows', flat.querySelectorAll('.agent-row').length === 0)
  check('but its rows are still badged', flat.querySelectorAll('.tool-badge').length === 4)
}



console.log(failures === 0 ? '\nAll render checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
