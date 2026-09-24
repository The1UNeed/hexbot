import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'static',
  site: 'https://hexbot.app',
  trailingSlash: 'always',
  // The pairing page carries one-time codes and is kept out of search.
  integrations: [sitemap({ filter: page => !page.includes('/pair/') })],
  // Shiki emits inline style attributes, which the site's CSP (style-src 'self') blocks.
  markdown: { syntaxHighlight: false },
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0 },
  },
})
