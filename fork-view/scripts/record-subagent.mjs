/**
 * Fixture recorder: how fixtures/subagent-*.jsonl were captured. Runs a LIVE
 * Claude Code session (with --dangerously-skip-permissions) in claude-test/.
 *
 * Records a Claude Code run that deliberately spawns a subagent, with and
 * without --forward-subagent-text, so the real hierarchy schema can be observed
 * instead of assumed.
 *
 *   node scripts/record-subagent.mjs <output.jsonl> [--forward]
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = path.resolve(root, process.argv[2])
const forward = process.argv.includes('--forward')

const PROMPT = `Use the Task tool to launch exactly one subagent (subagent_type "Explore") and ask it to read main.py in this directory and report in one sentence what the script does.

Do not read main.py yourself and do not modify any files. After the subagent reports back, reply with one short sentence summarising its finding.`

const args = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  ...(forward ? ['--forward-subagent-text'] : []),
]

mkdirSync(path.dirname(outPath), { recursive: true })
const out = createWriteStream(outPath, { encoding: 'utf8' })

console.log(`recording -> ${path.relative(root, outPath)}`)
console.log(`args: claude ${args.join(' ')}`)

const child = spawn('claude', args, {
  cwd: path.join(root, 'claude-test'),
  shell: process.platform === 'win32',
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdin.end(PROMPT, 'utf8')

let buffer = ''
let count = 0

child.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, '')
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue
    out.write(line + '\n')
    count += 1
    try {
      const e = JSON.parse(line)
      const ptid = e.parent_tool_use_id
      const blocks = Array.isArray(e.message?.content)
        ? e.message.content
            .map((b) =>
              b.type === 'tool_use'
                ? `tool_use:${b.name}:${b.id}`
                : b.type === 'tool_result'
                  ? `tool_result:${b.tool_use_id}`
                  : b.type
            )
            .join(',')
        : ''
      console.log(
        `${String(count).padStart(3)} ${String(e.type).padEnd(16)} ptid=${String(ptid ?? 'null').padEnd(30)} ${e.subtype ?? ''} ${blocks}`
      )
    } catch {
      console.log(`${count} [unparseable]`)
    }
  }
})

child.stderr.on('data', (c) => process.stderr.write(c))
child.on('close', (code) => {
  out.end()
  console.log(`\nexit ${code}, ${count} frames -> ${path.relative(root, outPath)}`)
})
