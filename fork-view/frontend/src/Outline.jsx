import { groupParallel } from '@shared/hierarchy.js'
import ToolIcon, { iconKey } from './ToolIcon.jsx'

const STATUS_WORD = {
  running: 'running',
  completed: 'completed',
  error: 'failed',
  incomplete: 'no result',
}

/**
 * Everything the token does not show, assembled for the tooltip.
 *
 * The token itself is the tool's name -- nothing else -- so its number in the
 * run, its target, its outcome and its subagent type have to live somewhere
 * reachable. `title` is that somewhere: available on hover, invisible to the
 * layout, and not part of the element's text, so the outline still reads as a
 * set of tool names.
 */
function describe(item, step) {
  const bits = [
    step != null && `${step}.`,
    item.name,
    item.agentType && `(${item.agentType})`,
    item.label && `— ${item.label}`,
  ].filter(Boolean)

  const status = STATUS_WORD[item.status]
  const lines = [bits.join(' ')]

  if (status) lines.push(status)
  if (item.orphanedParent) lines.push(`detached from missing parent ${item.orphanedParent}`)

  return lines.join(' · ')
}

/** Which siblings ran together. Shared with the trajectory so the outline's
 *  fan-out and the trajectory's row of cards always describe the same run. */
const groupSiblings = (items) => groupParallel(items, (item) => item.spawnsSubagent)

/**
 * One node: its tool as a text token, then its children.
 *
 * The token and the child list are siblings inside the <li>, and the token is
 * wrapped so it has a box of its own -- the wrapper is what a fork hangs its
 * drop line from, which keeps the connector attached to the token rather than
 * to the whole subtree below it.
 */
function Node({ item, onJump, activeToolId, stepOf }) {
  const step = stepOf(item.toolUseId)
  const classes = [
    'outline-item',
    `outline-kind-${iconKey(item.name)}`,
    `outline-${item.status}`,
    item.spawnsSubagent && 'outline-spawner',
    item.toolUseId === activeToolId && 'outline-active',
  ].filter(Boolean)

  return (
    <li className="outline-branch">
      <div className="outline-node">
        <button
          className={classes.join(' ')}
          onClick={() => onJump(item.toolUseId)}
          title={describe(item, step)}
        >
          <ToolIcon name={item.name} className="outline-glyph" />
          <span className="outline-name">{item.name}</span>
        </button>
      </div>

      {item.children.length > 0 && (
        <Level
          items={item.children}
          onJump={onJump}
          activeToolId={activeToolId}
          stepOf={stepOf}
        />
      )}
    </li>
  )
}

/**
 * One level of the tree, as one more stretch of the same column.
 *
 * Depth costs no indent. A subagent's calls are the run continuing, so they sit
 * on the same thread as everything else and the branch is told by the Task
 * token at its head; indenting each level instead would spend the sidebar's
 * width on whitespace, which is the one thing a fixed narrow column cannot
 * afford. Each level is still its own <ul>, because that is what carries the
 * hairline behind its own tokens.
 *
 * Parallel subagents are the exception, and they break the column deliberately.
 * A run of adjacent spawning calls is lifted into a nested `.outline-fork` list
 * laid out with flexbox, so the branches sit side by side under a shared
 * crossbar and rejoin under a second one -- the picture says they ran at the
 * same time and then the run carried on, which a vertical list cannot. The
 * branch count goes with it as `--branches`: equal-width branches put the
 * outermost centres half a branch in from each edge, and that closing bar is
 * the one connector CSS cannot place without knowing how many there are.
 *
 * `root` is carried only so the top level can start its thread at the first
 * token -- above it there is nothing left to connect to.
 */
function Level({ items, root = false, onJump, activeToolId, stepOf }) {
  const pass = { onJump, activeToolId, stepOf }

  return (
    <ul className={`outline-list${root ? ' outline-root' : ''}`}>
      {groupSiblings(items).map((group) =>
        group.parallel ? (
          <li key={group.items[0].toolUseId} className="outline-branch outline-fork-slot">
            <ul
              className="outline-list outline-fork"
              style={{ '--branches': group.items.length }}
            >
              {group.items.map((item) => (
                <Node key={item.toolUseId} item={item} {...pass} />
              ))}
            </ul>
          </li>
        ) : (
          <Node key={group.items[0].toolUseId} item={group.items[0]} {...pass} />
        )
      )}
    </ul>
  )
}

/**
 * Tool-call outline for one run, rendered straight from the tree `hierarchy.js`
 * builds. Tool names only -- no targets, no prose, no results -- so the outline
 * reads as the shape of the run rather than a second copy of it; everything
 * else sits in each token's tooltip instead.
 *
 * This is a table of contents, so it is built to a fixed narrow column and
 * stays there. Each call is one small monospaced chip carrying its tool's name,
 * set several steps smaller than the trajectory beside it and tinted by what
 * kind of call it is, so the palette answers "what happened here" before a
 * single name is read. The chips are threaded onto a single hairline running
 * down the centre of the column -- drawn behind them and visible only in the
 * gaps -- which forks into side-by-side columns where subagents ran in parallel
 * and closes back up where they rejoined, so a branch is visible as a branch
 * rather than as text that starts further right. Parallel branches divide the
 * column between them rather than widening it: names ellipsize, the sidebar
 * does not move, and the outline never scrolls sideways. Clicking a chip jumps
 * to that tool call via its stable DOM id. Deliberately secondary: quieter than
 * the conversation, and foldable.
 */
export default function Outline({
  items,
  open,
  onToggle,
  onJump,
  count,
  activeToolId,
  stepOf,
}) {
  if (!items.length) return null

  return (
    <aside className={`outline${open ? '' : ' outline-closed'}`}>
      <button className="outline-head" onClick={onToggle} aria-expanded={open}>
        <span>outline</span>
        <span className="outline-caret">{open ? '▾' : '▸'}</span>
        <span className="meta">{count}</span>
      </button>
      {open && (
        <Level
          items={items}
          root
          onJump={onJump}
          activeToolId={activeToolId}
          stepOf={stepOf}
        />
      )}
    </aside>
  )
}
