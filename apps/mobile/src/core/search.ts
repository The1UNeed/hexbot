import type { SearchEntry } from '../../../web/src/lib/search'
import { parseArgs, sharedFiles } from './chat'
import type { ChatMessage } from './types'

export {
  MESSAGE_LIMIT,
  queryTerms,
  search,
  type SearchDocument,
  type SearchHit,
  type SearchResults
} from '../../../web/src/lib/search'

/**
 * The open conversation as search entries, the same reading the app's panel
 * makes. Visual ids match the transcript's (`visual-<message>-<n>`), so a
 * found visual opens like a tapped one.
 */
export function searchEntries(
  messages: ChatMessage[],
  nameOf: (message: ChatMessage) => string
): SearchEntry[] {
  return messages.flatMap(message => {
    if (message.role === 'system') return []
    const tools = message.tools ?? []
    const visuals = tools
      .filter(tool => tool.name === 'hexbot_show_html' && tool.status === 'ok')
      .flatMap((tool, index) => {
        const args = parseArgs(tool.args) as { html?: unknown; title?: unknown } | null
        if (typeof args?.html !== 'string') return []
        return [
          {
            html: args.html,
            title: typeof args.title === 'string' && args.title ? args.title : 'Visual',
            toolId: `visual-${message.id}-${index}`
          }
        ]
      })
    return [
      {
        at: message.createdAt,
        author: nameOf(message),
        files: [
          ...(message.attachments ?? []).map(file => ({ name: file.name })),
          ...(message.role === 'assistant' ? sharedFiles(tools) : [])
        ],
        id: message.id,
        text: message.text,
        visuals
      }
    ]
  })
}
