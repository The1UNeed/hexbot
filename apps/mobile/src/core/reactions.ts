import type { Reaction, ReactionsChanged } from './types'

/**
 * Reactions in the open chat: one emoji on a message, yours on what the bot
 * said and the bot's on what you said (`hexbot.reactions.*`). Kept by the
 * history row a message is; a message of yours this phone has not read back
 * from history is found by the key it was sent with.
 */
export interface ChatReactions {
  byMessage: Record<string, Reaction[]>
  /** The row an input became, as the daemon's change named it. */
  inputs: Record<string, string>
}

/** The emoji the menu offers, as on the web. The daemon takes any one emoji. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👎'] as const

export const emptyReactions = (): ChatReactions => ({ byMessage: {}, inputs: {} })

/** A chat's reactions as `hexbot.reactions.list` returns them. */
export function indexReactions(list: readonly Reaction[]): ChatReactions {
  const byMessage: Record<string, Reaction[]> = {}
  for (const reaction of list) (byMessage[reaction.message_id] ??= []).push(reaction)
  return { byMessage, inputs: {} }
}

const withMessage = (state: ChatReactions, message: string, reactions: Reaction[]) => {
  const byMessage = { ...state.byMessage }
  if (reactions.length) byMessage[message] = reactions
  else delete byMessage[message]
  return byMessage
}

/** One message's reactions changed: the daemon's event, or its answer to yours. */
export function applyReactions(state: ChatReactions, changed: ReactionsChanged): ChatReactions {
  return {
    byMessage: withMessage(state, changed.message_id, changed.reactions),
    inputs: changed.input_id
      ? { ...state.inputs, [changed.input_id]: changed.message_id }
      : state.inputs
  }
}

/**
 * Your reaction on a bot's message, shown before the daemon answers. The
 * same emoji again takes it back: `emoji` is what to send, null to remove.
 */
export function toggleReaction(
  state: ChatReactions,
  message: string,
  emoji: string
): { emoji: null | string; state: ChatReactions } {
  const before = state.byMessage[message] ?? []
  const next = before.find(r => r.by === 'user')?.emoji === emoji ? null : emoji
  const reactions: Reaction[] = [
    ...before.filter(r => r.by !== 'user'),
    ...(next ? [{ at: Date.now() / 1000, by: 'user' as const, emoji: next, message_id: message }] : [])
  ]
  return { emoji: next, state: { ...state, byMessage: withMessage(state, message, reactions) } }
}

/**
 * Your reaction was refused: the message goes back to what it showed in
 * `before`. Every other message keeps what arrived in the meantime.
 */
export function restoreReactions(
  state: ChatReactions,
  before: ChatReactions,
  message: string
): ChatReactions {
  return { ...state, byMessage: withMessage(state, message, before.byMessage[message] ?? []) }
}

/** The reactions on a message, by its row or the key it was sent with. */
export function reactionsOn(
  state: ChatReactions,
  message: { rowId?: string; inputId?: string }
): Reaction[] {
  const row = message.rowId ?? (message.inputId ? state.inputs[message.inputId] : undefined)
  return (row && state.byMessage[row]) || []
}
