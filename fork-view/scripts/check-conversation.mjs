/**
 * Exercises shared/conversation.js: multi-run composition, session capture and
 * resume targeting, per-run isolation, and metrics extraction.
 *
 * Run with: node scripts/check-conversation.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  activeRun,
  canSubmit,
  conversationReducer,
  formatCost,
  formatDuration,
  initialConversation,
  isBusy,
  resumeTarget,
  isRunTerminal,
  liveMetrics,
  redundantTextIds,
  runMetrics,
  sessionChanged,
} = await import(new URL('../shared/conversation.js', import.meta.url))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`
  )
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

const apply = (state, actions) => actions.reduce(conversationReducer, state)
const start = (key, prompt, resumeSessionId = null, mode = 'live') => ({
  type: 'conversation/startRun',
  key,
  mode,
  prompt,
  cwd: 'claude-test',
  resumeSessionId,
})
const feed = (key, ...events) =>
  events.map((event) => ({ type: 'conversation/event', key, event }))

const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5' })
const done = (sid, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: sid,
  total_cost_usd: 0.0825,
  duration_ms: 9123,
  num_turns: 2,
  ...extra,
})

// ---------------------------------------------------------------------------
console.log('\n== multi-run composition ==')
{
  let s = initialConversation()
  check('starts empty', [s.runs.length, s.sessionId, isBusy(s), canSubmit(s)], [0, null, false, true])

  s = apply(s, [start('k1', 'first prompt')])
  check('run created', s.runs.length, 1)
  check('run numbered from 1', s.runs[0].index, 1)
  check('busy before any event', isBusy(s), true)
  check('cannot submit while busy', canSubmit(s), false)
  check('first run requests no resume', s.runs[0].requestedResumeSessionId, null)

  s = apply(s, feed('k1', init('11111111-1111-4111-8111-111111111111')))
  check('session captured from init', s.sessionId, '11111111-1111-4111-8111-111111111111')
  check('still busy mid-run', isBusy(s), true)

  s = apply(s, feed('k1', done('11111111-1111-4111-8111-111111111111'), { type: '_exit', code: 0 }))
  check('run 1 completed', s.runs[0].trajectory.status, 'completed')
  check('no longer busy', isBusy(s), false)
  check('follow-up now allowed', canSubmit(s), true)
  check('resume target is the captured session', resumeTarget(s), '11111111-1111-4111-8111-111111111111')

  // follow-up
  const run1Nodes = s.runs[0].trajectory.nodes.length
  s = apply(s, [start('k2', 'second prompt', resumeTarget(s))])
  check('two runs now', s.runs.length, 2)
  check('run 2 numbered 2', s.runs[1].index, 2)
  check('run 1 still present', s.runs[0].prompt, 'first prompt')
  check('run 1 trajectory untouched', s.runs[0].trajectory.nodes.length, run1Nodes)
  check('run 1 still completed', s.runs[0].trajectory.status, 'completed')
  check('run 2 requests resume', s.runs[1].requestedResumeSessionId, '11111111-1111-4111-8111-111111111111')

  s = apply(s, feed('k2', init('11111111-1111-4111-8111-111111111111')))
  check('run 2 running', s.runs[1].trajectory.status, 'running')
  check('run 1 unaffected by run 2 events', s.runs[0].trajectory.status, 'completed')
  check('active run is the newest', activeRun(s).key, 'k2')

  s = apply(s, feed('k2', done('11111111-1111-4111-8111-111111111111', { total_cost_usd: 0.21, duration_ms: 65000, num_turns: 5 })))
  check('per-run metrics differ', [runMetrics(s.runs[0]).costUsd, runMetrics(s.runs[1]).costUsd], [0.0825, 0.21])
  check('per-run turns differ', [runMetrics(s.runs[0]).numTurns, runMetrics(s.runs[1]).numTurns], [2, 5])
  check('events routed only to their run', [s.runs[0].trajectory.eventCount, s.runs[1].trajectory.eventCount], [3, 2])
}

// ---------------------------------------------------------------------------
console.log('\n== session id handling ==')
{
  // A resumed run that comes back under a different id must not be assumed.
  let s = apply(initialConversation(), [
    start('k1', 'a'),
    ...feed('k1', init('aaaaaaaa-1111-4111-8111-111111111111'), done('aaaaaaaa-1111-4111-8111-111111111111')),
    start('k2', 'b', 'aaaaaaaa-1111-4111-8111-111111111111'),
    ...feed('k2', init('bbbbbbbb-2222-4222-8222-222222222222'), done('bbbbbbbb-2222-4222-8222-222222222222')),
  ])
  check('adopts the newly reported id', s.sessionId, 'bbbbbbbb-2222-4222-8222-222222222222')
  check('change is detectable', sessionChanged(s.runs[1]), true)
  check('unchanged run is not flagged', sessionChanged(s.runs[0]), false)
  check('next resume uses the new id', resumeTarget(s), 'bbbbbbbb-2222-4222-8222-222222222222')

  // A run that never reports a session id must not wipe the known one.
  s = apply(s, [start('k3', 'c', resumeTarget(s)), ...feed('k3', { type: '_stderr', text: 'noise' })])
  check('session survives a run with no id', s.sessionId, 'bbbbbbbb-2222-4222-8222-222222222222')
}

// ---------------------------------------------------------------------------
console.log('\n== failure does not stick the conversation ==')
{
  // POST rejected (e.g. bad working directory): the run still terminalises.
  let s = apply(initialConversation(), [
    start('k1', 'bad cwd'),
    ...feed('k1', { type: '_error', message: 'Working directory does not exist: nope' }),
  ])
  check('failed run status', s.runs[0].trajectory.status, 'failed')
  check('not busy after failure', isBusy(s), false)
  check('can submit again', canSubmit(s), true)
  check('no metrics invented', runMetrics(s.runs[0]), {
    available: false, costUsd: null, durationMs: null, numTurns: null,
  })

  // Retry works and previous failed run stays visible.
  s = apply(s, [start('k2', 'retry', resumeTarget(s)), ...feed('k2', init('cccccccc-3333-4333-8333-333333333333'), done('cccccccc-3333-4333-8333-333333333333'))])
  check('failed run still listed', s.runs.length, 2)
  check('failed run kept its status', s.runs[0].trajectory.status, 'failed')
  check('retry succeeded', s.runs[1].trajectory.status, 'completed')
  check('first run had no session to resume', s.runs[0].requestedResumeSessionId, null)

  // Crash mid-run: exit without a result.
  const crashed = apply(initialConversation(), [
    start('k1', 'crash'),
    ...feed('k1', init('dddddddd-4444-4444-8444-444444444444'), { type: '_exit', code: 1 }),
  ])
  check('crash marks failed', crashed.runs[0].trajectory.status, 'failed')
  check('crash frees the conversation', canSubmit(crashed), true)
  check('crash still captured the session', resumeTarget(crashed), 'dddddddd-4444-4444-8444-444444444444')
  check('crash metrics unavailable', runMetrics(crashed.runs[0]).available, false)
}

// ---------------------------------------------------------------------------
console.log('== a stopped run is an ending like any other ==')
{
  const SID = 'eeeeeeee-5555-4555-8555-555555555555'

  // Mid-stop the conversation is still busy: the process has not gone yet, and
  // letting a follow-up start against a session still being killed is the one
  // thing this state exists to prevent.
  const stopping = apply(initialConversation(), [
    start('k1', 'a long job'),
    ...feed('k1', init(SID), { type: '_stopping' }),
  ])
  check('stopping: still busy', isBusy(stopping), true)
  check('stopping: cannot submit', canSubmit(stopping), false)
  check('stopping: status', stopping.runs[0].trajectory.status, 'stopping')

  const stopped = apply(stopping, [
    ...feed('k1', { type: '_stopped' }, { type: '_exit', code: null, signal: 'SIGTERM' }),
  ])
  check('stopped: status is stopped', stopped.runs[0].trajectory.status, 'stopped')
  check('stopped: frees the conversation', isBusy(stopped), false)
  check('stopped: can submit again', canSubmit(stopped), true)
  check('stopped: session still captured', resumeTarget(stopped), SID)
  check('stopped: no metrics invented', runMetrics(stopped.runs[0]).available, false)

  // ...and the session it captured is resumable, on the same path any other
  // ending uses. No new resume semantics are introduced for a stop.
  const after = apply(stopped, [
    start('k2', 'carry on', resumeTarget(stopped)),
    ...feed('k2', init(SID), done(SID)),
  ])
  check('after a stop: the next run starts', after.runs.length, 2)
  check('after a stop: it resumed that session', after.runs[1].requestedResumeSessionId, SID)
  check('after a stop: it completes normally', after.runs[1].trajectory.status, 'completed')
  check('after a stop: the stopped run is preserved', after.runs[0].trajectory.status, 'stopped')
  check(
    'after a stop: its trajectory is preserved',
    after.runs[0].trajectory.rawEvents.length > 0,
    true
  )
}

// ---------------------------------------------------------------------------
console.log('\n== metrics extraction ==')
{
  const one = (result) =>
    runMetrics(apply(initialConversation(), [start('k', 'p'), ...feed('k', result)]).runs[0])

  check('full result', (({ costUsd, durationMs, numTurns }) => ({ costUsd, durationMs, numTurns }))(one(done('s'))),
    { costUsd: 0.0825, durationMs: 9123, numTurns: 2 })

  const partial = one({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })
  check('partial result is available but fields null', [partial.available, partial.costUsd, partial.durationMs, partial.numTurns],
    [true, null, null, null])

  const bogus = one({ type: 'result', subtype: 'success', is_error: false, result: 'x', total_cost_usd: 'free', duration_ms: null, num_turns: NaN })
  check('non-numeric fields rejected', [bogus.costUsd, bogus.durationMs, bogus.numTurns], [null, null, null])
}

console.log('\n== formatting ==')
check('sub-second', formatDuration(842), '842 ms')
check('seconds', formatDuration(9123), '9.1 s')
check('minutes', formatDuration(65000), '1 m 5 s')
check('null duration', formatDuration(null), null)
check('cost', formatCost(0.18216549999999998), '$0.1822')
check('null cost', formatCost(null), null)

// ---------------------------------------------------------------------------
console.log('\n== replay is one run in the same shape ==')
{
  const frames = load(path.join(root, 'claude-test/events.jsonl'))
  let s = apply(initialConversation('replay'), [
    start('r1', 'prompt not recorded', null, 'replay'),
    ...feed('r1', ...frames, { type: '_replay_end' }),
  ])

  check('replay yields one run', s.runs.length, 1)
  check('replay run completed', s.runs[0].trajectory.status, 'completed')
  check('replay captured session', s.sessionId, '6769a0d1-5f70-48a1-a40b-862eded1ff4b')
  check('replay nodes built by the same reducer', s.runs[0].trajectory.nodes.length, 10)
  check('replay tool count', s.runs[0].trajectory.nodes.filter((n) => n.kind === 'tool').length, 4)

  const m = runMetrics(s.runs[0])
  check('replay metrics', [m.costUsd, m.durationMs, m.numTurns], [0.18216549999999998, 23270, 5])
  check('replay disallows follow-up', canSubmit(s), false)
}

// ---------------------------------------------------------------------------
console.log('\n== live metrics never contradict the run header ==')
{
  // The run header and the status-bar meter read the same run, so whatever one
  // of them claims, the other has to be able to stand next to it. Exactly three
  // states are legitimate; anything else is the two disagreeing on screen.
  const agree = (run) => {
    const header = runMetrics(run)
    const meter = liveMetrics(run, Date.now())
    if (!header.available && meter === null) return 'both silent'
    if (header.available && meter && !meter.live && meter.costUsd === header.costUsd) return 'both exact'
    if (!header.available && meter && meter.live) return 'meter live'
    return 'CONTRADICTION'
  }

  // Stopped without ever reporting a result -- what a truncated recording of an
  // interrupted run replays as. Nothing exact to show and nothing left to
  // count, so both read-outs must stay quiet.
  const stopped = activeRun(apply(initialConversation(), [
    start('t1', 'interrupted'),
    ...feed('t1', init('aaaaaaaa-1111-4111-8111-111111111111'), { type: '_replay_end' }),
  ]))
  check('a run with no result frame is terminal', isRunTerminal(stopped), true)
  check('  its header reports nothing', runMetrics(stopped).available, false)
  check('  its meter reports nothing either', liveMetrics(stopped, Date.now()), null)
  check('  so the two agree', agree(stopped), 'both silent')

  // Mid-run: nothing terminal yet, so the meter carries the live read-out.
  const running = activeRun(apply(initialConversation(), [
    start('t2', 'streaming'),
    ...feed('t2', init('bbbbbbbb-2222-4222-8222-222222222222')),
  ]))
  check('a streaming run is not terminal', isRunTerminal(running), false)
  check('  its meter is live', liveMetrics(running, Date.now())?.live, true)
  check('  and the two still agree', agree(running), 'meter live')

  // Finished properly: the result frame wins and both read the same figures.
  const finished = activeRun(apply(initialConversation(), [
    start('t3', 'finished'),
    ...feed('t3', init('cccccccc-3333-4333-8333-333333333333'), done('cccccccc-3333-4333-8333-333333333333')),
  ]))
  check('a finished run reports exact figures', liveMetrics(finished, Date.now())?.live, false)
  check('  cost matches the header', liveMetrics(finished, Date.now())?.costUsd, runMetrics(finished).costUsd)
  check('  duration matches the header', liveMetrics(finished, Date.now())?.durationMs, runMetrics(finished).durationMs)
  check('  and the two agree', agree(finished), 'both exact')

  // A failed run that DID report a result keeps its figures: "failed" is not
  // the same thing as "unmeasured".
  const failed = activeRun(apply(initialConversation(), [
    start('t4', 'failed with a result'),
    ...feed('t4', init('dddddddd-4444-4444-8444-444444444444'),
      done('dddddddd-4444-4444-8444-444444444444', { subtype: 'error_during_execution', is_error: true })),
  ]))
  check('a failed run that reported a result keeps its metrics', runMetrics(failed).available, true)
  check('  and its meter still shows them', liveMetrics(failed, Date.now())?.costUsd, 0.0825)
  check('  and the two agree', agree(failed), 'both exact')
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\n== the closing paragraph is shown once, never twice ==')
{
  // Hand-built node lists: the rule is about content identity, so the cheapest
  // honest test is to state the content and ask which node the view should skip.
  const text = (id, body, parentToolUseId = null) => ({ id, kind: 'text', text: body, parentToolUseId })
  const result = (body, id = 'r') => ({ id, kind: 'result', text: body, parentToolUseId: null })
  const tool = (id) => ({ id, kind: 'tool', name: 'Bash', parentToolUseId: null })
  const hides = (...nodes) => [...redundantTextIds({ nodes })].sort()

  const CLOSING = 'All three files are UTF-16 LE, and nothing was changed.'

  check('an exact repeat is hidden',
    hides(text('a', 'working on it'), text('b', CLOSING), result(CLOSING)), ['b'])
  // Widened deliberately. This used to answer `null`: the rule looked only at
  // the text node immediately before the result, so a result repeating
  // something further up was rendered twice. A resumed session does exactly
  // that -- see the batch case below -- and the narrowness cost more than it
  // saved. The search runs backwards and stops at the first match, so it is
  // the nearest repeat that gets claimed.
  check('  a result claims the nearest text it repeats, not only the last one',
    hides(text('a', CLOSING), text('b', 'something else'), result(CLOSING)), ['a'])
  check('  whitespace differences still count as a repeat',
    hides(text('b', `\n${CLOSING}\n  `), result(CLOSING)), ['b'])

  check('a result that merely begins with the narration is still a repeat',
    hides(text('b', CLOSING), result(`${CLOSING}\n\nTotal: 3 files.`)), ['b'])

  // The other direction must NOT be suppressed: a result frame shorter than the
  // narration would take content off the page with it.
  check('a result that is only a fragment of the narration hides nothing',
    hides(text('b', `${CLOSING} And one more thing.`), result(CLOSING)), [])

  check('a short distinct status hides nothing',
    hides(text('b', CLOSING), result('Survey complete: 3 files, no changes.')), [])
  check('an unrelated result hides nothing',
    hides(text('b', CLOSING), result('Run reported an error.')), [])
  check('a result that merely overlaps mid-string hides nothing',
    hides(text('b', CLOSING), result(`Summary\n\n${CLOSING}`)), [])

  check('a run with no result frame hides nothing',
    hides(text('a', 'one'), text('b', CLOSING)), [])
  check('an empty result frame hides nothing', hides(text('b', CLOSING), result('')), [])
  check('a whitespace-only result frame hides nothing', hides(text('b', CLOSING), result('   \n ')), [])
  check('a run with no text at all hides nothing', hides(tool('t'), result(CLOSING)), [])

  // A subagent's prose lives in its branch and is never what the run's own
  // result frame echoes, so it must never be the node that gets hidden.
  check('a subagent text node is never hidden',
    hides(tool('t'), text('sub', CLOSING, 'toolu_1'), result(CLOSING)), [])
  check('  even when a top-level repeat sits after it',
    hides(tool('t'), text('sub', 'branch prose', 'toolu_1'), text('b', CLOSING), result(CLOSING)), ['b'])

  check('an empty trajectory hides nothing', [...redundantTextIds({ nodes: [] })], [])
  check('a missing trajectory hides nothing', [...redundantTextIds(null)], [])

  // The shape a resumed run actually produces. `--resume` replays the session's
  // earlier turns, so the recording carries one result per turn and the
  // replayed ones arrive in a batch, after all of their narration rather than
  // each directly below its own. Observed on
  // sessions/runs/2026-09-20T01-37-58-683-zbt4sv.jsonl, which holds four of
  // each and rendered four stutters under the old rule.
  const A = 'All three dispatched concurrently from a single message.'
  const B = 'Agent B is back; A and C are still running.'
  const C = 'Agent C is back and independently corroborates B.'
  const D = 'All three completed. Here is the verdict.'

  check('a resumed run hides every repeat, not just the last',
    hides(
      text('n1', 'Launching three Explore agents.'),
      text('n25', A), text('n49', B), text('n53', C),
      result(A, 'n54'), result(B, 'n55'), result(C, 'n56'),
      text('n58', 'All three agents are back.'),
      text('n61', D), result(D, 'n62')
    ),
    ['n25', 'n49', 'n53', 'n61'])

  check('  narration that no result repeats stays visible',
    hides(text('n1', 'Launching.'), text('n2', A), result(A, 'r1')), ['n2'])

  // One text node cannot be claimed by two results, or the second would be
  // hiding something that is no longer anywhere on the page.
  check('  a text node is claimed once',
    hides(text('a', A), result(A, 'r1'), result(A, 'r2')), ['a'])
}

// ---------------------------------------------------------------------------
console.log('\n== reset and purity ==')
{
  let s = apply(initialConversation(), [start('k1', 'a'), ...feed('k1', init('eeeeeeee-5555-4555-8555-555555555555'), done('e'))])
  const cleared = conversationReducer(s, { type: 'conversation/reset', mode: null })
  check('reset clears runs', cleared.runs.length, 0)
  check('reset clears session', cleared.sessionId, null)
  check('original untouched', s.runs.length, 1)

  const ev = { type: 'conversation/event', key: 'k1', event: { type: '_stderr', text: 'x' } }
  check('reducer is pure', JSON.stringify(conversationReducer(s, ev)) === JSON.stringify(conversationReducer(s, ev)), true)
  check('unknown action is a no-op', conversationReducer(s, { type: 'nope' }) === s, true)
  check('event for unknown run is a no-op',
    conversationReducer(s, { type: 'conversation/event', key: 'missing', event: init('z') }) === s, true)
}

console.log(failures === 0 ? '\nAll conversation checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
