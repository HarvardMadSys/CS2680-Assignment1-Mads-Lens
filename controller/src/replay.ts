import { readFileSync } from 'node:fs'
import { buildTree, countNodes, renderTree } from './tree.ts'
import type { StreamEvent } from './types.ts'

export function loadTranscript(path: string): StreamEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as StreamEvent)
}

const path = process.argv[2]
if (!path) {
  console.error('Usage: node src/replay.ts <transcript.jsonl>')
  process.exit(1)
}

const tree = buildTree(loadTranscript(path))
console.log(renderTree(tree) || '(no tool calls)')
console.log(`\n${countNodes(tree)} tool calls`)
