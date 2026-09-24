import { getCollection } from 'astro:content'

export async function posts() {
  return (await getCollection('blog')).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
}

export const postDate = (date: Date) => date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
