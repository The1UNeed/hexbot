/**
 * Reactions in the bots' chats: one emoji on a message, yours on what a bot
 * said and a bot's on what you said. Read when a chat opens, kept current by
 * `hexbot.reactions.changed`, and shown at once when you react, before the
 * daemon answers. Not persisted.
 */

import { useEffect } from 'react'
import { create } from 'zustand'

import { reactionsList, reactionsSet } from '../lib/api'
import type { Reaction, ReactionsChanged } from '../lib/types'

import { connectionRead, useConnection } from './connection'

/** The emoji the picker offers. The daemon takes any one emoji. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👎'] as const

type ByMessage = Record<string, Reaction[]>

export interface ReactionsState {
  /** A change the daemon announced, or answered a `react` with. */
  apply: (changed: ReactionsChanged) => void
  /** Reactions by chat, then by the message they are on. */
  bySection: Record<string, ByMessage>
  /**
   * The message an input became, by chat: a bot reacts to a message this app
   * may still show under the key it was sent with, not its history row.
   */
  inputs: Record<string, Record<string, string>>
  load: (sectionId: string) => Promise<void>
  /** Leaves your emoji on a bot's message; the same emoji again takes it back. */
  react: (sectionId: string, messageId: string, emoji: string) => Promise<void>
  /** Forget everything: another daemon has other chats. */
  reset: () => void
}

/** Only the latest read of a chat may replace what is shown for it. */
const reads = new Map<string, number>()

const withMessage = (
  state: ReactionsState,
  sectionId: string,
  messageId: string,
  reactions: Reaction[]
): Pick<ReactionsState, 'bySection'> => {
  const section = { ...state.bySection[sectionId] }

  if (reactions.length) {
    section[messageId] = reactions
  } else {
    delete section[messageId]
  }

  return { bySection: { ...state.bySection, [sectionId]: section } }
}

export const useReactions = create<ReactionsState>((set, get) => ({
  bySection: {},
  inputs: {},

  apply(changed) {
    set(state => ({
      ...withMessage(state, changed.section_id, changed.message_id, changed.reactions),
      ...(changed.input_id && {
        inputs: {
          ...state.inputs,
          [changed.section_id]: {
            ...state.inputs[changed.section_id],
            [changed.input_id]: changed.message_id
          }
        }
      })
    }))
  },

  async load(sectionId) {
    const current = connectionRead()
    const mine = (reads.get(sectionId) ?? 0) + 1
    reads.set(sectionId, mine)

    try {
      const { reactions } = await reactionsList(sectionId)

      if (!current() || reads.get(sectionId) !== mine) {
        return
      }

      const section: ByMessage = {}

      for (const reaction of reactions) {
        ;(section[reaction.message_id] ??= []).push(reaction)
      }

      set(state => ({ bySection: { ...state.bySection, [sectionId]: section } }))
    } catch {
      // Reactions are an extra: a chat that cannot read them shows none.
    }
  },

  async react(sectionId, messageId, emoji) {
    const before = get().bySection[sectionId]?.[messageId] ?? []
    const mine = before.find(reaction => reaction.by === 'user')
    const next = mine?.emoji === emoji ? null : emoji
    const others = before.filter(reaction => reaction.by !== 'user')

    // Shown where you put it while the daemon catches up; a refusal puts it back.
    set(state =>
      withMessage(state, sectionId, messageId, [
        ...others,
        ...(next
          ? [{ at: Date.now() / 1000, by: 'user' as const, emoji: next, message_id: messageId }]
          : [])
      ])
    )

    try {
      get().apply(await reactionsSet(sectionId, messageId, next))
    } catch (error) {
      set(state => withMessage(state, sectionId, messageId, before))

      throw error
    }
  },

  reset() {
    reads.clear()
    set({ bySection: {}, inputs: {} })
  }
}))

const NONE: Reaction[] = []

/**
 * The reactions on one message of a chat. `inputId` finds a bot's reaction to
 * a message of yours that this app has not read back from history yet.
 */
export function useMessageReactions(
  sectionId: null | string | undefined,
  messageId: null | string | undefined,
  inputId?: string
): Reaction[] {
  return useReactions(state => {
    if (!sectionId) {
      return NONE
    }

    const section = state.bySection[sectionId]
    const row = inputId ? state.inputs[sectionId]?.[inputId] : undefined

    return (messageId && section?.[messageId]) || (row && section?.[row]) || NONE
  })
}

/**
 * Reads a chat's reactions when it opens and after every reconnect. Returns
 * the chat's id when the daemon keeps reactions, for the rows to react in.
 */
export function useChatReactions(sectionId: null | string | undefined): string | undefined {
  const supported = useConnection(state => Boolean(state.daemon?.reactions))
  const epoch = useConnection(state => state.epoch)
  const connects = useConnection(state => state.connects)
  const id = supported && sectionId ? sectionId : undefined

  useEffect(() => {
    if (id) {
      void useReactions.getState().load(id)
    }
  }, [connects, epoch, id])

  return id
}
