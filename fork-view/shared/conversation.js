/**
 * Conversation layer.
 *
 * A conversation is an ordered list of runs that share one Claude Code session.
 * Each run owns its own trajectory, produced by the unchanged per-run reducer in
 * parse.js -- this layer only routes events to the right run and tracks the
 * session id that ties them together. There is no second parser.
 *
 * Replay uses the same shape: a saved JSONL is a conversation of exactly one
 * run, so the renderer does not care which mode produced it.
 */

import { initialState, reduce } from './parse.js'
import { addUsage, emptyUsage, estimateCostUsd } from './pricing.js'

// A stopped run is over. It is listed here so the composer unlocks and a
// follow-up can be sent, exactly as after any other ending.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped'])

export function initialConversation(mode = null) {
  return {
    mode, // 'live' | 'replay' | null
    sessionId: null, // latest session id reported by the CLI
    cwd: null,
    runs: [],
    nextIndex: 1,
  }
}

export function conversationReducer(state, action) {
  switch (action.type) {
    case 'conversation/reset':
      return initialConversation(action.mode ?? null)

    case 'conversation/startRun': {
      const run = {
        key: action.key,
        index: state.nextIndex,
        prompt: action.prompt ?? '',
        cwd: action.cwd ?? state.cwd ?? null,
        // What we asked the CLI to resume. null means "start a new session".
        requestedResumeSessionId: action.resumeSessionId ?? null,
        runId: null,
        jsonlPath: null,
        startedAt: action.startedAt ?? null,
        trajectory: initialState(),
      }

      return {
        ...state,
        mode: action.mode ?? state.mode,
        cwd: run.cwd ?? state.cwd,
        runs: [...state.runs, run],
        nextIndex: state.nextIndex + 1,
      }
    }

    case 'conversation/runMeta':
      return {
        ...state,
        runs: state.runs.map((run) =>
          run.key === action.key
            ? {
                ...run,
                runId: action.runId ?? run.runId,
                jsonlPath: action.jsonlPath ?? run.jsonlPath,
              }
            : run
        ),
      }

    case 'conversation/event': {
      let updated = null

      const runs = state.runs.map((run) => {
        if (run.key !== action.key) return run
        updated = { ...run, trajectory: reduce(run.trajectory, action.event) }
        return updated
      })

      if (!updated) return state

      // Adopt whatever session id the CLI last reported. A resumed run is not
      // guaranteed to hand back the id we asked it to resume, so the next
      // follow-up always uses the most recently observed one.
      return {
        ...state,
        runs,
        sessionId: updated.trajectory.sessionId ?? state.sessionId,
      }
    }

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// derived helpers -- pure, so components stay dumb
// ---------------------------------------------------------------------------

export function activeRun(state) {
  return state.runs.length ? state.runs[state.runs.length - 1] : null
}

export function isRunTerminal(run) {
  return Boolean(run) && TERMINAL_STATUSES.has(run.trajectory.status)
}

/** True while the most recent run has not reached a terminal state. */
export function isBusy(state) {
  const run = activeRun(state)
  return Boolean(run) && !isRunTerminal(run)
}

/** A follow-up is only allowed once the previous run has finished. */
export function canSubmit(state) {
  return state.mode !== 'replay' && !isBusy(state)
}

/** The session id a new run should resume, or null to start fresh. */
export function resumeTarget(state) {
  return state.sessionId ?? null
}

/**
 * Did this run come back under a different session id than we asked for?
 * Worth surfacing rather than silently assuming resume identity.
 */
export function sessionChanged(run) {
  const observed = run.trajectory.sessionId
  return Boolean(
    run.requestedResumeSessionId && observed && observed !== run.requestedResumeSessionId
  )
}

/**
 * Per-run metrics, read from that run's own `result` frame. Each field is
 * checked independently so a partial result degrades to "unavailable" rather
 * than to a fabricated zero.
 */
export function runMetrics(run) {
  const result = run?.trajectory?.result

  if (!result) {
    return { available: false, costUsd: null, durationMs: null, numTurns: null }
  }

  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

  return {
    available: true,
    costUsd: num(result.total_cost_usd),
    durationMs: num(result.duration_ms),
    durationApiMs: num(result.duration_api_ms),
    numTurns: num(result.num_turns),
    subtype: result.subtype ?? null,
  }
}

/**
 * Everything the run has spent so far, from the usage each assistant frame
 * carries. Subagent frames are included -- their tokens are billed to this run.
 */
export function accumulatedUsage(trajectory) {
  let total = emptyUsage()
  for (const usage of Object.values(trajectory?.usageByMessage ?? {})) {
    total = addUsage(total, usage)
  }
  // Thinking is billed as output but is reported separately, as a running
  // estimate on its own frames rather than inside any message's usage.
  return { ...total, output_tokens: total.output_tokens + (trajectory?.thinkingTokens ?? 0) }
}

/**
 * Metrics for a run that may still be going.
 *
 * Once the result frame lands its figures are exact and win outright. Before
 * that, duration and turns are counted client-side and cost is priced from the
 * usage seen so far.
 *
 * That cost is reported as a LOWER BOUND, not an approximation. The streamed
 * frames carry only part of what the run is billed for -- measured against the
 * 92 recorded runs in this repo it lands a median of 25% under the figure the
 * result frame later reports, and in no run did it ever exceed it. "At least
 * this much" is a claim the data supports; "about this much" is not.
 *
 * A run that ended without a result frame gets neither treatment: there is
 * nothing exact to report and nothing live left to count, so this returns null
 * and the reader sees the run header's "metrics unavailable" alone.
 *
 * `nowMs` is passed in rather than read here, so this stays a pure function of
 * its inputs and the caller owns the ticking.
 */
export function liveMetrics(run, nowMs) {
  const trajectory = run?.trajectory
  if (!trajectory) return null

  const exact = runMetrics(run)
  if (exact.available) {
    return {
      live: false,
      costUsd: exact.costUsd,
      costIsLowerBound: false,
      durationMs: exact.durationMs,
      numTurns: exact.numTurns,
    }
  }

  // A run that has stopped without ever reporting a result has no metrics to
  // give. Its cost is unknowable, and the only clock it could be timed against
  // is this replay's rather than its own. Saying "unavailable" is the run
  // header's job; the meter stands down instead of printing a second, livelier,
  // contradictory answer beside it.
  if (isRunTerminal(run)) return null

  const usage = accumulatedUsage(trajectory)
  const costUsd = estimateCostUsd(usage, trajectory.model)

  return {
    live: true,
    costUsd,
    costIsLowerBound: costUsd != null,
    durationMs: trajectory.startedAtMs ? Math.max(0, nowMs - trajectory.startedAtMs) : null,
    numTurns: trajectory.assistantTurns || null,
  }
}

/** "$0.1234", or the same prefixed with >= when it is only what has been seen. */
export function formatCostBound(usd, isLowerBound) {
  const text = formatCost(usd)
  if (text == null) return null
  return isLowerBound ? `\u2265${text}` : text
}

/**
 * The ids of text nodes a result block is about to repeat.
 *
 * Claude Code's `result` frame usually carries the assistant's own final
 * message, so the closing paragraph arrives twice: once as narration, once
 * again inside the run's result. Rendering both makes a run end on a stutter.
 *
 * A trajectory can hold **several** result nodes, which is what this used to
 * get wrong. A run started with `--resume` replays the session's earlier turns,
 * so its recording carries one `init`/`result` pair per turn -- one observed
 * recording has four of each -- and the three replayed results arrive in a
 * batch, each echoing narration from further up rather than the line directly
 * above it. Looking at only the first result, and comparing it against only the
 * very last text node, matched neither: four stutters were rendered and none
 * was caught.
 *
 * So every result claims the nearest earlier text node it repeats, and a node
 * can only be claimed once. Nearest-first matters: it stops a long result from
 * claiming some short earlier line that happens to be a prefix of it when the
 * paragraph directly above is the real repeat.
 *
 * Suppression stays deliberately narrow. A result must be equal to that text or
 * begin with it, so nothing is ever hidden that the reader cannot still read,
 * in full, in the result block. A result frame that says something the
 * narration does not (a short status line, an error, a summary that merely
 * overlaps) leaves both in place, because then they are two different pieces of
 * information and dropping either would lose content.
 *
 * This is a view concern, not a parsing one: the nodes stay in the trajectory
 * and in the raw event log, and only the renderer skips them.
 */
export function redundantTextIds(trajectory) {
  const hidden = new Set()
  const nodes = trajectory?.nodes
  if (!nodes?.length) return hidden

  // Top-level narration not yet echoed by a result, oldest first. A subagent's
  // prose belongs to its branch and is never what a run's result frame repeats.
  const unclaimed = []

  for (const node of nodes) {
    if (node.kind === 'text' && !node.parentToolUseId) {
      if (node.text?.trim()) unclaimed.push(node)
      continue
    }

    if (node.kind !== 'result') continue

    const resultText = node.text?.trim()
    if (!resultText) continue

    for (let i = unclaimed.length - 1; i >= 0; i -= 1) {
      const text = unclaimed[i].text.trim()
      if (resultText === text || resultText.startsWith(text)) {
        hidden.add(unclaimed[i].id)
        unclaimed.splice(i, 1)
        break
      }
    }
  }

  return hidden
}

export function formatDuration(ms) {
  if (ms == null) return null
  if (ms < 1000) return `${ms} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`

  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes} m ${seconds} s`
}

export function formatCost(usd) {
  if (usd == null) return null
  return `$${usd.toFixed(4)}`
}
