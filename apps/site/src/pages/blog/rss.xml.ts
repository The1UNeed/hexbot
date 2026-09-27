import type { APIContext } from 'astro'
import { posts } from '../../lib/blog'

const escape = (text: string) => text.replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`)

export async function GET({ site }: APIContext) {
  const items = (await posts()).map(post => {
    const link = new URL(`/blog/${post.id}/`, site).href
    return `<item><title>${escape(post.data.title)}</title><link>${link}</link><guid>${link}</guid><pubDate>${post.data.date.toUTCString()}</pubDate><description>${escape(post.data.description)}</description></item>`
  })
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Hexbot blog</title><link>${new URL('/blog/', site).href}</link><description>News from Hexbot.</description>${items.join('')}</channel></rss>`
  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
