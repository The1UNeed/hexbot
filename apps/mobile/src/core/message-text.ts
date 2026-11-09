import { readableMath } from './math'

// The few Markdown marks a bot's message uses, read once so the bubble and
// the copied text agree on what the message says.

export type Span =
  { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; url: string }

export type Block =
  { kind: 'code'; text: string } | { kind: 'paragraph'; heading: boolean; spans: Span[] }

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/

function spans(text: string): Span[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part): Span => {
      const link = LINK.exec(part)
      if (link) return { kind: 'link', text: link[1], url: link[2] }
      if (part.startsWith('**') && part.endsWith('**'))
        return { kind: 'bold', text: readableMath(part.slice(2, -2)) }
      if (part.startsWith('`') && part.endsWith('`'))
        return { kind: 'code', text: part.slice(1, -1) }
      return { kind: 'text', text: readableMath(part) }
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

/** A message's code blocks, a blank line apart, or null when it has none. */
export function messageCode(text: string): string | null {
  const code = parseMessage(text)
    .filter(block => block.kind === 'code')
    .map(block => block.text)
  return code.length ? code.join('\n\n') : null
}
