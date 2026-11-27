/**
 * Comments the user leaves on a file open beside the chat. They wait above
 * the chat's composer and go with the next message, so the bot reads each one
 * with the words or area it is about. A picture the user marks up can be
 * added to the message the same way. Not persisted: they belong to the page,
 * like the side tabs.
 */

import { create } from 'zustand'

import type { FileComment } from '../lib/file-comments'

export { type FileComment, withComments } from '../lib/file-comments'

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
