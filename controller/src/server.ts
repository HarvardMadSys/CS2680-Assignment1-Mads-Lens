import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from './runner.ts'

const PORT = Number(process.env.PORT ?? 8000)
const HOST = process.env.HOST ?? '0.0.0.0'
const APP_DIR = fileURLToPath(new URL('../', import.meta.url))
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))
const DEFAULT_CWD = fileURLToPath(new URL('../sandbox/', import.meta.url))
const RUNS_DIR = fileURLToPath(new URL('../runs/', import.meta.url))
/** Recordings that ship with the app, so replay works on a fresh clone. */
const DEMO_DIR = fileURLToPath(new URL('../demo-runs/', import.meta.url))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

interface RunRequest {
  prompt?: unknown
  cwd?: unknown
  resume?: unknown
  skipPermissions?: unknown
  model?: unknown
  fallbackModel?: unknown
  effort?: unknown
  agent?: unknown
  agents?: unknown
  appendSystemPrompt?: unknown
  addDirs?: unknown
  fullEnv?: unknown
  maxSubagents?: unknown
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : []

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Sessions currently accepting input, so a follow-up can join a turn already
 *  running rather than waiting for it to finish. */
const active = new Map<string, { send: (text: string) => void; close: () => void; interrupt: () => void }>()

const subagentCap = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 25 ? value : undefined

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function serveStatic(url: string, res: ServerResponse) {
  const rel = url === '/' ? 'index.html' : decodeURIComponent(url.slice(1))
  const path = resolve(PUBLIC_DIR, rel)
  if (path !== PUBLIC_DIR.replace(/\/$/, '') && !path.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    return sendJson(res, 403, { error: 'forbidden' })
  }
  try {
    const file = await readFile(path)
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(file)
  } catch {
    sendJson(res, 404, { error: 'not found' })
  }
}

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  let body: RunRequest
  try {
    body = JSON.parse(await readBody(req)) as RunRequest
  } catch (error) {
    return sendJson(res, 400, { error: `could not read request: ${(error as Error).message}` })
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })

  const cwd = resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : DEFAULT_CWD)
  // The default scratch directory is git-ignored, so a fresh clone lacks it.
  if (cwd === resolve(DEFAULT_CWD)) mkdirSync(cwd, { recursive: true })
  try {
    if (!(await stat(cwd)).isDirectory()) return sendJson(res, 400, { error: `not a directory: ${cwd}` })
  } catch {
    return sendJson(res, 400, { error: `working directory does not exist: ${cwd}` })
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })

  const write = (event: unknown) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  mkdirSync(RUNS_DIR, { recursive: true })
  const transcriptName = `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  const transcript = createWriteStream(join(RUNS_DIR, transcriptName))

  const runId = randomUUID()
  write({ type: 'driver_started', cwd, prompt, transcript: transcriptName, runId })
  res.on('close', () => active.delete(runId))

  try {
    const effort = str(body.effort)
    for await (const event of runClaude({
      prompt,
      cwd,
      onLine: (line) => transcript.write(`${line}\n`),
      model: str(body.model) ?? 'sonnet',
      fallbackModel: str(body.fallbackModel),
      effort: effort && EFFORTS.has(effort) ? effort : undefined,
      agent: str(body.agent),
      agents: body.agents && typeof body.agents === 'object' ? (body.agents as Record<string, unknown>) : undefined,
      appendSystemPrompt: str(body.appendSystemPrompt),
      addDirs: strList(body.addDirs),
      maxSubagents: subagentCap(body.maxSubagents),
      // A cap of zero means no delegation at all, which the env var cannot
      // express, so the spawning tools are withheld instead.
      disallowedTools: subagentCap(body.maxSubagents) === 0 ? ['Agent', 'Task'] : undefined,
      strictMcpConfig: body.fullEnv !== true,
      permissionMode: body.skipPermissions === true ? undefined : 'acceptEdits',
      skipPermissions: body.skipPermissions === true,
      resume: str(body.resume),
      streaming: true,
      onSend: (send, close, interrupt) => active.set(runId, { send, close, interrupt }),
      signal: controller.signal,
    })) {
      write(event)
    }
  } catch (error) {
    write({ type: 'driver_error', message: (error as Error).message })
  }

  active.delete(runId)
  transcript.end()
  if (!res.writableEnded) res.end()
}

/** Delivers a follow-up into a session that is already running. */
async function handleMessage(req: IncomingMessage, res: ServerResponse) {
  let body: { runId?: unknown; text?: unknown; end?: unknown; stop?: unknown } = {}
  try { body = JSON.parse(await readBody(req)) } catch {
    return sendJson(res, 400, { error: 'bad request body' })
  }
  const run = active.get(String(body.runId ?? ''))
  if (!run) return sendJson(res, 404, { error: 'no session is accepting input' })

  if (body.stop === true) {
    run.interrupt()
    return sendJson(res, 200, { ok: true, stopped: true })
  }
  if (body.end === true) {
    run.close()
    return sendJson(res, 200, { ok: true, ended: true })
  }
  const text = str(body.text)
  if (!text) return sendJson(res, 400, { error: 'text is required' })
  run.send(text)
  sendJson(res, 200, { ok: true })
}

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c })
    child.stderr.on('data', (c: Buffer) => { out += c })
    child.on('error', (e) => resolve({ code: -1, out: e.message }))
    child.on('close', (c) => resolve({ code: c ?? -1, out: out.trim() }))
  })
}

const MAIN = 'main'

async function repoFor(body: { cwd?: unknown }): Promise<string | null> {
  const start = str(body.cwd) ?? APP_DIR
  const top = await git(['rev-parse', '--show-toplevel'], start)
  return top.code === 0 ? top.out : null
}

/** The default working dir sits inside the app's own checkout, so without this
 *  guard the merge button would check out, merge and push the repository the
 *  app was cloned from. Merging is only offered for a separate repository. */
function ownsApp(repo: string): boolean {
  const top = resolve(repo)
  const app = resolve(APP_DIR)
  return app === top || app.startsWith(top + sep)
}

const OWN_REPO_ERROR =
  'refusing to merge: the working dir is inside the repository that contains Controller itself. '
  + 'Point the working dir at a separate git repository (e.g. run `git init` in sandbox/).'

/** What merging would do, so the page can show it before anything happens. */
async function handleMergePreview(req: IncomingMessage, res: ServerResponse) {
  let body: { cwd?: unknown } = {}
  try { body = JSON.parse(await readBody(req)) } catch { /* defaults are fine */ }

  const repo = await repoFor(body)
  if (!repo) return sendJson(res, 400, { error: 'not inside a git repository' })
  if (ownsApp(repo)) return sendJson(res, 400, { error: OWN_REPO_ERROR })

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).out
  const dirty = (await git(['status', '--porcelain'], repo)).out
  const ahead = (await git(['rev-list', '--count', `${MAIN}..${branch}`], repo)).out
  const stat = (await git(['diff', '--stat', `${MAIN}...${branch}`], repo)).out
  const log = (await git(['log', '--oneline', `${MAIN}..${branch}`], repo)).out
  const remote = (await git(['remote'], repo)).out.split('\n')[0] ?? ''
  const unpushed = remote
    ? (await git(['rev-list', '--count', `${remote}/${MAIN}..${MAIN}`], repo)).out
    : '0'

  sendJson(res, 200, {
    repo,
    branch,
    onMain: branch === MAIN,
    dirty: dirty ? dirty.split('\n').length : 0,
    commits: Number(ahead) || 0,
    stat: stat.split('\n').slice(-1)[0] ?? '',
    log: log.split('\n').slice(0, 6),
    remote,
    unpushed: Number(unpushed) || 0,
  })
}

/** Merges the current branch into main, then pushes main to the first remote
 *  if there is one. */
async function handleMerge(req: IncomingMessage, res: ServerResponse) {
  let body: { cwd?: unknown } = {}
  try { body = JSON.parse(await readBody(req)) } catch { /* defaults are fine */ }

  const repo = await repoFor(body)
  if (!repo) return sendJson(res, 400, { error: 'not inside a git repository' })
  if (ownsApp(repo)) return sendJson(res, 400, { error: OWN_REPO_ERROR })

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).out
  if (branch === MAIN) return sendJson(res, 400, { error: `already on ${MAIN} — nothing to merge` })
  if ((await git(['status', '--porcelain'], repo)).out) {
    return sendJson(res, 400, { error: 'working tree is dirty — commit or stash first' })
  }

  const checkout = await git(['checkout', MAIN], repo)
  if (checkout.code !== 0) return sendJson(res, 500, { error: checkout.out })

  const merge = await git(['merge', '--no-ff', branch, '-m', `Merge ${branch} into ${MAIN}`], repo)
  if (merge.code !== 0) {
    await git(['merge', '--abort'], repo)
    await git(['checkout', branch], repo)
    return sendJson(res, 409, { error: `merge failed, nothing changed:\n${merge.out}` })
  }

  const head = (await git(['log', '-1', '--oneline'], repo)).out

  // The merge has already landed locally, so a failed push is reported rather
  // than thrown: the caller needs to know both facts.
  const remote = (await git(['remote'], repo)).out.split('\n')[0] ?? ''
  if (!remote) {
    return sendJson(res, 200, { ok: true, branch, head, output: merge.out, pushed: false, pushError: 'no remote configured' })
  }
  const push = await git(['push', remote, MAIN], repo)
  sendJson(res, 200, {
    ok: true,
    branch,
    head,
    output: merge.out,
    remote,
    pushed: push.code === 0,
    pushError: push.code === 0 ? undefined : push.out,
    pushOutput: push.code === 0 ? push.out : undefined,
  })
}

/** Searches the skills.sh registry. Proxied rather than called from the page so
 *  the browser is not subject to the registry's CORS policy. */
async function handleSkillSearch(url: URL, res: ServerResponse) {
  const query = (url.searchParams.get('q') ?? '').trim()
  if (!query) return sendJson(res, 200, { skills: [] })
  try {
    const upstream = await fetch(`https://www.skills.sh/api/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!upstream.ok) return sendJson(res, 502, { error: `registry returned ${upstream.status}` })
    const body = (await upstream.json()) as { skills?: Array<Record<string, unknown>> }
    const skills = (body.skills ?? []).slice(0, 24).map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? s.skillId ?? ''),
      source: String(s.source ?? ''),
      installs: Number(s.installs ?? 0),
    }))
    sendJson(res, 200, { skills })
  } catch (error) {
    sendJson(res, 502, { error: `registry unreachable: ${(error as Error).message}` })
  }
}

/** owner/repo, optionally with a skill path. Keeps anything odd out of argv. */
const PACKAGE = /^[\w.-]+\/[\w.-]+(\/[\w.-]+)*$/

/** Installs a skill with the skills CLI. This writes to the project, so the page
 *  only ever calls it from an explicit click. */
async function handleSkillInstall(req: IncomingMessage, res: ServerResponse) {
  let source = ''
  try {
    source = String((JSON.parse(await readBody(req)) as { source?: unknown }).source ?? '').trim()
  } catch {
    return sendJson(res, 400, { error: 'bad request body' })
  }
  if (!PACKAGE.test(source)) return sendJson(res, 400, { error: `not a valid package: ${source}` })

  const child = spawn('npx', ['-y', 'skills@latest', 'add', source, '--project', '--yes'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c: Buffer) => { out += c })
  child.stderr.on('data', (c: Buffer) => { out += c })

  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
  const code: number = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (c) => resolve(c ?? -1))
  })
  clearTimeout(timer)

  // Strip every CSI sequence, not just colour: the CLI's spinner emits cursor
  // moves and erases that would otherwise land in the page as literal noise.
  // The spinner frames themselves survive that, so drop them too.
  const clean = out
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/[◐◓◑◒◇◆]/g, '').replace(/\s+…\.*\s*/g, ' ').trim())
    .filter((line) => line && line !== '│' && !/^(Cloning repository|Resolving)/.test(line))
    .join('\n')
    .trim()
  if (code === 0) sendJson(res, 200, { ok: true, source, output: clean.slice(-600) })
  else sendJson(res, 500, { error: clean.slice(-600) || `skills add exited ${code}` })
}

/** Reports what this machine's Claude Code can do — tools, skills, agents, MCP
 *  servers. The child is killed as soon as its init event lands, which is
 *  before any model request, so probing costs nothing. */
async function handleCapabilities(url: URL, res: ServerResponse) {
  const controller = new AbortController()
  const fullEnv = url.searchParams.get('fullEnv') === '1'
  try {
    for await (const event of runClaude({
      prompt: 'ok',
      strictMcpConfig: !fullEnv,
      signal: controller.signal,
    })) {
      const init = event as { type?: string; subtype?: string } & Record<string, unknown>
      if (init.type === 'system' && init.subtype === 'init') {
        controller.abort()
        return sendJson(res, 200, {
          model: init.model,
          version: init.claude_code_version,
          tools: init.tools ?? [],
          skills: init.skills ?? [],
          agents: init.agents ?? [],
          mcpServers: init.mcp_servers ?? [],
          slashCommands: init.slash_commands ?? [],
          permissionMode: init.permissionMode,
        })
      }
    }
  } catch (error) {
    // Claude missing or failing is an expected state (e.g. replay-only use),
    // so it is reported in the body rather than as a server error.
    return sendJson(res, 200, { unavailable: true, error: (error as Error).message })
  }
  sendJson(res, 200, { unavailable: true, error: 'no init event' })
}

/** Replays a recorded run. This is how the page will work once deployed, where
 *  spawning the claude binary is not possible. */
async function handleReplay(url: URL, res: ServerResponse) {
  const name = basename(url.searchParams.get('file') ?? '')
  if (!name.endsWith('.jsonl')) return sendJson(res, 400, { error: 'file must be a .jsonl transcript' })

  let raw: string
  try {
    raw = await readFile(join(RUNS_DIR, name), 'utf8')
  } catch {
    try {
      raw = await readFile(join(DEMO_DIR, name), 'utf8')
    } catch {
      return sendJson(res, 404, { error: `no such transcript: ${name}` })
    }
  }

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
  const delay = Number(url.searchParams.get('delay') ?? 0)
  for (const line of raw.split('\n')) {
    if (!line.trim() || res.writableEnded) continue
    res.write(`${line}\n`)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  }
  res.end()
}

createServer((req, res) => {
  const parsed = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const url = parsed.pathname
  if (req.method === 'POST' && url === '/api/run') {
    void handleRun(req, res)
  } else if (req.method === 'GET' && url === '/api/defaults') {
    sendJson(res, 200, { cwd: DEFAULT_CWD })
  } else if (req.method === 'POST' && url === '/api/message') {
    void handleMessage(req, res)
  } else if (req.method === 'POST' && url === '/api/git/merge-preview') {
    void handleMergePreview(req, res)
  } else if (req.method === 'POST' && url === '/api/git/merge') {
    void handleMerge(req, res)
  } else if (req.method === 'GET' && url === '/api/skills/search') {
    void handleSkillSearch(parsed, res)
  } else if (req.method === 'POST' && url === '/api/skills/install') {
    void handleSkillInstall(req, res)
  } else if (req.method === 'GET' && url === '/api/capabilities') {
    void handleCapabilities(parsed, res)
  } else if (req.method === 'GET' && url === '/api/replay') {
    void handleReplay(parsed, res)
  } else if (req.method === 'GET' && url === '/api/transcripts') {
    void readdir(RUNS_DIR)
      .then((files) => sendJson(res, 200, { transcripts: files.filter((f) => f.endsWith('.jsonl')).sort().reverse() }))
      .catch(() => sendJson(res, 200, { transcripts: [] }))
  } else if (req.method === 'GET') {
    void serveStatic(url, res)
  } else {
    sendJson(res, 405, { error: 'method not allowed' })
  }
}).listen(PORT, HOST, () => {
  console.log(`\n  Controller   →  http://localhost:${PORT}  (listening on ${HOST}:${PORT})\n  default cwd  →  ${DEFAULT_CWD}\n`)
})
