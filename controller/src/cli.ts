import { mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { runClaude } from './runner.ts'
import { buildTree, countNodes, renderTree } from './tree.ts'
import { blocks, isInit, isMessage, isResult, type ResultEvent, type StreamEvent } from './types.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: 'string' },
    model: { type: 'string', default: 'sonnet' },
    'permission-mode': { type: 'string', default: 'acceptEdits' },
    'skip-permissions': { type: 'boolean', default: false },
    'sandbox-dir': { type: 'string', default: 'sandbox' },
    'allowed-tools': { type: 'string' },
    resume: { type: 'string' },
    'record-dir': { type: 'string', default: 'runs' },
    'full-env': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const prompt = positionals.join(' ').trim()

if (values.help || !prompt) {
  console.log(`Usage: node src/cli.ts "<prompt>" [options]

  --cwd <dir>              working directory for the child run (default: cwd)
  --model <name>           default: sonnet
  --permission-mode <m>    default: acceptEdits
  --skip-permissions       auto-approve everything; runs in --sandbox-dir
                           unless --cwd says otherwise
  --sandbox-dir <dir>      scratch dir for --skip-permissions (default: sandbox)
  --allowed-tools <a,b>    comma-separated auto-approved tools
  --resume <session-id>    continue a previous session
  --record-dir <dir>       transcript output dir (default: runs)
  --full-env               include user MCP servers (default: isolated)
`)
  process.exit(prompt ? 0 : 1)
}

// Bypassing every permission check inside the source tree would let a run edit
// the driver that launched it, so an unscoped --skip-permissions is confined to
// a scratch directory.
const cwd = values.cwd ?? (values['skip-permissions'] ? values['sandbox-dir'] : undefined)
if (cwd) mkdirSync(cwd, { recursive: true })

mkdirSync(values['record-dir'], { recursive: true })
const startedAt = new Date().toISOString().replace(/[:.]/g, '-')
const transcriptPath = join(values['record-dir'], `${startedAt}.jsonl`)
const transcript = createWriteStream(transcriptPath)

const events: StreamEvent[] = []
let header = false
// A backgrounded subagent makes the session emit another init/result pair, and
// total_cost_usd is cumulative in each, so only the last result is meaningful.
let final: ResultEvent | undefined

for await (const event of runClaude({
  prompt,
  cwd,
  model: values.model,
  permissionMode: values['permission-mode'],
  skipPermissions: values['skip-permissions'],
  allowedTools: values['allowed-tools']?.split(',').map((t) => t.trim()).filter(Boolean),
  resume: values.resume,
  strictMcpConfig: !values['full-env'],
  onLine: (line) => transcript.write(`${line}\n`),
})) {
  events.push(event)

  if (isInit(event) && !header) {
    header = true
    console.log(`session  ${event.session_id}`)
    console.log(`model    ${event.model}`)
    console.log(`tools    ${event.tools.length} available`)
    console.log(`cwd      ${event.cwd}`)
    console.log(`perms    ${values['skip-permissions'] ? 'BYPASSED (all tools auto-approved)' : (event.permissionMode ?? values['permission-mode'])}\n`)
  } else if (isMessage(event)) {
    for (const block of blocks(event)) {
      if (block.type !== 'tool_use') continue
      const { name } = block as { name: string }
      console.log(`  → ${name}${event.parent_tool_use_id ? ' (subagent)' : ''}`)
    }
  } else if (isResult(event)) {
    final = event
  }
}

transcript.end()

const tree = buildTree(events)
console.log(`\n${renderTree(tree) || '  (no tool calls)'}\n`)
if (final) {
  console.log(`${countNodes(tree)} tool calls · ${final.num_turns} turns · ${(final.duration_ms / 1000).toFixed(1)}s · $${final.total_cost_usd.toFixed(4)}`)
  console.log(`transcript  ${transcriptPath}`)
  console.log(`resume with --resume ${final.session_id}`)
}
