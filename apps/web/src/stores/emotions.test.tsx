import { act, renderHook } from '@testing-library/react'

import { BORED_AFTER_MS, DROWSY_AFTER_MS, EMOTION_SECONDS } from '../lib/emotions'
import type { Message, RoomEvent, RoomTurn } from '../lib/types'

import { useConversationFeelings, useEmotions, useRoomFeelings } from './emotions'

const user = (id: string, text: string): Message => ({
  attachments: [],
  createdAt: 0,
  id,
  role: 'user',
  streaming: false,
  text,
  toolCalls: []
})

const replying: Message = {
  attachments: [],
  createdAt: 0,
  id: 'r1',
  role: 'assistant',
  streaming: true,
  text: '',
  toolCalls: []
}

const feels = () => useEmotions.getState().feelings.ada

beforeEach(() => {
  vi.useFakeTimers()
  useEmotions.setState({ feelings: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('bot feelings', () => {
  it('shows an emotion for its time, then lets it pass', () => {
    act(() => useEmotions.getState().feel('ada', 'proud'))
    expect(feels()).toBe('proud')
    act(() => vi.advanceTimersByTime(EMOTION_SECONDS.proud * 1000))
    expect(feels()).toBeUndefined()
  })

  it('reacts to news in the open chat, not to history it opened on', () => {
    const history = [user('u1', 'thanks!')]

    const { rerender } = renderHook(
      ({ messages, section }) => useConversationFeelings('ada', section, messages),
      { initialProps: { messages: history, section: 's1' } }
    )

    expect(feels()).toBeUndefined()
    rerender({
      messages: [...history, user('u2', 'Can you check the build?'), replying],
      section: 's1'
    })
    expect(feels()).toBe('curious')
    // Switching conversations is a new baseline, not news.
    act(() => useEmotions.getState().calm('ada'))
    rerender({ messages: [user('u9', 'thank you'), replying], section: 's2' })
    expect(feels()).toBeUndefined()
  })

  it('gets bored, then drowsy, in a quiet chat and wakes when something happens', () => {
    const history = [user('u1', 'hi')]

    const { rerender, unmount } = renderHook(
      ({ messages }) => useConversationFeelings('ada', 's1', messages),
      { initialProps: { messages: history } }
    )

    act(() => vi.advanceTimersByTime(BORED_AFTER_MS))
    expect(feels()).toBe('bored')
    act(() => vi.advanceTimersByTime(DROWSY_AFTER_MS - BORED_AFTER_MS))
    expect(feels()).toBe('drowsy')
    act(() => vi.advanceTimersByTime(60 * 60_000))
    expect(feels()).toBe('drowsy')
    rerender({ messages: [...history, user('u2', 'still there?'), replying] })
    expect(feels()).toBe('curious')
    unmount()
    // Only the curious moment is left to pass; the idle timers are gone.
    act(() => vi.advanceTimersByTime(EMOTION_SECONDS.curious * 1000))
    expect(feels()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one turn one reaction while a card closes its bubble', () => {
    const said = user('u1', 'thanks!')

    const { rerender } = renderHook(
      ({ active, messages }) => useConversationFeelings('ada', 's1', messages, true, active),
      { initialProps: { active: false, messages: [said] } }
    )

    rerender({ active: true, messages: [said, replying] })
    expect(feels()).toBe('shy')
    act(() => useEmotions.getState().calm('ada'))
    // An approval card closes the bubble; the turn runs on in a new one.
    const closed = { ...replying, streaming: false, text: 'Sorry, I need approval.' }
    rerender({ active: true, messages: [said, closed] })
    rerender({ active: true, messages: [said, closed, { ...replying, id: 'r2' }] })
    expect(feels()).toBeUndefined()
  })

  it('takes a room history that loads after opening as the baseline', () => {
    const event = (seq: number, text: string): RoomEvent => ({
      actor_id: 'ada',
      actor_kind: 'bot',
      created_at: seq,
      kind: 'message.bot',
      payload: { text },
      room_id: 'r1',
      seq
    })

    const turns: Record<string, RoomTurn> = {}

    const { rerender } = renderHook(
      ({ events, ready }) => useRoomFeelings('r1', events, turns, {}, ready),
      { initialProps: { events: [] as RoomEvent[], ready: false } }
    )

    rerender({ events: [event(1, 'Merged it.')], ready: true })
    expect(feels()).toBeUndefined()
    rerender({ events: [event(1, 'Merged it.'), event(2, 'Shipped.')], ready: true })
    expect(feels()).toBe('celebrating')
  })
})
