import express from 'express'
import { router } from './routes.js'
import { ensureDataDirs, reconcileInterruptedChats } from './storage.js'

const app = express()
// Internal API port. The browser never talks to it directly: the Vite dev server (PORT, default
// 8000) proxies same-origin /api requests here.
const port = process.env.API_PORT ? Number(process.env.API_PORT) : 8001
// This app can execute commands and has no authentication, so the API listens on loopback only
// by default. Vite forwards same-origin /api requests, so permissive CORS is unnecessary.
const host = process.env.API_HOST || '127.0.0.1'

app.use(express.json())
app.use('/api', router)

async function main() {
  await ensureDataDirs()
  await reconcileInterruptedChats()

  app.listen(port, host, () => {
    console.log(`API server listening on http://${host}:${port} (internal, proxied by Vite)`)
  })
}

main()
