import { defineConfig } from 'electron-vite'

// Build-time constants for the main process, declared in src/global.d.ts.
// The main process is built as an SSR bundle, where `import.meta.env.*` is
// never replaced, so plain globals carry the values instead.
export default defineConfig({
  main: {
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
