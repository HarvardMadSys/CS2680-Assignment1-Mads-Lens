import { splitInput } from '@shared/parse.js'
import {
  branchSize,
  groupParallel,
  hasBranch,
  isSubagentSpawner,
  toolDomId,
} from '@shared/hierarchy.js'
import { formatCostBound } from '@shared/conversation.js'
import Collapsible from './Collapsible.jsx'
import Markdown from './Markdown.jsx'
import ToolIcon, { iconKey, StatusIcon } from './ToolIcon.jsx'
import { resultPeek, toolSummary } from './summary.js'

/** Branches larger than this start collapsed. */
export const LARGE_BRANCH = 6

function Raw({ event, show }) {
  if (!show) return null

  return (
    <details className="raw">
      <summary>raw event</summary>
      <pre>{JSON.stringify(event, null, 2)}</pre>
    </details>
  )
}

function formatDuration(ms) {
  if (ms == null) return null
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function ToolResult({ result }) {
  if (!result) return null

  // Prefer the structured stdout/stderr from `tool_use_result`; fall back to
  // the flat tool_result content for tools that do not provide it.
  const hasStd = result.stdout != null || result.stderr != null
  const stdoutEmpty = hasStd && !result.stdout?.trim() && !result.stderr

  if (stdoutEmpty) return <div className="block-empty">(no output)</div>

  if (hasStd) {
    return (
      <>
        {result.stdout?.trim() && <Collapsible text={result.stdout} label="stdout" />}
        {result.stderr && <Collapsible text={result.stderr} label="stderr" tone="error" />}
      </>
    )
  }

  if (!result.text?.trim()) return <div className="block-empty">(no output)</div>

  // Always label the result so it is never mistaken for the tool's input.
  return (
    <Collapsible
      text={result.text}
      label={result.isError ? 'error' : 'output'}
      tone={result.isError ? 'error' : 'default'}
    />
  )
}

function AgentSummary({ agent }) {
  if (!agent) return null

  const bits = [
    agent.agentType,
    agent.status,
    agent.totalToolUseCount != null && `${agent.totalToolUseCount} tool calls`,
    agent.totalTokens != null && `${agent.totalTokens} tokens`,
    formatDuration(agent.totalDurationMs),
  ].filter(Boolean)

  return <div className="agent-summary">{bits.join(' · ')}</div>
}

/**
 * What the subagent cost, how long it ran, how many turns it took -- read off
 * the branch header, in the same order and the same words the run header uses
 * for the run as a whole.
 *
 * A figure that is genuinely unknown is left out rather than shown as zero: a
 * subagent still running has no cost yet, and the sidecar the CLI actually
 * emits carries no cost at all, so what is shown there is priced from its
 * tokens and marked as a lower bound with the same "at least" sign as the
 * status bar. The tooltip says which it is, so the number is never ambiguous.
 */
function BranchMetrics({ metrics }) {
  if (!metrics) return null

  const parts = []
  const cost = formatCostBound(metrics.costUsd, metrics.costIsLowerBound)
  if (cost) parts.push(cost)

  const duration = formatDuration(metrics.durationMs)
  if (duration) parts.push(duration)

  if (metrics.numTurns != null) {
    parts.push(`${metrics.numTurns} turn${metrics.numTurns === 1 ? '' : 's'}`)
  }

  if (!parts.length) return null

  const title = metrics.running
    ? 'Still running: elapsed time so far. Cost and turns are reported when it finishes.'
    : metrics.costIsLowerBound
      ? 'This subagent reports no cost of its own, so cost is priced from the tokens it reported -- at least this much, likely more.'
      : 'Reported by the subagent\u2019s own result frame.'

  return (
    <span className={`branch-metrics${metrics.running ? ' branch-metrics-live' : ''}`} title={title}>
      {parts.join(' \u00b7 ')}
    </span>
  )
}

/**
 * A run of sibling entries, with parallel subagents laid out as a row of cards.
 *
 * Adjacent spawning calls ran at the same time, so they are lifted out of the
 * vertical flow into one container and given equal width -- side by side when
 * the column can hold them, stacked when it cannot, which the grid decides on
 * its own. Everything else renders in sequence exactly as before.
 *
 * `groupParallel` is the same function the outline groups with, so the sidebar
 * and the trajectory can never disagree about which calls ran together.
 */
export function TreeNodes({ entries, ctx }) {
  return groupParallel(entries, (entry) => isSubagentSpawner(entry.node)).map((group) =>
    group.parallel ? (
      <div
        key={group.items[0].node.id}
        className="agent-row"
        style={{ '--cards': group.items.length }}
      >
        {group.items.map((entry) => (
          <TreeNode key={entry.node.id} entry={entry} ctx={ctx} />
        ))}
      </div>
    ) : (
      <TreeNode key={group.items[0].node.id} entry={group.items[0]} ctx={ctx} />
    )
  )
}

/**
 * The subagent trajectory owned by an Agent/Task call. An indented execution
 * branch rather than a nested card: one connector line, the same row language
 * as the main flow, and recursive so a subagent that spawns its own subagent
 * indents one step further.
 *
 * It sits beside the spawning call's detail rather than inside it, so the
 * branch stays part of the visible flow even while that call's raw input and
 * output are folded away.
 */
function Branch({ entry, ctx }) {
  const toolId = entry.node.toolUseId
  const size = branchSize(entry)
  const open = ctx.isBranchOpen(toolId, size > LARGE_BRANCH)
  const agentType = entry.node.spawnedAgentType ?? entry.children[0]?.node.subagentType

  return (
    <div className={`branch${open ? '' : ' branch-collapsed'}`}>
      <button
        className="branch-head"
        onClick={() => ctx.toggleBranch(toolId, !open)}
        aria-expanded={open}
      >
        <span className="branch-caret">{open ? '▾' : '▸'}</span>
        <span className="branch-title">subagent trajectory</span>
        {agentType && <span className="branch-agent">{agentType}</span>}
        <span className="meta">
          {size} step{size === 1 ? '' : 's'}
        </span>
        <BranchMetrics metrics={entry.metrics} />
        {!open && <span className="more-hint">show</span>}
      </button>

      <AgentSummary agent={entry.node.result?.agent} />

      {open && (
        <div className="branch-body">
          <TreeNodes entries={entry.children} ctx={ctx} />
        </div>
      )}
    </div>
  )
}

/**
 * A tool call is a single row by default -- status, name, target, outcome --
 * and opens into its full input and output on click. The row is the execution
 * flow; the detail is evidence you ask for.
 */
function ToolNode({ entry, ctx }) {
  const node = entry.node
  const toolId = node.toolUseId
  const open = ctx.isToolOpen(toolId)
  const { primary, rest } = splitInput(node.input)
  const duration = formatDuration(node.durationMs)
  const branch = hasBranch(entry)
  const step = ctx.stepOf(toolId)
  const isActive = ctx.activeToolId === toolId
  const target = toolSummary(node)
  // Shown while the row is closed, so folded detail is never silent.
  const peek = open ? null : resultPeek(node)
  // A call the reader cancelled out from under is drawn with the stop mark
  // rather than the generic "no result" ring -- same node, same status, a mark
  // that says which of the two ways it was left unfinished.
  const mark =
    node.status === 'incomplete' && ctx.runStatus === 'stopped' ? 'stopped' : node.status

  return (
    <div
      id={toolDomId(ctx.runKey, toolId)}
      className={`node tool tool-${node.status}${branch ? ' tool-spawner' : ''}${
        isActive ? ' tool-active' : ''
      }${open ? ' tool-open' : ''}`}
    >
      <button
        className="tool-head"
        onClick={() => ctx.toggleTool(toolId, !open)}
        aria-expanded={open}
        title={node.label || node.name}
      >
        {step != null && <span className="tool-step">{step}</span>}
        <span className={`tool-badge badge-${iconKey(node.name)}`}>
          <ToolIcon name={node.name} />
          <span className="tool-name">{node.name}</span>
        </span>
        {target && <span className="tool-target">{target}</span>}
        <span className="spacer" />
        {peek && <span className={`tool-peek peek-${peek.tone}`}>{peek.text}</span>}
        {branch && <span className="branch-badge">subagent</span>}
        {duration && <span className="tool-duration">{duration}</span>}
        {/* The outcome sits where the eye leaves the row, as a mark rather
            than a character -- the column of them is the thing a reader scans
            a long trajectory down. */}
        <span className={`glyph glyph-${mark}`}>
          <StatusIcon status={mark} />
        </span>
        <span className="chevron">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="tool-body">
          {primary && <Collapsible text={primary.text} label={primary.field} tone="input" />}
          {rest && <Collapsible text={JSON.stringify(rest, null, 2)} label="input" tone="json" />}
          {!primary && !rest && <div className="block-empty">(no input)</div>}

          {node.status === 'running' && <div className="block-empty running">{'running…'}</div>}
          {node.status === 'incomplete' && (
            <div className="block-empty warn">no result arrived before the run ended</div>
          )}
          {node.result?.interrupted && <div className="block-empty warn">interrupted</div>}
          {!branch && <AgentSummary agent={node.result?.agent} />}
          <ToolResult result={node.result} />
        </div>
      )}

      {branch && <Branch entry={entry} ctx={ctx} />}

      {entry.orphanedParent && (
        <div className="node notice notice-warn">
          <span className="notice-text">
            parent tool call {entry.orphanedParent} is not in this trajectory
          </span>
        </div>
      )}

      <Raw event={node.raw} show={ctx.showRaw} />
    </div>
  )
}

/**
 * Renders one tree entry. A node with no children renders exactly as it did
 * before the hierarchy existed, so ordinary runs stay flat.
 */
export default function TreeNode({ entry, ctx }) {
  const node = entry.node
  const orphanNote = entry.orphanedParent ? (
    <div className="orphan-note">
      detached from missing parent {entry.orphanedParent.slice(0, 16)}
    </div>
  ) : null

  switch (node.kind) {
    case 'tool':
      return <ToolNode entry={entry} ctx={ctx} />

    case 'text':
      return (
        <div className="node text">
          {orphanNote}
          <Markdown text={node.text} />
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'user_text':
      return (
        <div className="node user-text">
          {/* With a parent this is the task handed to a subagent, not the user. */}
          <div className="node-tag">
            {node.parentToolUseId ? 'subagent task' : 'user'}
            {node.subagentType ? ` · ${node.subagentType}` : ''}
          </div>
          {orphanNote}
          <Markdown text={node.text} />
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'thinking':
      return (
        <div className="node thinking">
          {node.redacted ? 'redacted thinking' : 'thinking'}
          {node.tokens ? ` · ~${node.tokens} tokens` : ''}
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'orphan_tool_result':
      return (
        <div className="node tool tool-error">
          <div className="tool-head static">
            <span className="glyph glyph-error">
              <StatusIcon status="error" />
            </span>
            <ToolIcon name={null} />
            <span className="tool-name">unmatched tool result</span>
            <span className="tool-target">{node.toolUseId ?? '(no id)'}</span>
          </div>
          <div className="tool-body">
            <ToolResult result={node.result} />
          </div>
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'result':
      return (
        <div className={`node result ${node.isError ? 'result-error' : ''}`}>
          <div className="node-tag">
            <StatusIcon status={node.isError ? 'error' : 'completed'} className="result-mark" />
            <span>final result</span>
            {node.subtype && <span className="result-subtype">{node.subtype}</span>}
          </div>
          {node.text ? <Markdown text={node.text} /> : <div className="block-empty">(empty)</div>}
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'notice':
      return (
        <div className={`node notice notice-${node.level}`}>
          <span className="notice-text">{node.text}</span>
          {node.detail && <Collapsible text={node.detail} tone="error" />}
          <Raw event={node.raw} show={ctx.showRaw} />
        </div>
      )

    case 'unknown':
    case 'unknown_block':
      return (
        <div className="node notice notice-info">
          <span className="notice-text">
            {node.text ?? `unhandled content block: ${node.blockType}`}
          </span>
          <Raw event={node.raw} show />
        </div>
      )

    default:
      return null
  }
}
