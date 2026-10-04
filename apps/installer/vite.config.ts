/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri loads the dev server at a fixed port (src-tauri/tauri.conf.json, devUrl).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  clearScreen: false,
  plugins: [react(), tailwindcss()],
  server: { port: 1430, strictPort: true },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts'
  }
})
