import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'static',
  site: 'https://hexbot.app',
  trailingSlash: 'always',
  // Shiki emits inline style attributes, which the site's CSP (style-src 'self') blocks.
  markdown: { syntaxHighlight: false },
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0 },
  },
})
