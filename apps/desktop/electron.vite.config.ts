import { defineConfig, loadEnv } from 'electron-vite'

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      'import.meta.env.HEXBOT_CRASH_URL': JSON.stringify(
        loadEnv(mode, process.cwd(), '').HEXBOT_CRASH_URL ?? ''
      )
    }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } }
  }
}))
