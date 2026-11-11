import { splitMentions, type Tag, tagOf } from '../../../web/src/lib/tags'
import { readableMath } from './math'

// The few Markdown marks a bot's message uses, read once so the bubble and
// the copied text agree on what the message says. A link that names a bot, a
// file or a place in Hexbot is a tag (apps/web/src/lib/tags.ts), as on the web.

export type Span =
  | { kind: 'text' | 'bold' | 'code'; text: string }
  | { kind: 'link'; text: string; url: string }
  /** Something Hexbot opens itself: a bot, a file, a room, a Settings page. */
  | { kind: 'tag'; text: string; tag: Exclude<Tag, { kind: 'link' }> }

export type Block =
  { kind: 'code'; text: string } | { kind: 'paragraph'; heading: boolean; spans: Span[] }

const INLINE =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:<[^>]+>|[^\s)]+)\)|https?:\/\/[^\s<>()]+)/g
const LINK = /^\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)$/
/** Marks that end a sentence after a bare address rather than the address. */
const TRAILING = /[.,;:!?'"]+$/

/** Plain text, with each `@handle` as a tag; whether it is a bot is the roster's to say. */
function words(text: string): Span[] {
  return splitMentions(text).map(
    (part): Span =>
      typeof part === 'string'
        ? { kind: 'text', text: readableMath(part) }
        : { kind: 'tag', text: `@${part.handle}`, tag: { kind: 'bot', handle: part.handle } }
  )
}

function spans(text: string): Span[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .flatMap((part): Span[] => {
      const link = LINK.exec(part)
      if (link) {
        const target = link[2] ?? link[3]!
        const tag = tagOf(target)
        // The address as written, so a link named by its own address is not written twice.
        if (tag?.kind === 'link') return [{ kind: 'link', text: link[1]!, url: target }]
        if (tag) return [{ kind: 'tag', text: link[1]!, tag }]
        // Any other target is not ours to open: the words stay, the address goes.
        return /^(?:mailto|tel):/i.test(target)
          ? [{ kind: 'link', text: link[1]!, url: target }]
          : [{ kind: 'text', text: link[1]! }]
      }
      if (/^https?:\/\//.test(part)) {
        const url = part.replace(TRAILING, '')
        const rest = part.slice(url.length)
        return [{ kind: 'link', text: url, url }, ...(rest ? words(rest) : [])]
      }
      if (part.startsWith('**') && part.endsWith('**'))
        return [{ kind: 'bold', text: readableMath(part.slice(2, -2)) }]
      if (part.startsWith('`') && part.endsWith('`'))
        return [{ kind: 'code', text: part.slice(1, -1) }]
      return words(part)
    })
}

export function parseMessage(text: string): Block[] {
  return text
    .split(/(```[\s\S]*?```)/g)
    .filter(Boolean)
    .flatMap((block): Block[] => {
      if (block.startsWith('```'))
        return [
          {
            kind: 'code',
            text: block
              .replace(/^```[^\n]*\n?/, '')
              .replace(/```$/, '')
              .trimEnd()
          }
        ]
      const trimmed = block.trim()
      if (!trimmed) return []
      return trimmed.split(/\n\s*\n/).map(paragraph => ({
        kind: 'paragraph',
        heading: /^#{1,6}\s+/.test(paragraph),
        spans: spans(paragraph.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s/gm, '• '))
      }))
    })
}

/**
 * The message as the bubble shows it, for copying and selecting: no Markdown
 * marks, paragraphs a blank line apart, and a link's address after its words.
 */
export function messageText(text: string): string {
  return parseMessage(text)
    .map(block =>
      block.kind === 'code'
        ? block.text
        : block.spans
            .map(span =>
              span.kind === 'link' && span.url !== span.text
                ? `${span.text} (${span.url})`
                : span.text
            )
            .join('')
    )
    .join('\n\n')
}
