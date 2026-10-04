#!/usr/bin/env node
// Test-only CLI: consumes the same recorded stream shapes; never invokes a model.
const fs = require('node:fs/promises')
const path = require('node:path')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function main() {
  const fixture = JSON.parse(await fs.readFile(process.env.PATCHWORK_TEST_FIXTURE, 'utf8'))
  const prompt = process.argv[process.argv.indexOf('-p') + 1]
  const start = fixture.find((e) => e.kind === 'run_start' && e.prompt === prompt)
  if (!start) throw new Error('Unknown test prompt')
  await fs.appendFile(
    path.join(process.env.PATCHWORK_DATA_DIR, 'invocations.jsonl'),
    `${JSON.stringify({ prompt, args: process.argv.slice(2) })}\n`,
  )
  for (const envelope of fixture.filter((e) => e.runId === start.runId && e.kind === 'claude')) {
    const event = envelope.event
    if (
      event.subtype === 'task_notification' &&
      (start.runId === 'history-2' || start.runId === 'history-3')
    ) {
      const gate = path.join(process.env.PATCHWORK_DATA_DIR, `${start.runId}.continue`)
      while (true) {
        try {
          await fs.access(gate)
          break
        } catch {
          await delay(40)
        }
      }
    }
    process.stdout.write(`${JSON.stringify(event)}\n`)
    await delay(30)
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
