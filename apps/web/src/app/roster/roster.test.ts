import type { Bot, Room } from '../../lib/types'

import { orderedRosterItems } from './index'

describe('roster ordering', () => {
  it('orders bots and rooms together by daemon activity time', () => {
    const bot = { last_activity_at: 100, name: 'writer' } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot], [room]).map(item => item.kind)).toEqual(['room', 'bot'])
  })
})
