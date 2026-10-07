import { listed, touched } from './navigation'
import type { Section } from './types'

const section = (patch: Partial<Section>): Section => ({
  archived_at: null,
  bot: 'owl',
  created_at: 1,
  id: 's',
  live_session_id: null,
  message_count: 0,
  preview: '',
  title: 'New section',
  title_by: null,
  updated_at: 1,
  ...patch
})

describe('which sections a bot lists', () => {
  it('counts a section touched once it has a message, a preview, or a draft', () => {
    expect(touched(section({}))).toBe(false)
    expect(touched(section({ message_count: 2 }))).toBe(true)
    expect(touched(section({}), { s: 'half a thought' })).toBe(true)
  })

  it('leaves out archived sections, Dreams, and threads', () => {
    expect(listed(section({ message_count: 1 }))).toBe(true)
    expect(listed(section({ archived_at: 5, message_count: 1 }))).toBe(false)
    expect(listed(section({ message_count: 1, title: 'Dreams' }))).toBe(false)
    expect(listed(section({ message_count: 1, peer_bot: 'fox' }))).toBe(false)
  })
})
