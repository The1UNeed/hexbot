import type * as api from '../lib/api'
import { daemonInfo, sectionsCreate, sectionsList, sectionsUnarchive } from '../lib/api'
import type { DaemonInfo, Section } from '../lib/types'

import { useConnection } from './connection'
import { legacyChat, useSections } from './sections'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  daemonInfo: vi.fn(),
  sectionsCreate: vi.fn(),
  sectionsList: vi.fn(),
  sectionsUnarchive: vi.fn()
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
const chat = (bot: string) => useSections.getState().chat(bot)

/** An older daemon listing these sections of `bot`. Picks are remembered by bot. */
const listing = (bot: string, ...sections: Section[]) =>
  vi.mocked(sectionsList).mockResolvedValue({
    sections: sections.map(item => ({ ...item, bot: item.peer_bot ? item.bot : bot }))
  })

/** Waits for `chat` to ask, then answers with the section of `id`, or none. */
async function pick(id: null | string) {
  await vi.waitFor(() => expect(useSections.getState().choosing).not.toBeNull())
  const choosing = useSections.getState().choosing!

  choosing.pick(choosing.choices.find(choice => choice.id === id) ?? null)

  return choosing.choices.map(choice => choice.id)
}

describe("a bot's chat", () => {
  beforeEach(() => {
    vi.mocked(sectionsCreate)
      .mockReset()
      .mockResolvedValue({ section: section('made') })
    vi.mocked(sectionsList).mockReset()
    vi.mocked(sectionsUnarchive).mockReset()
    vi.mocked(daemonInfo).mockReset()
    useSections.setState({ byId: {}, choosing: null, idsByBot: {}, liveSessionId: {} })
    useConnection.setState({ daemon: daemon({ version: '0.1.6' }) })
  })

  it('is the daemon’s pick once it keeps one chat per bot, even when this window knows one', async () => {
    // The one this window lists may be a chat recovery set aside, which would not open.
    useSections.setState({ byId: { set: section('set') }, idsByBot: { writer: ['set'] } })
    useConnection.setState({ daemon: null })
    vi.mocked(daemonInfo).mockResolvedValue(daemon({ one_chat: true }))

    expect((await chat('writer'))?.id).toBe('made')
    expect(sectionsCreate).toHaveBeenCalledWith('writer')
    expect(sectionsList).not.toHaveBeenCalled()
    expect(sectionsUnarchive).not.toHaveBeenCalled()
  })

  it('asks on an older daemon rather than guess which section is its Dreams log', async () => {
    // A real conversation, and a newer log the user renamed: the list cannot tell them apart.
    listing(
      'ann',
      section('night', { title: 'Night notes', updated_at: 9 }),
      section('trip', { title: 'Trip', updated_at: 5 }),
      section('empty', { message_count: 0, updated_at: 10 }),
      section('thread', { message_count: 9, peer_bot: 'scout', updated_at: 11 })
    )

    const opening = chat('ann')

    expect(await pick('trip')).toEqual(['night', 'trip'])
    expect((await opening)?.id).toBe('trip')

    // Asked once while the app runs.
    expect((await chat('ann'))?.id).toBe('trip')
    expect(sectionsList).toHaveBeenCalledWith({ bot: 'ann', include_archived: true })
    expect(sectionsCreate).not.toHaveBeenCalled()
  })

  it('asks too when a conversation the user named Dreams sits beside another', async () => {
    listing(
      'ben',
      section('named', { title: 'Dreams', title_by: null, updated_at: 7 }),
      section('trip', { title: 'Trip', updated_at: 5 })
    )

    const opening = chat('ben')

    expect(await pick('named')).toEqual(['named', 'trip'])
    expect((await opening)?.id).toBe('named')
    expect(sectionsCreate).not.toHaveBeenCalled()
  })

  it('opens the one section with something said, whatever its title, without asking', async () => {
    listing(
      'cat',
      section('dreams', { title: 'Dreams', updated_at: 2 }),
      section('empty', { message_count: 0, updated_at: 9 })
    )

    expect((await chat('cat'))?.id).toBe('dreams')
    expect(useSections.getState().choosing).toBeNull()
  })

  it('opens the newest open section when none has anything said, and makes one only for none', async () => {
    listing(
      'dan',
      section('put-away', { archived_at: 9, message_count: 0, updated_at: 9 }),
      section('older', { message_count: 0, updated_at: 3 }),
      section('newer', { message_count: 0, updated_at: 4 })
    )

    expect((await chat('dan'))?.id).toBe('newer')
    expect(sectionsCreate).not.toHaveBeenCalled()

    listing('dan')
    expect((await chat('dan'))?.id).toBe('made')
    expect(sectionsCreate).toHaveBeenCalledOnce()
  })

  it('brings an archived chat back so it takes messages', async () => {
    listing('eve', section('trip', { archived_at: 5, title: 'Trip' }))
    vi.mocked(sectionsUnarchive).mockResolvedValue({
      section: section('trip', { bot: 'eve', title: 'Trip' })
    })

    const opened = await chat('eve')

    expect(sectionsUnarchive).toHaveBeenCalledWith('trip')
    expect(opened).toMatchObject({ archived_at: null, id: 'trip' })
    expect(useSections.getState().byId.trip?.archived_at).toBeNull()
    expect(sectionsCreate).not.toHaveBeenCalled()
  })

  it('fails without making a section when the archived chat cannot come back', async () => {
    listing('fay', section('trip', { archived_at: 5 }))
    vi.mocked(sectionsUnarchive).mockRejectedValue(new Error('daemon unavailable'))

    await expect(chat('fay')).rejects.toThrow('daemon unavailable')
    expect(sectionsCreate).not.toHaveBeenCalled()
  })

  it('opens and makes nothing when the user picks none', async () => {
    listing('gus', section('a'), section('b'))

    const opening = chat('gus')

    await pick(null)
    expect(await opening).toBeNull()
    expect(sectionsCreate).not.toHaveBeenCalled()
    expect(useSections.getState().choosing).toBeNull()
  })
})

describe('an older daemon’s chat', () => {
  it('is certain only while at most one section has something said', () => {
    const thread = section('thread', { message_count: 9, peer_bot: 'scout' })
    const other = section('other', { bot: 'scout' })

    expect(legacyChat([thread, other], 'writer')).toBeNull()
    expect(legacyChat([thread, section('only')], 'writer')).toEqual({ section: section('only') })
    expect(
      legacyChat(
        [
          section('put-away', { archived_at: 4, updated_at: 9 }),
          section('old', { updated_at: 1 }),
          section('new', { updated_at: 2 })
        ],
        'writer'
      )
    ).toEqual({
      choices: [
        section('new', { updated_at: 2 }),
        section('old', { updated_at: 1 }),
        section('put-away', { archived_at: 4, updated_at: 9 })
      ]
    })
  })
})
