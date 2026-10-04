// Explicitly opt-in: this uses your stored Claude login and consumes real usage.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, cp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(
  process.env.PATCHWORK_LIVE_VERIFY,
  '1',
  'Set PATCHWORK_LIVE_VERIFY=1 to authorize live usage',
)
assert.ok(
  !process.env.ANTHROPIC_API_KEY,
  'Unset ANTHROPIC_API_KEY; use your stored Claude Code login',
)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const scratch = await mkdtemp(path.join(os.tmpdir(), 'patchwork-live-'))
console.log(`Artifacts: ${scratch}`)
const workspace = path.join(scratch, 'workspace')
const data = path.join(scratch, 'data')
const bin = path.join(scratch, 'bin')
await cp(path.join(root, 'demo-project'), workspace, { recursive: true })
await mkdir(path.join(data, 'fixtures'), { recursive: true })
await mkdir(bin)
const cli = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
await writeFile(
  path.join(bin, 'claude'),
  `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(cli)}, [...process.argv.slice(2), '--max-budget-usd', '2'], {stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code??1));
`,
  { mode: 0o755 },
)
const env = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  PATCHWORK_DATA_DIR: data,
  API_PORT: '3198',
  PATCHWORK_API_TARGET: 'http://127.0.0.1:3198',
}
const api = 'http://127.0.0.1:3198/api'
const url = 'http://127.0.0.1:5198'
const children = []
let browser
let chatId
async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${label}`)
}
async function available(url) {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}
async function history() {
  return (await fetch(`${api}/chats/${chatId}`)).json()
}
try {
  assert.ok(
    !(await available(`${api}/health`)) && !(await available(url)),
    'Verification ports already in use',
  )
  children.push(
    spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env, stdio: 'inherit' }),
  )
  await waitFor(() => available(`${api}/health`), 'API')
  children.push(
    spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '5198',
        '--strictPort',
      ],
      { cwd: path.join(root, 'client'), env, stdio: 'inherit' },
    ),
  )
  await waitFor(() => available(url), 'frontend')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    reducedMotion: 'reduce',
  })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose workspace' })
  await picker.getByLabel('Folder path').fill(workspace)
  await picker.getByRole('button', { name: 'Use workspace', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  const chats = await (await fetch(`${api}/chats`)).json()
  chatId = chats.find((chat) => chat.cwd === workspace).id
  const phrase = `copper-lantern-${Date.now()}`
  const prompts = [
    `Work only in this disposable directory. Remember the phrase ${phrase} in conversation, never in a file. Run npm test, read cli.mjs and cli.test.mjs, fix the line-count bug without weakening tests, and run npm test again. Empty input should have zero lines and a trailing newline should not add a line. End with a Markdown heading and short bullet list.`,
    'Without reading files or using tools, repeat the secret phrase I asked you to remember and explain the bug you just fixed in one sentence.',
    'Use one subagent (Agent or Task tool) to read cli.mjs and cli.test.mjs and report one remaining edge case. The subagent must use Read. Do not change files. Briefly summarize its finding.',
  ]
  for (let index = 0; index < prompts.length; index++) {
    console.log(`Starting live prompt ${index + 1}/3`)
    await page.getByRole('textbox').fill(prompts[index])
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    if (index === 0) {
      await page.locator('[data-tool-call-id]').first().waitFor({ timeout: 180000 })
      assert.equal((await history()).chat.status, 'running', 'Tool rendered before completion')
      await page.screenshot({ path: path.join(scratch, 'live-streaming.png'), fullPage: true })
    }
    await waitFor(
      async () => (await history()).events.filter((e) => e.kind === 'run_end').length === index + 1,
      `live run ${index + 1}`,
      240000,
    )
    const saved = await history()
    const starts = saved.events.filter((e) => e.kind === 'run_start')
    const events = saved.events.filter((e) => e.runId === starts[index].runId)
    assert.equal(
      events.find((e) => e.kind === 'run_end').status,
      'completed',
      JSON.stringify(events.at(-1)),
    )
    const raw = events.filter((e) => e.kind === 'claude').map((e) => e.event)
    await writeFile(
      path.join(scratch, `events-${index + 1}.jsonl`),
      `${raw.map((e) => JSON.stringify(e)).join('\n')}\n`,
    )
    const result = raw.find((e) => e.type === 'result' && !e.parent_tool_use_id)
    assert.ok(
      result &&
        typeof result.total_cost_usd === 'number' &&
        typeof result.duration_ms === 'number' &&
        typeof result.num_turns === 'number',
    )
    if (index === 1)
      assert.ok(result.result.includes(phrase), 'Follow-up remembers unrecorded secret')
    if (index === 2) {
      assert.ok(
        raw.some(
          (e) => e.parent_tool_use_id && e.message?.content?.some((b) => b.type === 'tool_use'),
        ),
        'Real nested tool events',
      )
      await writeFile(
        path.join(data, 'fixtures', 'live-subagent.jsonl'),
        `${raw.map((e) => JSON.stringify(e)).join('\n')}\n`,
      )
    }
    await page.getByRole('button', { name: 'Show trajectory', exact: true }).waitFor()
    console.log(
      `Run ${index + 1} completed: $${result.total_cost_usd}, ${result.duration_ms}ms, ${result.num_turns} turns`,
    )
  }
  execFileSync(process.execPath, ['--test', 'cli.test.mjs'], { cwd: workspace, stdio: 'inherit' })
  const saved = await history()
  const sessions = saved.events
    .filter((e) => e.kind === 'claude' && e.event.type === 'result' && !e.event.parent_tool_use_id)
    .map((e) => e.event.session_id)
  assert.equal(new Set(sessions).size, 1, 'All prompts resume the same Claude session')
  await page.getByRole('button', { name: 'Show trajectory', exact: true }).click()
  await page.screenshot({ path: path.join(scratch, 'live-completed-history.png'), fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: 'Show trajectory', exact: true }).click()
  assert.equal(await page.locator('[data-trajectory-run]').count(), 3)
  await page.goto(`${url}/?replay=live-subagent`)
  await page.getByText('Recorded replay · read-only', { exact: true }).waitFor()
  await page.locator('[data-run-session]').first().waitFor()
  await page.screenshot({ path: path.join(scratch, 'raw-recording-replay.png'), fullPage: true })
  assert.deepEqual(errors, [])
  await writeFile(
    path.join(scratch, 'verification.json'),
    JSON.stringify(
      {
        session: sessions[0],
        runs: 3,
        liveToolObserved: true,
        resumeVerified: true,
        subagentVerified: true,
        rawReplayVerified: true,
      },
      null,
      2,
    ),
  )
  console.log(
    `PASS: live streaming, fix, session resume, subagent, restore, raw replay. Artifacts: ${scratch}`,
  )
} finally {
  if (chatId) await fetch(`${api}/chats/${chatId}/stop`, { method: 'POST' }).catch(() => {})
  await browser?.close()
  for (const child of children.reverse()) child.kill('SIGTERM')
}
