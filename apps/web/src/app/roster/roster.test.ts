import type { Bot, Room } from '../../lib/types'

import { orderedBots, orderedRosterItems, startingModel } from './index'

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
