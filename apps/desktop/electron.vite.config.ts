import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'electron-vite'

// A lent computer runs commands in the extension's own sandbox
// (src/main/computer.ts). It reads its policy beside the bundle.
const isolation = fileURLToPath(new URL('../../backend/pi-runtime/isolation.ts', import.meta.url))
const policy = fileURLToPath(
  new URL('../../backend/pi-runtime/credential-policy.json', import.meta.url)
)

// Build-time constants for the main process, declared in src/global.d.ts.
// The main process is built as an SSR bundle, where `import.meta.env.*` is
// never replaced, so plain globals carry the values instead.
export default defineConfig({
  main: {
    resolve: { alias: { 'hexbot-isolation': isolation } },
    plugins: [
      {
        name: 'hexbot-credential-policy',
        generateBundle() {
          this.emitFile({
            fileName: 'credential-policy.json',
            source: readFileSync(policy, 'utf8'),
            type: 'asset'
          })
        }
      }
    ],
    define: {
      __HEXBOT_CRASH_URL__: JSON.stringify(process.env.HEXBOT_CRASH_URL ?? ''),
      // Public PostHog project key for anonymous usage data; unset in dev, so dev sends nothing.
      __HEXBOT_POSTHOG_KEY__: JSON.stringify(process.env.HEXBOT_POSTHOG_KEY ?? ''),
      __HEXBOT_CHANNEL__: JSON.stringify(process.env.HEXBOT_CHANNEL ?? 'dev'),
      // 'full' bundles the daemon runtime; 'client' only connects to one.
      __HEXBOT_EDITION__: JSON.stringify(process.env.HEXBOT_EDITION ?? 'full')
    }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } }
  }
})
