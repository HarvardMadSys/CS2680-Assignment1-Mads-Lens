const $ = (id) => document.getElementById(id)

const dialogue = $('dialogue')
const tocHost = $('toc')
const runState = $('runState')
const hint = $('hint')
const sendBtn = $('send')
const promptEl = $('prompt')

const RESULT_LINES = 3
const INPUT_LINES = 2
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const LABEL_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'query', 'prompt', 'skill']
const ATTACH_CHARS = 6000

let sessionId = null
let running = false
let calls = new Map()
let callCount = 0
let currentRunBody = null
let activeRunId = null
let turnActive = false
// true only while replaying a recorded transcript, where prompts must be drawn
// from the stream because nothing rendered them locally
let restoring = false

/** laneKey -> { label, total, done, error, pending } — feeds the scope. */
let lanes = new Map()

/** id -> node, plus the roots, so the outline can be drawn as a real tree. */
let treeNodes = new Map()
let treeRoots = []

const customAgents = {}
const attachments = []

const state = { model: 'sonnet', effort: 'high' }
let requireSubagents = false

/* ═══════════ helpers ═══════════ */

const truncate = (text, max = 84) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function inputLabel(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of LABEL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return truncate(value)
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return first ? truncate(first) : ''
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? (p?.type ? `[${p.type}]` : ''))))
      .filter(Boolean).join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Clips by lines and characters: a Write input or minified log arrives as one
 *  enormous single line that a line count alone lets through. */
function renderClipped(host, text, maxLines, maxChars = 260) {
  host.textContent = ''
  const lines = text.split('\n')
  let head = lines.slice(0, maxLines).join('\n')
  if (head.length > maxChars) head = `${head.slice(0, maxChars)}…`
  const body = el('div', null, head)
  host.appendChild(body)
  if (head === text) return

  const hiddenLines = Math.max(0, lines.length - maxLines)
  const more = hiddenLines > 0
    ? `show ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}`
    : `show ${text.length - head.length} more chars`
  const button = el('button', 'expand', more)
  button.type = 'button'
  let open = false
  button.addEventListener('click', () => {
    open = !open
    body.textContent = open ? text : head
    button.textContent = open ? 'collapse' : more
  })
  host.appendChild(button)
}

const atBottom = () => dialogue.scrollHeight - dialogue.scrollTop - dialogue.clientHeight < 90
const autoscroll = (was) => { if (was) dialogue.scrollTop = dialogue.scrollHeight }

/* ═══════════ run + session state ═══════════ */

function setRunState(s, label) {
  runState.dataset.state = s
  runState.title = label ?? s
  runState.setAttribute('aria-label', `run state: ${label ?? s}`)
  $('scopeTag').textContent = label ?? s
}

function setSession(id) {
  sessionId = id
  $('sessionLabel').textContent = id ? `sid ${id.slice(0, 8)}` : 'no session'
}

function setRoute() {
  $('statRoute').textContent = `${state.model} · ${state.effort}`
  $('routerTag').textContent = state.model
}

/* ═══════════ lanes + scope ═══════════ */

function lane(key) {
  if (!lanes.has(key)) {
    lanes.set(key, { label: key === 'main' ? 'main' : 'subagent', total: 0, done: 0, error: 0, pending: 0 })
  }
  return lanes.get(key)
}

function arc(cx, cy, r, frac, stroke, width) {
  const c = 2 * Math.PI * r
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" style="stroke:${stroke}" stroke-width="${width}"
    stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round"
    transform="rotate(-90 ${cx} ${cy})"/>`
}

function drawScope() {
  const svg = $('scope')
  const cx = 120, cy = 120
  const subs = [...lanes.entries()].filter(([k]) => k !== 'main')
  const main = lanes.get('main')

  let out = ''
  for (const r of [56, 88, 112]) {
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" style="stroke:var(--scope-grid)" stroke-width="1"/>`
  }
  out += `<line x1="8" y1="${cy}" x2="232" y2="${cy}" style="stroke:var(--scope-axis)"/>
          <line x1="${cx}" y1="8" x2="${cx}" y2="232" style="stroke:var(--scope-axis)"/>`

  subs.forEach(([, l], i) => {
    const a = (i / Math.max(subs.length, 1)) * Math.PI * 2 - Math.PI / 2
    const x = cx + Math.cos(a) * 88
    const y = cy + Math.sin(a) * 88
    // Colours are CSS variables so the scope follows the light/dark theme.
    const colour = l.error ? 'var(--red)' : 'var(--o)'
    out += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
      style="stroke:${l.pending ? colour : 'rgba(232,85,31,.35)'}" stroke-width="1" ${l.pending ? 'stroke-dasharray="3 3"' : ''}/>`
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="17" style="fill:var(--scope-node);stroke:${colour}" stroke-width="1.2"${l.pending ? ' class="pulse"' : ''}/>`
    out += arc(x, y, 17, l.total ? (l.done + l.error) / l.total : 0, colour, 2.5)
    out += `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle"
      font-family="Geist Pixel, monospace" font-size="11" style="fill:var(--text)">${l.done + l.error}</text>`
  })

  const mainColour = main?.error ? 'var(--red)' : 'var(--text)'
  out += `<circle cx="${cx}" cy="${cy}" r="30" style="fill:var(--scope-node);stroke:${mainColour}" stroke-width="1.4"/>`
  if (main) out += arc(cx, cy, 30, main.total ? (main.done + main.error) / main.total : 0, mainColour, 3)
  out += `<text x="${cx}" y="${cy - 1}" text-anchor="middle" font-family="Geist Pixel, monospace"
    font-size="15" style="fill:var(--text)">${main ? main.done + main.error : 0}</text>`
  out += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="Geist, sans-serif"
    font-size="8" letter-spacing="1.4" style="fill:var(--text-3)">main</text>`

  svg.innerHTML = out
}

/* ═══════════ rendering ═══════════ */

function container(parentToolUseId) {
  const parent = parentToolUseId ? calls.get(parentToolUseId) : null
  return parent ? parent.children : currentRunBody
}

function addText(text, parent) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return
  const was = atBottom()
  container(parent).appendChild(el('div', 'entry msg', trimmed))
  autoscroll(was)
}

function addThinking(text, parent) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return
  const was = atBottom()
  const d = el('details', 'entry thinking')
  d.appendChild(el('summary', null, 'thinking'))
  d.appendChild(el('div', 'body', trimmed))
  container(parent).appendChild(d)
  autoscroll(was)
}

function addCall(block, parent) {
  const was = atBottom()
  // Cards start folded to their one-line head, so a long run reads as a list of
  // calls; a click on the head (or its outline row) opens the input and result.
  const root = el('div', 'call flash collapsed')
  root.dataset.status = 'pending'
  root.id = `call-${block.id}`

  const head = el('div', 'call-head')
  head.append(
    el('span', 'twisty', '▾'),
    el('span', 'mark', '○'),
    el('span', 'tool-name', block.name),
    el('span', 'tool-label', inputLabel(block.input)),
  )
  if (parent) head.appendChild(el('span', 'badge', 'sub'))

  const body = el('div', 'call-body')
  const input = el('div', 'kv')
  renderClipped(input, JSON.stringify(block.input ?? {}, null, 2), INPUT_LINES)
  const result = el('div', 'result')
  result.appendChild(el('span', 'waiting', '▚ waiting for result…'))
  const children = el('div', 'children')
  body.append(input, result, children)

  head.addEventListener('click', () => root.classList.toggle('collapsed'))
  root.append(head, body)
  container(parent).appendChild(root)

  const laneKey = parent ?? 'main'
  const l = lane(laneKey)
  l.total += 1
  l.pending += 1
  if (parent && l.label === 'subagent') {
    const spawn = calls.get(parent)
    if (spawn?.label) l.label = spawn.label
  }

  calls.set(block.id, {
    el: root, children, result,
    mark: head.querySelector('.mark'),
    outline: addOutline(block, parent),
    lane: laneKey,
    label: inputLabel(block.input) || block.name,
  })

  callCount += 1
  $('statCalls').textContent = String(callCount)
  drawScope()
  autoscroll(was)
}

function attachResult(block) {
  const call = calls.get(block.tool_use_id)
  if (!call) return
  const was = atBottom()
  const isError = block.is_error === true
  const status = isError ? 'error' : 'ok'

  call.el.dataset.status = status
  call.mark.textContent = isError ? '✕' : '✓'
  const node = treeNodes.get(block.tool_use_id)
  if (node) { node.status = status; drawTree() }

  call.result.classList.toggle('is-error', isError)
  renderClipped(call.result, resultText(block.content) || '(no output)', RESULT_LINES)

  const l = lane(call.lane)
  l.pending = Math.max(0, l.pending - 1)
  if (isError) l.error += 1
  else l.done += 1
  drawScope()
  autoscroll(was)
}

function markHasChildren(parentToolUseId) {
  const parent = parentToolUseId ? calls.get(parentToolUseId) : null
  if (parent) parent.el.classList.add('has-children')
}

function addOutline(block, parentId) {
  const node = {
    id: block.id,
    name: block.name,
    label: inputLabel(block.input),
    status: 'pending',
    parentId: parentId ?? null,
    children: [],
  }
  treeNodes.set(block.id, node)
  const parent = parentId ? treeNodes.get(parentId) : null
  if (parent) parent.children.push(node)
  else treeRoots.push(node)
  drawTree()
  return node
}

/** Calls whose children are folded away in the outline. */
const folded = new Set()

/** The outline is a table of contents: call names, nested under the call that
 *  spawned them, each group foldable so a long subagent run cannot bury the
 *  main agent's work. The dialogue carries the detail. */
function drawTree() {
  tocHost.replaceChildren()
  let shown = 0

  const render = (nodes, depth) => {
    for (const n of nodes) {
      shown += 1
      const row = el('div', 'toc-row')
      row.dataset.status = n.status
      row.style.paddingLeft = `${4 + depth * 14}px`

      const twisty = el('button', 'toc-twisty')
      twisty.type = 'button'
      if (n.children.length) {
        twisty.textContent = folded.has(n.id) ? '▸' : '▾'
        twisty.title = folded.has(n.id) ? 'expand' : 'collapse'
        twisty.addEventListener('click', (event) => {
          event.stopPropagation()
          if (folded.has(n.id)) folded.delete(n.id)
          else folded.add(n.id)
          drawTree()
        })
      } else {
        twisty.classList.add('is-leaf')
      }

      const jump = el('button', 'toc-jump')
      jump.type = 'button'
      jump.append(
        el('span', 'mark', n.status === 'error' ? '✕' : n.status === 'ok' ? '✓' : '○'),
        el('span', 'toc-name', n.name),
      )
      if (n.label) jump.appendChild(el('span', 'toc-detail', n.label))
      if (n.children.length && folded.has(n.id)) {
        jump.appendChild(el('span', 'toc-count', `${n.children.length}`))
      }
      jump.addEventListener('click', () => jumpToCall(n.id))

      row.append(twisty, jump)
      tocHost.appendChild(row)

      if (n.children.length && !folded.has(n.id)) render(n.children, depth + 1)
    }
  }

  render(treeRoots, 0)
  $('outlineCount').textContent = String(treeNodes.size)
  if (!treeNodes.size) tocHost.appendChild(el('p', 'void', 'no calls yet'))
}

function jumpToCall(id) {
  const target = document.getElementById(`call-${id}`)
  if (!target) return
  target.classList.remove('collapsed')
  let node = target.parentElement
  while (node && node !== dialogue) {
    if (node.classList.contains('children')) node.closest('.call')?.classList.remove('collapsed')
    node = node.parentElement
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.remove('target')
  void target.offsetWidth
  target.classList.add('target')
}


/* ═══════════ events ═══════════ */

function handleEvent(event) {
  if (event.type === 'driver_started') { activeRunId = event.runId ?? null; syncSendKey(); return }
  if (event.type === 'driver_error') return failRun(event.message)

  if (event.type === 'system' && event.subtype === 'init') {
    if (event.session_id) setSession(event.session_id)
    if (Array.isArray(event.skills)) renderSkills(event.skills)
    if (Array.isArray(event.mcp_servers)) renderMcp(event.mcp_servers)
    return
  }

  if (event.type === 'assistant' || event.type === 'user') {
    const parent = event.parent_tool_use_id ?? null
    if (parent) markHasChildren(parent)
    const content = event.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'text') {
        // --replay-user-messages echoes our own prompt back so the transcript
        // holds both sides. Live, the composer already drew it as the run head,
        // so echoing it again would double every message.
        if (event.type === 'user' && !parent) {
          if (restoring) startRunBlock(block.text.replace(DELEGATION_TAG, '').trim())
          continue
        }
        addText(block.text, parent)
      } else if (block.type === 'thinking') addThinking(block.thinking, parent)
      else if (block.type === 'tool_use') addCall(block, parent)
      else if (block.type === 'tool_result') attachResult(block)
    }
    return
  }

  if (event.type === 'result') {
    // A backgrounded subagent emits a second result and total_cost_usd is
    // cumulative in each, so the last one wins.
    if (event.session_id) setSession(event.session_id)
    $('statCost').textContent = `$${Number(event.total_cost_usd ?? 0).toFixed(4)}`
    $('statDuration').textContent = `${(Number(event.duration_ms ?? 0) / 1000).toFixed(1)}s`
    $('statTurns').textContent = String(event.num_turns ?? '—')
    turnActive = false
    setWorking(false)
    syncSendKey()
    if (runState.dataset.state !== 'failed') setRunState('done')
    if (event.is_error || event.subtype !== 'success') failRun(event.result || `run ended: ${event.subtype}`)
  }
}

function failRun(message) {
  setRunState('failed')
  setWorking(false)
  ;(currentRunBody ?? dialogue).appendChild(el('div', 'entry run-error', `run failed\n${message}`))
  dialogue.scrollTop = dialogue.scrollHeight
}

/* ═══════════ stream ═══════════ */

async function consume(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { handleEvent(JSON.parse(line)) } catch { /* partial line; next chunk completes it */ }
    }
  }
}

function startRunBlock(prompt) {
  const run = el('div', 'run-block')
  const head = el('div', 'run-head')
  head.append(el('span', 'caret', '›'), el('span', null, prompt))
  run.appendChild(head)
  currentRunBody = el('div', 'run-body')
  run.appendChild(currentRunBody)
  dialogue.querySelector('.boot')?.remove()
  dialogue.appendChild(run)
  dialogue.scrollTop = dialogue.scrollHeight
}

/* ═══════════ submit ═══════════ */

function setWorking(on) {
  $('working').hidden = !on
  if (on) dialogue.scrollTop = dialogue.scrollHeight
}

function syncSendKey() {
  const stoppable = turnActive && activeRunId && !promptEl.value.trim()
  sendBtn.classList.toggle('is-stop', Boolean(stoppable))
  sendBtn.title = stoppable ? 'stop this turn' : 'run'
  sendBtn.setAttribute('aria-label', stoppable ? 'stop this turn' : 'run')
}

async function stopTurn() {
  if (!activeRunId) return
  try {
    await fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: activeRunId, stop: true }),
    })
    hint.textContent = 'stopped'
  } catch (error) {
    hint.textContent = error.message
  }
}

const DELEGATION_TAG = /\n*^sub-agents needed: \d+$/m

function assemblePrompt(base) {
  const parts = [base]
  if (attachments.length) {
    parts.push(...attachments.map((a) => `--- attached file: ${a.name} ---\n${a.text}`))
  }
  // Stated as a requirement on the request itself, which the model follows far
  // more reliably than the same ask buried in a system prompt. Kept out of the
  // transcript view so the board shows what was typed.
  if (requireSubagents && subagents > 0) parts.push(`sub-agents needed: ${subagents}`)
  return parts.join('\n\n')
}

async function submit(prompt) {
  hint.classList.remove('error')
  turnActive = true
  setRunState('running')
  setWorking(true)
  syncSendKey()
  startRunBlock(prompt)

  // A session already open takes the message mid-turn, so the agent can keep
  // working while more instructions arrive.
  if (activeRunId) {
    try {
      const response = await fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: activeRunId, text: assemblePrompt(prompt) }),
      })
      if (!response.ok) throw new Error((await response.json()).error)
    } catch (error) {
      failRun(error.message)
    }
    promptEl.focus()
    return
  }

  running = true
  const resume = $('continueSession').checked ? sessionId : null
  if (!resume) {
    calls = new Map()
    lanes = new Map()
    treeNodes = new Map()
    treeRoots = []
    folded.clear()
    callCount = 0
    $('outlineCount').textContent = '0'
    drawTree()
    drawScope()
  }

  let failed = false
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: assemblePrompt(prompt),
        cwd: $('cwd').value,
        resume,
        skipPermissions: $('skipPerms').checked,
        fullEnv: $('fullEnv').checked,
        model: state.model,
        effort: state.effort,
        agent: requireSubagents && subagents > 0 ? 'orchestrator' : $('mainAgent').value,
        agents: requireSubagents && subagents > 0
          // A prompt alone only asks for delegation. Driving the main loop with
          // an agent that has no editing or shell tools makes delegation the
          // only way work can happen.
          ? {
              ...customAgents,
              orchestrator: {
                description: 'Plans and delegates every piece of substantive work to subagents',
                prompt:
                  'You are an orchestrator. Delegate ALL substantive work to subagents with the '
                  + 'Agent tool: editing files, running commands, writing code, investigating. You may '
                  + 'read and search only to decide what to delegate. Never do the work yourself. '
                  + `Split the request into ${subagents} independent pieces and run ${subagents} `
                  + 'subagents in parallel, then '
                  + 'report what they found.',
                tools: ['Agent', 'Task', 'Read', 'Glob', 'Grep', 'TodoWrite'],
              },
            }
          : customAgents,
        appendSystemPrompt: [
          $('appendSystem').value.trim(),
          // An instruction, not a hard constraint: there is no flag that forces
          // delegation, so this reaches the model through the system prompt.
          requireSubagents && subagents > 0
            ? `Delegate substantive work to subagents with the Agent tool rather than doing it yourself. Run up to ${subagents} in parallel where the work is independent.`
            : '',
        ].filter(Boolean).join('\n\n'),
        addDirs: $('addDirs').value.split(',').map((s) => s.trim()).filter(Boolean),
        maxSubagents: subagents,
      }),
    })

    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      failRun(detail.error ?? `HTTP ${response.status}`)
      failed = true
    } else {
      await consume(response)
    }
  } catch (error) {
    failRun(error.message)
    failed = true
  }

  running = false
  activeRunId = null
  turnActive = false
  setWorking(false)
  syncSendKey()
  if (runState.dataset.state !== 'failed' && !failed) setRunState('done')
  if (runState.dataset.state === 'failed') hint.classList.add('error')
  promptEl.focus()
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  const prompt = promptEl.value.trim()
  if (!prompt) {
    if (turnActive && activeRunId) void stopTurn()
    return
  }
  promptEl.value = ''
  promptEl.style.height = 'auto'
  void submit(prompt)
})

promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    $('composer').requestSubmit()
  }
})
promptEl.addEventListener('input', () => {
  syncSendKey()
  promptEl.style.height = 'auto'
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 130)}px`
})

/* ═══════════ router: effort knob + model ═══════════ */

const knob = $('effortKnob')
let effortIndex = 2

function setEffort(index) {
  effortIndex = Math.max(0, Math.min(EFFORTS.length - 1, index))
  state.effort = EFFORTS[effortIndex]
  knob.style.setProperty('--angle', `${-120 + effortIndex * 60}deg`)
  knob.setAttribute('aria-valuenow', String(effortIndex))
  $('effortValue').textContent = state.effort
  setRoute()
}

let knobStart = null
knob.addEventListener('pointerdown', (event) => {
  knobStart = { y: event.clientY, index: effortIndex }
  knob.setPointerCapture(event.pointerId)
})
knob.addEventListener('pointermove', (event) => {
  if (!knobStart) return
  setEffort(knobStart.index - Math.round((event.clientY - knobStart.y) / 20))
})
knob.addEventListener('pointerup', () => { knobStart = null })
knob.addEventListener('pointercancel', () => { knobStart = null })
knob.addEventListener('wheel', (event) => {
  event.preventDefault()
  setEffort(effortIndex + (event.deltaY > 0 ? -1 : 1))
}, { passive: false })
knob.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); setEffort(effortIndex + 1) }
  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); setEffort(effortIndex - 1) }
})

$('modelRow').addEventListener('click', (event) => {
  const button = event.target.closest('[data-model]')
  if (!button) return
  for (const b of $('modelRow').children) b.classList.toggle('is-on', b === button)
  state.model = button.dataset.model
  setRoute()
})

/* ═══════════ agents ═══════════ */

function sigil(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const ticks = 5 + (h % 7)
  const spin = h % 360
  let marks = ''
  for (let i = 0; i < ticks; i += 1) {
    const a = (i / ticks) * Math.PI * 2
    const x1 = 15 + Math.cos(a) * 9, y1 = 15 + Math.sin(a) * 9
    const x2 = 15 + Math.cos(a) * 13, y2 = 15 + Math.sin(a) * 13
    marks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#FF5312" stroke-width="1.5"/>`
  }
  return `<svg class="viz" viewBox="0 0 30 30"><g transform="rotate(${spin} 15 15)">
    <circle cx="15" cy="15" r="9" fill="none" style="stroke:var(--sigil-ring)"/>
    <circle cx="15" cy="15" r="3.5" fill="#FF5312"/>${marks}</g></svg>`
}

function renderAgents() {
  const deck = $('agentDeck')
  deck.replaceChildren()
  const names = Object.keys(customAgents)
  $('agentCount').textContent = `${names.length} custom`

  for (const name of names) {
    const card = el('div', 'agent-card')
    card.innerHTML = sigil(name)
    const meta = el('div', 'meta')
    meta.append(el('b', null, name), el('small', null, customAgents[name].description || 'no description'))
    const kill = el('button', 'kill', '✕')
    kill.type = 'button'
    kill.addEventListener('click', () => {
      delete customAgents[name]
      renderAgents()
      syncAgentOptions()
    })
    card.append(meta, kill)
    deck.appendChild(card)
  }
}

function syncAgentOptions() {
  const select = $('mainAgent')
  const current = select.value
  select.replaceChildren()
  select.appendChild(new Option('default', ''))
  for (const name of capabilityAgents) select.appendChild(new Option(name, name))
  for (const name of Object.keys(customAgents)) select.appendChild(new Option(`${name} ·custom`, name))
  select.value = current
}

let capabilityAgents = []

$('newAgent').addEventListener('click', () => {
  const form = $('agentForm')
  form.hidden = !form.hidden
  if (!form.hidden) $('agentName').focus()
})
$('agentCancel').addEventListener('click', () => { $('agentForm').hidden = true })

$('agentForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const name = $('agentName').value.trim().replace(/\s+/g, '-')
  if (!name) return
  const tools = $('agentTools').value.split(',').map((t) => t.trim()).filter(Boolean)
  customAgents[name] = {
    description: $('agentDesc').value.trim() || `custom agent ${name}`,
    prompt: $('agentPrompt').value.trim() || `You are ${name}.`,
    ...(tools.length ? { tools } : {}),
  }
  for (const id of ['agentName', 'agentDesc', 'agentPrompt', 'agentTools']) $(id).value = ''
  $('agentForm').hidden = true
  renderAgents()
  syncAgentOptions()
})

/* ═══════════ capabilities ═══════════ */

function renderSkills(skills) {
  const host = $('skillChips')
  host.replaceChildren()
  $('skillCount').textContent = String(skills.length)
  $('skillEmpty').hidden = true
  for (const skill of skills) {
    const chip = el('button', 'chip', skill)
    chip.type = 'button'
    chip.title = `insert /${skill}`
    chip.addEventListener('click', () => {
      promptEl.value = `/${skill} ${promptEl.value}`.trim()
      promptEl.focus()
    })
    host.appendChild(chip)
  }
}

function renderMcp(servers) {
  const host = $('mcpList')
  host.replaceChildren()
  $('mcpCount').textContent = String(servers.length)
  if (!servers.length) {
    host.appendChild(el('p', 'void', 'isolated · strict-mcp-config'))
    return
  }
  for (const server of servers) {
    const row = el('div', 'mcp-row')
    row.dataset.status = server.status
    row.append(el('i'), el('span', null, server.name), el('small', null, server.status))
    host.appendChild(row)
  }
}

async function probe() {
  try {
    const response = await fetch(`/api/capabilities?fullEnv=${$('fullEnv').checked ? 1 : 0}`)
    const data = await response.json()
    if (!response.ok || data.unavailable) throw new Error(data.error)
    capabilityAgents = data.agents ?? []
    renderSkills(data.skills ?? [])
    renderMcp(data.mcpServers ?? [])
    syncAgentOptions()
    $('capTag').textContent = `${(data.tools ?? []).length} tools`
  } catch (error) {
    $('capTag').textContent = 'probe failed'
    $('mcpList').replaceChildren(el('p', 'void', error.message))
  }
}

let registryTimer = 0

$('skillFilter').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase()
  let shown = 0
  for (const chip of $('skillChips').children) {
    chip.hidden = Boolean(query) && !chip.textContent.toLowerCase().includes(query)
    if (!chip.hidden) shown += 1
  }
  $('skillEmpty').hidden = shown > 0 || !query

  clearTimeout(registryTimer)
  if (query.length < 2) {
    $('skillRegistry').replaceChildren()
    $('skillStatus').textContent = ''
    return
  }
  $('skillStatus').textContent = 'searching skills.sh…'
  registryTimer = setTimeout(() => void searchRegistry(query), 320)
})

const installed = new Set()

async function searchRegistry(query) {
  try {
    const response = await fetch(`/api/skills/search?q=${encodeURIComponent(query)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    renderRegistry(data.skills ?? [])
    $('skillStatus').textContent = data.skills?.length ? `${data.skills.length} on skills.sh` : 'nothing on skills.sh'
  } catch (error) {
    $('skillRegistry').replaceChildren()
    $('skillStatus').textContent = error.message
  }
}

function renderRegistry(skills) {
  const host = $('skillRegistry')
  host.replaceChildren()
  for (const skill of skills.slice(0, 10)) {
    const row = el('div', 'reg-row')
    const meta = el('div', 'reg-meta')
    meta.append(el('b', null, skill.name), el('small', null, skill.source))
    const count = el('span', 'reg-installs', skill.installs ? `${Math.round(skill.installs / 1000)}k` : '')
    const add = el('button', 'cap tiny', installed.has(skill.source) ? 'added' : 'add')
    add.type = 'button'
    add.disabled = installed.has(skill.source)
    add.addEventListener('click', () => void install(skill, add))
    row.append(meta, count, add)
    host.appendChild(row)
  }
}

async function install(skill, button) {
  button.disabled = true
  button.textContent = '…'
  $('skillStatus').textContent = `installing ${skill.source} — this can take a minute`
  try {
    const response = await fetch('/api/skills/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: skill.source }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    installed.add(skill.source)
    button.textContent = 'added'
    $('skillStatus').textContent = `installed ${skill.source}`
    void probe()
  } catch (error) {
    button.disabled = false
    button.textContent = 'add'
    $('skillStatus').textContent = `install failed — ${error.message}`
  }
}

$('fullEnv').addEventListener('change', () => {
  $('capTag').textContent = 'probing…'
  void probe()
})

$('appendSystem').addEventListener('input', (event) => {
  $('instrTag').textContent = event.target.value.trim() ? 'active' : 'off'
})

/* ═══════════ version control ═══════════ */

for (const button of document.querySelectorAll('[data-stage]')) {
  button.addEventListener('click', () => {
    promptEl.value = button.dataset.stage
    promptEl.focus()
    promptEl.dispatchEvent(new Event('input'))
  })
}

/* ═══════════ settings knob + files ═══════════ */

$('settingsKnob').addEventListener('click', (event) => {
  const panel = $('deckSettings')
  panel.hidden = !panel.hidden
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden))
})

$('fileBtn').addEventListener('click', () => $('fileInput').click())

$('fileInput').addEventListener('change', async (event) => {
  for (const file of event.target.files) {
    const text = await file.text().catch(() => '')
    attachments.push({ name: file.name, text: text.slice(0, ATTACH_CHARS) })
  }
  event.target.value = ''
  renderAttachments()
})

function renderAttachments() {
  const host = $('attachments')
  host.replaceChildren()
  attachments.forEach((a, index) => {
    const chip = el('span', 'attach')
    chip.append(el('span', null, `${a.name} · ${a.text.length}c`))
    const kill = el('button', null, '✕')
    kill.type = 'button'
    kill.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments() })
    chip.appendChild(kill)
    host.appendChild(chip)
  })
}

/* ═══════════ voice ═══════════ */

let voice = null

async function startVoice() {
  const panel = $('voice')
  const orb = $('orb')
  const text = $('voiceText')
  panel.hidden = false
  $('micBtn').classList.add('is-live')
  text.textContent = 'listening…'

  voice = { stream: null, ctx: null, raf: 0, recogniser: null }

  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    voice.ctx = new AudioContext()
    const source = voice.ctx.createMediaStreamSource(voice.stream)
    const analyser = voice.ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      analyser.getByteTimeDomainData(bins)
      let sum = 0
      for (const b of bins) sum += (b - 128) ** 2
      const level = Math.min(1, Math.sqrt(sum / bins.length) / 34)
      orb.style.setProperty('--level', level.toFixed(3))
      voice.raf = requestAnimationFrame(tick)
    }
    tick()
  } catch (error) {
    text.textContent = `microphone unavailable — ${error.message}`
  }

  const Recogniser = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (!Recogniser) {
    text.textContent = 'speech recognition unavailable in this browser — level meter only'
    return
  }
  voice.recogniser = new Recogniser()
  voice.recogniser.continuous = true
  voice.recogniser.interimResults = true
  voice.recogniser.lang = navigator.language || 'en-US'

  let settled = ''
  voice.recogniser.addEventListener('result', (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0].transcript
      if (event.results[i].isFinal) settled += chunk
      else interim += chunk
    }
    const phrase = (settled + interim).trim()
    text.textContent = phrase || 'listening…'
    promptEl.value = phrase
    promptEl.dispatchEvent(new Event('input'))
  })
  voice.recogniser.addEventListener('error', (event) => {
    text.textContent = `recognition error — ${event.error}`
  })
  voice.recogniser.start()
}

function stopVoice() {
  $('voice').hidden = true
  $('micBtn').classList.remove('is-live')
  if (!voice) return
  cancelAnimationFrame(voice.raf)
  voice.recogniser?.stop()
  voice.stream?.getTracks().forEach((t) => t.stop())
  void voice.ctx?.close()
  voice = null
  promptEl.focus()
}

$('micBtn').addEventListener('click', () => { voice ? stopVoice() : startVoice() })
$('voiceStop').addEventListener('click', stopVoice)

/* ═══════════ chrome ═══════════ */

$('newSession').addEventListener('click', () => {
  if (activeRunId) {
    void fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: activeRunId, end: true }),
    })
    activeRunId = null
  }
  setSession(null)
  hint.textContent = 'session cleared — next run starts fresh'
})

const expandBtn = $('expand')
expandBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await $('console').requestFullscreen()
  } catch {
    document.body.classList.toggle('expanded')
  }
})
document.addEventListener('fullscreenchange', () => {
  const full = document.fullscreenElement === $('console')
  document.body.classList.toggle('expanded', full)
  expandBtn.title = full ? 'restore (F)' : 'fill the screen (F)'
  expandBtn.setAttribute('aria-label', full ? 'restore' : 'expand')
})

const themeBtn = $('themeBtn')

/** The theme itself is set in index.html before first paint; this keeps the
 *  key's glyph and label in step and remembers an explicit choice. */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme
  const other = theme === 'light' ? 'dark' : 'light'
  themeBtn.title = `${other} mode (L)`
  themeBtn.setAttribute('aria-label', `switch to ${other} mode`)
}

themeBtn.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  setTheme(theme)
  try { localStorage.setItem('controller-theme', theme) } catch { /* the choice just won't persist */ }
})

// Until a theme is chosen here, follow the OS when it switches.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
  let saved = null
  try { saved = localStorage.getItem('controller-theme') } catch { /* storage blocked */ }
  if (!saved) setTheme(event.matches ? 'light' : 'dark')
})

setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

document.addEventListener('keydown', (event) => {
  const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)
  if (typing) return
  if (event.key.toLowerCase() === 'f') expandBtn.click()
  if (event.key.toLowerCase() === 'l' && !event.metaKey && !event.ctrlKey) themeBtn.click()
  if (event.key.toLowerCase() === 'c') document.body.classList.toggle('show-rack')
  if (event.key.toLowerCase() === 's') document.body.classList.toggle('show-scope')
})

for (const [id, cls] of [['toggleRack', 'show-rack'], ['toggleScope', 'show-scope']]) {
  $(id)?.addEventListener('click', () => document.body.classList.toggle(cls))
}

/* ═══════════ boot ═══════════ */

fetch('/api/defaults')
  .then((r) => r.json())
  .then((d) => { $('cwd').value = d.cwd })
  .catch(() => { $('cwd').value = '' })

setEffort(2)
setRoute()
drawScope()
renderAgents()
void probe()

const params = new URLSearchParams(location.search)
const replayFile = params.get('replay')
if (replayFile) {
  setRunState('running')
  startRunBlock(`[replay] ${replayFile}`)
  fetch(`/api/replay?file=${encodeURIComponent(replayFile)}&delay=${encodeURIComponent(params.get('delay') ?? '0')}`)
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).error)
      restoring = true
      await consume(response)
      restoring = false
      if (runState.dataset.state !== 'failed') setRunState('done')
      hint.textContent = `replayed ${replayFile}`
    })
    .catch((error) => failRun(error.message))
}

promptEl.focus()

/* ═══════════ merge ═══════════ */

const mergePanel = $('mergePanel')

async function mergePost(path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: $('cwd').value }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

$('mergeBtn').addEventListener('click', async () => {
  $('mergeBody').textContent = 'reading the repository…'
  $('mergeGo').disabled = true
  mergePanel.hidden = false
  try {
    const p = await mergePost('/api/git/merge-preview')
    const lines = [
      `repo     ${p.repo.split('/').pop()}`,
      `branch   ${p.branch} → main`,
      p.remote ? `remote   ${p.remote}/main${p.unpushed ? ` · ${p.unpushed} local commit(s) not yet pushed` : ''}` : 'remote   none — local merge only',
    ]
    if (p.onMain) lines.push('', 'already on main — nothing to merge')
    else if (p.dirty) lines.push('', `${p.dirty} uncommitted change${p.dirty === 1 ? '' : 's'} — commit or stash first`)
    else if (!p.commits) lines.push('', 'no commits ahead of main')
    else {
      lines.push(`commits  ${p.commits}`, p.stat ? `changes  ${p.stat.trim()}` : '', '', ...p.log)
    }
    $('mergeBody').textContent = lines.filter((l) => l !== undefined).join('\n')
    $('mergeGo').disabled = Boolean(p.onMain || p.dirty || !p.commits)
  } catch (error) {
    $('mergeBody').textContent = error.message
    $('mergeGo').disabled = true
  }
})

$('mergeGo').addEventListener('click', async () => {
  $('mergeGo').disabled = true
  $('mergeBody').textContent = 'merging…'
  try {
    const r = await mergePost('/api/git/merge')
    const tail = r.pushed
      ? `pushed to ${r.remote}/main`
      : `NOT PUSHED — ${r.pushError}\n\nthe merge is committed locally; push it yourself once resolved`
    $('mergeBody').textContent = `merged ${r.branch} into main\n\n${r.head}\n\n${tail}`
  } catch (error) {
    $('mergeBody').textContent = error.message
  }
})

$('mergeCancel').addEventListener('click', () => { mergePanel.hidden = true })

/* ═══════════ subagent lever ═══════════ */

const SUB_MAX = 25
const lever = $('subLever')
let subagents = 4

function setSubagents(next) {
  subagents = Math.max(0, Math.min(SUB_MAX, Math.round(next)))
  $('subValue').textContent = String(subagents)
  $('subFill').style.setProperty('--fill', `${(subagents / SUB_MAX) * 100}%`)
  lever.dataset.value = String(subagents)
  lever.setAttribute('aria-valuenow', String(subagents))
  if (typeof syncRequire === 'function') syncRequire()
  lever.title = subagents === 0
    ? 'no delegation — the Agent tool is withheld'
    : `up to ${subagents} subagent${subagents === 1 ? '' : 's'} at once`
}

function levelFromPointer(event) {
  const box = lever.getBoundingClientRect()
  const ratio = 1 - (event.clientY - box.top) / box.height
  setSubagents(ratio * SUB_MAX)
}

let levering = false
lever.addEventListener('pointerdown', (event) => {
  levering = true
  lever.setPointerCapture(event.pointerId)
  levelFromPointer(event)
})
lever.addEventListener('pointermove', (event) => { if (levering) levelFromPointer(event) })
lever.addEventListener('pointerup', () => { levering = false })
lever.addEventListener('pointercancel', () => { levering = false })

lever.addEventListener('wheel', (event) => {
  event.preventDefault()
  setSubagents(subagents + (event.deltaY > 0 ? -1 : 1))
}, { passive: false })

lever.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); setSubagents(subagents + 1) }
  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); setSubagents(subagents - 1) }
})

setSubagents(4)

syncSendKey()

$('requireSub').addEventListener('change', (event) => {
  requireSubagents = event.target.checked
  syncRequire()
})

function syncRequire() {
  const off = subagents === 0
  if (off) requireSubagents = false
  const box = $('requireSub')
  box.checked = requireSubagents
  box.disabled = off
  $('requireLabel').textContent = off
    ? 'delegation off'
    : requireSubagents ? 'delegation required' : 'delegation optional'
  $('agentCount').textContent =
    `${Object.keys(customAgents).length} custom${requireSubagents ? ' · forced' : ''}`
}
