import type * as api from '../lib/api'
import { messagesFromHistory, sectionsList, sectionsOpen } from '../lib/api'
import type { Section } from '../lib/types'

import { isThread, selectSectionsForBot, useSections } from './sections'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsList: vi.fn(),
  sectionsOpen: vi.fn()
}))

const section = (overrides: Partial<Section> = {}) =>
  ({
    archived_at: null,
    bot: 'writer',
    id: 's1',
    live_session_id: null,
    message_count: 2,
    peer_bot: null,
    preview: 'hello',
    title: 'Plans',
    title_by: null,
    ...overrides
  }) as Section

describe('threads and the section index', () => {
  beforeEach(() => {
    useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, sendingTitles: {} })
  })

  it('keeps threads out of the index however they arrive', async () => {
    const thread = section({ id: 'th1', peer_bot: 'scout', title: 'From scout' })
    expect(isThread(thread)).toBe(true)
    expect(isThread(section())).toBe(false)

    vi.mocked(sectionsList).mockResolvedValue({ sections: [section(), thread] })
    await useSections.getState().refresh()
    expect(selectSectionsForBot('writer')(useSections.getState()).map(item => item.id)).toEqual([
      's1'
    ])
    expect(useSections.getState().byId.th1).toBeUndefined()

    // An open that returns a thread (a changed event, a live session) does not list it either.
    vi.mocked(sectionsOpen).mockResolvedValue({
      messages: [],
      section: { ...thread, live_session_id: 'live-t' }
    })
    await useSections.getState().open('th1')
    expect(useSections.getState().byId.th1).toBeUndefined()
    expect(useSections.getState().liveSessionId.th1).toBe('live-t')
  })

  it('opens a thread for the panel with the asker as the user side', async () => {
    vi.mocked(sectionsOpen).mockResolvedValue({
      messages: [
        { display_kind: 'hidden', role: 'user', row_id: 'u1', text: '@scout: Draft the intro?' },
        { display_kind: 'hidden', role: 'user', row_id: 'u2', text: '@planner: not this one' },
        { display_kind: 'hidden', role: 'system', row_id: 'u3', text: '@scout: nor this' },
        { role: 'assistant', row_id: 'a1', text: 'Sure.' }
      ],
      section: section({ id: 'th1', live_session_id: 'live-t', peer_bot: 'scout' })
    })

    const opened = await useSections.getState().openThread('th1', 'scout')
    expect(opened.liveSessionId).toBe('live-t')
    expect(opened.messages.map(item => [item.role, item.text])).toEqual([
      ['user', 'Draft the intro?'],
      ['assistant', 'Sure.']
    ])
    expect(useSections.getState().liveSessionId.th1).toBe('live-t')
    expect(useSections.getState().byId.th1).toBeUndefined()
  })

  it('still drops every hidden row from an ordinary section', () => {
    const rows = [
      { display_kind: 'hidden', role: 'user', text: '@scout: hi' },
      { role: 'assistant', text: 'Hello.' }
    ]

    expect(messagesFromHistory(rows).map(item => item.text)).toEqual(['Hello.'])
  })
})
