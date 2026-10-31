import type { SearchEntry, SearchFile } from '../../lib/search'
import type { Message, RoomEvent } from '../../lib/types'
import { visualsOf } from '../conversation/visual'

export * from '../../lib/search'

/** Tools that write a file at their `path` argument: Pi's and the earlier names. */
const WRITE_TOOLS = new Set(['edit', 'patch', 'write', 'write_file'])

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** The files a bot's message wrote, from its finished write and edit calls. */
function writtenFiles(message: Pick<Message, 'toolCalls'>): SearchFile[] {
  return message.toolCalls.flatMap(call => {
    if (!WRITE_TOOLS.has(call.name) || call.status !== 'ok') {
      return []
    }

    const args = typeof call.args === 'string' ? parse(call.args) : call.args
    const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}

    const path = [record.path, record.file_path].find(
      (value): value is string => typeof value === 'string' && value.trim() !== ''
    )

    return path ? [{ name: baseName(path), path }] : []
  })
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A bot's chat as search entries. */
export function chatEntries(
  messages: Message[],
  names: { bot: string; you?: string }
): SearchEntry[] {
  return messages.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return []
    }

    const assistant = message.role === 'assistant'

    return [
      {
        at: message.sentAt ?? (message.createdAt || undefined),
        author: assistant ? names.bot : (names.you ?? 'You'),
        files: [
          ...message.attachments.map(attachment => ({ attachment, name: attachment.name })),
          ...(assistant ? writtenFiles(message) : [])
        ],
        id: message.id,
        text: [...(message.parts ?? []), message.text].filter(Boolean).join('\n'),
        visuals: assistant ? visualsOf(message) : []
      }
    ]
  })
}

/** A room's messages as search entries; `nameOf` names who spoke. */
export function roomEntries(
  events: RoomEvent[],
  nameOf: (event: RoomEvent) => string
): SearchEntry[] {
  return events.flatMap(event => {
    if (event.kind !== 'message.bot' && event.kind !== 'message.user') {
      return []
    }

    const files = (event.payload.attachments ?? []).flatMap(item => {
      const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : null

      return typeof name === 'string' && name ? [{ name }] : []
    })

    return [
      {
        at: event.created_at * 1000,
        author: nameOf(event),
        files,
        id: String(event.seq),
        text: typeof event.payload.text === 'string' ? event.payload.text : '',
        visuals: []
      }
    ]
  })
}
