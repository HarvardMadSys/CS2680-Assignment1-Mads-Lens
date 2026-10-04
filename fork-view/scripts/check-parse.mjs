/**
 * Exercises shared/parse.js against the real recorded trajectories plus a set
 * of hand-built edge cases. Run with: node scripts/check-parse.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { initialState, reduce } = await import(
  new URL('../shared/parse.js', import.meta.url)
)

let failures = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}

/**
 * Every recording in `sessions/runs/`, as repo-relative paths.
 *
 * That directory is runtime output: it is gitignored, so on a fresh clone it
 * may hold nothing -- or not exist at all, since git does not create empty
 * directories. A bare `readdirSync` therefore throws ENOENT on a clone that has
 * never started a run, which is exactly the state a first `npm run check`
 * should cope with. The committed fixtures are what pin behaviour; whatever
 * happens to be here is extra corpus, and having none of it is not a failure.
 */
function recordedRuns(root) {
  const dir = path.join(root, 'sessions/runs')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => `sessions/runs/${f}`)
}

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

function run(frames, mode = 'replay') {
  let s = reduce(initialState(), { type: '_reset', mode })
  for (const f of frames) s = reduce(s, f)
  return s
}

function counts(state) {
  const out = {}
  for (const n of state.nodes) out[n.kind] = (out[n.kind] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------------------
console.log('\n== real trajectories ==')

for (const rel of ['claude-test/events.jsonl', ...recordedRuns(root)]) {
  const frames = load(path.join(root, rel))
  const s = run([...frames, { type: '_replay_end' }])

  console.log(`\n${rel}`)
  console.log(`  status=${s.status} session=${s.sessionId} model=${s.model}`)
  console.log(`  frames=${s.eventCount} nodes=${s.nodes.length} filtered=${s.hiddenCount}`)
  console.log(`  node kinds: ${JSON.stringify(counts(s))}`)

  const tools = s.nodes.filter((n) => n.kind === 'tool')
  for (const t of tools) {
    const r = t.result
    const preview = (r?.stdout ?? r?.text ?? '').split('\n')[0].slice(0, 46)
    console.log(
      `    ${t.status.padEnd(10)} ${t.name.padEnd(6)} ${String(t.durationMs).padStart(5)}ms  ${preview}`
    )
  }

  check(`${rel}: no pending tools left`, s.pendingToolIds.length, 0)

  // A tool node may only be missing its result if the recording genuinely never
  // carried one. That -- not "every tool has a result" -- is the parser's
  // actual obligation: several saved runs are truncated recordings of runs that
  // were interrupted mid-call, and no parser can conjure a result the file does
  // not contain. The stronger claim below is the one worth making, because it
  // still fails if a result IS present and the parser fails to attach it.
  const returned = new Set()
  for (const frame of frames) {
    for (const block of frame?.message?.content ?? []) {
      if (block?.type === 'tool_result') returned.add(block.tool_use_id)
    }
  }
  const unmatched = tools.filter((t) => !t.result)
  check(
    `${rel}: no tool result present in the file was left unmatched`,
    unmatched.filter((t) => returned.has(t.toolUseId)).map((t) => t.name),
    []
  )

  if (s.result) {
    // A run that reported a result ran to completion, so nothing may dangle.
    check(`${rel}: a completed run matched every tool`, unmatched.length, 0)
  } else {
    // Interrupted. The calls still in flight when the recording stopped are
    // expected to have no result -- but they must be settled, not left looking
    // like they are still going.
    check(`${rel}: an interrupted run leaves nothing running`,
      tools.filter((t) => t.status === 'running').map((t) => t.name), [])
    check(`${rel}: its unfinished tools are marked incomplete`,
      unmatched.every((t) => t.status === 'incomplete'), true)
  }
  check(`${rel}: no orphans`, counts(s).orphan_tool_result ?? 0, 0)
  // Match the frame's own subtype, not the substring: a recorded run whose
  // prose or Bash command merely mentions the word is not a filtering failure.
  check(`${rel}: commands_changed filtered out`,
    s.nodes.some((n) => n.raw?.subtype === 'commands_changed'), false)
  check(`${rel}: no empty text nodes`,
    s.nodes.filter((n) => n.kind === 'text' && !n.text.trim()).length, 0)
}

// ---------------------------------------------------------------------------
console.log('\n== edge cases ==')

const tu = (id, name, input, extra = {}) => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  ...extra,
})
const tr = (id, content, isError, sidecar) => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:02.500Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
  ...(sidecar ? { tool_use_result: sidecar } : {}),
})

// multi-block assistant event
{
  const s = run([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'x' },
          { type: 'text', text: 'Doing two things.' },
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    },
  ])
  check('multi-block: 4 nodes', s.nodes.length, 4)
  check('multi-block: kinds', s.nodes.map((n) => n.kind), ['thinking', 'text', 'tool', 'tool'])
  check('multi-block: both tools pending', s.pendingToolIds, ['a', 'b'])
  check('multi-block: ids are tool_use ids', s.nodes.slice(2).map((n) => n.id), ['a', 'b'])
}

// out-of-order results across events
{
  const s = run([
    tu('a', 'Bash', { command: 'ls' }),
    tu('b', 'Bash', { command: 'pwd' }),
    tr('b', 'second done'),
    tr('a', 'first done'),
  ])
  const byId = Object.fromEntries(s.nodes.filter((n) => n.kind === 'tool').map((n) => [n.id, n]))
  check('out-of-order: a matched', byId.a.result.text, 'first done')
  check('out-of-order: b matched', byId.b.result.text, 'second done')
  check('out-of-order: none pending', s.pendingToolIds.length, 0)
  check('out-of-order: results do not add nodes', s.nodes.length, 2)
}

// error result
{
  const s = run([tu('a', 'Bash', { command: 'false' }), tr('a', 'boom', true)])
  check('error result: status', s.nodes[0].status, 'error')
  check('error result: isError', s.nodes[0].result.isError, true)
}

// structured stdout/stderr preferred
{
  const s = run([
    tu('a', 'Bash', { command: 'x' }),
    tr('a', 'flat text', false, { stdout: 'OUT', stderr: 'ERR', interrupted: false }),
  ])
  check('sidecar: stdout kept', s.nodes[0].result.stdout, 'OUT')
  check('sidecar: stderr kept', s.nodes[0].result.stderr, 'ERR')
  check('sidecar: flat text still available', s.nodes[0].result.text, 'flat text')
  check('sidecar: duration computed', s.nodes[0].durationMs, 2500)
}

// blank stderr is dropped
{
  const s = run([tu('a', 'Bash', { command: 'x' }), tr('a', 'y', false, { stdout: 'o', stderr: '' })])
  check('blank stderr dropped', s.nodes[0].result.stderr, null)
}

// array-shaped tool_result content
{
  const s = run([
    tu('a', 'Read', { file_path: '/x' }),
    tr('a', [{ type: 'text', text: 'line one' }, { type: 'image', source: {} }]),
  ])
  check('array content: text joined', s.nodes[0].result.text, 'line one')
  check('array content: blocks kept', s.nodes[0].result.contentBlocks.length, 2)
}

// image-only content
{
  const s = run([tu('a', 'Read', {}), tr('a', [{ type: 'image', source: {} }])])
  check('image-only content', s.nodes[0].result.text, '[image]')
}

// orphan result
{
  const s = run([tr('ghost', 'no matching call')])
  check('orphan: node kind', s.nodes[0].kind, 'orphan_tool_result')
  check('orphan: id preserved', s.nodes[0].toolUseId, 'ghost')
  check('orphan: does not crash', s.nodes.length, 1)
}

// pending tool at end of run
{
  const s = run([
    tu('a', 'Bash', { command: 'sleep 999' }),
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  ])
  check('pending at result: settled', s.nodes[0].status, 'incomplete')
  check('pending at result: list cleared', s.pendingToolIds.length, 0)
}
{
  const s = run([tu('a', 'Bash', {}), { type: '_exit', code: 1 }])
  check('pending at exit: settled', s.nodes[0].status, 'incomplete')
  check('pending at exit: run failed', s.status, 'failed')
}
{
  const s = run([tu('a', 'Bash', {}), { type: '_replay_end' }])
  check('pending at replay end: settled', s.nodes[0].status, 'incomplete')
}

// empty text block is not a node
{
  const s = run([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } },
  ])
  check('blank text: no node', s.nodes.length, 0)
}

// thinking never becomes assistant text
{
  const s = run([
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 350 },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
    },
  ])
  check('thinking: kind', s.nodes[0].kind, 'thinking')
  check('thinking: token count folded in', s.nodes[0].tokens, 350)
  check('thinking: not text', s.nodes.some((n) => n.kind === 'text'), false)
  check('thinking_tokens counted as filtered', s.hiddenCount, 1)
}

// noise filtering
{
  const s = run([
    { type: 'system', subtype: 'commands_changed' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  ])
  check('noise: no nodes', s.nodes.length, 0)
  check('noise: counted', s.hiddenCount, 2)
  check('noise: raw log keeps them', s.rawEvents.length, 2)
}
{
  const s = run([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }])
  check('non-allowed rate limit surfaces', s.nodes[0].kind, 'notice')
}

// unknown / malformed frames must not crash
{
  const s = run([
    { type: 'some_future_event', session_id: 'z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'weird_block' }] } },
    { type: 'assistant', message: { content: 'plain string content' } },
    { type: 'assistant' },
    { type: 'user', message: null },
    {},
  ])
  check('unknown: survived', s.nodes.length > 0, true)
  check('unknown: typed node', s.nodes[0].kind, 'unknown')
  check('unknown: session captured', s.sessionId, 'z')
  check('unknown block: typed node', s.nodes[1].kind, 'unknown_block')
  check('string content becomes text', s.nodes[2].kind, 'text')
}

// tool_progress is routine "still working" chatter, not an unknown event. It
// carries the running tool's own id in parent_tool_use_id, so leaking it as a
// node is what used to give an ordinary Bash call a subagent branch.
{
  const s = run([
    tu('a', 'Bash', { command: 'npm run build' }),
    { type: 'tool_progress', parent_tool_use_id: 'a', tool_use_id: 'a', progress: { elapsed_ms: 1200 } },
    { type: 'system', subtype: 'tool_progress', parent_tool_use_id: 'a' },
    tr('a', 'ok'),
  ])
  check('tool_progress: makes no node', s.nodes.length, 1)
  check('tool_progress: only the Bash call remains', s.nodes[0].name, 'Bash')
  check('tool_progress: counted as filtered', s.hiddenCount, 2)
  check('tool_progress: never an unknown node', s.nodes.some((n) => n.kind === 'unknown'), false)
  check('tool_progress: kept in the raw log', s.rawEvents.length, 4)
}
{
  // ...but suppression is narrow: a genuinely unrecognised type still surfaces.
  const s = run([{ type: 'tool_teleport', parent_tool_use_id: 'a' }])
  check('unrecognised types still surface', s.nodes[0].kind, 'unknown')
  check('unrecognised types name themselves', s.nodes[0].text, 'unhandled event type: tool_teleport')
}

// parent_tool_use_id is carried but not nested
{
  const s = run([tu('a', 'Task', { description: 'sub' }), tu('b', 'Bash', {}, { parent_tool_use_id: 'a' })])
  check('parentToolUseId recorded', s.nodes[1].parentToolUseId, 'a')
  check('still flat', s.nodes.length, 2)
}

// purity (React StrictMode double-invokes reducers)
{
  const base = run([tu('a', 'Bash', { command: 'ls' })])
  const ev = tr('a', 'out')
  check('pure: same output twice',
    JSON.stringify(reduce(base, ev)) === JSON.stringify(reduce(base, ev)), true)
  check('pure: input untouched', base.nodes[0].status, 'running')
}

// ---------------------------------------------------------------------------
console.log('\n== stopping a run ==')

// A cancellation is a third ending. It must not be reported as a failure, it
// must keep everything recorded before it, and a stop that races the run
// finishing must lose to whatever the run actually did.
{
  const s = run([
    tu('a', 'Read', { file_path: 'main.py' }),
    tr('a', 'contents'),
    tu('b', 'Bash', { command: 'sleep 999' }),
    { type: '_stopping' },
    { type: '_stopped' },
    { type: '_exit', code: null, signal: 'SIGTERM' },
  ])
  check('stopped: status is stopped, not failed', s.status, 'stopped')
  check('stopped: no error recorded', s.error, null)
  check('stopped: no result invented', s.result, null)
  check('stopped: finished call keeps its outcome', s.nodes[0].status, 'completed')
  check('stopped: its output is still there', s.nodes[0].result.text, 'contents')
  // The tool_result folded into node 0 rather than making one of its own.
  check('stopped: interrupted call is settled', s.nodes[1].status, 'incomplete')
  check('stopped: nothing left pending', s.pendingToolIds.length, 0)
  check('stopped: the run ends on a stop notice', s.nodes.at(-1).kind, 'notice')
  check('stopped: the notice is not an error', s.nodes.at(-1).level, 'stopped')
}

// The intermediate state, which is what disables the button.
{
  const s = run([tu('a', 'Bash', {}), { type: '_stopping' }])
  check('stopping: status is stopping', s.status, 'stopping')
  check('stopping: nothing settled yet', s.nodes[0].status, 'running')
}

// Stop pressed as the run lands. The result frame got there first, so the run
// completed -- and saying otherwise would be inventing an ending.
{
  const s = run([
    tu('a', 'Bash', { command: 'ls' }),
    tr('a', 'out'),
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    { type: '_stopping' },
    { type: '_stopped' },
    { type: '_exit', code: 0 },
  ])
  check('stop after completion: still completed', s.status, 'completed')
  check('stop after completion: result kept', typeof s.result, 'object')
}

// ...and the same race against a failure.
{
  const s = run([
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' },
    { type: '_stopping' },
    { type: '_stopped' },
  ])
  check('stop after failure: still failed', s.status, 'failed')
}

// A result frame that arrives from the dying process does not turn a
// cancellation into a success.
{
  const s = run([
    tu('a', 'Bash', {}),
    { type: '_stopped' },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    { type: '_exit', code: null, signal: 'SIGTERM' },
  ])
  check('late result: run stays stopped', s.status, 'stopped')
  check('late result: frame still recorded', typeof s.result, 'object')
}

// Pressing stop twice sends `_stopping` once and `_stopped` twice at worst.
{
  const s = run([
    tu('a', 'Bash', {}),
    { type: '_stopping' },
    { type: '_stopped' },
    { type: '_stopped' },
  ])
  check('double stop: still stopped', s.status, 'stopped')
  check(
    'double stop: one notice, not two',
    s.nodes.filter((n) => n.kind === 'notice' && n.level === 'stopped').length,
    1
  )
}

// `_exit` alone after a stop request that never got its `_stopped` through --
// the process died anyway, and that is still a cancellation, not a crash.
{
  const s = run([tu('a', 'Bash', {}), { type: '_stopping' }, { type: '_exit', code: null }])
  check('exit while stopping: stopped, not failed', s.status, 'stopped')
  check('exit while stopping: no crash notice', s.error, null)
}

// A stop frame for a run that never started changes nothing.
{
  const s = run([{ type: '_stopped' }])
  check('stop with no run: status', s.status, 'stopped')
}

// The ordinary endings are untouched.
{
  const ok = run([
    tu('a', 'Bash', {}),
    tr('a', 'out'),
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    { type: '_exit', code: 0 },
  ])
  check('regression: a normal run still completes', ok.status, 'completed')

  const bad = run([tu('a', 'Bash', {}), { type: '_exit', code: 1 }])
  check('regression: a crash still fails', bad.status, 'failed')

  const err = run([{ type: '_error', message: 'boom' }])
  check('regression: an error still fails', err.status, 'failed')
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
