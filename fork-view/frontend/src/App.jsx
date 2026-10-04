import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'

import {
  activeRun,
  canSubmit,
  conversationReducer,
  initialConversation,
  formatCostBound,
  formatDuration,
  isBusy,
  liveMetrics,
  resumeTarget,
} from '@shared/conversation.js'
import Run from './Run.jsx'
import {
  attachmentKind,
  composePrompt,
  isAllowedUpload,
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  attachmentLabel,
} from '@shared/attachments.js'
import {
  cancelRun,
  fetchSessions,
  fetchTrajectories,
  replayTrajectory,
  startLiveRun,
  uploadAttachment,
} from './sources.js'
import { toolSummary } from './summary.js'
import ToolIcon, { StatusIcon } from './ToolIcon.jsx'

/**
 * What the run has cost, how long it has been going, how many turns -- while
 * it is still going, rather than only once the result frame lands.
 *
 * Duration and turns are counted here and are exact. Cost is not: the streamed
 * frames carry only part of what a run is billed for, so what is priced from
 * them is a floor, shown with a >= and swapped for the exact total the moment
 * the result frame arrives. Calling that floor "about $x" would be the one
 * reading the data does not support -- across the 92 recorded runs in this
 * repo it sits a median of 25% low, and never once above.
 */
function LiveMetrics({ metrics }) {
  if (!metrics) return null

  const cost = formatCostBound(metrics.costUsd, metrics.costIsLowerBound)
  const duration = formatDuration(metrics.durationMs)

  const parts = []
  if (cost) parts.push({ key: 'cost', text: cost })
  if (duration) parts.push({ key: 'duration', text: duration })
  if (metrics.numTurns != null) {
    parts.push({
      key: 'turns',
      text: `${metrics.numTurns} turn${metrics.numTurns === 1 ? '' : 's'}`,
    })
  }

  if (!parts.length) return null

  return (
    <span
      className={`run-meter${metrics.live ? ' run-meter-live' : ''}`}
      title={
        metrics.live
          ? 'Live: duration and turns are counted as the run streams. Cost is priced from the usage reported so far, which is only part of what the run is billed for -- at least this much, likely more. Replaced by the exact total when the run finishes.'
          : 'Reported by the run\u2019s own result frame.'
      }
    >
      {parts.map((part, i) => (
        <span key={part.key} className={i === 0 ? 'run-meter-cost' : 'run-meter-part'}>
          {i > 0 && <span className="run-meter-sep">{' · '}</span>}
          {part.text}
        </span>
      ))}
    </span>
  )
}

/**
 * Files waiting to go out with the next prompt.
 *
 * An image shows itself, because a thumbnail is the only way to tell one
 * screenshot from another; a PDF shows its name, because its first page is not
 * worth fetching to draw at 40px. Each one can be taken off again until the run
 * is sent -- after that the composer is empty and the attachment is part of a
 * run that has already happened.
 *
 * The preview is an object URL over the local File, not the uploaded copy: the
 * server stores attachments inside the run's working directory and does not
 * serve that directory, and it should not start serving it for a thumbnail.
 */
function Attachments({ items, onRemove, disabled }) {
  if (!items.length) return null

  return (
    <ul className="attachments">
      {items.map((item) => (
        <li
          key={item.id}
          className={`attachment attachment-${item.kind}${
            item.error ? ' attachment-failed' : ''
          }${!item.path && !item.error ? ' attachment-pending' : ''}`}
        >
          {item.kind === 'image' && item.previewUrl ? (
            <img className="attachment-thumb" src={item.previewUrl} alt="" />
          ) : (
            <span className="attachment-thumb attachment-glyph" aria-hidden="true">
              {attachmentLabel(item.name)}
            </span>
          )}

          <span className="attachment-body">
            <span className="attachment-name" title={item.error ?? item.path ?? item.name}>
              {item.name}
            </span>
            <span className="attachment-note">
              {item.error ? item.error : item.path ? item.path : 'uploading\u2026'}
            </span>
          </span>

          <button
            className="attachment-remove"
            onClick={() => onRemove(item.id)}
            disabled={disabled}
            title={`Remove ${item.name}`}
            aria-label={`Remove ${item.name}`}
          >
            {'\u2715'}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** "19 Sep, 20:24" -- enough to tell two sessions apart, and no more. */
function sessionTime(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso ?? ''
  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

let keyCounter = 0
const nextKey = () => `run-${Date.now()}-${(keyCounter += 1)}`

/** How far the newest node may sit below the fold and still count as
 *  "following the stream". */
const FOLLOW_SLACK_PX = 140

export default function App() {
  const [conversation, dispatch] = useReducer(
    conversationReducer,
    null,
    () => initialConversation()
  )

  const [cwd, setCwd] = useState('claude-test')
  const [prompt, setPrompt] = useState('')
  const [trajectories, setTrajectories] = useState([])
  const [sessions, setSessions] = useState([])
  // Which past session a first run should resume. '' means start fresh. Only
  // consulted before this conversation has a session of its own.
  const [resumeChoice, setResumeChoice] = useState('')
  const [selected, setSelected] = useState('')
  const [attachments, setAttachments] = useState([])
  const [dragging, setDragging] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [following, setFollowing] = useState(true)

  const activeSource = useRef(null)
  const bottom = useRef(null)
  // Where auto-follow last put the page, so the scroll events its own scrolling
  // emits are not read back as the reader scrolling away.
  const selfScrollY = useRef(-1)

  const busy = isBusy(conversation)

  // One beat for every live read-out on the page: the run meter in the status
  // bar and the elapsed time on any subagent still out there. Only runs while
  // something is streaming, so an idle page re-renders on nothing.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return undefined
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])
  // Every run, reduced to what a jump list needs. Rebuilt whenever the runs
  // array changes -- which is every streamed event -- but it is four fields per
  // run, and passing the runs themselves would hand each sidebar a reference to
  // every other run's whole trajectory.
  const runIndex = useMemo(
    () =>
      conversation.runs.map((r) => ({
        key: r.key,
        index: r.index,
        status: r.trajectory.status,
        prompt: r.prompt,
      })),
    [conversation.runs]
  )

  const submittable = canSubmit(conversation)
  const current = activeRun(conversation)
  const meter = current ? liveMetrics(current, nowMs) : null
  const totalNodes = conversation.runs.reduce((n, r) => n + r.trajectory.nodes.length, 0)

  // The tool the agent is executing right now, surfaced in the sticky bar so it
  // is visible without hunting through a long trajectory.
  const activeTool = useMemo(() => {
    if (!current || current.trajectory.status !== 'running') return null
    const nodes = current.trajectory.nodes
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (nodes[i].kind === 'tool' && nodes[i].status === 'running') return nodes[i]
    }
    return null
  }, [current])

  // Loaded on mount and refreshed whenever a run finishes, so a freshly saved
  // trajectory shows up in the replay list.
  useEffect(() => {
    if (busy) return

    fetchTrajectories()
      .then((list) => {
        setTrajectories(list)
        setSelected((value) => value || list[0]?.path || '')
      })
      .catch(() => {})

    fetchSessions()
      .then((list) => {
        setSessions(list)
        // The newest session is the default -- but as an initial value only.
        // Once the reader has chosen, a refresh must not move it under them.
        setResumeChoice((value) => (value === '' && list.length ? list[0].sessionId : value))
      })
      .catch(() => {})
  }, [busy])

  // How far the newest node sits below the bottom of the viewport. Positive
  // means the tail has run off the bottom of the screen.
  //
  // Measured against the tail itself rather than against the document, because
  // the composer and the page's bottom padding sit below it: "scrolled to the
  // newest node" and "scrolled to the end of the document" are some 400px
  // apart. A detector reading the document therefore answered "detached" for
  // the very position auto-follow had just scrolled to, and auto-follow spent
  // the whole stream switching itself off.
  const tailOvershoot = useCallback(() => {
    const el = bottom.current
    if (!el) return 0
    return el.getBoundingClientRect().bottom - window.innerHeight
  }, [])

  // Auto-follow, but yield to the reader: scrolling up detaches, scrolling back
  // down re-attaches.
  useEffect(() => {
    const onScroll = () => {
      // A scroll that landed exactly where auto-follow put it is auto-follow's
      // own, echoing back a frame later. Only the reader's scrolling gets to
      // decide whether to detach, otherwise pinning reads as leaving.
      if (Math.abs(window.scrollY - selfScrollY.current) < 1) return
      selfScrollY.current = -1
      setFollowing(tailOvershoot() <= FOLLOW_SLACK_PX)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [tailOvershoot])

  // Pinning runs in a layout effect and scrolls inside one animation frame: a
  // passive effect fires after the browser has painted, so the new node would
  // be drawn un-pinned for a frame first, and a fast stream appends many nodes
  // between paints. rAF collapses that burst into a single scroll and still
  // runs before the frame is painted, so the scroll lands in the same frame as
  // the nodes that caused it.
  useLayoutEffect(() => {
    if (!following) return undefined

    const frame = requestAnimationFrame(() => {
      const overshoot = tailOvershoot()
      // Downwards only. The reader may already be below the newest node --
      // parked at the composer, say -- and hauling them back up to it is the
      // bounce this whole dance exists to avoid.
      if (overshoot <= 0) return
      window.scrollBy(0, overshoot)
      selfScrollY.current = window.scrollY
    })

    return () => cancelAnimationFrame(frame)
  }, [totalNodes, conversation.runs.length, following, tailOvershoot])

  // Re-attaching is enough: the effect above does the scrolling, on the same
  // downwards-only path as every other follow-scroll. Animating towards a
  // target that is still growing would be its own kind of jank.
  const jumpToLatest = () => setFollowing(true)

  const emit = useCallback(
    (key) => (event) => dispatch({ type: 'conversation/event', key, event }),
    []
  )

  // Object URLs are a document-lifetime resource, so each one is released when
  // its attachment goes -- on removal, and on send.
  const dropAttachments = useCallback((keep = () => false) => {
    setAttachments((current) => {
      for (const item of current) {
        if (!keep(item) && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
      return current.filter(keep)
    })
  }, [])

  const removeAttachment = useCallback(
    (id) => dropAttachments((item) => item.id !== id),
    [dropAttachments]
  )

  /**
   * Take files from a paste or a drop and start uploading them.
   *
   * Each one is put on screen before its upload finishes, so a large paste
   * shows up immediately and reports its own progress. The client-side checks
   * here only spare an obviously doomed round trip -- the server is what
   * decides, and its answer is what lands on the chip.
   */
  const attachFiles = useCallback(
    async (files) => {
      const incoming = [...files].filter(Boolean)
      if (!incoming.length) return

      const pending = incoming.map((file) => {
        const id = nextKey()
        const kind = attachmentKind(file.name)
        const tooBig = file.size > MAX_UPLOAD_BYTES
        const wrongKind = !isAllowedUpload(file.name)

        return {
          item: {
            id,
            name: file.name,
            kind,
            path: null,
            previewUrl:
              kind === 'image' && !wrongKind ? URL.createObjectURL(file) : null,
            error: wrongKind
              ? `Only ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')} can be attached.`
              : tooBig
                ? 'Larger than the 20MB limit.'
                : null,
          },
          file,
          skip: tooBig || wrongKind,
        }
      })

      setAttachments((current) => [...current, ...pending.map((p) => p.item)])

      await Promise.all(
        pending.map(async ({ item, file, skip }) => {
          if (skip) return

          try {
            const saved = await uploadAttachment({ cwd, file })
            setAttachments((current) =>
              current.map((x) => (x.id === item.id ? { ...x, path: saved.path } : x))
            )
          } catch (err) {
            setAttachments((current) =>
              current.map((x) => (x.id === item.id ? { ...x, error: err.message } : x))
            )
          }
        })
      )
    },
    [cwd]
  )

  const onPrompPaste = useCallback(
    (event) => {
      const files = event.clipboardData?.files
      if (!files?.length) return
      // Only when there is a file. A paste that is merely text has to keep
      // behaving like a paste.
      event.preventDefault()
      attachFiles(files)
    },
    [attachFiles]
  )

  const onPromptDrop = useCallback(
    (event) => {
      event.preventDefault()
      setDragging(false)
      const files = event.dataTransfer?.files
      if (files?.length) attachFiles(files)
    },
    [attachFiles]
  )

  // An attachment still on its way up has no path to put in the prompt, so the
  // run waits for it rather than going out half-described.
  const attachmentsSettling = attachments.some((item) => !item.path && !item.error)
  const readyAttachments = attachments.filter((item) => item.path)

  // Only a run that is actually still going can be stopped. `stopping` is
  // already excluded, which is what disables the button after the first press
  // without a second piece of state to keep in step.
  const stoppable = current?.trajectory.status === 'running' && Boolean(current.runId)

  /**
   * Ask the server to kill this run's Claude Code process tree.
   *
   * `_stopping` is dispatched first so the button disables on the click rather
   * than on the round trip. It is a frame like any other and goes through the
   * same reducer -- and the reducer ignores it unless the run is still running,
   * so a press that races the run finishing cannot undo the outcome that
   * landed. The `_stopped` and `_exit` frames arrive over the run's existing
   * SSE stream; nothing here closes it by hand.
   */
  async function stopRun() {
    if (!stoppable) return

    const key = current.key
    const onEvent = emit(key)
    onEvent({ type: '_stopping' })

    try {
      const outcome = await cancelRun(current.runId)
      // The run beat the request. Its own frames already carry the real
      // outcome, so nothing is forced here -- reporting it as stopped would be
      // inventing an ending it did not have.
      if (outcome.state === 'finished') return
    } catch (err) {
      // The process may well still be running, so this is a plain failure to
      // stop rather than a stop: the reducer leaves the run in `stopping` and
      // the notice says why.
      onEvent({ type: '_error', message: `Could not stop the run: ${err.message}` })
    }
  }

  function resetConversation(mode) {
    activeSource.current?.stop?.()
    activeSource.current = null
    setFollowing(true)
    dropAttachments()
    dispatch({ type: 'conversation/reset', mode })
  }

  async function submit() {
    const text = prompt.trim()
    // An attachment on its own is a legitimate ask -- "read this" -- so the
    // prompt may be empty as long as something is going with it.
    if ((!text && !readyAttachments.length) || !submittable || attachmentsSettling) return

    // What Claude Code is actually given: a line naming each attachment, then
    // what was typed. The run records this rather than the typed text alone,
    // because a viewer that showed a different prompt than the one the agent
    // answered would be the one thing it must never do.
    const outgoing = composePrompt(text, readyAttachments)

    // A follow-up resumes whatever session the CLI last reported. Before this
    // conversation has one of its own, the picker decides which past session to
    // pick up -- or none of them, which starts a new Claude Code conversation.
    const resumeSessionId = resumeTarget(conversation) ?? (resumeChoice || null)
    const key = nextKey()
    const onEvent = emit(key)

    setFollowing(true)
    dispatch({
      type: 'conversation/startRun',
      key,
      mode: 'live',
      prompt: outgoing,
      cwd,
      resumeSessionId,
      startedAt: new Date().toISOString(),
    })
    setPrompt('')
    dropAttachments()

    try {
      const run = await startLiveRun({ cwd, prompt: outgoing, resumeSessionId, onEvent })
      activeSource.current = run

      dispatch({
        type: 'conversation/runMeta',
        key,
        runId: run.runId,
        jsonlPath: run.jsonlPath,
      })
      onEvent({ type: '_run_started', runId: run.runId, cwd: run.cwd })
    } catch (err) {
      // The run still exists and reaches a terminal state, so the conversation
      // is never left stuck.
      onEvent({ type: '_error', message: err.message })
    }
  }

  async function runReplay() {
    if (!selected) return

    resetConversation('replay')

    const key = nextKey()
    const onEvent = emit(key)
    const meta = trajectories.find((t) => t.path === selected)?.meta ?? null

    dispatch({
      type: 'conversation/startRun',
      key,
      mode: 'replay',
      prompt: meta?.prompt ?? '',
      cwd: meta?.cwd ?? null,
      resumeSessionId: meta?.resumeSessionId ?? null,
    })
    dispatch({ type: 'conversation/runMeta', key, jsonlPath: selected })

    try {
      activeSource.current = await replayTrajectory({ path: selected, onEvent })
    } catch (err) {
      onEvent({ type: '_error', message: err.message })
    }
  }

  // The working directory is locked because the Claude Code session is tied to
  // it -- so lock it only once a session actually exists. A first run that
  // failed before reaching the CLI (bad directory, spawn failure) must leave
  // the field editable, otherwise the mistake is unrecoverable.
  const locked = conversation.mode === 'live' && Boolean(conversation.sessionId)
  const buttonLabel = conversation.sessionId ? 'Send follow-up' : 'Run'
  const status = current?.trajectory.status ?? 'idle'

  return (
    <div className="app">
      <header className="app-head">
        <div className="status-bar">
          {/* Owner, then tool, then what the tool is for. The slash is the
              divider the rest of the page already uses for machine values, so
              the masthead is set in the same language as everything under it. */}
          <div className="wordmark">
            <h1>
              <span className="wordmark-owner">Claude Code</span>
              <span className="wordmark-slash">/</span>
              <span className="wordmark-name">Trajectory viewer</span>
            </h1>
            <div className="wordmark-tagline">observe · understand · iterate</div>
          </div>

          <span className="spacer" />

          <LiveMetrics metrics={meter} />
          {conversation.mode && <span className="meta">{conversation.mode}</span>}
          {conversation.cwd && (
            <span className="meta" title={conversation.cwd}>
              {conversation.cwd}
            </span>
          )}
          {conversation.sessionId && (
            <span className="meta session-id" title={conversation.sessionId}>
              session {conversation.sessionId}
            </span>
          )}
          {conversation.runs.length > 0 && (
            <span className="meta">
              {conversation.runs.length} run{conversation.runs.length === 1 ? '' : 's'}
            </span>
          )}
          <span className={`pill pill-${status}`}>{status}</span>

          {/* Only while there is a process to kill. It leaves the bar entirely
              once the run ends, rather than sitting there disabled: a control
              that can never apply again is not worth the width. */}
          {(stoppable || status === 'stopping') && (
            <button
              className="stop-run"
              onClick={stopRun}
              disabled={!stoppable}
              title={
                stoppable
                  ? 'Terminate this Claude Code run'
                  : 'Already stopping this run'
              }
            >
              <StatusIcon status="stopped" className="stop-run-mark" />
              <span>stop</span>
            </button>
          )}
        </div>

        {/* The slot is held open for the whole run, not just while a tool is
            in flight: the bar sits in the sticky header, so letting it mount
            and unmount between calls shifted every node on the page by its own
            height -- a hundred times over a long trajectory. */}
        {busy && (
          <div className="active-tool-slot">
            {activeTool && (
              <div className="active-tool">
                <span className="glyph glyph-running">
                  <StatusIcon status="running" />
                </span>
                <ToolIcon name={activeTool.name} />
                <span className="active-tool-name">{activeTool.name}</span>
                <span className="meta">{toolSummary(activeTool)}</span>
              </div>
            )}
          </div>
        )}
      </header>

      <main className="conversation">
        {conversation.runs.map((run) => (
          <Run
            key={run.key}
            run={run}
            runIndex={runIndex}
            showRaw={showRaw}
            nowMs={nowMs}
          />
        ))}
        <div ref={bottom} />
      </main>

      {/* Only offered when the reader has scrolled away from a live stream. */}
      {!following && busy && (
        <button className="follow-latest" onClick={jumpToLatest}>
          {'↓ Jump to latest'}
        </button>
      )}

      <section className="composer">
        <div className="panel">
          <h2>
            {conversation.mode === 'replay'
              ? 'Replay mode — start a new conversation to run live'
              : conversation.sessionId
                ? 'Follow up in this session'
                : resumeChoice
                  ? 'Follow up in the selected session'
                  : 'New conversation'}
          </h2>

          {/* Only before this conversation has a session of its own: once it
              does, a follow-up continues that one and there is nothing to
              choose. With no past sessions there is nothing to show either,
              and the composer simply starts a new conversation. */}
          {!conversation.sessionId && sessions.length > 0 && (
            <label>
              Continue from
              <select
                value={resumeChoice}
                onChange={(e) => {
                  setResumeChoice(e.target.value)
                  // A session is tied to the directory it ran in, so picking
                  // one brings its working directory with it.
                  const picked = sessions.find((x) => x.sessionId === e.target.value)
                  if (picked?.cwd) setCwd(picked.cwd)
                }}
                disabled={busy}
              >
                {sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {sessionTime(session.lastActivityTimestamp)}
                    {' — '}
                    {session.promptExcerpt || '(no prompt recorded)'}
                  </option>
                ))}
                <option value="">Start a new conversation</option>
              </select>
            </label>
          )}

          <label>
            Working directory
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="claude-test"
              spellCheck={false}
              disabled={locked || busy}
              title={
                locked
                  ? 'Locked to the working directory of this session'
                  : busy
                    ? 'A run is in progress'
                    : undefined
              }
            />
          </label>

          {/* Above the textarea, so what is going out with the prompt is
              visible while the prompt is being written. */}
          <Attachments
            items={attachments}
            onRemove={removeAttachment}
            disabled={busy}
          />

          <label>
            Prompt
            <textarea
              className={dragging ? 'prompt-dropping' : undefined}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={onPrompPaste}
              onDrop={onPromptDrop}
              onDragOver={(e) => {
                // Without this the browser navigates to the dropped file.
                e.preventDefault()
                setDragging(true)
              }}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              rows={4}
              placeholder={
                conversation.sessionId
                  ? 'Follow-up for the same Claude Code session…'
                  : 'What should Claude Code do?'
              }
              disabled={conversation.mode === 'replay'}
            />
          </label>

          <div className="composer-actions">
            <button
              onClick={submit}
              disabled={
                !submittable ||
                attachmentsSettling ||
                (!prompt.trim() && !readyAttachments.length)
              }
            >
              {buttonLabel}
            </button>
            <button
              className="secondary"
              onClick={() => resetConversation(null)}
              disabled={busy || conversation.runs.length === 0}
            >
              New conversation
            </button>
            {busy && <span className="meta">{'run in progress…'}</span>}
          </div>
        </div>

        <div className="panel">
          <h2>Replay</h2>
          <label>
            Saved trajectory
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {trajectories.map((t) => (
                <option key={t.path} value={t.path}>
                  {t.path}
                </option>
              ))}
            </select>
          </label>
          <button onClick={runReplay} disabled={busy || !selected}>
            Replay
          </button>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => setShowRaw(e.target.checked)}
            />
            Show raw JSON on each node
          </label>
        </div>
      </section>

      <footer className="app-foot">
        <span className="foot-item">
          <span className="foot-slash">/</span> Fork View
          <span className="foot-dim">Claude Code trajectory viewer</span>
        </span>
        <span className="spacer" />
        <span className="foot-item">
          <span className="foot-dim">Created by</span>
          <span className="foot-slash">/</span> Zoe Jingyi Liu
        </span>
      </footer>
    </div>
  )
}
