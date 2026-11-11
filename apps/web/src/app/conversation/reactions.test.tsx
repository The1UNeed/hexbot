import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Message } from '../../lib/types'
import { useReactions } from '../../stores/reactions'

import { MessageRow } from './index'

const owl = { avatar: null, display_name: 'Owl', name: 'owl' } as unknown as Bot

const message = (partial: Partial<Message>): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming: false,
  text: '',
  toolCalls: [],
  ...partial
})

const row = (partial: Partial<Message>, reactIn: null | string = 'chat') =>
  render(
    <MessageRow
      bot={owl}
      message={message(partial)}
      onImage={() => {}}
      reactIn={reactIn ?? undefined}
    />
  )

/** The daemon answers a reaction with the message's reactions, as it announces them. */
const daemon = () => {
  const call = vi.fn((method: string, params: Record<string, unknown>) =>
    method === 'hexbot.reactions.set'
      ? Promise.resolve({
          message_id: params.message_id,
          reactions: params.emoji
            ? [{ at: 1, by: 'user', emoji: params.emoji, message_id: params.message_id }]
            : [],
          section_id: params.section_id
        })
      : Promise.reject(new Error(`unexpected ${method}`))
  )

  setActiveRpc({ call } as never)

  return call
}

describe('reactions', () => {
  beforeEach(() => {
    useReactions.getState().reset()
  })

  it('lets you react to each of a bot\'s bubbles, and take the reaction back', async () => {
    const call = daemon()
    row({ partIds: ['a1'], parts: ['On it.'], text: 'Booked the 9am.', textId: 'a2' })
    const buttons = screen.getAllByRole('button', { name: 'React' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'thumbs up' }))
    // Shown at once, on the bubble it was left on.
    const chip = await screen.findByRole('button', { name: 'Remove your thumbs up reaction' })
    expect(chip).toHaveTextContent('👍')
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.reactions.set', {
        emoji: '👍',
        message_id: 'a2',
        section_id: 'chat'
      })
    )
    fireEvent.click(chip)
    await waitFor(() => expect(screen.queryByTestId('reactions')).toBeNull())
    expect(call).toHaveBeenLastCalledWith('hexbot.reactions.set', {
      emoji: null,
      message_id: 'a2',
      section_id: 'chat'
    })
  })

  it('puts the bubble back when the daemon refuses', async () => {
    setActiveRpc({ call: vi.fn(() => Promise.reject(new Error('message not found'))) } as never)
    row({ text: 'Booked the 9am.', textId: 'a2' })
    fireEvent.click(screen.getByRole('button', { name: 'React' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'heart' }))
    await waitFor(() => expect(screen.queryByTestId('reactions')).toBeNull())
  })

  it('offers nothing while the bubble is written, without a row to name, or outside a chat', () => {
    const { unmount } = row({ parts: ['On it.'], streaming: true, text: 'Boo' })
    expect(screen.queryByRole('button', { name: 'React' })).toBeNull()
    unmount()
    row({ text: 'Booked the 9am.', textId: 'a2' }, null)
    expect(screen.queryByRole('button', { name: 'React' })).toBeNull()
  })

  it("shows the bot's reaction on your message, found by row or by the key it was sent with", () => {
    row({ id: 'local-1', inputId: 'in-1', role: 'user', text: 'Thanks, that worked.' })
    expect(screen.queryByTestId('reactions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'React' })).toBeNull()
    act(() =>
      routeEvent({
        payload: {
          input_id: 'in-1',
          message_id: 'u1',
          reactions: [{ at: 1, bot: 'owl', by: 'bot', emoji: '🎉', message_id: 'u1' }],
          section_id: 'chat'
        },
        type: 'hexbot.reactions.changed'
      } as never)
    )
    const chip = screen.getByRole('img', { name: 'Owl reacted with celebrate' })
    expect(chip).toHaveTextContent('🎉')
    // The bot's reaction is not yours to take back.
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('reads a chat\'s reactions and forgets them for another daemon', async () => {
    const call = vi.fn(() =>
      Promise.resolve({
        reactions: [{ at: 1, by: 'user', emoji: '👍', message_id: 'a2' }]
      })
    )

    setActiveRpc({ call } as never)
    await useReactions.getState().load('chat')
    expect(call).toHaveBeenCalledWith('hexbot.reactions.list', { section_id: 'chat' })
    row({ text: 'Booked the 9am.', textId: 'a2' })
    expect(screen.getByRole('button', { name: 'Remove your thumbs up reaction' })).toBeVisible()
    act(() => useReactions.getState().reset())
    expect(screen.queryByTestId('reactions')).toBeNull()
  })
})
