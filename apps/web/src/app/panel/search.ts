import type { SearchEntry, SearchFile } from '../../lib/search'
import type { Message, RoomEvent } from '../../lib/types'
import { filesOf } from '../conversation/shared-files'
import { visualsOf } from '../conversation/visual'

export * from '../../lib/search'

/** The files a bot's message shared, as the chat shows them. */
function sharedFiles(message: Pick<Message, 'toolCalls'>): SearchFile[] {
  return filesOf(message).map(({ name, path }) => ({ name, path }))
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
          ...(assistant ? sharedFiles(message) : [])
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
