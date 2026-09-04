import { defineConfig, loadEnv } from 'electron-vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    main: {
      define: {
        'import.meta.env.HEXBOT_CRASH_URL': JSON.stringify(env.HEXBOT_CRASH_URL ?? ''),
        // 'full' bundles the daemon runtime; 'client' only connects to one.
        'import.meta.env.HEXBOT_EDITION': JSON.stringify(env.HEXBOT_EDITION ?? 'full')
      }
    },
    preload: {
      build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } }
    }
  }
})
