import { describe, it, expect } from 'vitest'
import { SECTIONS_QUERY, defaultSection, rebind, type ChatRoute } from './routes'
import type { Bot, Section } from './types'
const bot = { name: 'ada', display_name: 'Ada' } as Bot
const section = (id: string, extra: Partial<Section> = {}) =>
  ({ id, bot: 'ada', title: id, ...extra }) as Section
describe('open conversation', () => {
  it('keeps a teammate thread open when the lists reload', () => {
    // The daemon lists teammate threads only when asked to.
    expect(SECTIONS_QUERY.include_threads).toBe(true)
    const thread = section('t', { peer_bot: 'grace' } as Partial<Section>)
    const route: ChatRoute = { kind: 'section', section: thread, bot }
    expect(rebind(route, { bots: [bot], rooms: [], sections: [section('a'), thread] })).toEqual(
      route
    )
    expect(rebind(route, { bots: [bot], rooms: [], sections: [section('a')] })).toBeNull()
  })
  it('opens a bot on its own latest thread, not a teammate thread', () => {
    const sections = [
      section('t', { peer_bot: 'grace' } as Partial<Section>),
      section('old', { archived_at: 1 } as Partial<Section>),
      section('mine')
    ]
    expect(defaultSection(sections, 'ada')?.id).toBe('mine')
  })
})
