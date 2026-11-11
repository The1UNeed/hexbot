import { describe, expect, it } from 'vitest'

import {
  applyReactions,
  emptyReactions,
  indexReactions,
  reactionsOn,
  restoreReactions,
  toggleReaction
} from './reactions'

const thumbs = { at: 1, by: 'user' as const, emoji: '👍', message_id: 'a1' }

describe('reactions', () => {
  it('keeps a chat\'s reactions by the message they are on', () => {
    const state = indexReactions([thumbs, { ...thumbs, by: 'bot', bot: 'owl', message_id: 'u1' }])
    expect(reactionsOn(state, { rowId: 'a1' })).toEqual([thumbs])
    expect(reactionsOn(state, { rowId: 'nowhere' })).toEqual([])
    expect(reactionsOn(emptyReactions(), {})).toEqual([])
  })

  it('shows yours at once, replaces it, and takes it back with the same emoji', () => {
    const first = toggleReaction(emptyReactions(), 'a1', '👍')
    expect(first.emoji).toBe('👍')
    expect(reactionsOn(first.state, { rowId: 'a1' })).toMatchObject([{ by: 'user', emoji: '👍' }])
    const second = toggleReaction(first.state, 'a1', '❤️')
    expect(second.emoji).toBe('❤️')
    expect(reactionsOn(second.state, { rowId: 'a1' })).toMatchObject([{ emoji: '❤️' }])
    const third = toggleReaction(second.state, 'a1', '❤️')
    expect(third.emoji).toBeNull()
    expect(third.state.byMessage).toEqual({})
  })

  it('puts back only the message whose reaction was refused', () => {
    const before = indexReactions([{ at: 1, by: 'user', emoji: '👍', message_id: 'a1' }])
    const shown = toggleReaction(before, 'a1', '❤️').state
    // The bot reacted to another message while the daemon was asked.
    const meanwhile = applyReactions(shown, {
      input_id: 'in-1',
      message_id: 'u1',
      reactions: [{ at: 2, bot: 'owl', by: 'bot', emoji: '🎉', message_id: 'u1' }],
      section_id: 'chat'
    })
    const restored = restoreReactions(meanwhile, before, 'a1')
    expect(restored.byMessage.a1?.[0]?.emoji).toBe('👍')
    expect(restored.byMessage.u1?.[0]?.emoji).toBe('🎉')
    expect(restored.inputs).toEqual({ 'in-1': 'u1' })
  })

  it("finds the bot's reaction on a message of yours by the key it was sent with", () => {
    const reaction = { at: 2, bot: 'owl', by: 'bot' as const, emoji: '🎉', message_id: 'u1' }
    const state = applyReactions(emptyReactions(), {
      input_id: 'in-1',
      message_id: 'u1',
      reactions: [reaction],
      section_id: 'chat'
    })
    expect(reactionsOn(state, { inputId: 'in-1' })).toEqual([reaction])
    expect(reactionsOn(state, { rowId: 'u1' })).toEqual([reaction])
    // Taken back: nothing is left on the message.
    const cleared = applyReactions(state, { message_id: 'u1', reactions: [], section_id: 'chat' })
    expect(reactionsOn(cleared, { inputId: 'in-1' })).toEqual([])
  })
})
