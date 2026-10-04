import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The browser only ever talks to this server (PORT, default 8000 on all interfaces). It proxies
// same-origin /api requests, including the streamed NDJSON runs, to the internal Express API.
const apiPort = process.env.API_PORT || '8001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 8000),
    strictPort: true,
    // localhost and IP addresses always work; list extra hostnames (comma-separated) here.
    ...(process.env.ALLOWED_HOSTS ? { allowedHosts: process.env.ALLOWED_HOSTS.split(',') } : {}),
    proxy: {
      '/api': {
        target: process.env.PATCHWORK_API_TARGET ?? `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
