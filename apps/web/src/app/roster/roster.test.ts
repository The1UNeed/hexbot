import type { Bot, Room, Section } from '../../lib/types'

import { orderedRosterItems } from './index'

describe('roster ordering', () => {
  it('orders bots and rooms together by daemon activity time', () => {
    const bot = { last_activity_at: 100, name: 'writer' } as Bot
    const room = { archived_at: null, id: 'room-1', last_activity_at: 200 } as Room
    expect(orderedRosterItems([bot], [room]).map(item => item.kind)).toEqual(['room', 'bot'])
  })
})

describe('sections under a bot', () => {
  const now = Date.now() / 1000

  const section = (id: string, ago: number, message_count: number) =>
    ({ archived_at: null, id, message_count, preview: '', updated_at: now - ago }) as Section

  const bot = { name: 'a', sections_recent: [], sections_total: 4 } as unknown as Bot
  const blank = section('blank', 0, 0)
  const all = [blank, section('old', 30 * 86_400, 3), section('b', 60, 2), section('c', 120, 1)]

  it('lists touched sections newest first and hides untouched ones', async () => {
    const { visibleRecentSections } = await import('./index')
    expect(visibleRecentSections(bot, false, all).map(item => item.id)).toEqual(['b', 'c'])
  })

  it('hides the open section until it has a message', async () => {
    const { visibleRecentSections } = await import('./index')
    expect(visibleRecentSections(bot, false, all, 'blank').map(item => item.id)).toEqual(['b', 'c'])
  })

  it('keeps an older open section visible', async () => {
    const { visibleRecentSections } = await import('./index')
    expect(visibleRecentSections(bot, false, all, 'old').map(item => item.id)).toEqual([
      'b',
      'c',
      'old'
    ])
  })

  it('lists an untouched section once it holds a draft', async () => {
    const { visibleRecentSections } = await import('./index')
    expect(
      visibleRecentSections(bot, false, all, undefined, { blank: 'hello' }).map(item => item.id)
    ).toEqual(['blank', 'b'])
  })

  it('expanded shows every touched section and never the Dreams one', async () => {
    const { visibleRecentSections } = await import('./index')
    const dreams = { ...section('dreams', 10, 4), title: 'Dreams' }
    expect(visibleRecentSections(bot, true, [...all, dreams]).map(item => item.id)).toEqual([
      'b',
      'c',
      'old'
    ])
  })
})
