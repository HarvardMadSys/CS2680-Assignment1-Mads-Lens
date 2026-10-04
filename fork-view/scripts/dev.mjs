// Starts the API server and the Vite dev server together.
//
// The browser only ever talks to Vite (PORT, default 8000, on HOST, default
// 0.0.0.0). Vite proxies /api -- including the SSE event streams -- to the API
// server, which listens on API_PORT (default 8001) on the loopback interface
// only, so it is never exposed directly.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiPort = process.env.API_PORT || '8001'

const children = [
  spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: apiPort, HOST: '127.0.0.1' },
  }),
  // vite.config.js reads PORT, HOST and API_PORT from the environment.
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: apiPort },
  }),
]

const shutdown = () => children.forEach((c) => c.kill())

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
children.forEach((c) => c.on('exit', shutdown))
