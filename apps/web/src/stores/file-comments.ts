/**
 * Comments the user leaves on a file open beside the chat. They wait above
 * the chat's composer and go with the next message, so the bot reads each one
 * with the words or area it is about. A picture the user marks up can be
 * added to the message the same way. Not persisted: they belong to the page,
 * like the side tabs.
 */

import { create } from 'zustand'

/** One comment on a file. */
export interface FileComment {
  id: string
  /** The file's name, as its tab shows it. */
  name: string
  /** Where the daemon keeps it; absent for a file only this page holds. */
  path?: string
  /** Where in the file: "line 12", "B2:C4 on Sheet1", "slide 3", "the area at 40, 120". */
  where?: string
  /** The words or values the comment is about, as the user selected them. */
  quote?: string
  note: string
  /** The side tab it was left in, so a picture's marks show on that picture only. */
  tab?: string
  /** The area of a picture it marks, in the picture's pixels, drawn on the picture while it waits. */
  area?: { x: number; y: number; w: number; h: number }
}

interface FileCommentsState {
  /** By chat: the section, or the live session for a chat without one yet. */
  byChat: Record<string, FileComment[]>
  /** Files to add to a chat's composer, such as a picture the user marked up. */
  outbox: Record<string, File[]>
  add: (chat: string, comment: Omit<FileComment, 'id'>) => void
  remove: (chat: string, id: string) => void
  /** Takes a chat's comments, as a message sends them. */
  take: (chat: string) => FileComment[]
  /** Puts comments back, as a send that failed returns its draft. */
  restore: (chat: string, comments: FileComment[]) => void
  attach: (chat: string, file: File) => void
  takeFiles: (chat: string) => File[]
}

let made = 0

const NONE: FileComment[] = []

export const useFileComments = create<FileCommentsState>()((set, get) => ({
  byChat: {},
  outbox: {},

  add(chat, comment) {
    const next = { ...comment, id: `comment-${++made}` }

    set(state => ({ byChat: { ...state.byChat, [chat]: [...(state.byChat[chat] ?? []), next] } }))
  },

  remove(chat, id) {
    set(state => ({
      byChat: { ...state.byChat, [chat]: (state.byChat[chat] ?? []).filter(item => item.id !== id) }
    }))
  },

  take(chat) {
    const taken = get().byChat[chat] ?? []

    if (taken.length) {
      set(state => ({ byChat: { ...state.byChat, [chat]: [] } }))
    }

    return taken
  },

  restore(chat, comments) {
    if (comments.length) {
      set(state => ({
        byChat: { ...state.byChat, [chat]: [...comments, ...(state.byChat[chat] ?? [])] }
      }))
    }
  },

  attach(chat, file) {
    set(state => ({ outbox: { ...state.outbox, [chat]: [...(state.outbox[chat] ?? []), file] } }))
  },

  takeFiles(chat) {
    const taken = get().outbox[chat] ?? []

    if (taken.length) {
      set(state => ({ outbox: { ...state.outbox, [chat]: [] } }))
    }

    return taken
  }
}))

export const fileCommentsActions = () => useFileComments.getState()

/** A chat's comments, for a component. */
export function useChatComments(chat: null | string): FileComment[] {
  return useFileComments(state => (chat ? (state.byChat[chat] ?? NONE) : NONE))
}

const clip = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text

/**
 * The message the composer sends: what the user typed, then each comment with
 * the file it is on, so the bot finds the place and edits that file.
 */
export function withComments(text: string, comments: FileComment[]): string {
  if (!comments.length) {
    return text
  }

  const lines = comments.map((comment, index) => {
    // A file tag: the chat shows the name, which opens the file, and the bot reads the path.
    const label = comment.name.replace(/[[\]\\]/g, '\\$&')

    const file = comment.path
      ? `[${label}](<${comment.path.replace(/[<>\\]/g, '\\$&')}>)`
      : comment.name

    const where = comment.where ? `, ${comment.where}` : ''

    const quote = comment.quote
      ? `, on "${clip(comment.quote.replace(/\s+/g, ' ').trim(), 400)}"`
      : ''

    return `${index + 1}. ${file}${where}${quote}: ${comment.note}`
  })

  const ask = text.trim() || 'Please work through my comments on these files.'

  return `${ask}\n\nMy comments:\n${lines.join('\n')}\n\nWhere a comment asks for a change, edit the file in place.`
}
