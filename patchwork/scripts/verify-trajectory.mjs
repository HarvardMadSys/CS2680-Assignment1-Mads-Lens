import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const scratch = await mkdtemp(path.join(os.tmpdir(), 'patchwork-trajectory-'))
const data = path.join(scratch, 'data')
const bin = path.join(scratch, 'bin')
await mkdir(data)
await mkdir(bin)
await mkdir(path.join(data, 'fixtures'))
await copyFile(
  path.join(root, 'server/data/fixtures/subagent-concurrent-review.json'),
  path.join(data, 'fixtures/subagent-concurrent-review.json'),
)
await copyFile(path.join(root, 'scripts/fixtures/claude.cjs'), path.join(bin, 'claude'))
await chmod(path.join(bin, 'claude'), 0o755)
const fixture = path.join(root, 'server/data/fixtures/trajectory-history.json')
const recording = JSON.parse(await readFile(fixture, 'utf8'))
const prompts = recording.filter((e) => e.kind === 'run_start').map((e) => e.prompt)
const env = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  PATCHWORK_DATA_DIR: data,
  PATCHWORK_TEST_FIXTURE: fixture,
  API_PORT: '3197',
  PATCHWORK_API_TARGET: 'http://127.0.0.1:3197',
}
const api = 'http://127.0.0.1:3197/api'
let server
let vite
let browser
const errors = []
let restarting = false
let expectedDisconnects = 0
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function startServer() {
  server = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env, stdio: 'pipe' })
  server.stderr.on('data', (chunk) => errors.push(String(chunk)))
  await waitFor(async () => {
    try {
      return (await fetch(`${api}/health`)).ok
    } catch {
      return false
    }
  }, 'server health')
}
async function stop(child) {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
}
try {
  await startServer()
  vite = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      '5197',
      '--strictPort',
    ],
    { cwd: path.join(root, 'client'), env, stdio: 'pipe' },
  )
  vite.stderr.on('data', (chunk) => {
    if (restarting && /socket hang up|ECONNREFUSED/.test(String(chunk))) expectedDisconnects++
    else errors.push(String(chunk))
  })
  await waitFor(async () => {
    try {
      return (await fetch('http://127.0.0.1:5197')).ok
    } catch {
      return false
    }
  }, 'Vite')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    reducedMotion: 'reduce',
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5197')
  await page.getByRole('textbox').waitFor()
  await page.getByRole('button', { name: 'Collapse chat history' }).click()
  const panel = page.getByRole('complementary', { name: 'Trajectory history' })
  const workspace = path.join(scratch, 'demo-project')
  await mkdir(path.join(workspace, 'app'), { recursive: true })
  await mkdir(path.join(workspace, 'tests'))
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose workspace' })
  await picker.getByLabel('Folder path').fill(path.join(scratch, 'not-a-folder'))
  await picker.getByRole('button', { name: 'Use workspace', exact: true }).click()
  await picker.getByRole('alert').waitFor()
  assert.match(await picker.getByRole('alert').innerText(), /does not exist/)
  await picker.getByLabel('Folder path').fill(workspace)
  await picker.getByRole('button', { name: 'Browse', exact: true }).click()
  await picker.getByRole('button', { name: 'app', exact: true }).waitFor()
  await page.screenshot({ path: path.join(scratch, 'workspace-picker.png'), fullPage: true })
  await picker.getByRole('button', { name: 'app', exact: true }).click()
  await picker.getByText('No subfolders. You can use this folder.').waitFor()
  await picker.getByRole('button', { name: 'Use workspace', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await page
    .locator('span[title]')
    .filter({ hasText: path.join(workspace, 'app') })
    .waitFor()
  await panel.getByRole('button', { name: 'Widen trajectory' }).click()
  async function send(prompt) {
    await page.getByRole('textbox').fill(prompt)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  async function reopenTrajectory() {
    await page.getByRole('button', { name: 'Show trajectory', exact: true }).click()
    await panel.waitFor()
  }
  await send(prompts[0])
  await page.getByRole('button', { name: /Completed.*2\.5s/ }).waitFor()
  await panel.waitFor({ state: 'hidden' })
  await page.screenshot({ path: path.join(scratch, 'trajectory-auto-closed.png'), fullPage: true })
  await send(prompts[1])
  await panel.locator('[data-trajectory-tool="server-test"]').waitFor()
  assert.ok(
    (await panel.getByText('Working', { exact: true }).count()) >= 2,
    'launch acknowledgement is still working',
  )
  const mainBefore = await panel.locator('[data-trajectory-tool="main-during"]').boundingBox()
  await writeFile(path.join(data, 'history-2.continue'), '')
  await page.getByRole('button', { name: 'Show trajectory', exact: true }).waitFor()
  await reopenTrajectory()
  await panel.getByText('RUN 2 · Completed', { exact: true }).waitFor()
  assert.ok((await panel.getByText('Failed', { exact: true }).count()) >= 1)
  const mainAfter = await panel.locator('[data-trajectory-tool="main-during"]').boundingBox()
  assert.equal(mainAfter.x, mainBefore.x, 'parent lane stays put after child returns')
  await panel.getByRole('button', { name: 'Collapse branch: Review client', exact: true }).click()
  assert.equal(await panel.locator('[data-trajectory-tool="nested-read"]').count(), 0)
  await panel.getByRole('button', { name: 'Expand branch: Review client', exact: true }).click()
  await panel.locator('[data-trajectory-tool="nested-read"]').click()
  await page.locator('[data-tool-call-id="nested-read"] .code-surface').first().waitFor()
  await panel.getByRole('button', { name: 'Call outline', exact: true }).click()
  const outlineCall = panel.locator('[data-trajectory-tool="nested-read"]')
  assert.equal(await outlineCall.innerText(), 'Read', 'outline shows just the call name')
  assert.equal(
    await outlineCall.locator('xpath=ancestor::ol').count(),
    3,
    'nested ownership remains visible',
  )
  await outlineCall.click()
  await page.locator('[data-tool-call-id="nested-read"] .code-surface').first().waitFor()
  await panel
    .getByRole('button', { name: 'Collapse outline branch: Review client', exact: true })
    .click()
  assert.equal(await panel.locator('[data-trajectory-tool="nested-read"]').count(), 0)
  await panel.getByRole('button', { name: 'Lanes', exact: true }).click()
  await panel.getByRole('button', { name: 'Expand branch: Review client', exact: true }).click()
  await panel.locator('[data-trajectory-tool="first-read"]').click()
  await page.locator('[data-tool-call-id="first-read"] .code-surface').first().waitFor()
  const scrollBefore = await panel
    .locator('[data-trajectory-scroll]')
    .evaluate((el) => el.scrollTop)
  await send(prompts[2])
  await panel.getByText('RUN 3 · Running', { exact: true }).waitFor()
  await panel.locator('[data-trajectory-tool="followup-read"]').waitFor()
  assert.equal(await panel.locator('[data-trajectory-run]').count(), 3)
  assert.equal(
    await panel.locator('[data-trajectory-scroll]').evaluate((el) => el.scrollTop),
    scrollBefore,
    'live follow-up preserves history scroll',
  )
  assert.equal(
    await panel.locator('[data-trajectory-tool="first-read"]').getAttribute('aria-current'),
    'true',
  )
  await page.screenshot({ path: path.join(scratch, 'wide-live-history.png'), fullPage: true })
  await panel.getByRole('button', { name: 'Full prompt for run 1' }).click()
  await page.getByText(prompts[0], { exact: true }).last().waitFor()
  await page.keyboard.press('Escape')
  const chats = await (await fetch(`${api}/chats`)).json()
  const id = chats[0].id
  const beforeRestart = await (await fetch(`${api}/chats/${id}`)).json()
  assert.equal(beforeRestart.events.filter((e) => e.kind === 'run_start').length, 3)
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  await picker.getByLabel('Folder path').fill(path.join(workspace, 'tests'))
  await picker.getByRole('button', { name: 'Use workspace', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await waitFor(
    async () => (await panel.locator('[data-trajectory-run]').count()) === 0,
    'new workspace opens its own chat',
  )
  const stillRunning = await (await fetch(`${api}/chats/${id}`)).json()
  assert.equal(stillRunning.chat.status, 'running', 'changing workspace never stops another run')
  assert.equal(stillRunning.chat.cwd, path.join(workspace, 'app'))
  await page.getByRole('button', { name: beforeRestart.chat.title, exact: true }).click()
  await panel.getByText('RUN 3 · Running', { exact: true }).waitFor()
  await page.reload()
  await panel.getByText('RUN 3 · Running', { exact: true }).waitFor()
  assert.equal(await panel.locator('[data-trajectory-run]').count(), 3)
  await panel.locator('[data-trajectory-tool="first-read"]').click()
  await page.locator('[data-tool-call-id="first-read"] .code-surface').first().waitFor()
  restarting = true
  await stop(server)
  await startServer()
  await page.reload()
  await reopenTrajectory()
  await panel.getByText('RUN 3 · Interrupted', { exact: true }).waitFor()
  restarting = false
  assert.equal(await panel.locator('[data-trajectory-run]').count(), 3)
  await panel.locator('[data-trajectory-tool="first-read"]').click()
  await page.locator('[data-tool-call-id="first-read"] .code-surface').first().waitFor()
  const invocations = (await readFile(path.join(data, 'invocations.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(invocations.length, 3, 'refresh, restart and navigation never execute again')
  assert.ok(invocations[1].args.includes('--resume'))
  assert.ok(invocations[2].args.includes('--resume'))
  assert.equal(await page.getByRole('button', { name: 'Open agent graph' }).count(), 0)
  assert.equal(await page.getByRole('dialog').count(), 0)
  await panel.getByRole('button', { name: 'Collapse branch: Review server', exact: true }).click()
  await page.reload()
  await reopenTrajectory()
  await panel.getByRole('button', { name: 'Expand branch: Review server', exact: true }).waitFor()
  const newChat = await (
    await fetch(`${api}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: beforeRestart.chat.cwd }),
    })
  ).json()
  await page.reload()
  await page.getByRole('button', { name: 'Expand chat history' }).click()
  await page
    .getByRole('button', { name: `New chat ${beforeRestart.chat.cwd}`, exact: true })
    .click()
  await waitFor(
    async () => (await panel.locator('[data-trajectory-run]').count()) === 0,
    'other chat is empty',
  )
  // Restore via persisted selected-chat id; no API execution is involved.
  await page.evaluate((chatId) => localStorage.setItem('patchwork.activeChatId', chatId), id)
  await page.reload()
  await reopenTrajectory()
  await panel.getByRole('button', { name: 'Expand branch: Review server', exact: true }).waitFor()
  assert.notEqual(id, newChat.id)
  await page.getByRole('button', { name: 'Collapse chat history' }).click()
  await page.screenshot({ path: path.join(scratch, 'wide-restored-history.png'), fullPage: true })
  await page.setViewportSize({ width: 1100, height: 900 })
  await panel.getByRole('separator').focus()
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight')
  await panel.getByText('4 agent lanes · scroll sideways to see every branch').waitFor()
  await page.screenshot({ path: path.join(scratch, 'narrow-history.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open trajectory', exact: true }).click()
  await panel.getByRole('button', { name: `Run 1: ${prompts[0]}` }).waitFor()
  await panel.getByText('4 agent lanes · scroll sideways to see every branch').waitFor()
  await page.screenshot({ path: path.join(scratch, 'mobile-history.png'), fullPage: true })
  const mobileBranches = panel
    .locator('[data-trajectory-run]')
    .nth(1)
    .locator('.trajectory-lane-scroll')
  await mobileBranches.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  await panel.getByRole('button', { name: /^Reveal agent: .+ — Check accessibility$/ }).click()
  assert.equal(
    await panel
      .getByRole('button', { name: /^Reveal agent: .+ — Check accessibility$/ })
      .getAttribute('aria-current'),
    'true',
  )
  await page.getByRole('button', { name: 'Close trajectory', exact: true }).click()
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  await picker.getByLabel('Folder path').waitFor()
  await waitFor(
    async () =>
      picker.evaluate(
        (el) => getComputedStyle(el).opacity === '1' && el.getBoundingClientRect().height > 200,
      ),
    'mobile workspace picker painted',
  )
  await page.screenshot({ path: path.join(scratch, 'workspace-picker-mobile.png'), fullPage: true })
  const pickerBounds = await picker.boundingBox()
  assert.ok(
    pickerBounds.x >= 0 && pickerBounds.x + pickerBounds.width <= 390,
    'picker fits mobile width',
  )
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1400, height: 1000 })
  // A real preflight failure: a disposable test directory is renamed after selection.
  const unavailable = path.join(scratch, 'temporary-workspace')
  await mkdir(unavailable)
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  await picker.getByLabel('Folder path').fill(unavailable)
  await picker.getByRole('button', { name: 'Use workspace', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await rename(unavailable, `${unavailable}-moved`)
  await send('Inspect this temporary workspace.')
  await page.getByText('Run failed', { exact: true }).waitFor()
  await reopenTrajectory()
  await panel.getByText('RUN 1 · Failed', { exact: true }).waitFor()
  await page.reload()
  await page.getByText('Run failed', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(scratch, 'failed-workspace-run.png'), fullPage: true })
  // Exercise the compact presentation with the recorded 13-file client review. Replay never
  // invokes the fixture CLI, and all data remains in the disposable test directory.
  await page.goto('http://127.0.0.1:5197/?replay=subagent-concurrent-review')
  await reopenTrajectory()
  await panel.getByRole('button', { name: 'Widen trajectory' }).click()
  const haru = panel.getByRole('button', {
    name: 'Reveal agent: Haru Tanaka — Client app & state architecture',
    exact: true,
  })
  const laneId = await haru.evaluate((el) => el.closest('[data-lane-header]').dataset.laneHeader)
  const lane = panel.locator(`[data-lane="${laneId}"]`)
  await lane.getByText('Read 13 files · App.tsx, ChatStore.tsx, …', { exact: true }).waitFor()
  assert.equal(
    await lane.locator('[data-trajectory-tool]').count(),
    0,
    'reads are initially grouped',
  )
  await haru.click()
  await panel.getByRole('region', { name: 'Selected task details' }).waitFor()
  await panel.getByText('Jump to latest', { exact: true }).waitFor()
  await waitFor(
    async () => (await panel.locator('.trajectory-paths > path').count()) === 2,
    'assignment and return connectors',
  )
  await lane.getByRole('button', { name: 'Show individual steps' }).click()
  assert.equal(
    await lane.locator('[data-trajectory-tool]').count(),
    13,
    'all individual reads are recoverable',
  )
  const read = lane.getByRole('button', { name: 'Read: ChatStore.tsx', exact: true })
  const readId = await read.getAttribute('data-trajectory-tool')
  await read.click()
  await page.locator(`[data-tool-call-id="${readId}"] .code-surface`).first().waitFor()
  await panel.locator('[data-trajectory-scroll]').evaluate((el) => {
    el.scrollTop = 360
  })
  const headerPosition = await haru.evaluate((el) => ({
    header: el.closest('.trajectory-sticky-headers').getBoundingClientRect().top,
    scroll: el.closest('[data-trajectory-scroll]').getBoundingClientRect().top,
  }))
  assert.ok(Math.abs(headerPosition.header - headerPosition.scroll) < 2, 'task headers stay sticky')
  await page.screenshot({ path: path.join(scratch, 'compact-task-details.png'), fullPage: true })
  await page.reload()
  await reopenTrajectory()
  assert.equal(
    await lane.locator('[data-trajectory-tool]').count(),
    13,
    'expanded activity survives refresh',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open trajectory', exact: true }).click()
  const compactBranches = panel.locator('.trajectory-lane-scroll')
  await compactBranches.evaluate((el) => {
    el.scrollLeft = 244
  })
  await waitFor(async () => {
    const body = await compactBranches.evaluate((el) => el.scrollLeft)
    const header = await panel.locator('.trajectory-header-scroll').evaluate((el) => el.scrollLeft)
    return body > 0 && Math.abs(body - header) < 1
  }, 'mobile headers follow horizontal scrolling')
  await page.screenshot({ path: path.join(scratch, 'compact-mobile-details.png'), fullPage: true })
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(
    JSON.stringify(
      {
        passed: true,
        artifacts: scratch,
        prompts: 4,
        invocations: invocations.length,
        expectedDisconnectsDuringRestart: expectedDisconnects,
        checks: [
          'background launch',
          'nested reveal',
          'historical live selection',
          'stable lanes and scroll',
          'refresh',
          'server restart',
          'session resume',
          'chat isolation',
          'persisted folds',
          'wide/narrow/mobile',
          'no graph dialog',
          'workspace browsing and validation',
          'workspace switch preserves active run',
          'visible preflight failure survives refresh',
          'automatic panel close without a click and manual reopening',
          'grouped 13-file review and exact step reveal',
          'task inspector and assignment/return connectors',
          'sticky task headers and synchronized mobile lanes',
          'expanded groups survive refresh',
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await browser?.close()
  await stop(vite)
  await stop(server)
  console.log(`Test data and screenshots retained at ${scratch}`)
}
