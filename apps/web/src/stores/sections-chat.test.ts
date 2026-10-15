import type * as api from '../lib/api'
import { daemonInfo, sectionsCreate, sectionsList } from '../lib/api'
import type { DaemonInfo, Section } from '../lib/types'

import { useConnection } from './connection'
import { keptChat, useSections } from './sections'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  daemonInfo: vi.fn(),
  sectionsCreate: vi.fn(),
  sectionsList: vi.fn()
}))

const section = (id: string, overrides: Partial<Section> = {}) =>
  ({
    archived_at: null,
    bot: 'writer',
    id,
    live_session_id: null,
    message_count: 3,
    peer_bot: null,
    preview: '',
    title: 'General',
    title_by: null,
    updated_at: 1,
    ...overrides
  }) as Section

const daemon = (info: Partial<DaemonInfo>) => info as DaemonInfo

describe("a bot's chat", () => {
  beforeEach(() => {
    vi.mocked(sectionsCreate)
      .mockReset()
      .mockResolvedValue({ section: section('made') })
    vi.mocked(sectionsList).mockReset()
    vi.mocked(daemonInfo).mockReset()
    useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, sendingTitles: {} })
  })

  it('is the one an older daemon keeps, which makes a section on every create', async () => {
    useConnection.setState({ daemon: daemon({ version: '0.1.6' }) })
    vi.mocked(sectionsList).mockResolvedValue({
      sections: [
        section('thread', { message_count: 9, peer_bot: 'scout', updated_at: 9 }),
        section('dreams', { title: 'Dreams', updated_at: 8 }),
        section('empty', { message_count: 0, updated_at: 7 }),
        section('long')
      ]
    })

    for (const _ of [1, 2]) {
      expect((await useSections.getState().chat('writer')).id).toBe('long')
    }

    expect(sectionsList).toHaveBeenCalledWith({ bot: 'writer', include_archived: true })
    expect(sectionsCreate).not.toHaveBeenCalled()

    // A bot with nothing yet gets the one create makes.
    vi.mocked(sectionsList).mockResolvedValue({ sections: [] })
    expect((await useSections.getState().chat('writer')).id).toBe('made')
  })

  it('is the daemon’s pick once it keeps one chat per bot, asking it if not yet known', async () => {
    useConnection.setState({ daemon: null })
    vi.mocked(daemonInfo).mockResolvedValue(daemon({ one_chat: true }))

    expect((await useSections.getState().chat('writer')).id).toBe('made')
    expect(sectionsList).not.toHaveBeenCalled()
    expect(sectionsCreate).toHaveBeenCalledWith('writer')
  })

  it('ranks something said, then not the Dreams log, then not archived, then newest', () => {
    const put = section('put-away', { archived_at: 5, updated_at: 6 })
    const named = section('named', { title: 'Dreams', title_by: 'bot', updated_at: 0 })

    expect(
      keptChat([section('dreams', { title: 'Dreams', updated_at: 9 }), put], 'writer')?.id
    ).toBe('put-away')
    expect(keptChat([put, named], 'writer')?.id).toBe('named')
    expect(keptChat([section('other', { bot: 'scout' })], 'writer')).toBeUndefined()
  })
})
