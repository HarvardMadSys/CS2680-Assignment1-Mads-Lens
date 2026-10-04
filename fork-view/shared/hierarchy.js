/**
 * Derives a subagent hierarchy from the flat node list produced by parse.js.
 *
 * Nothing here mutates the reducer's state: `buildTree` reads `nodes` and
 * returns a separate tree of wrappers, so the flat list stays authoritative and
 * the reducer remains useful on its own.
 *
 * Observed schema (fixtures/subagent-forward.jsonl):
 *   - an `Agent` tool_use spawns a subagent
 *   - every frame belonging to that subagent carries the Agent call's id in
 *     `parent_tool_use_id`, including nested tool_use AND their tool_result
 *   - a nested tool_result's own `tool_use_id` is the *nested* tool's id, so
 *     result matching (parse.js) and parenting (here) are independent
 *   - the Agent call's own result arrives with `parent_tool_use_id: null`
 *   - nesting can recurse: a subagent's Agent call parents its own children
 *
 * `parent_tool_use_id` alone is NOT enough to mean "subagent activity": progress
 * and telemetry frames carry the id of the ordinary tool they describe, so
 * nesting on the id alone gives a Bash call a subagent trajectory. Only an
 * agent-spawning call (Agent/Task) may own a branch.
 */
import { SUBAGENT_TOOLS } from './parse.js'
import { estimateCostUsd } from './pricing.js'

/**
 * Does this node spawn a subagent whose frames nest beneath it?
 *
 * Trusts the flag parse.js set, and falls back to the tool name so a node built
 * by something other than the reducer (a test, a future source) still works.
 */
export function isSubagentSpawner(node) {
  if (!node || node.kind !== 'tool') return false
  return node.spawnsSubagent === true || SUBAGENT_TOOLS.has(node.name)
}

/** Stable DOM id for a tool call. Derived from the tool-use id, never a position. */
export function toolDomId(runKey, toolUseId) {
  return `tool-${runKey}-${toolUseId}`
}

/**
 * What one subagent cost, how long it ran, and how many turns it took.
 *
 * Two sources, in order of authority:
 *
 *  1. A `result` frame of its own, nested under the spawning call and carrying
 *     `parent_tool_use_id`. Same shape as the run's result event, so cost and
 *     turns are exact. parse.js routes any such frame to `subagentResults`.
 *     No trajectory recorded in this repo contains one -- of 103 result frames
 *     across 109 files, none carried a `parent_tool_use_id` -- so this path is
 *     here for the shape rather than exercised by the current CLI.
 *
 *  2. The `tool_use_result` sidecar on the spawning call's own tool_result,
 *     which is what every recorded trajectory actually carries. It reports
 *     duration and token totals but *no cost at all*, so cost is priced from
 *     its `usage` and `resolvedModel` and reported as a lower bound -- see
 *     `liveMetrics` in conversation.js for why that bound is sound.
 *
 * Returns null for a call that is not an agent spawner. A spawner that has not
 * come back yet returns a `running` entry so the branch can tick along with it.
 */
export function subagentMetrics(entry, options = {}) {
  const node = entry?.node
  if (!isSubagentSpawner(node)) return null

  const { subagentResults = null, nowMs = null } = options
  const int = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  const nested = node.toolUseId ? subagentResults?.[node.toolUseId] : null
  if (nested) {
    return {
      source: 'result',
      running: false,
      costUsd: int(nested.total_cost_usd),
      costIsLowerBound: false,
      durationMs: int(nested.duration_ms),
      numTurns: int(nested.num_turns),
      totalTokens: null,
    }
  }

  const agent = node.result?.agent
  if (agent) {
    const costUsd = estimateCostUsd(agent.usage, agent.model)
    return {
      source: 'sidecar',
      running: false,
      costUsd,
      // Priced from tokens because the sidecar reports no cost of its own.
      costIsLowerBound: costUsd != null,
      durationMs: int(agent.totalDurationMs),
      // One iteration is one assistant message, which is what a turn counts.
      numTurns: Array.isArray(agent.usage?.iterations)
        ? agent.usage.iterations.length
        : null,
      totalTokens: int(agent.totalTokens),
    }
  }

  // Still out there. Duration ticks from the spawning call; nothing else is
  // known until it reports back, and a zero would read as a finished subagent
  // that cost nothing.
  const startedAt = node.startedAt ? Date.parse(node.startedAt) : NaN
  return {
    source: 'running',
    running: true,
    costUsd: null,
    costIsLowerBound: false,
    durationMs:
      nowMs != null && Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : null,
    numTurns: null,
    totalTokens: null,
  }
}

/**
 * Build a tree of { node, children } from the flat node list.
 *
 * Parenting is purely id-based and done in a second pass, so it does not depend
 * on events arriving in any particular order: a child seen before its parent
 * still attaches correctly.
 *
 * Returns { roots, byToolId, parentOf, orphanCount }.
 */
export function buildTree(nodes, options = {}) {
  const entries = nodes.map((node) => ({ node, children: [] }))

  // Pass 1: index every tool call by its tool-use id.
  const byToolId = new Map()
  for (const entry of entries) {
    if (entry.node.kind === 'tool' && entry.node.toolUseId) {
      byToolId.set(entry.node.toolUseId, entry)
    }
  }

  // Pass 2: attach. Order-independent because every entry already exists.
  const roots = []
  let orphanCount = 0

  for (const entry of entries) {
    const parentId = entry.node.parentToolUseId

    if (!parentId) {
      roots.push(entry)
      continue
    }

    const parent = byToolId.get(parentId)

    if (!parent) {
      // Unknown parent (truncated trajectory, or a resumed session whose
      // spawning call lived in an earlier run). Keep the node visible at the
      // top level and mark why, rather than dropping it.
      entry.orphanedParent = parentId
      orphanCount += 1
      roots.push(entry)
      continue
    }

    if (!isSubagentSpawner(parent.node)) {
      // The parent exists but is an ordinary tool, so this frame merely refers
      // to that call (progress, telemetry) rather than belonging to a subagent
      // it spawned. Not an orphan -- nothing is missing -- so it stays at the
      // top level, unflagged, and the tool keeps its plain single-row shape.
      roots.push(entry)
      continue
    }

    if (parent === entry || createsCycle(parent, entry, byToolId)) {
      entry.orphanedParent = parentId
      orphanCount += 1
      roots.push(entry)
      continue
    }

    parent.children.push(entry)
  }

  // toolId -> parent toolId, for expanding ancestors when jumping.
  const parentOf = new Map()
  for (const [toolId, entry] of byToolId) {
    const parentId = entry.node.parentToolUseId
    const parent = parentId ? byToolId.get(parentId) : null
    // Same gate as the attach pass, so the jump-to-tool chain matches the tree.
    if (parent && isSubagentSpawner(parent.node)) parentOf.set(toolId, parentId)
  }

  // Metrics hang off the entry, not the node: the flat node list stays
  // exactly what parse.js produced, as it does for topology.
  for (const entry of entries) {
    const metrics = subagentMetrics(entry, options)
    if (metrics) entry.metrics = metrics
  }

  return { roots, byToolId, parentOf, orphanCount }
}

/** Would attaching `child` under `parent` close a loop? Defensive only. */
function createsCycle(parent, child, byToolId) {
  if (child.node.kind !== 'tool' || !child.node.toolUseId) return false

  const seen = new Set()
  let cursor = parent

  while (cursor) {
    if (cursor === child) return true

    const id = cursor.node.toolUseId
    if (!id || seen.has(id)) break
    seen.add(id)

    const nextId = cursor.node.parentToolUseId
    cursor = nextId ? byToolId.get(nextId) : null
  }

  return false
}

/** Total node count in a branch, used to decide whether to collapse it. */
export function branchSize(entry) {
  return entry.children.reduce((total, child) => total + 1 + branchSize(child), 0)
}

/**
 * Does this entry own a subagent trajectory? `buildTree` only ever gives
 * children to an agent-spawning call, so child count is the whole test.
 */
export function hasBranch(entry) {
  return entry.children.length > 0
}

/**
 * Outline of tool calls only -- no prose, no results. Mirrors the tree so the
 * subagent hierarchy is preserved.
 *
 * Each item: { toolUseId, name, label, status, spawnsSubagent, depth, children }
 */
export function buildOutline(roots, depth = 0) {
  const items = []

  for (const entry of roots) {
    if (entry.node.kind === 'tool') {
      items.push({
        toolUseId: entry.node.toolUseId,
        name: entry.node.name,
        label: entry.node.label ?? '',
        status: entry.node.status,
        spawnsSubagent: isSubagentSpawner(entry.node),
        agentType: entry.node.spawnedAgentType ?? null,
        orphanedParent: entry.orphanedParent ?? null,
        metrics: entry.metrics ?? null,
        depth,
        children: buildOutline(entry.children, depth + 1),
      })
      continue
    }

    // A non-tool node cannot appear in the outline, but anything nested under
    // it still can, so keep walking rather than pruning the subtree.
    items.push(...buildOutline(entry.children, depth))
  }

  return items
}

/**
 * Split one level's siblings into the runs that ran in parallel and the ones
 * that ran in sequence.
 *
 * Only *adjacent spawning calls* count as parallel, and only two or more of
 * them. That is the shape parallel subagents actually arrive in -- several Task
 * blocks emitted in a single assistant turn -- and the restriction is what
 * keeps everything else sequential: a subagent that read five files ran those
 * reads one after another, so laying them out side by side would claim a
 * concurrency the run never had. A lone spawner has nothing to sit beside.
 *
 * Both views group with this one function, so a fan-out in the outline and a
 * row of cards in the trajectory can never disagree about what ran together.
 * `spawns` reads the flag off whatever shape the caller holds -- tree entries in
 * the trajectory, outline items in the sidebar.
 *
 * Returns `[{ parallel, items }]` in the original order.
 */
export function groupParallel(items, spawns) {
  const groups = []

  for (const item of items) {
    const open = groups[groups.length - 1]

    if (spawns(item) && open?.parallel) open.items.push(item)
    else groups.push({ parallel: Boolean(spawns(item)), items: [item] })
  }

  // A group of one is just a call that happens to spawn something; it stays in
  // the column like any other.
  return groups.map((group) =>
    group.parallel && group.items.length > 1 ? group : { ...group, parallel: false }
  )
}

/** Flattened outline, useful for counting and for tests. */
export function flattenOutline(items) {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)])
}

/**
 * Chain of ancestor tool ids for a tool, outermost first. Used to expand
 * collapsed branches before scrolling to a nested tool call.
 */
export function ancestorsOf(toolUseId, parentOf) {
  const chain = []
  const seen = new Set()
  let cursor = parentOf.get(toolUseId)

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    chain.unshift(cursor)
    cursor = parentOf.get(cursor)
  }

  return chain
}
