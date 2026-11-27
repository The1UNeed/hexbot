import type { Bot, Room } from '../../lib/types'

import { isPinned, orderedBots, orderedRosterItems, startingModel } from './index'

describe('roster ordering', () => {
  it('orders bots and rooms together by daemon activity time', () => {
    const bot = { last_activity_at: 100, name: 'writer' } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot], [room]).map(item => item.kind)).toEqual(['room', 'bot'])
  })

  it('keeps the primary bot on top for older daemons, which send no pins', () => {
    const primary = { last_activity_at: 1, name: 'hexbot', primary: true } as Bot
    const bot = { last_activity_at: 100, name: 'writer', primary: false } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot, primary], [room]).map(entry => entry.item)).toEqual([
      primary,
      room,
      bot
    ])
    expect(isPinned({ item: primary, kind: 'bot' })).toBe(true)
    expect(orderedBots([bot, primary])).toEqual([primary, bot])
  })

  it('lets you unpin the primary bot', () => {
    const primary = { last_activity_at: 1, name: 'hexbot', pinned_at: null, primary: true } as Bot
    const bot = { last_activity_at: 100, name: 'writer', pinned_at: null } as Bot
    expect(isPinned({ item: primary, kind: 'bot' })).toBe(false)
    expect(orderedRosterItems([primary, bot], []).map(entry => entry.item)).toEqual([bot, primary])
  })

  it('keeps pinned bots and rooms first, in the order they were pinned', () => {
    const primary = { last_activity_at: 1, name: 'hexbot', pinned_at: 5, primary: true } as Bot
    const later = { last_activity_at: 1, name: 'writer', pinned_at: 20 } as Bot
    const busy = { last_activity_at: 500, name: 'coder', pinned_at: null } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 2, pinned_at: 10 } as Room
    expect(orderedRosterItems([busy, later, primary], [room]).map(entry => entry.item)).toEqual([
      primary,
      room,
      later,
      busy
    ])
  })
})

describe('startingModel', () => {
  const providers = [{ id: 'anthropic' }, { id: 'openai-codex' }]

  it('starts a new bot on the default from Settings when its provider is connected', () => {
    expect(startingModel({ model: '', provider: '' }, providers, 'anthropic/claude-fable-5-1')).toEqual({
      model: 'claude-fable-5-1',
      provider: 'anthropic'
    })
  })

  it('starts empty when the default is on a provider since removed, or there is none', () => {
    expect(startingModel({ model: '', provider: '' }, providers, 'openrouter/x')).toEqual({
      model: '',
      provider: ''
    })
    expect(startingModel({ model: '', provider: '' }, providers, null)).toEqual({ model: '', provider: '' })
  })

  it('keeps a choice from an earlier open only while its provider is connected', () => {
    const chosen = { model: 'gpt-6-astra', provider: 'openai-codex' }
    expect(startingModel(chosen, providers, 'anthropic/claude-fable-5-1')).toEqual(chosen)
    expect(startingModel(chosen, [{ id: 'anthropic' }], 'anthropic/claude-fable-5-1')).toEqual({
      model: 'claude-fable-5-1',
      provider: 'anthropic'
    })
    expect(startingModel(chosen, [], null)).toEqual({ model: '', provider: '' })
  })
})
