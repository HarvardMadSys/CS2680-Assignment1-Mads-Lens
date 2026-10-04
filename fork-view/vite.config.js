import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

// The browser only needs PORT; /api (and its SSE streams) is proxied to the
// API server on API_PORT. See scripts/dev.mjs.
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8000)
const API_PORT = Number(process.env.API_PORT || 8001)

export default defineConfig({
  root: path.join(root, 'frontend'),
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.join(root, 'shared') },
  },
  server: {
    host: HOST,
    port: PORT,
    strictPort: true,
    // Reachable by IP or any hostname, not only localhost.
    allowedHosts: true,
    fs: { allow: [root] },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: path.join(root, 'frontend', 'dist'),
    emptyOutDir: true,
  },
})
