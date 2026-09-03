/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [tanstackRouter({ target: 'react' }), react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts'
  }
})
