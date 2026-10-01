/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `pnpm dev` (scripts/dev/run.mjs) serves the bundle from Vite and proxies the
// loopback daemon behind the same origin, so the browser signs in with the
// daemon's cookie flow exactly as it does on a daemon-served page.
const daemon = process.env.VITE_HEXBOT_ORIGIN?.replace(/\/+$/, '')

export default defineConfig({
  base: '/',
  plugins: [tanstackRouter({ target: 'react' }), react(), tailwindcss()],
  server: daemon
    ? {
        proxy: Object.fromEntries(
          ['/api', '/hexbot', '/login', '/auth'].map(prefix => [prefix, { target: daemon, ws: true }])
        )
      }
    : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts'
  }
})
