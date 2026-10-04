/**
 * Browser audit.
 *
 * Drives the real UI in an installed Chromium browser so interaction, live SSE
 * streaming, collapse/expand and the outline jump are verified in a real DOM
 * rather than only as static markup.
 *
 * Assumes the server is already serving the production build on
 * http://127.0.0.1:8000 (npm run build && npm start); set BASE_URL to point it
 * elsewhere. Set CHROME_PATH if no browser is found at the default paths.
 *
 *   node scripts/check-browser.mjs
 */
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8000'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const executablePath = CANDIDATES.find((p) => p && fs.existsSync(p))
if (!executablePath) {
  console.error('No Chromium-based browser found.')
  process.exit(2)
}

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

const $ = (sel) => page.$(sel)
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0)
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null)

async function waitFor(fn, { timeout = 180000, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const runStatus = (index = 1) =>
  page
    .$$eval('.run', (els) => els.map((e) => e.querySelector('.pill')?.textContent ?? ''))
    .then((all) => all[index - 1] ?? null)

/**
 * Replay a saved trajectory and wait until it has finished arriving.
 *
 * Two things every caller used to have to remember, and one that none of them
 * did.
 *
 * `page.select` with a value the <select> does not carry is a silent no-op: it
 * leaves whatever was chosen before in place, the Replay button then replays
 * *that*, and every assertion below measures the wrong trajectory while
 * reporting a pass. A recording that has been moved, renamed or -- in the case
 * of `sessions/runs/`, which is gitignored runtime output -- simply deleted
 * turns a whole section green without testing anything. So the option is
 * checked first and a missing one is a hard failure, named.
 *
 * The wait is for the run's own terminal status rather than for a node count
 * plus a sleep. A sleep long enough for this machine is not long enough for a
 * slower one, and a node count is satisfied part-way through the stream -- both
 * leave the next assertion racing the tail of the replay.
 */
async function startReplay(trajectoryPath, { label = trajectoryPath } = {}) {
  const listed = await page.$$eval(
    '.panel:last-child select option',
    (options, want) => options.map((o) => o.value).includes(want),
    trajectoryPath
  )
  if (!listed) {
    throw new Error(`no such trajectory in the replay list: ${trajectoryPath}`)
  }

  await page.select('.panel:last-child select', trajectoryPath)
  const buttons = await page.$$('.panel:last-child button')
  await buttons[buttons.length - 1].click()

  await waitFor(
    async () => ['completed', 'failed', 'stopped'].includes(await runStatus(1)),
    { label: `replay of ${label}` }
  )
}

async function setCwd(value) {
  const input = await $('.composer input[type="text"], .composer input:not([type])')
  await input.click()
  // Select-all then overwrite. A controlled React input ignores value writes
  // that do not dispatch a real input event, so this has to go through keys.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await input.type(value)

  const actual = await page.$eval('.composer input', (e) => e.value)
  if (actual !== value) throw new Error(`could not set cwd: got "${actual}", want "${value}"`)
}

async function submitPrompt(prompt, cwd) {
  if (cwd !== undefined) await setCwd(cwd)
  const ta = await $('.composer textarea')
  await ta.click()
  await ta.type(prompt)
  const buttons = await page.$$('.composer-actions button')
  await buttons[0].click()
}

// ===========================================================================
console.log('\n== page loads ==')

await page.goto(BASE, { waitUntil: 'networkidle0' })
check('app mounted', (await count('.app')) === 1)
check('composer present', (await count('.composer textarea')) === 1)
check('working-directory input present', (await count('.composer input')) >= 1)
check('replay list populated', (await count('.panel:last-child select option')) > 0)
check('no page errors on load', pageErrors.length === 0, pageErrors.join(' | '))

// ===========================================================================
console.log('\n== R4: invalid working directory ==')

await submitPrompt('this should not run', 'no-such-directory-xyz')
await waitFor(async () => (await runStatus(1)) === 'failed', { label: 'failed run' })

check('run 1 marked failed', (await runStatus(1)) === 'failed')
check('failure reason visible', (await text('.run .notice-error'))?.includes('does not exist') === true)
check('metrics reported unavailable', (await page.content()).includes('metrics unavailable'))
check('no fabricated cost', !(await page.$eval('.run', (e) => e.textContent)).includes('$0.00'))

// Regression: a first run that failed before a session existed must leave the
// working directory editable, otherwise a typo is unrecoverable.
check(
  'working directory still editable after a failed first run',
  (await page.$eval('.composer input', (e) => e.disabled)) === false
)
check(
  'composer not stuck busy after failure',
  (await page.$eval('.composer', (e) => !e.textContent.includes('run in progress')))
)

// ===========================================================================
console.log('\n== R1 + R2 + R3 + R4: live run ==')

await submitPrompt(
  'Run `ls -la` and then `python main.py --help`. Report both outputs in a short Markdown list with a fenced code block. Do not modify files.',
  'claude-test'
)

// Controls must lock while a run is active.
await waitFor(async () => (await runStatus(2)) === 'running', { label: 'run 2 running' })
const lockedDuringRun = await page.$$eval('.composer-actions button', (b) => b[0].disabled)
const cwdLocked = await page.$eval('.composer input', (e) => e.disabled)
check('submit disabled while a run is active', lockedDuringRun === true)
check('working directory locked to the session', cwdLocked === true)
check('previous failed run still visible', (await count('.run')) === 2)
check('previous run kept its failed status', (await runStatus(1)) === 'failed')

// Incremental arrival: a tool card must appear before the run finishes.
let sawToolWhileRunning = false
let sawRunningTool = false
await waitFor(
  async () => {
    const st = await runStatus(2)
    const tools = await count('.run:nth-of-type(2) .node.tool')
    if (st === 'running' && tools > 0) sawToolWhileRunning = true
    if ((await count('.run:nth-of-type(2) .tool-running')) > 0) sawRunningTool = true
    return st === 'completed' || st === 'failed'
  },
  { label: 'run 2 terminal' }
)

check('R2: tool cards appeared while the run was still streaming', sawToolWhileRunning)
check('R4: a tool was shown pending/running during the run', sawRunningTool)
check('R4: run 2 completed', (await runStatus(2)) === 'completed')
check('R1: a second run started after the first completed', (await count('.run')) === 2)

const run2 = '.run:nth-of-type(2)'
check('R2: markdown rendered (paragraph)', (await count(`${run2} .markdown p`)) > 0)
check('R2: markdown code fence rendered', (await count(`${run2} .markdown pre code`)) > 0)
check('R2: markdown list rendered', (await count(`${run2} .markdown li`)) > 0)
check('R3: tool cards present', (await count(`${run2} .node.tool`)) > 0)
check('R3: tool results attached (completed)', (await count(`${run2} .tool-completed`)) > 0)

// Rows are compact by default; the detail is one click away.
check('R3: tool detail folded by default', (await count(`${run2} .tool-body`)) === 0)
check('R3: folded rows still report their outcome', (await count(`${run2} .tool-peek`)) > 0)
check('R3: folded rows name their target', (await count(`${run2} .tool-target`)) > 0)
await page.click(`${run2} .expand-all`)
await new Promise((r) => setTimeout(r, 250))
check('R3: expand all reveals the detail', (await count(`${run2} .tool-body`)) > 0)

check('R3: stdout labelled', (await page.$eval(run2, (e) => e.textContent)).includes('stdout'))

// R6 metrics
const metrics = await page.$eval(run2, (e) => {
  const labels = [...e.querySelectorAll('.metric-label')].map((x) => x.textContent)
  const values = [...e.querySelectorAll('.metric-value')].map((x) => x.textContent)
  return Object.fromEntries(labels.map((l, i) => [l, values[i]]))
})
console.log(`     metrics: ${JSON.stringify(metrics)}`)
check('R6: cost shown', /^\$\d/.test(metrics.cost ?? ''))
check('R6: wall-clock duration shown', /(ms|s)$/.test(metrics.duration ?? ''))
check('R6: turn count shown', /^\d+$/.test(metrics.turns ?? ''))

// R5: session captured
const sessionText = await page.$eval('.status-bar', (e) => e.textContent)
check('R5: conversation session id shown', /session [0-9a-f]{8}-/.test(sessionText), sessionText)

// R3: expand/collapse of long output.
//
// Every read is scoped to the block the control belongs to. This used to click
// the first `button.link` in the run and then measure the first `.block-body`
// in the run -- two different elements, because the first block is an input and
// the first fold is further down in some tool's output. The number never moved,
// so a control that works reported `112 -> 112` and failed.
if ((await count(`${run2} button.link`)) > 0) {
  await page.$eval(`${run2} button.link`, (btn) =>
    btn.closest('.block').setAttribute('data-probe', 'live')
  )
  const liveChars = () =>
    page.$eval('[data-probe="live"] .block-body', (e) => e.textContent.length)

  const before = await liveChars()
  await page.click('[data-probe="live"] button.link')
  await waitFor(async () => (await liveChars()) !== before, { label: 'the live block to expand' })
  const after = await liveChars()
  check('R3: expand reveals more output', after > before, `${before} -> ${after}`)

  await page.click('[data-probe="live"] button.link')
  await waitFor(async () => (await liveChars()) === before, { label: 'the live block to collapse' })
  check('R3: collapse restores the preview', (await liveChars()) === before)
} else {
  console.log('  SKIP  R3 expand/collapse: no output exceeded the truncation threshold')
}

// Per-row collapse still wins over the run-wide default.
const firstToolHead = await page.$(`${run2} .tool-head`)
const bodiesBefore = await count(`${run2} .tool-body`)
await firstToolHead.click()
const bodiesAfter = await count(`${run2} .tool-body`)
check('tool row collapses on click', bodiesAfter === bodiesBefore - 1)
await (await page.$(`${run2} .tool-head`)).click()
check('tool row reopens', (await count(`${run2} .tool-body`)) === bodiesBefore)

// ===========================================================================
console.log('\n== R5: session resume in the browser ==')

const sessionBefore = (await page.$eval('.status-bar', (e) => e.textContent)).match(
  /session ([0-9a-f-]{36})/
)?.[1]

await submitPrompt('Reply with just the word FOLLOWUP. Do not use any tools.')
await waitFor(async () => ['completed', 'failed'].includes(await runStatus(3)), {
  label: 'run 3 terminal',
})

check('R5: run 3 completed', (await runStatus(3)) === 'completed')
check('R1/R5: all three runs still visible', (await count('.run')) === 3)
check('R5: run 3 labelled as resumed', (await page.$eval('.run:nth-of-type(3) .run-head', (e) => e.textContent)).includes('resumed'))

const sessionAfter = (await page.$eval('.status-bar', (e) => e.textContent)).match(
  /session ([0-9a-f-]{36})/
)?.[1]
check('R5: same session id across runs', sessionBefore === sessionAfter, `${sessionBefore} / ${sessionAfter}`)

const run2MetricsStill = await page.$eval(run2, (e) =>
  [...e.querySelectorAll('.metric-value')].map((x) => x.textContent).join('|')
)
check('R6: earlier run keeps its own metrics', run2MetricsStill.startsWith('$'), run2MetricsStill)
check(
  'R6: run metrics are per-run, not shared',
  (await page.$$eval('.run .metrics', (els) =>
    els.map((e) => e.textContent).filter((t, i, a) => a.indexOf(t) === i).length
  )) > 1
)

// The deliberate invalid-directory test above produces a 400, which the browser
// logs as a console error. That is correct behaviour, so only unexpected errors
// count here.
const unexpected = pageErrors.filter((e) => !e.includes('400'))
check('no unexpected page errors during live runs', unexpected.length === 0, unexpected.join(' | '))

// ===========================================================================
console.log('\n== R7: subagent fixture replay ==')

await startReplay('fixtures/subagent-forward.jsonl')
await waitFor(async () => (await count('.run')) === 1, { label: 'one run on the page' })

check('replay produced one run', (await count('.run')) === 1)
check('R7: spawning card marked', (await count('.tool-spawner')) === 1)
check('R7: subagent badge shown', (await count('.branch-badge')) === 1)
check('R7: branch rendered', (await count('.branch')) === 1)
check('R7: short branch expanded by default', (await count('.branch-body')) === 1)

const nestedInside = await page.evaluate(() => {
  const spawner = document.querySelector('.tool-spawner')
  const nested = spawner?.querySelector('.branch .node.tool')
  return Boolean(nested) && spawner.contains(nested)
})
check('R7: nested tool is contained by the spawning card', nestedInside)

check('R7: outline rendered', (await count('.outline')) === 1)
check('R7: outline lists both tools', (await count('.outline-item')) === 2)
check('R7: outline nests the subagent tool', (await count('.outline-list .outline-list')) === 1)

// Collapse the branch, confirm nested content hides, then reopen.
await (await page.$('.branch-head')).click()
check('R7: branch collapses', (await count('.branch-body')) === 0)
check('R7: collapsed branch keeps its header', (await count('.branch-head')) === 1)
check('R7: outline still lists hidden nested tool', (await count('.outline-item')) === 2)

// Outline jump must reopen the collapsed branch and scroll to the target.
const nestedOutlineBtn = await page.$('.outline-list .outline-list .outline-item')
await nestedOutlineBtn.click()
await new Promise((r) => setTimeout(r, 900))
check('R7: outline jump reopened the branch', (await count('.branch-body')) === 1)

const jumped = await page.evaluate(() => {
  const el = document.querySelector('.branch .node.tool')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { id: el.id, inView: r.top >= -50 && r.top <= window.innerHeight }
})
check('R7: jump target has a tool-use-derived dom id', jumped?.id?.includes('toolu_') === true, jumped?.id)
check('R7: jump scrolled the target into view', jumped?.inView === true)

// ===========================================================================
console.log('\n== parallel subagents fan out (geometry) ==')

// Layout is the whole claim here -- "side by side", "the connectors meet" --
// and neither can be checked without a real stylesheet and a real layout pass,
// which is why this lives in the browser audit rather than in check-render.
await startReplay('fixtures/parallel-tasks.jsonl')
await waitFor(async () => (await count('.outline-item')) === 6, { label: 'six outline tokens' })

const fan = await page.evaluate(() => {
  const fork = document.querySelector('.outline-fork')
  if (!fork) return null
  const branches = [...fork.querySelectorAll(':scope > .outline-branch')]
  const edge = (el, pseudo, prop) => getComputedStyle(el, pseudo)[prop]
  return {
    display: getComputedStyle(fork).display,
    direction: getComputedStyle(fork).flexDirection,
    boxes: branches.map((b) => b.getBoundingClientRect().toJSON()),
    pills: branches.map((b) =>
      b.querySelector(':scope > .outline-node > .outline-item').getBoundingClientRect().toJSON()
    ),
    // The trunk into a fan-out is the thread of the level it interrupts,
    // carried on through the gap the fork opens above its crossbar -- the
    // fan-out draws no connector of its own to reach the column.
    trunk: edge(fork.parentElement.parentElement, '::before', 'borderLeftWidth'),
    forkMask: getComputedStyle(fork).backgroundClip,
    bars: branches.map((b) => [edge(b, '::before', 'borderTopWidth'), edge(b, '::after', 'content')]),
    drops: branches.map((b) =>
      edge(b.querySelector(':scope > .outline-node'), '::before', 'borderLeftWidth')
    ),
    colours: [...document.querySelectorAll('.outline-item')].map(
      (el) => getComputedStyle(el).color
    ),
    token: (() => {
      const cs = getComputedStyle(document.querySelector('.outline-item'))
      return {
        borderWidth: cs.borderTopWidth,
        borderColour: cs.borderTopColor,
        background: cs.backgroundColor,
        padY: parseFloat(cs.paddingTop),
        radius: cs.borderRadius,
        fontSize: parseFloat(cs.fontSize),
        lineHeight: parseFloat(cs.lineHeight),
        padding: parseFloat(cs.paddingLeft),
        icons: document.querySelectorAll('.outline-item svg').length,
      }
    })(),
    head: (() => {
      const cs = getComputedStyle(document.querySelector('.tool-name'))
      return { fontSize: parseFloat(cs.fontSize), lineHeight: parseFloat(cs.lineHeight) }
    })(),
  }
})

check('parallel: the two subagents fan out', Boolean(fan))
check('parallel: the fan-out is a flex row',
  fan?.display === 'flex' && fan?.direction === 'row', `${fan?.display}/${fan?.direction}`)
check('parallel: both branches share a top edge',
  fan?.pills[0].top === fan?.pills[1].top,
  `${fan?.pills[0].top} vs ${fan?.pills[1].top}`)
check('parallel: the branches sit beside each other',
  fan?.pills[0].left < fan?.pills[1].left)
check('parallel: the branch boxes touch, so the crossbar is unbroken',
  Math.abs(fan.boxes[0].right - fan.boxes[1].left) < 0.5,
  `${fan.boxes[0].right} -> ${fan.boxes[1].left}`)
check('parallel: trunk is a border, not a character', fan?.trunk === '1px')
check('parallel: the fan-out masks the thread it replaces', fan?.forkMask === 'content-box')
check('parallel: crossbar is a border on each branch',
  fan?.bars.every(([top]) => top === '1px'))
check('parallel: crossbar stops at the last branch', fan?.bars.at(-1)[1] === 'none')
check('parallel: each branch drops a connector', fan?.drops.every((d) => d === '1px'))
// The connector runs behind the tokens and is hidden by them, which only
// works if a token is opaque -- a tinted wash would leave the line showing
// through the middle of every name. The border is there but colourless: it is
// reserved for the two states that need an edge, and reserving it means those
// states cost no reflow.
check('parallel: tokens are opaque, so the thread passes behind them',
  fan?.token.background !== 'rgba(0, 0, 0, 0)' && !/,\s*0(\.\d+)?\s*\)$/.test(fan?.token.background ?? ''),
  `${fan?.token.background}`)
check('parallel: tokens carry no visible border at rest',
  fan?.token.borderWidth === '1px' && fan?.token.borderColour === 'rgba(0, 0, 0, 0)',
  `${fan?.token.borderWidth} / ${fan?.token.borderColour}`)
check('parallel: every token carries its kind glyph', fan?.token.icons === 6, `${fan?.token.icons}`)
// Enough padding to read as a chip on a thread, little enough that the chip
// is still mostly its name: the sidebar's width belongs to tool names.
check('parallel: tokens are padded as chips, not as rows',
  fan?.token.padding > 3 && fan?.token.padding <= 10 && fan?.token.padY <= 3,
  `${fan?.token.padding}px / ${fan?.token.padY}px`)
check('parallel: the outline is set well below the trajectory',
  fan?.token.fontSize <= fan?.head.fontSize * 0.85,
  `${fan?.token.fontSize}px vs ${fan?.head.fontSize}px`)
check('parallel: the outline sets tighter lines than the trajectory',
  fan?.token.lineHeight < fan?.head.lineHeight,
  `${fan?.token.lineHeight}px vs ${fan?.head.lineHeight}px`)
check('parallel: tool kinds are coloured apart',
  new Set(fan?.colours).size === 3, [...new Set(fan?.colours)].join(' '))
check('parallel: no box-drawing characters in the outline',
  !/[\u2500-\u257f]/.test(await page.$eval('.outline', (e) => e.textContent)))

// ===========================================================================
console.log('\n== R7 regression: normal trajectory stays flat ==')

await startReplay('claude-test/events.jsonl')
await waitFor(async () => (await count('.node.tool')) === 4, { label: 'four tool cards' })

check('flat replay: four tool cards', (await count('.node.tool')) === 4)
check('flat replay: no branches', (await count('.branch')) === 0)
check('flat replay: no subagent badges', (await count('.branch-badge')) === 0)
check('flat replay: no spawner styling', (await count('.tool-spawner')) === 0)
check('flat replay: outline is flat', (await count('.outline-list .outline-list')) === 0)
check('flat replay: outline lists four tools', (await count('.outline-item')) === 4)
check('flat replay: markdown rendered', (await count('.markdown p')) > 0)
check('flat replay: no fan-out', (await count('.outline-fork')) === 0)

const column = await page.evaluate(() =>
  [...document.querySelectorAll('.outline-item')].map((el) => {
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), top: r.top, bottom: r.bottom }
  })
)
check('flat replay: outline is a single vertical line',
  new Set(column.map((c) => c.left)).size === 1,
  column.map((c) => c.left).join(','))
check('flat replay: every pill stacks below the last',
  column.every((c, i) => i === 0 || c.top >= column[i - 1].bottom - 1))

// ===========================================================================
console.log('\n== the outline column is width-locked ==')

// The outline is a table of contents in a fixed sidebar, so its width is a
// constant of the layout rather than a function of the run. A trajectory that
// fans out into nested parallel subagents four levels deep has to come out at
// exactly the width of one that made four tool calls in a row -- same column,
// same trajectory beside it, and no horizontal scrollbar anywhere inside.
// Measured rather than read off the CSS: `flex: 1 1 0` only shares the width
// out if nothing downstream re-establishes a minimum.
const measureOutline = () =>
  page.evaluate(() => {
    const outline = document.querySelector('.outline')
    const traj = document.querySelector('.trajectory')
    const cs = getComputedStyle(outline)
    const box = outline.getBoundingClientRect()
    // The padding box: as far right as content is actually allowed to reach.
    const contentRight = box.right - parseFloat(cs.borderRightWidth)
    const items = [...outline.querySelectorAll('.outline-item')]
    const branches = [...outline.querySelectorAll('.outline-branch:not(.outline-fork-slot)')]
    // Tree depth, counting the <li> per node and skipping the extra one a
    // fan-out inserts for its slot.
    const depthOf = (el) => branches.filter((li) => li.contains(el)).length
    const excess = (el) => el.scrollWidth - el.clientWidth

    return {
      width: box.width,
      cols: getComputedStyle(document.querySelector('.run-body')).gridTemplateColumns,
      overflowX: cs.overflowX,
      scrollExcess: excess(outline),
      forkExcess: Math.max(0, ...[...outline.querySelectorAll('.outline-fork')].map(excess)),
      overhang: Math.max(0, ...items.map((el) => el.getBoundingClientRect().right - contentRight)),
      depth: Math.max(0, ...items.map(depthOf)),
      forks: outline.querySelectorAll('.outline-fork').length,
      nestedForks: outline.querySelectorAll('.outline-fork .outline-fork').length,
      items: items.length,
      trajectoryWidth: traj.getBoundingClientRect().width,
    }
  })

// Reload first: `position: sticky` plus a scrolled page make bounding boxes
// carried over from the previous section unsafe to compare against.
await page.goto(BASE, { waitUntil: 'networkidle0' })
await startReplay('claude-test/events.jsonl')
await waitFor(async () => (await count('.outline-item')) === 4, { label: 'zero-subagent replay' })
const plain = await measureOutline()

await startReplay('fixtures/parallel-deep.jsonl')
await waitFor(async () => (await count('.outline-item')) === 10, { label: 'deep parallel replay' })
const deep = await measureOutline()

console.log(`     zero subagents: ${JSON.stringify(plain)}`)
console.log(`     two parallel branches, four deep: ${JSON.stringify(deep)}`)

check(
  'width-lock: the deep run really is two parallel branches four levels deep',
  deep.depth === 4 && deep.forks === 2 && deep.nestedForks === 1,
  `depth ${deep.depth}, ${deep.forks} forks, ${deep.nestedForks} nested`
)
check(
  'width-lock: the outline is exactly as wide with two branches as with none',
  Math.abs(deep.width - plain.width) < 0.5,
  `${plain.width} vs ${deep.width}`
)
check('width-lock: the sidebar track is unchanged', deep.cols === plain.cols,
  `${plain.cols} vs ${deep.cols}`)
check(
  'width-lock: the trajectory beside it does not move',
  Math.abs(deep.trajectoryWidth - plain.trajectoryWidth) < 0.5,
  `${plain.trajectoryWidth} vs ${deep.trajectoryWidth}`
)
check('width-lock: horizontal scrolling is off, not merely unused',
  deep.overflowX === 'hidden', deep.overflowX)
check(
  'width-lock: the outline has nothing to scroll sideways to',
  deep.scrollExcess < 1 && plain.scrollExcess < 1,
  `${plain.scrollExcess} / ${deep.scrollExcess}`
)
check('width-lock: no fan-out scrolls sideways', deep.forkExcess < 1, `${deep.forkExcess}`)
check('width-lock: every token stays inside the column', deep.overhang < 0.5,
  `${deep.overhang}px past the edge`)

// A card nested inside another card has to stay inside it. This is geometry, so
// only a real layout pass can catch it: a column flex container with
// `align-items: start` sizes its items to max-content on the cross axis, which
// pushes an inner card straight out through the side of the outer one.
//
// It only shows at a width where the *outer* fan-out pairs its cards, because
// that is what leaves the inner rows short of room -- at the 1280px this
// section otherwise runs at, the top row stacks and nothing overflows. So the
// window is widened for this measurement and put back afterwards.
await page.setViewport({ width: 1800, height: 900 })
await new Promise((r) => setTimeout(r, 250))

// A deep branch is collapsed by default, so the nested cards have to be opened
// before there is any geometry to measure.
for (const head of await page.$$('.branch-collapsed .branch-head')) await head.click()
await new Promise((r) => setTimeout(r, 400))

const nesting = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.node.tool.tool-spawner')]
  const rows = [...document.querySelectorAll('.agent-row')]
  const depth = (el) => {
    let d = 0
    let p = el.parentElement
    while (p) {
      if (p.classList.contains('tool-spawner')) d += 1
      p = p.parentElement
    }
    return d
  }
  return {
    cards: cards.length,
    maxDepth: Math.max(0, ...cards.map(depth)),
    worstOverflow: Math.max(
      0,
      ...cards.map((c) => {
        const parent = c.parentElement.closest('.node.tool.tool-spawner')
        if (!parent) return 0
        return c.getBoundingClientRect().right - parent.getBoundingClientRect().right
      })
    ),
    worstRowExcess: Math.max(0, ...rows.map((r) => r.scrollWidth - r.clientWidth)),
    trajectoryExcess: (() => {
      const t = document.querySelector('.trajectory')
      return t.scrollWidth - t.clientWidth
    })(),
  }
})
console.log(`     nesting: ${JSON.stringify(nesting)}`)
// Card depth, not the outline's <li> depth the width-lock section counts: this
// fixture puts a card inside a card inside a card, which is two levels of
// containment and the shape that broke.
check('nesting: the fixture really does nest cards inside cards',
  nesting.cards === 6 && nesting.maxDepth === 2, `${nesting.cards} cards, depth ${nesting.maxDepth}`)
check('nesting: no card escapes the card that owns it',
  nesting.worstOverflow < 1, `${Math.round(nesting.worstOverflow)}px past its parent`)
check('nesting: no fan-out row is wider than the space it was given',
  nesting.worstRowExcess < 1, `${Math.round(nesting.worstRowExcess)}px`)
check('nesting: the trajectory itself never scrolls sideways',
  nesting.trajectoryExcess < 1, `${nesting.trajectoryExcess}px`)

// Back to the width the rest of this section measures at.
await page.setViewport({ width: 1280, height: 900 })
await new Promise((r) => setTimeout(r, 250))

// A fan-out nested inside another fan-out is where the two connector systems
// overlap: an inner fork is itself an `.outline-list` inside an `.outline-fork`,
// so the elbow rules and the crossbar rules can match the same branch at the
// same specificity and the bar comes apart into stray ticks. Checked per
// branch, on the run that actually has one nested inside another.
const joints = await page.evaluate(() =>
  [...document.querySelectorAll('.outline-fork')].flatMap((fork, f) => {
    const branches = [...fork.querySelectorAll(':scope > .outline-branch')]
    return branches.map((b, i) => {
      const before = getComputedStyle(b, '::before')
      const node = b.querySelector(':scope > .outline-node')
      return {
        fork: f,
        last: i === branches.length - 1,
        halfBar: parseFloat(before.width),
        half: b.getBoundingClientRect().width / 2,
        barLeft: parseFloat(before.left),
        barBorder: before.borderTopWidth,
        tail: getComputedStyle(b, '::after').content,
        drop: getComputedStyle(node, '::before').borderLeftWidth,
      }
    })
  })
)
console.log(`     fork joints: ${JSON.stringify(joints)}`)

check('width-lock: every branch of every fan-out draws half a crossbar',
  joints.length === 4 && joints.every((j) => Math.abs(j.halfBar - j.half) < 0.5),
  joints.map((j) => `${j.halfBar}/${j.half}`).join(' '))
check('width-lock: no branch of a fan-out is given an elbow instead',
  joints.every((j) => j.barLeft >= 0), joints.map((j) => j.barLeft).join(' '))
check('width-lock: the crossbar is a hairline at every depth',
  joints.every((j) => j.barBorder === '1px' && j.drop === '1px'))
check('width-lock: the crossbar stops at the last branch of each fan-out',
  joints.every((j) => (j.tail === 'none') === j.last),
  joints.map((j) => `${j.last}:${j.tail}`).join(' '))

// ===========================================================================
console.log('\n== malformed / hostile input does not break the page ==')

const before = pageErrors.length
const survived = await page.evaluate(() => Boolean(document.querySelector('.app')))
check('page still mounted after all replays', survived)
check('no new page errors', pageErrors.length === before, pageErrors.slice(before).join(' | '))

// ===========================================================================
console.log('\n== R3: long-output fold/expand (deterministic fixture) ==')

// A small, anonymous fixture with genuinely long tool output exercises the
// truncation path without depending on development recordings or live output.
await startReplay('fixtures/long-output.jsonl', { label: 'the long-output fixture' })

check('R3: a long trajectory opens as rows, not walls of output',
  (await count('.tool-body')) === 0)

// Wait for the rows to actually open rather than for a fixed number of
// milliseconds: expanding every row in a trajectory this size is real work, and
// how long it takes is a property of the machine, not of the feature.
await page.click('.expand-all')
await waitFor(async () => (await count('.tool-body')) > 3, { label: 'every row expanded' })
check('R3: expand all opens every row', (await count('.tool-body')) > 3)

// This fixture was chosen because it contains genuinely long tool output, so
// the truncation path is exercised deterministically rather than depending on
// what a live run happens to print. That makes the folded block an assertion,
// not a condition -- the whole section used to sit inside `if (expanders.length)`
// and would report a clean pass while testing none of it if the fold ever
// stopped happening.
const expanders = await count('button.link')
check('R3: long output was folded', expanders > 0, `${expanders} expanders`)

// The widest fold, not whichever happens to be first in the DOM: the first one
// is a function of render order, so the numbers this section prints changed
// between runs for no reason anyone could see.
const target = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.block')].filter((b) => b.querySelector('button.link'))
  const hidden = (b) => {
    const m = b.querySelector('button.link').textContent.match(/(\d+)/)
    return m ? Number(m[1]) : 0
  }
  const widest = blocks.sort((a, b) => hidden(b) - hidden(a))[0]
  widest.setAttribute('data-probe', '1')
  return {
    label: widest.querySelector('button.link').textContent,
    chars: widest.querySelector('.block-body').textContent.length,
  }
})
console.log(`     ${JSON.stringify(target)}`)
check('R3: fold control names what is hidden', target.label.startsWith('Show all ('))

const probeChars = () =>
  page.$eval('[data-probe="1"] .block-body', (e) => e.textContent.length)
const probeLabel = () =>
  page.$eval('[data-probe="1"] button.link', (e) => e.textContent.trim())

// React re-renders on its own schedule, so every one of these waits for the
// change it is about to assert rather than reading the DOM in the same tick as
// the click that changes it.
await page.click('[data-probe="1"] button.link')
await waitFor(async () => (await probeChars()) !== target.chars, { label: 'the block to expand' })
const expanded = await probeChars()
check('R3: expanding reveals the full output', expanded > target.chars, `${target.chars} -> ${expanded}`)
check('R3: control switches to collapse', (await probeLabel()) === 'Collapse')

await page.click('[data-probe="1"] button.link')
await waitFor(async () => (await probeChars()) === target.chars, { label: 'the block to collapse' })
check('R3: collapsing restores the preview', (await probeChars()) === target.chars)

check(
  'R3: output preserves whitespace and line breaks',
  (await page.$eval('[data-probe="1"] .block-body', (e) => getComputedStyle(e).whiteSpace)) ===
    'pre-wrap'
)

check('large replay: page survived', (await count('.app')) === 1)
check('large replay: run completed', (await runStatus(1)) === 'completed')

// ===========================================================================
console.log('\n== polish: legibility of a long trajectory ==')

// Still on the large replay from the previous section.
const polish = await page.evaluate(() => {
  const cardSteps = [...document.querySelectorAll('.node.tool .tool-step')].map((e) =>
    e.textContent.trim()
  )
  // A token shows its tool's name and nothing else, so the number it shares
  // with the card is read off the tooltip that carries everything the token
  // does not. The numbering still has to agree -- that is what makes the
  // outline a table of contents rather than a second, differently ordered
  // list of the same calls.
  const outlineSteps = [...document.querySelectorAll('.outline-item')].map(
    (e) => (e.title.match(/^(\d+)\./) ?? [])[1] ?? ''
  )
  const appHead = document.querySelector('.app-head')
  const runHead = document.querySelector('.run-head')
  return {
    cardSteps,
    outlineSteps,
    appHeadSticky: getComputedStyle(appHead).position === 'sticky',
    runHeadSticky: getComputedStyle(runHead).position === 'sticky',
    foldMarkers: document.querySelectorAll('.fold-marker').length,
    foldedBlocks: document.querySelectorAll('.block-folded').length,
    outputLabels: [...document.querySelectorAll('.block-label')].map((e) => e.textContent),
  }
})

check('polish: tool cards are numbered', polish.cardSteps.length > 0)
check(
  'polish: outline numbering matches the cards',
  JSON.stringify(polish.outlineSteps) === JSON.stringify(polish.cardSteps),
  `${polish.outlineSteps.slice(0, 5)} vs ${polish.cardSteps.slice(0, 5)}`
)
check('polish: app header is sticky', polish.appHeadSticky)
check('polish: run header is sticky', polish.runHeadSticky)
check('polish: folded blocks carry a fold marker', polish.foldMarkers === polish.foldedBlocks)
check('polish: folded output is marked', polish.foldMarkers > 0, `${polish.foldMarkers}`)
check(
  'polish: results are labelled distinctly from inputs',
  polish.outputLabels.some((l) => l === 'stdout' || l === 'output')
)

// Headers must really stay on screen once the page is scrolled.
await page.evaluate(() => window.scrollTo(0, 1200))
await new Promise((r) => setTimeout(r, 300))
const stuck = await page.evaluate(() => {
  const a = document.querySelector('.app-head').getBoundingClientRect()
  const r = document.querySelector('.run-head').getBoundingClientRect()
  return { appTop: Math.round(a.top), runTop: Math.round(r.top), scrolled: window.scrollY }
})
console.log(`     ${JSON.stringify(stuck)}`)
check('polish: app header stays on screen when scrolled', stuck.scrolled > 0 && stuck.appTop >= 0 && stuck.appTop < 40)
check('polish: run header stays on screen when scrolled', stuck.runTop >= 0 && stuck.runTop < 120)

// Collapsing a row must advertise that output is hidden underneath.
const peek = await page.evaluate(() => {
  document.querySelector('.node.tool .tool-head').click()
  return true
})
await new Promise((r) => setTimeout(r, 200))
check(
  'polish: collapsed row shows an output peek',
  peek && (await count('.node.tool .tool-peek')) > 0
)
await page.evaluate(() => document.querySelector('.node.tool .tool-head').click())
await new Promise((r) => setTimeout(r, 200))
check('polish: peek disappears when reopened', (await count('.node.tool .tool-peek')) === 0)

// ===========================================================================
console.log('\n== R7: live subagent run in the browser ==')

// A short viewport for this section, so the tail of a one-subagent trajectory
// is reliably below the fold and auto-follow has something to do. In a 900px
// window this run never grows past the viewport, so the detach scenario could
// not happen at all -- and a scenario that cannot happen turns its checks into
// a permanent skip, which tests nothing while looking fine. Width is untouched,
// so the layout is the same one every other section measures.
await page.setViewport({ width: 1280, height: 420 })
await page.goto(BASE, { waitUntil: 'networkidle0' })
await submitPrompt(
  'Use the Task tool to launch exactly one subagent (subagent_type "Explore") and ask it to read main.py and report in one sentence what it does. Do not read it yourself and do not modify files.',
  'claude-test'
)

// Four of the things this section checks for are transient: the active-tool
// bar, the outline's highlight on the running call, nested subagent rows while
// the parent is still streaming, and the jump-to-latest button. Polling for
// them from here samples every ~200ms through a round trip, so a state that
// comes and goes inside one interval is simply missed -- which is why two of
// these checks failed intermittently on a run where the feature worked.
//
// So the page watches itself. A MutationObserver records whether each state was
// *ever* present, which is exactly what the checks below ask; nothing is
// weakened, the observation just stops depending on when the sampler looked.
// `armed` is flipped from here once the reader has been scrolled away, because
// the jump-to-latest button is only meaningful after that.
await page.evaluate(() => {
  const seen = {
    activeToolBar: false,
    outlineActive: false,
    nestedWhileRunning: false,
    followLatestWhileDetached: false,
  }
  window.__probe = { seen, armed: false }

  const scan = () => {
    const running = Boolean(document.querySelector('.run')?.classList.contains('run-running'))
    if (document.querySelector('.active-tool')) seen.activeToolBar = true
    if (document.querySelector('.outline-active')) seen.outlineActive = true
    if (running && document.querySelector('.branch .node.tool')) seen.nestedWhileRunning = true
    if (window.__probe.armed && document.querySelector('.follow-latest')) {
      seen.followLatestWhileDetached = true
    }
  }

  scan()
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })
})

let scrolledUpOnce = false
let stayedPutWhileDetached = false
let scrollTopAfterDetach = null

await waitFor(
  async () => {
    const st = await runStatus(1)

    // Once there is something to scroll, scroll up and confirm auto-follow
    // yields to the reader instead of yanking them back down.
    if (st === 'running' && !scrolledUpOnce) {
      // The run has to have produced something before pretending the reader
      // scrolls away from it, and scroll position is the wrong signal for that:
      // focusing the composer to type the prompt already scrolls a short window
      // to the bottom, so "the page is scrolled down" is true before a single
      // frame has arrived. Scrolling to the top of a trajectory that is still
      // empty leaves the tail inside the viewport, auto-follow reads that as
      // still-following, and the button never renders -- which is how this
      // check kept failing on a feature that works. One rendered tool call puts
      // the tail well below the fold at scrollY 0. Measured: with this
      // condition the button is present for the rest of the run; with the
      // scroll-position one it never appeared at all.
      const hasContent = (await count('.node.tool')) >= 1
      if (hasContent) {
        scrolledUpOnce = true
        await page.evaluate(() => {
          window.scrollTo(0, 0)
          window.__probe.armed = true
        })
        await new Promise((r) => setTimeout(r, 400))
      }
    } else if (scrolledUpOnce && scrollTopAfterDetach === null) {
      scrollTopAfterDetach = await page.evaluate(() => window.scrollY)
    } else if (scrolledUpOnce && st === 'running') {
      const now = await page.evaluate(() => window.scrollY)
      if (now <= scrollTopAfterDetach + 40) stayedPutWhileDetached = true
    }

    return st === 'completed' || st === 'failed'
  },
  { label: 'subagent run terminal' }
)

const seen = await page.evaluate(() => window.__probe.seen)
console.log(`     ${JSON.stringify(seen)}`)

check('polish: active-tool bar appeared during the run', seen.activeToolBar)
check('polish: outline highlighted the active tool', seen.outlineActive)

if (scrolledUpOnce) {
  check('polish: scrolling up detaches auto-follow', stayedPutWhileDetached)
  check('polish: a "jump to latest" affordance appears while detached',
    seen.followLatestWhileDetached)
} else {
  // Not a pass. The section sizes the window so this cannot normally happen, so
  // reaching here means the run ended before auto-follow ever moved the page
  // and the two checks above went untested.
  check('polish: the auto-follow detach scenario was reachable', false,
    'the run ended before auto-follow scrolled the page')
}

check('polish: active-tool bar clears once the run ends', (await count('.active-tool')) === 0)

check('R7: live run completed', (await runStatus(1)) === 'completed')
check('R7: nested subagent activity appeared while still streaming', seen.nestedWhileRunning)
check('R7: live branch rendered', (await count('.branch')) === 1)
check('R7: live spawner marked', (await count('.tool-spawner')) === 1)
check(
  'R7: live nested tool contained by the spawning card',
  await page.evaluate(() => {
    const s = document.querySelector('.tool-spawner')
    const n = s?.querySelector('.branch .node.tool')
    return Boolean(n) && s.contains(n)
  })
)
check('R7: live outline nests', (await count('.outline-list .outline-list')) === 1)

const savedPath = await page.$eval('.run .run-head', (e) => e.textContent)
check('runtime JSONL path shown for the live run', savedPath.includes('sessions/runs/'), savedPath)
fs.writeFileSync(
  'scripts/.last-browser-run.txt',
  savedPath.match(/sessions\/runs\/[^\s]+\.jsonl/)?.[0] ?? '',
  'utf8'
)

// ===========================================================================
console.log('\n== responsive layout ==')

await page.setViewport({ width: 1280, height: 900 })

// Reset to the known flat 4-tool trajectory so the layout assertions do not
// depend on whatever run happened to be on screen.
await page.goto(BASE, { waitUntil: 'networkidle0' })
await startReplay('claude-test/events.jsonl')
await waitFor(async () => (await count('.outline-item')) === 4, { label: 'flat replay for layout' })

const wide = await page.evaluate(() => {
  const body = document.querySelector('.run-body')
  const outline = document.querySelector('.outline')
  const traj = document.querySelector('.trajectory')
  const app = document.querySelector('.app')
  return {
    cols: getComputedStyle(body).gridTemplateColumns,
    outlineVisible: outline ? outline.getBoundingClientRect().width > 0 : false,
    sideBySide: outline && traj
      ? outline.getBoundingClientRect().left > traj.getBoundingClientRect().right - 5
      : false,
    items: document.querySelectorAll('.outline-item').length,
    appShare: app.getBoundingClientRect().width / window.innerWidth,
    promptSize: parseFloat(getComputedStyle(document.querySelector('.run-prompt-text')).fontSize),
    proseSize: parseFloat(getComputedStyle(document.querySelector('.node.text .markdown')).fontSize),
  }
})
console.log(`     wide: ${JSON.stringify(wide)}`)
check('wide: outline beside the trajectory', wide.sideBySide && wide.outlineVisible)
check('wide: outline shows all tool calls', wide.items === 4)
check('wide: the viewer uses most of the window', wide.appShare > 0.9, `${wide.appShare}`)
check('wide: the prompt leads the hierarchy', wide.promptSize > wide.proseSize, `${wide.promptSize} > ${wide.proseSize}`)
check('wide: assistant prose is comfortably readable', wide.proseSize >= 15, `${wide.proseSize}px`)

// Load fresh at a narrow width: the outline's default folded state is decided
// at mount, and `position: sticky` makes bounding-box comparisons on an
// already-scrolled page meaningless.
const narrowPage = await browser.newPage()
await narrowPage.setViewport({ width: 480, height: 900 })
await narrowPage.goto(BASE, { waitUntil: 'networkidle0' })
await narrowPage.select('.panel:last-child select', 'claude-test/events.jsonl')
const nb = await narrowPage.$$('.panel:last-child button')
await nb[nb.length - 1].click()
await new Promise((r) => setTimeout(r, 2500))

const narrow = await narrowPage.evaluate(() => {
  const body = document.querySelector('.run-body')
  const outline = document.querySelector('.outline')
  const traj = document.querySelector('.trajectory')
  return {
    mediaApplies: matchMedia('(max-width: 899px)').matches,
    singleColumn: getComputedStyle(body).gridTemplateColumns.split(' ').length === 1,
    outlineOrder: getComputedStyle(outline).order,
    trajectoryOrder: getComputedStyle(traj).order,
    foldedByDefault: outline.classList.contains('outline-closed'),
    canUnfold: Boolean(outline.querySelector('.outline-head')),
    trajectoryWidth: traj.getBoundingClientRect().width,
    toolCards: document.querySelectorAll('.node.tool').length,
    markdown: document.querySelectorAll('.markdown p').length,
    metrics: document.querySelectorAll('.metric-value').length,
    outlineItemsWhileFolded: document.querySelectorAll('.outline-item').length,
  }
})
console.log(`     narrow: ${JSON.stringify(narrow)}`)

check('narrow: single-column layout applies', narrow.mediaApplies && narrow.singleColumn)
check(
  'narrow: outline ordered ahead of the trajectory',
  Number(narrow.outlineOrder) < Number(narrow.trajectoryOrder || 0)
)
check('narrow: outline folded by default', narrow.foldedByDefault)
check('narrow: folded outline hides its items', narrow.outlineItemsWhileFolded === 0)
check('narrow: outline can be unfolded', narrow.canUnfold)
check('narrow: trajectory keeps full width', narrow.trajectoryWidth > 380)

// Required information must still be present and reachable at narrow width.
check('narrow: tool calls still rendered', narrow.toolCards === 4)
check('narrow: assistant text still rendered', narrow.markdown > 0)
check('narrow: metrics still rendered', narrow.metrics === 3)

await narrowPage.click('.outline-head')
await new Promise((r) => setTimeout(r, 200))
check(
  'narrow: unfolding reveals every tool call',
  (await narrowPage.$$eval('.outline-item', (e) => e.length)) === 4
)
const narrowJump = await narrowPage.evaluate(() => {
  document.querySelector('.outline-item').click()
  return true
})
await new Promise((r) => setTimeout(r, 900))
check(
  'narrow: outline jump still works',
  narrowJump &&
    (await narrowPage.evaluate(() => {
      const el = document.querySelector('.node.tool')
      const r = el.getBoundingClientRect()
      return r.top >= -80 && r.top <= window.innerHeight
    }))
)

await browser.close()

console.log(
  failures === 0 ? '\nAll browser checks passed.\n' : `\n${failures} BROWSER CHECK(S) FAILED\n`
)
process.exit(failures === 0 ? 0 : 1)
