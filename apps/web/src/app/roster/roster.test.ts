import type { Bot, Room } from '../../lib/types'

import { orderedBots, orderedRosterItems } from './index'

describe('roster ordering', () => {
  it('orders bots and rooms together by daemon activity time', () => {
    const bot = { last_activity_at: 100, name: 'writer' } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot], [room]).map(item => item.kind)).toEqual(['room', 'bot'])
  })

  it('pins the primary bot on top however quiet it is', () => {
    const primary = { last_activity_at: 1, name: 'hexbot', primary: true } as Bot
    const bot = { last_activity_at: 100, name: 'writer', primary: false } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot, primary], [room]).map(entry => entry.item)).toEqual([
      primary,
      room,
      bot
    ])
    expect(orderedBots([bot, primary])).toEqual([primary, bot])
  })
})
