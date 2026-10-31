import type { Attachment } from './types'

/**
 * Search in one conversation: what was said, the files shared or written,
 * the visuals the bot drew, and in a bot's chat its soul and memory. The app
 * and the mobile app each read their conversation into entries and share
 * this. Every word of the query must appear; case and accents do not matter.
 */

/** A visual as search reads it: the page and the call that drew it. */
export interface SearchVisual {
  html: string
  title: string
  toolId: string
}

/** One message of a conversation, as search reads it. */
export interface SearchEntry {
  /** The message id in a bot's chat, the event's seq in a room. */
  id: string
  at?: number
  author: string
  files: SearchFile[]
  text: string
  visuals: SearchVisual[]
}

export interface SearchFile {
  attachment?: Attachment
  name: string
  /** Where the bot wrote it, for files it made. */
  path?: string
}

export interface SearchDocument {
  kind: 'memory' | 'soul'
  text: string
  title: string
}

export type SearchTarget =
  | { document: SearchDocument['kind']; kind: 'document' }
  | { id: string; kind: 'entry' }
  | { kind: 'visual'; visual: SearchVisual }

export interface SearchHit {
  at?: number
  key: string
  snippet: string
  target: SearchTarget
  title: string
}

export interface SearchResults {
  documents: SearchHit[]
  files: SearchHit[]
  messages: SearchHit[]
  total: number
  visuals: SearchHit[]
}

/** Messages listed at most; a longer list is a query to narrow, not to scroll. */
export const MESSAGE_LIMIT = 100

const EMPTY: SearchResults = { documents: [], files: [], messages: [], total: 0, visuals: [] }

/** Lower case without accents: "Café" finds "cafe". */
function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * Folds per character, so an offset in the result is the same offset in
 * `text`: NFD can split one character into several. Marks use it.
 */
export function foldKeepingOffsets(text: string): string {
  let out = ''

  for (const char of text) {
    const folded = fold(char)
    const lower = char.toLowerCase()
    out += folded.length === char.length ? folded : lower.length === char.length ? lower : char
  }

  return out
}

export function queryTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** The text around the first match, or null when a word is missing. */
export function snippetOf(text: string, terms: string[], width = 120): null | string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const folded = foldKeepingOffsets(flat)

  if (!terms.every(term => folded.includes(term))) {
    return null
  }

  const first = Math.min(...terms.map(term => folded.indexOf(term)))
  const start = Math.max(0, first - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''

  return `${head}${flat.slice(start, end).trim()}${tail}`
}

/** A visual's words: its page without tags, scripts and styles. */
export function visualText(visual: SearchVisual): string {
  return visual.html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Everything in the conversation that matches, newest first within each kind. */
export function search(
  entries: SearchEntry[],
  query: string,
  documents: SearchDocument[] = []
): SearchResults {
  const terms = queryTerms(query)

  if (!terms.length) {
    return EMPTY
  }

  const messages: SearchHit[] = []
  const files: SearchHit[] = []
  const visuals: SearchHit[] = []
  const seenFiles = new Set<string>()
  const seenVisuals = new Set<string>()

  for (const entry of [...entries].reverse()) {
    const said = snippetOf(entry.text, terms)

    if (said) {
      messages.push({
        at: entry.at,
        key: `message:${entry.id}`,
        snippet: said,
        target: { id: entry.id, kind: 'entry' },
        title: entry.author
      })
    }

    for (const file of entry.files) {
      // A file known only by name is told apart by its message: two invoice.pdf uploads are two files.
      const id = file.path ?? file.attachment?.id ?? `${entry.id}:${file.name}`

      if (seenFiles.has(id) || !snippetOf(file.path ?? file.name, terms)) {
        continue
      }

      seenFiles.add(id)
      files.push({
        at: entry.at,
        key: `file:${id}`,
        // The name leads; the path under it says where the bot put it.
        snippet: file.path && file.path !== file.name ? file.path : '',
        target: { id: entry.id, kind: 'entry' },
        title: file.name
      })
    }

    for (const visual of entry.visuals) {
      const text = visualText(visual)

      // The title counts for the match; the snippet shows the page, not the title again.
      if (seenVisuals.has(visual.toolId) || !snippetOf(`${visual.title} ${text}`, terms)) {
        continue
      }

      seenVisuals.add(visual.toolId)
      visuals.push({
        at: entry.at,
        key: `visual:${visual.toolId}`,
        snippet: snippetOf(text, terms) ?? (text.length > 120 ? `${text.slice(0, 120)}…` : text),
        target: { kind: 'visual', visual },
        title: visual.title
      })
    }
  }

  const docs = documents.flatMap(document => {
    const found = snippetOf(document.text, terms)

    return found
      ? [
          {
            key: `document:${document.kind}`,
            snippet: found,
            target: { document: document.kind, kind: 'document' as const },
            title: document.title
          }
        ]
      : []
  })

  const shown = messages.slice(0, MESSAGE_LIMIT)

  return {
    documents: docs,
    files,
    messages: shown,
    total: messages.length + files.length + visuals.length + docs.length,
    visuals
  }
}
