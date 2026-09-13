import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __HEXBOT_CRASH_URL__: '""', __HEXBOT_EDITION__: '"full"', __HEXBOT_CHANNEL__: '"stable"' },
  test: {
    include: ['src/**/*.test.ts', 'e2e/daemon.test.ts']
  }
})
