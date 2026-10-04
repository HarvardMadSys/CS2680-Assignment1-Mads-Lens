import { useCallback, useMemo, useState } from 'react'

import {
  formatCost,
  formatDuration,
  redundantTextIds,
  runMetrics,
  sessionChanged,
} from '@shared/conversation.js'
import {
  ancestorsOf,
  buildOutline,
  buildTree,
  flattenOutline,
  toolDomId,
} from '@shared/hierarchy.js'
import Outline from './Outline.jsx'
import { TreeNodes } from './Trajectory.jsx'

const WIDE_SCREEN = '(min-width: 900px)'

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${value == null ? ' metric-missing' : ''}`}>
        {value ?? 'unavailable'}
      </span>
    </div>
  )
}

/**
 * Metrics come from this run's own `result` frame. A run that failed before
 * producing one shows why instead of displaying zeroes.
 */
function Metrics({ run }) {
  const metrics = runMetrics(run)

  if (!metrics.available) {
    if (!['completed', 'failed', 'stopped'].includes(run.trajectory.status)) return null

    return (
      <div className="metrics metrics-none">
        no result event &mdash; metrics unavailable for this run
      </div>
    )
  }

  return (
    <div className="metrics">
      <Metric label="cost" value={formatCost(metrics.costUsd)} />
      <Metric label="duration" value={formatDuration(metrics.durationMs)} />
      <Metric label="turns" value={metrics.numTurns ?? null} />
    </div>
  )
}

/**
 * The run's own facts, as a bordered card in the sidebar rather than a strip of
 * text in the header.
 *
 * The header answers "which run am I in"; this answers "what did it cost, how
 * long did it take, which session was it". Those are reference figures -- read
 * once, then glanced back at -- so they belong beside the trajectory, not
 * threaded through the row that has to stay legible while it is stuck to the
 * top of the screen.
 *
 * `Metrics` is reused verbatim, so a run with no result frame still says so
 * here rather than showing zeroes.
 */
function RunMeta({ run }) {
  const { trajectory } = run

  const rows = [
    trajectory.sessionId && {
      key: 'session id',
      full: trajectory.sessionId,
      short: `${trajectory.sessionId.slice(0, 8)}…`,
    },
    run.startedAt && {
      key: 'started',
      full: run.startedAt,
      short: new Date(run.startedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    },
    run.cwd && { key: 'working dir', full: run.cwd, short: run.cwd },
  ].filter(Boolean)

  return (
    <div className="run-meta">
      <div className="run-meta-head">run metadata</div>

      <div className="run-meta-row">
        <span className="run-meta-key">status</span>
        <span className={`pill pill-${trajectory.status}`}>{trajectory.status}</span>
      </div>

      <Metrics run={run} />

      {rows.map((row) => (
        <div className="run-meta-row" key={row.key}>
          <span className="run-meta-key">{row.key}</span>
          <span className="run-meta-val" title={row.full}>
            {row.short}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Enough of a prompt to tell two runs apart in a 264px column. */
function excerpt(text, max = 52) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Every run in the conversation, as a jump list.
 *
 * A run's output is long -- a deep trajectory is thousands of pixels -- so by
 * the third follow-up, finding run 2 again means scrolling past everything run
 * 3 did. This is the table of contents one level up from the outline: the
 * outline indexes the calls inside a run, this indexes the runs.
 *
 * It sits at the top of the sticky sidebar rather than once at the top of the
 * page, so it is in reach wherever the reader has got to. Below two runs there
 * is nothing to navigate between, so it does not appear at all.
 *
 * Scrolling is done against the section's own DOM id rather than through
 * state, for the same reason the outline's jump is: the target is already
 * rendered, and routing a scroll through the reducer would make a navigation
 * aid part of the conversation's data.
 */
function RunIndex({ runs, currentKey }) {
  if (!runs || runs.length < 2) return null

  const jump = (key) => {
    const el = document.getElementById(runDomId(key))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <nav className="run-index">
      <div className="run-index-head">runs</div>
      <ol className="run-index-list">
        {runs.map((item) => (
          <li key={item.key}>
            <button
              className={`runjump runjump-${item.status}${
                item.key === currentKey ? ' runjump-current' : ''
              }`}
              onClick={() => jump(item.key)}
              aria-current={item.key === currentKey ? 'true' : undefined}
              title={item.prompt || `Run ${item.index}`}
            >
              <span className="runjump-n">{item.index}</span>
              <span className="runjump-text">
                {excerpt(item.prompt) || 'no prompt recorded'}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Where the jump list scrolls to. One per run, stable for its lifetime. */
const runDomId = (key) => `run-${key}`

/**
 * One run of the conversation.
 *
 * `expandAll` is the run-wide default for tool detail. Tool calls read as
 * compact rows out of the box; this flips every row open at once, and the
 * per-tool overrides still win afterwards.
 */
export default function Run({
  run,
  runIndex = null,
  showRaw,
  expandAll = false,
  nowMs = null,
}) {
  const { trajectory } = run
  const changed = sessionChanged(run)

  // Open/closed overrides. Absent means "use the default", so newly streamed
  // nodes pick up sensible defaults without being fought by stale state.
  const [toolOverrides, setToolOverrides] = useState(() => new Map())
  const [branchOverrides, setBranchOverrides] = useState(() => new Map())
  const [detailsOpen, setDetailsOpen] = useState(expandAll)
  // A finished run can be folded away to a single line once it has been read.
  // Open by default, always: a run that hid its own output the moment it landed
  // would be hiding the thing the page exists to show.
  const [collapsed, setCollapsed] = useState(false)

  const [outlineOpen, setOutlineOpen] = useState(
    () =>
      typeof window === 'undefined' || window.matchMedia?.(WIDE_SCREEN).matches !== false
  )

  // Derived from the flat node list every render; the reducer state is never
  // mutated into a tree.
  // A running subagent's elapsed time has to come from somewhere, and a value
  // read during render would never tick; `nowMs` is supplied by the caller and
  // refreshed on the same one-second beat as the status bar.
  //
  // It is only let through while this run is actually streaming. A finished run
  // has no elapsed time left to count, and letting the clock into its
  // dependencies would rebuild the whole tree once a second for every run on
  // the page -- including, during a live run, every completed run above it.
  const tick = trajectory.status === 'running' ? nowMs : null
  const { roots, parentOf } = useMemo(
    () =>
      buildTree(trajectory.nodes, {
        subagentResults: trajectory.subagentResults,
        nowMs: tick,
      }),
    [trajectory.nodes, trajectory.subagentResults, tick]
  )
  const outline = useMemo(() => buildOutline(roots), [roots])
  const flatOutline = useMemo(() => flattenOutline(outline), [outline])

  // Stable step numbers shared by the outline and the tool rows, so the two
  // views are easy to map onto each other in a long trajectory.
  const stepOf = useMemo(() => {
    const map = new Map()
    flatOutline.forEach((item, i) => map.set(item.toolUseId, i + 1))
    return map
  }, [flatOutline])

  // The result frame usually repeats the assistant's closing paragraph, and
  // the result block is the better place for it: it is labelled, and it is
  // where a reader looks for the answer. The node stays in the trajectory and
  // in the raw log -- only this view skips it.
  const mutedNodeIds = useMemo(() => redundantTextIds(trajectory), [trajectory])

  const activeToolId = useMemo(() => {
    if (trajectory.status !== 'running') return null
    for (let i = trajectory.nodes.length - 1; i >= 0; i -= 1) {
      const node = trajectory.nodes[i]
      if (node.kind === 'tool' && node.status === 'running') return node.toolUseId
    }
    return null
  }, [trajectory.nodes, trajectory.status])

  const setOverride = (setter) => (id, value) =>
    setter((previous) => new Map(previous).set(id, value))

  const ctx = useMemo(
    () => ({
      runKey: run.key,
      showRaw,
      activeToolId,
      // Only so a call left pending by a cancellation can draw the stop mark
      // rather than the generic "no result" ring. The node's own status stays
      // `incomplete`, which is what actually happened to it.
      runStatus: trajectory.status,
      stepOf: (id) => stepOf.get(id) ?? null,
      isToolOpen: (id) => toolOverrides.get(id) ?? detailsOpen,
      isBranchOpen: (id, collapsedByDefault) =>
        branchOverrides.get(id) ?? !collapsedByDefault,
      toggleTool: setOverride(setToolOverrides),
      toggleBranch: setOverride(setBranchOverrides),
    }),
    [
      run.key,
      showRaw,
      activeToolId,
      trajectory.status,
      stepOf,
      toolOverrides,
      branchOverrides,
      detailsOpen,
    ]
  )

  // Flipping the run-wide default also drops the per-tool overrides, otherwise
  // "expand all" would silently skip rows the reader had closed by hand.
  const toggleAllDetail = () => {
    setDetailsOpen((value) => !value)
    setToolOverrides(new Map())
  }

  // Jumping to a nested tool has to open every branch and row above it first,
  // otherwise the target is not in the DOM to scroll to.
  const onJump = useCallback(
    (toolUseId) => {
      const chain = ancestorsOf(toolUseId, parentOf)

      if (chain.length) {
        setBranchOverrides((previous) => {
          const next = new Map(previous)
          for (const id of chain) next.set(id, true)
          return next
        })
      }

      // Let the expansion render before scrolling.
      requestAnimationFrame(() => {
        const el = document.getElementById(toolDomId(run.key, toolUseId))
        if (!el) return
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('jump-target')
        setTimeout(() => el.classList.remove('jump-target'), 1600)
      })
    },
    [parentOf, run.key]
  )

  return (
    <section
      className={`run run-${trajectory.status}${collapsed ? ' run-folded' : ''}`}
      id={runDomId(run.key)}
    >
      <header className="run-head">
        <button
          className="run-fold"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          title={collapsed ? `Show run ${run.index}` : `Collapse run ${run.index}`}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="run-number">Run {run.index}</span>
        <span className={`pill pill-${trajectory.status}`}>{trajectory.status}</span>

        {run.requestedResumeSessionId ? (
          <span className="meta" title={run.requestedResumeSessionId}>
            resumed {run.requestedResumeSessionId.slice(0, 8)}
          </span>
        ) : (
          <span className="meta">new session</span>
        )}

        {changed && (
          <span className="meta warn" title={trajectory.sessionId}>
            session id changed to {trajectory.sessionId.slice(0, 8)}
          </span>
        )}

        <span className="spacer" />

        {!collapsed && (
          <button
            className="expand-all"
            onClick={toggleAllDetail}
            aria-pressed={detailsOpen}
          >
            {detailsOpen ? 'collapse all' : 'expand all'}
          </button>
        )}

        {run.jsonlPath && (
          <span className="meta run-path" title={run.jsonlPath}>
            {run.jsonlPath}
          </span>
        )}
      </header>

      {collapsed && (
        <button className="run-stub" onClick={() => setCollapsed(false)}>
          <span className="run-stub-text">
            {run.prompt || <span className="block-empty">(prompt not recorded)</span>}
          </span>
          <span className="spacer" />
          <span className="meta">
            {flatOutline.length} tool call{flatOutline.length === 1 ? '' : 's'}
          </span>
          <span className="more-hint">show</span>
        </button>
      )}

      {!collapsed && (
        <>
          <div className="run-prompt">
            <span className="run-prompt-tag">You</span>
            <div className="run-prompt-text">
              {run.prompt || <span className="block-empty">(prompt not recorded)</span>}
            </div>
          </div>

          <div className="run-body">
            <div className="trajectory">
              <TreeNodes
                entries={roots.filter((entry) => !mutedNodeIds.has(entry.node.id))}
                ctx={ctx}
              />
              {trajectory.nodes.length === 0 && trajectory.status === 'running' && (
                <div className="block-empty">{'waiting for the first event…'}</div>
              )}
            </div>

            {/* The sidebar column: the table of contents, then the run's own
              facts. Both are cards, and they scroll with the run as one unit --
              the outline keeps its own internal scrolling for a long run. */}
            <div className="run-side">
              <RunIndex runs={runIndex} currentKey={run.key} />

              <Outline
                items={outline}
                count={flatOutline.length}
                open={outlineOpen}
                activeToolId={activeToolId}
                stepOf={(id) => stepOf.get(id) ?? null}
                onToggle={() => setOutlineOpen((value) => !value)}
                onJump={onJump}
              />

              <RunMeta run={run} />
            </div>
          </div>

          {!collapsed && ['completed', 'failed', 'stopped'].includes(trajectory.status) && (
            <div className="run-close">
              <button className="run-close-btn" onClick={() => setCollapsed(true)}>
                {`▴ collapse run ${run.index}`}
              </button>
            </div>
          )}

          {trajectory.rawEvents.length > 0 && (
            <details className="event-log">
              <summary>
                Raw event log ({trajectory.rawEvents.length} frames
                {trajectory.hiddenCount > 0 && `, ${trajectory.hiddenCount} filtered`})
              </summary>
              <pre>
                {trajectory.rawEvents
                  .map((e, i) => `${String(i).padStart(3)}  ${JSON.stringify(e)}`)
                  .join('\n')}
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  )
}
