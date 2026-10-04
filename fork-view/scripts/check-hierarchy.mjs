/**
 * Hierarchy checks.
 *
 * Driven first by the verified subagent fixtures recorded in Iteration 05
 * (fixtures/subagent-forward.jsonl), then by synthetic cases for orderings and
 * failure modes the real recording does not contain.
 *
 * Run with: node scripts/check-hierarchy.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { initialState, reduce, SUBAGENT_TOOLS } = await import(new URL('../shared/parse.js', import.meta.url))
const {
  ancestorsOf,
  branchSize,
  buildOutline,
  buildTree,
  flattenOutline,
  hasBranch,
  toolDomId,
} = await import(new URL('../shared/hierarchy.js', import.meta.url))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`
  )
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

function replay(frames) {
  let s = reduce(initialState(), { type: '_reset', mode: 'replay' })
  for (const f of frames) s = reduce(s, f)
  return reduce(s, { type: '_replay_end' })
}

/**
 * Same, without the replay terminator. The synthetic cases below have no
 * `result` frame, and `_replay_end` would add a "no result" notice node that
 * has nothing to do with what they are testing.
 */
function build(frames) {
  let s = reduce(initialState(), { type: '_reset', mode: 'replay' })
  for (const f of frames) s = reduce(s, f)
  return s
}

/** Compact shape of the tree, for readable assertions. */
function shape(entries) {
  return entries.map((e) => {
    const label = e.node.kind === 'tool' ? `tool:${e.node.name}` : e.node.kind
    return e.children.length ? { [label]: shape(e.children) } : label
  })
}

// ===========================================================================
console.log('\n== verified subagent fixture (forward) ==')

const fwFrames = load(path.join(root, 'fixtures/subagent-forward.jsonl'))
const fw = replay(fwFrames)
const fwTree = buildTree(fw.nodes)

const agentNode = fw.nodes.find((n) => n.kind === 'tool' && n.name === 'Agent')
console.log(`  Agent tool_use id: ${agentNode.toolUseId}`)
console.log(`  tree: ${JSON.stringify(shape(fwTree.roots))}`)

check('run parsed cleanly', fw.status, 'completed')
// 4 task_* lifecycle frames + 1 allowed rate_limit_event. (No thinking_tokens
// frames in this particular recording.)
check('noise frames filtered', fw.hiddenCount, 5)
check(
  'all four task_* frames were dropped',
  fwFrames.filter((e) => String(e.subtype ?? '').startsWith('task_')).length,
  4
)
check(
  'no task_* node leaked in',
  fw.nodes.some((n) => String(n.text ?? '').startsWith('system: task')),
  false
)

check('top level holds only main-agent nodes', fwTree.roots.every((e) => !e.node.parentToolUseId), true)
check('tree shape', shape(fwTree.roots), [
  'text',
  { 'tool:Agent': ['user_text', 'tool:Read', 'text'] },
  'text',
  'result',
])
check('no orphans in a complete trajectory', fwTree.orphanCount, 0)

const agentEntry = fwTree.byToolId.get(agentNode.toolUseId)
check('Agent call owns a branch', hasBranch(agentEntry), true)
check('branch size', branchSize(agentEntry), 3)
check('Agent flagged as a spawner', agentNode.spawnsSubagent, true)
check('spawned agent type captured', agentNode.spawnedAgentType, 'Explore')

// Everything inside the branch belongs to the subagent.
check(
  'every branch child points at the Agent call',
  agentEntry.children.every((c) => c.node.parentToolUseId === agentNode.toolUseId),
  true
)
check(
  'subagent task prompt is inside the branch',
  agentEntry.children[0].node.kind === 'user_text' &&
    agentEntry.children[0].node.text.startsWith('Read the file main.py'),
  true
)

const nestedRead = agentEntry.children.find((c) => c.node.kind === 'tool')
check('nested tool is Read', nestedRead.node.name, 'Read')
check('nested tool matched its own result', nestedRead.node.status, 'completed')
check(
  'nested result text came through',
  nestedRead.node.result.text.includes('import argparse'),
  true
)
check(
  'nested result matched by its OWN tool_use_id, not the parent id',
  nestedRead.node.toolUseId !== agentNode.toolUseId,
  true
)
check(
  'subagent assistant text is inside the branch',
  agentEntry.children.some((c) => c.node.kind === 'text' && c.node.text.includes('argparse')),
  true
)
check(
  'subagent nodes carry their agent type',
  agentEntry.children.every((c) => c.node.subagentType === 'Explore'),
  true
)

// The Agent call's own result arrives at the top level and lands on the card.
check('Agent call completed', agentNode.status, 'completed')
check('Agent result summary extracted', agentNode.result.agent.agentType, 'Explore')
check('Agent result status', agentNode.result.agent.status, 'completed')
check('Agent tool-use count', agentNode.result.agent.totalToolUseCount, 1)

// ===========================================================================
console.log('\n== fixture recorded WITHOUT --forward-subagent-text ==')

const nf = replay(load(path.join(root, 'fixtures/subagent-no-forward.jsonl')))
const nfTree = buildTree(nf.nodes)
const nfAgent = nf.nodes.find((n) => n.kind === 'tool' && n.name === 'Agent')
const nfBranch = nfTree.byToolId.get(nfAgent.toolUseId)

console.log(`  tree: ${JSON.stringify(shape(nfTree.roots))}`)
check('hierarchy still builds without the flag', hasBranch(nfBranch), true)
check('nested tool call still present', nfBranch.children.some((c) => c.node.kind === 'tool'), true)
check(
  'but the subagent assistant text is missing',
  nfBranch.children.some((c) => c.node.kind === 'text'),
  false
)

// ===========================================================================
console.log('\n== outline ==')

const outline = buildOutline(fwTree.roots)
check('outline has one root item', outline.length, 1)
check('root item is the Agent call', outline[0].name, 'Agent')
check('outline nests the subagent tool', outline[0].children.map((i) => i.name), ['Read'])
check('outline depth tracked', [outline[0].depth, outline[0].children[0].depth], [0, 1])
check('outline total items', flattenOutline(outline).length, 2)
check('outline carries status', flattenOutline(outline).map((i) => i.status), ['completed', 'completed'])
check(
  'outline contains no prose or results',
  flattenOutline(outline).every((i) => !('text' in i) && !('result' in i)),
  true
)
check('outline marks the spawner', outline[0].spawnsSubagent, true)
check('outline exposes the agent type', outline[0].agentType, 'Explore')

check(
  'outline ids match the rendered tool ids',
  flattenOutline(outline).map((i) => i.toolUseId),
  fw.nodes.filter((n) => n.kind === 'tool').map((n) => n.toolUseId)
)
check(
  'dom id is derived from the tool-use id, not a position',
  toolDomId('run-7', agentNode.toolUseId),
  `tool-run-7-${agentNode.toolUseId}`
)
check(
  'ancestors of the nested tool',
  ancestorsOf(nestedRead.node.toolUseId, fwTree.parentOf),
  [agentNode.toolUseId]
)
check('ancestors of a top-level tool', ancestorsOf(agentNode.toolUseId, fwTree.parentOf), [])

// ===========================================================================
console.log('\n== regression: only an agent-spawning call owns a branch ==')

for (const rel of ['claude-test/events.jsonl', ...recordedRuns(root)]) {
  const frames = load(path.join(root, rel))
  const s = replay(frames)
  const tree = buildTree(s.nodes)
  const flat =
    tree.roots.length === s.nodes.length && tree.roots.every((e) => e.children.length === 0)

  // The expectation is read off the raw frames, not off the tree, so this stays
  // a claim about the recording rather than a restatement of buildTree.
  //
  // `parent_tool_use_id` on its own does NOT mean subagent activity: progress
  // and telemetry frames carry the id of the ordinary tool they describe, so a
  // Bash call that reported progress carries the field without ever having
  // spawned anything. Only a frame parented to an Agent/Task call may nest.
  const agentCallIds = new Set()
  for (const frame of frames) {
    for (const block of frame?.message?.content ?? []) {
      if (block?.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) agentCallIds.add(block.id)
    }
  }

  const nestedFrames = frames.filter((f) => f.parent_tool_use_id)
  const nestsUnderAgent = nestedFrames.some((f) => agentCallIds.has(f.parent_tool_use_id))

  if (nestsUnderAgent) {
    check(`${rel}: frames sit under an agent call, so it nests`, flat, false)
  } else {
    check(`${rel}: renders flat (no nesting)`, flat, true)
  }

  // The regression itself, asserted only where the corpus can exercise it: a
  // plain tool that emitted telemetry must not come out owning a branch. The
  // earlier version of this check tested `frames.some(f => f.parent_tool_use_id)`
  // and so demanded the opposite -- it was pinning the bug in place.
  if (nestedFrames.length && !nestsUnderAgent) {
    check(
      `${rel}: parent_tool_use_id on a plain tool makes no branch`,
      [flat, tree.roots.some((e) => e.children.length > 0)],
      [true, false]
    )
  }

  check(`${rel}: no orphans`, tree.orphanCount, 0)
}

// ===========================================================================
console.log('\n== id-based, order-independent parenting ==')

const tu = (id, name, input = {}, ptid = null) => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  parent_tool_use_id: ptid,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const tr = (id, content, ptid = null) => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:01.000Z',
  parent_tool_use_id: ptid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
})
const txt = (text, ptid = null) => ({
  type: 'assistant',
  parent_tool_use_id: ptid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

{
  // Child frames interleaved with unrelated main-agent frames: adjacency would
  // get this wrong, ids do not.
  const s = build([
    tu('A', 'Agent', { subagent_type: 'Explore' }),
    tu('M1', 'Bash', { command: 'main work' }),
    tu('S1', 'Read', {}, 'A'),
    tr('M1', 'main done'),
    tr('S1', 'sub done', 'A'),
    txt('subagent says hi', 'A'),
    tr('A', 'agent finished'),
  ])
  const t = buildTree(s.nodes)
  check('interleaved: two roots', shape(t.roots), [{ 'tool:Agent': ['tool:Read', 'text'] }, 'tool:Bash'])
  check('interleaved: main tool stayed top level', t.roots[1].node.name, 'Bash')
  check('interleaved: main tool got its own result', t.roots[1].node.result.text, 'main done')
  check('interleaved: nested tool got its own result', t.roots[0].children[0].node.result.text, 'sub done')
}

{
  // A child frame arriving before its parent tool_use is still parented.
  const s = build([txt('early child', 'A'), tu('A', 'Agent', {}), tr('A', 'done')])
  const t = buildTree(s.nodes)
  check('child before parent: single root', t.roots.length, 1)
  check('child before parent: attached anyway', shape(t.roots), [{ 'tool:Agent': ['text'] }])
  check('child before parent: not an orphan', t.orphanCount, 0)
}

{
  // Three levels.
  const s = build([
    tu('A', 'Agent', { subagent_type: 'Explore' }),
    tu('B', 'Agent', { subagent_type: 'general-purpose' }, 'A'),
    tu('C', 'Grep', {}, 'B'),
    tr('C', 'hit', 'B'),
    tr('B', 'inner agent done', 'A'),
    tr('A', 'outer agent done'),
  ])
  const t = buildTree(s.nodes)
  check('recursive nesting', shape(t.roots), [{ 'tool:Agent': [{ 'tool:Agent': ['tool:Grep'] }] }])
  check('deep ancestors', ancestorsOf('C', t.parentOf), ['A', 'B'])
  check('outline nests three deep', JSON.stringify(buildOutline(t.roots)).includes('Grep'), true)
  check('branch size counts descendants', branchSize(t.roots[0]), 2)
}

{
  // Unknown parent id: kept visible at the top level and flagged.
  const s = build([txt('from a vanished agent', 'GHOST'), tu('A', 'Bash', {}), tr('A', 'ok')])
  const t = buildTree(s.nodes)
  check('orphan kept, not dropped', t.roots.length, 2)
  check('orphan counted', t.orphanCount, 1)
  check('orphan flagged with its missing parent', t.roots[0].orphanedParent, 'GHOST')
  check('orphan node still readable', t.roots[0].node.text, 'from a vanished agent')
}

{
  // Self-parenting and mutual cycles must not hang or drop nodes.
  const s = build([tu('A', 'Agent', {}, 'A')])
  const t = buildTree(s.nodes)
  check('self-parent broken to root', t.roots.length, 1)
  check('self-parent flagged', t.roots[0].orphanedParent, 'A')

  const s2 = build([tu('X', 'Agent', {}, 'Y'), tu('Y', 'Agent', {}, 'X')])
  const t2 = buildTree(s2.nodes)
  check('cycle does not hang', t2.roots.length + flattenOutline(buildOutline(t2.roots)).length > 0, true)
  check('cycle keeps both nodes reachable', flattenOutline(buildOutline(t2.roots)).length, 2)
}

// ===========================================================================
console.log('\n== only an agent-spawning call may own a branch ==')

{
  // A frame that merely *references* an ordinary tool's id (progress and
  // telemetry frames do) must not turn that tool into a subagent spawner.
  const s = build([tu('B', 'Bash', { command: 'npm run build' }), txt('still working', 'B'), tr('B', 'ok')])
  const t = buildTree(s.nodes)
  check('non-spawning parent: Bash owns no branch', hasBranch(t.byToolId.get('B')), false)
  check('non-spawning parent: referencing node stays top level', shape(t.roots), ['tool:Bash', 'text'])
  check('non-spawning parent: not an orphan -- the parent exists', t.orphanCount, 0)
  check('non-spawning parent: not flagged as detached', t.roots[1].orphanedParent, undefined)
  check(
    'non-spawning parent: outline does not mark Bash as a spawner',
    buildOutline(t.roots)[0].spawnsSubagent,
    false
  )
  check('non-spawning parent: no jump ancestors invented', ancestorsOf('B', t.parentOf), [])
}

{
  // The identical frame under an Agent call still nests: the gate is the
  // parent's tool, not the presence of parent_tool_use_id.
  const s = build([tu('A', 'Agent', { subagent_type: 'Explore' }), txt('still working', 'A'), tr('A', 'done')])
  const t = buildTree(s.nodes)
  check('spawning parent: Agent still owns its branch', hasBranch(t.byToolId.get('A')), true)
  check('spawning parent: shape', shape(t.roots), [{ 'tool:Agent': ['text'] }])
}

{
  // Task is the other spawning tool, and a Read nested under a Bash id is not
  // subagent activity however deep the ids go.
  const s = build([
    tu('T', 'Task', { subagent_type: 'Explore' }),
    tu('B', 'Bash', {}, 'T'),
    tu('R', 'Read', {}, 'B'),
  ])
  const t = buildTree(s.nodes)
  check('Task spawns, Bash does not', shape(t.roots), [{ 'tool:Task': ['tool:Bash'] }, 'tool:Read'])
  check('ancestors stop at the spawner', ancestorsOf('B', t.parentOf), ['T'])
  check('no ancestors through a non-spawner', ancestorsOf('R', t.parentOf), [])
}

{
  // End to end on a recorded trajectory, with progress frames injected for the
  // Bash-shaped case no recording contains.
  //
  // Reads a fixture rather than a run out of `sessions/runs/`. That directory
  // is runtime output and gitignored -- the recording this used to name was
  // deleted off the machine and took the whole check down with it, and on a
  // fresh clone it was never there at all. What the case actually needs is one
  // recorded Agent call, which `subagent-forward` pins and version control
  // keeps.
  const frames = load(path.join(root, 'fixtures/subagent-forward.jsonl'))
  const agentId = frames
    .flatMap((f) => (f.type === 'assistant' ? (f.message?.content ?? []) : []))
    .find((b) => b?.type === 'tool_use' && b.name === 'Agent')?.id
  const noisy = [
    ...frames,
    tu('B', 'Bash', { command: 'npm run build' }),
    { type: 'tool_progress', parent_tool_use_id: 'B', tool_use_id: 'B' },
    { type: 'tool_progress', parent_tool_use_id: agentId, tool_use_id: agentId },
    tr('B', 'ok'),
  ]
  const t = buildTree(build(noisy).nodes)
  check('recorded agent + progress: Bash stays a plain row', hasBranch(t.byToolId.get('B')), false)
  check('recorded agent + progress: the Agent call keeps its branch', hasBranch(t.byToolId.get(agentId)), true)
  check(
    'recorded agent + progress: no unhandled-event node',
    build(noisy).nodes.some((n) => String(n.text ?? '').startsWith('unhandled event type')),
    false
  )
}

{
  // A non-tool node cannot host children, but nested tools under it survive.
  const s = build([tu('A', 'Agent', {}), tu('S', 'Read', {}, 'A'), tr('S', 'x', 'A')])
  const t = buildTree(s.nodes)
  const items = buildOutline(t.roots)
  check('outline skips prose but keeps nested tools', flattenOutline(items).map((i) => i.name), ['Agent', 'Read'])
}

{
  // buildTree must not mutate the reducer's nodes.
  const s = build([tu('A', 'Agent', {}), tu('S', 'Read', {}, 'A')])
  const before = JSON.stringify(s.nodes)
  buildTree(s.nodes)
  buildTree(s.nodes)
  check('buildTree does not mutate state', JSON.stringify(s.nodes) === before, true)
  check('buildTree is deterministic',
    JSON.stringify(shape(buildTree(s.nodes).roots)) === JSON.stringify(shape(buildTree(s.nodes).roots)), true)
}

console.log(failures === 0 ? '\nAll hierarchy checks passed.\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
