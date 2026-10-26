// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BORED_AFTER_MS, DROWSY_AFTER_MS } from '../../../web/src/lib/emotions'
import { emptyChat } from './chat'
import { useFeeling } from './feelings'
import type { ChatState, ChatTool } from './types'

const tool = (status: ChatTool['status']): ChatTool => ({
  args: {},
  detail: '',
  id: `t${status}`,
  name: 'terminal',
  status
})

const said = (text: string): ChatState => ({
  ...emptyChat(),
  messages: [{ id: 'u1', role: 'user', text }]
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('mobile feelings', () => {
  it('reacts as a turn starts, to failed steps, and to how it ends', () => {
    const { rerender, result } = renderHook(({ chat }) => useFeeling('s1', chat), {
      initialProps: { chat: said('thanks so much') }
    })

    expect(result.current).toBeUndefined()
    const working = { ...said('thanks so much'), busy: true }
    rerender({ chat: working })
    expect(result.current).toBe('shy')
    rerender({ chat: { ...working, tools: [tool('error')] } })
    expect(result.current).toBe('confused')
    rerender({ chat: { ...said('thanks so much'), error: 'Provider down' } })
    expect(result.current).toBe('sad')
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current).toBeUndefined()
    // Stopped by you: no feelings about it.
    rerender({ chat: working })
    act(() => vi.advanceTimersByTime(10_000))
    rerender({ chat: { ...said('thanks so much'), error: 'The turn was interrupted' } })
    expect(result.current).toBeUndefined()
  })

  it('takes a running chat that loads after opening as the baseline', () => {
    const { rerender, result } = renderHook(({ chat, ready }) => useFeeling('s1', chat, ready), {
      initialProps: { chat: emptyChat(), ready: false }
    })

    rerender({ chat: { ...said('thanks so much'), busy: true }, ready: true })
    expect(result.current).toBeUndefined()
  })

  it('gets bored, then drowsy, and starts calm in another chat', () => {
    const { rerender, result } = renderHook(({ chat, id }) => useFeeling(id, chat), {
      initialProps: { chat: said('hi'), id: 's1' }
    })

    act(() => vi.advanceTimersByTime(BORED_AFTER_MS))
    expect(result.current).toBe('bored')
    act(() => vi.advanceTimersByTime(DROWSY_AFTER_MS - BORED_AFTER_MS))
    expect(result.current).toBe('drowsy')
    rerender({ chat: said('hi'), id: 's2' })
    expect(result.current).toBeUndefined()
  })
})
