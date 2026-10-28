/// <reference types="vitest/config" />

import { gzipSync } from 'node:zlib'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// `pnpm dev` (scripts/dev/run.mjs) serves the bundle from Vite and proxies the
// loopback daemon behind the same origin, so the browser signs in with the
// daemon's cookie flow exactly as it does on a daemon-served page.
const daemon = process.env.VITE_HEXBOT_ORIGIN?.replace(/\/+$/, '')

// The daemon sends browsers the `.gz` beside each hashed script and style
// (`ServeDir::precompressed_gzip`); the app reads the plain files.
const gzipAssets = (): Plugin => ({
  apply: 'build',
  // After Vite's own post hooks, which still edit the CSS.
  generateBundle: {
    handler(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (!/^assets\/.+\.(css|js)$/.test(file.fileName)) {
          continue
        }

        const source = file.type === 'chunk' ? file.code : file.source
        this.emitFile({ fileName: `${file.fileName}.gz`, source: gzipSync(source, { level: 9 }), type: 'asset' })
      }
    },
    order: 'post'
  },
  name: 'hexbot-gzip-assets'
})

export default defineConfig({
  base: '/',
  plugins: [tanstackRouter({ target: 'react' }), react(), tailwindcss(), gzipAssets()],
  server: {
    // As the daemon does: frames load only from this origin, so a bot's
    // visual cannot navigate its frame to another site. The app in dev also
    // frames the bots' computer from the local daemon's own port.
    headers: {
      'Content-Security-Policy': "frame-src 'self' http://127.0.0.1:* http://localhost:*"
    },
    ...(daemon && {
      proxy: Object.fromEntries(
        ['/api', '/hexbot', '/login', '/auth'].map(prefix => [prefix, { target: daemon, ws: true }])
      )
    })
  },
  test: {
    // Token tests read tokens.css as text (`?raw`); other CSS stays out of tests.
    css: { include: [/tokens\.css/] },
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts'
  }
})
