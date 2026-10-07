import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Unit tests run the stores and libraries in Node. Native modules are
// replaced with small fakes in test/mocks.
const mock = (name: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test/mocks', name)

export default defineConfig({
  resolve: {
    alias: {
      '@react-native-async-storage/async-storage': mock('async-storage.ts'),
      'expo-haptics': mock('expo-haptics.ts'),
      'expo-router': mock('expo-router.ts'),
      'expo-secure-store': mock('expo-secure-store.ts'),
      'react-native': mock('react-native.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts']
  }
})
