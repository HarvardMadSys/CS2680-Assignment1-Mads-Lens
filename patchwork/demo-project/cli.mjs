import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function summarize(text) {
  return {
    lines: text.split('\n').length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    characters: [...text].length,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node cli.mjs <file>')
    process.exitCode = 1
  } else {
    const counts = summarize(readFileSync(file, 'utf8'))
    console.log(`${counts.lines} lines, ${counts.words} words, ${counts.characters} characters`)
  }
}
