import { cp, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../demo-project/', import.meta.url))
const destination = await mkdtemp(path.join(os.tmpdir(), 'patchwork-linecount-'))
await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
console.log(`Demo workspace: ${destination}`)
console.log(
  'Choose this folder in the web app. Its trailing-newline test intentionally fails until the agent fixes it.',
)
