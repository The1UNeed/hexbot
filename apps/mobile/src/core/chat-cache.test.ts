import { describe, expect, it } from 'vitest'

import { afterRead, cursorFor, fingerprint, keep, newestPart, prefetchOrder, type HeldRows } from './chat-cache'
import type { Bot } from './types'

const row = (text: string) => ({ role: 'assistant', row_id: text, text })
const whole = (rows: unknown[], touched = 0, cursor = 'c'): HeldRows => ({ rows, cursor, complete: true, touched })

describe('a chat held for switching', () => {
  it('appends only a delta read with the cursor it sent, and replaces on a full read', () => {
    const held = whole([row('One')], 1, 'c1')

    const appended = afterRead(held, { messages: [row('Two')], history_cursor: 'c2', history_delta: true }, 'c1', 2)
    expect(appended).toEqual({ rows: [row('One'), row('Two')], cursor: 'c2', complete: true, touched: 2 })

    // The daemon could not use the cursor: everything came again.
    const replaced = afterRead(held, { messages: [row('Again')], history_cursor: 'c3', history_delta: false }, 'c1', 3)
    expect(replaced.rows).toEqual([row('Again')])

    // Nothing was sent, so nothing is appended to.
    expect(afterRead(held, { messages: [row('All')], history_delta: true }, undefined, 4).rows).toEqual([row('All')])
  })

  it('sends a cursor for only part of a history just to read ahead', () => {
    const part: HeldRows = { rows: [row('Late')], cursor: 'c', complete: false, touched: 0 }

    expect(cursorFor(part)).toBeUndefined()
    expect(cursorFor(part, true)).toBe('c')
    expect(cursorFor(whole([row('All')]))).toBe('c')
    expect(cursorFor(undefined, true)).toBeUndefined()
  })

  it('keeps whole histories for the chats opened last and the newest part of the rest', () => {
    const big = Array.from({ length: 600 }, (_, index) => row(`m${index}`))
    const map = new Map<string, HeldRows>()

    for (let index = 0; index < 6; index++) keep(map, `chat${index}`, whole(big, index))

    const kept = [...map].map(([id, item]) => [id, item.complete, item.rows.length])
    expect(kept.filter(([, complete]) => complete).map(([id]) => id)).toEqual(['chat2', 'chat3', 'chat4', 'chat5'])
    expect(map.get('chat0')!.rows).toEqual(newestPart(big))
    expect(map.get('chat0')!.rows.at(-1)).toEqual(row('m599'))
  })

  it('leaves small whole chats whole, however many', () => {
    const map = new Map<string, HeldRows>()

    for (let index = 0; index < 8; index++) keep(map, `chat${index}`, whole([row(`m${index}`)], index))

    expect([...map.values()].every(item => item.complete && item.fits)).toBe(true)
  })

  it('reads the primary bot first, then the list order, and notices a bot that wrote', () => {
    const bot = (name: string, extra: Partial<Bot> = {}) =>
      ({ name, last_activity_at: 1, sections_recent: [], status: 'idle', ...extra }) as unknown as Bot

    expect(prefetchOrder([bot('a'), bot('b', { primary: true }), bot('c')]).map(b => b.name)).toEqual(['b', 'a', 'c'])
    expect(fingerprint(bot('a'))).not.toBe(fingerprint(bot('a', { last_activity_at: 2 })))
    expect(fingerprint(bot('a'))).not.toBe(fingerprint(bot('a', { status: 'working' })))
  })
})
