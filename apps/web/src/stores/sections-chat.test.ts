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

const daemon = (info: Omit<Partial<DaemonInfo>, 'one_chat'> & { one_chat?: boolean }) =>
  info as DaemonInfo

const chat = (bot: string) => useSections.getState().chat(bot)
let listed: Section[] = []

/** An older daemon listing these sections of `bot`. Picks are remembered by bot. */
const listing = (bot: string, ...sections: Section[]) => {
  listed = sections.map(item => ({ ...item, bot: item.peer_bot ? item.bot : bot }))
  vi.mocked(sectionsList).mockResolvedValue({
    sections: listed
  })
}

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
    vi.mocked(sectionsUnarchive)
      .mockReset()
      .mockImplementation(async id => ({
        section: { ...listed.find(item => item.id === id)!, archived_at: null, updated_at: 20 }
      }))
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
    expect(sectionsUnarchive).not.toHaveBeenCalled()
    expect(useSections.getState().choosing).toBeNull()
  })

  it.each([null, 5])(
    'persists an explicit older pick before opening, archived_at=%s',
    async archived_at => {
      const bot = `persist-${archived_at}`
      listing(
        bot,
        section('old', { archived_at, updated_at: 1, title: 'Trip' }),
        section('new', { updated_at: 9 })
      )
      const opening = chat(bot)
      await pick('old')
      expect(await opening).toMatchObject({
        id: 'old',
        title: 'Trip',
        archived_at: null,
        updated_at: 20
      })
      expect(sectionsUnarchive).toHaveBeenCalledExactlyOnceWith('old')
      expect(sectionsCreate).not.toHaveBeenCalled()
    }
  )

  it('does not remember a failed persistence RPC, and lets the user retry or cancel', async () => {
    listing('persist-failure', section('old'), section('new', { updated_at: 9 }))
    vi.mocked(sectionsUnarchive).mockRejectedValueOnce(new Error('write failed'))
    const opening = chat('persist-failure')
    const failed = expect(opening).rejects.toThrow('write failed')
    await pick('old')
    await failed
    const retry = chat('persist-failure')
    await pick(null)
    expect(await retry).toBeNull()
    expect(sectionsUnarchive).toHaveBeenCalledTimes(1)
    expect(sectionsCreate).not.toHaveBeenCalled()
  })

  it('does not persist a choice from a superseded lookup or a changed daemon', async () => {
    let complete!: (value: { sections: Section[] }) => void
    vi.mocked(sectionsList).mockReturnValueOnce(
      new Promise(resolve => {
        complete = resolve
      })
    )
    const old = chat('stale')
    await Promise.resolve()
    useConnection.setState({ epoch: 'another-daemon' })
    complete({ sections: [section('stale')] })
    expect(await old).toBeNull()
    expect(sectionsUnarchive).not.toHaveBeenCalled()
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

describe('older picks during reconnect', () => {
  beforeEach(() => {
    useConnection.setState({
      target: { kind: 'local' },
      epoch: 'first',
      daemon: daemon({ one_chat: false, install_id: 'first' })
    })
    useSections.setState({ byId: {}, choosing: null, idsByBot: {}, liveSessionId: {} })
    vi.mocked(sectionsUnarchive)
      .mockReset()
      .mockImplementation(async id => ({ section: section(id) }))
    vi.mocked(sectionsCreate)
      .mockReset()
      .mockResolvedValue({ section: section('canonical') })
    vi.mocked(daemonInfo).mockReset()
    vi.mocked(sectionsList).mockReset()
    listing('writer', section('old'), section('new'))
  })

  it.each(['list', 'unarchive', 'chooser'] as const)(
    'a blip cancels the in-flight %s and its callbacks',
    async boundary => {
      let complete!: () => void

      if (boundary === 'list') {
        vi.mocked(sectionsList).mockReturnValueOnce(
          new Promise(resolve => {
            complete = () => resolve({ sections: listed })
          })
        )
      }

      if (boundary === 'unarchive') {
        vi.mocked(sectionsUnarchive).mockReturnValueOnce(
          new Promise(resolve => {
            complete = () => resolve({ section: section('old') })
          })
        )
      }

      const pending = chat('writer')
      let stale: ReturnType<typeof useSections.getState>['choosing'] = null

      if (boundary !== 'list') {
        await vi.waitFor(() => expect(useSections.getState().choosing).not.toBeNull())
        stale = useSections.getState().choosing

        if (boundary === 'unarchive') {
          stale!.pick(section('old'))
          await vi.waitFor(() => expect(sectionsUnarchive).toHaveBeenCalledOnce())
        }
      } else {
        await vi.waitFor(() => expect(sectionsList).toHaveBeenCalled())
      }

      useConnection.getState().setDaemon(null)
      useConnection.getState().setDaemon(daemon({ one_chat: false, install_id: 'first' }))
      stale?.pick(section('old'))
      complete?.()
      expect(await pending).toBeNull()
      expect(useSections.getState().choosing).toBeNull()
      expect(useSections.getState().byId.old).toBeUndefined()
      const retry = chat('writer')
      await pick(null)
      expect(await retry).toBeNull()
    }
  )

  it.each([false, true])(
    'an info RPC checks install identity before using an old pick, upgraded=%s',
    async upgraded => {
      const first = chat('writer')
      await pick('old')
      expect((await first)?.id).toBe('old')
      useConnection.getState().setDaemon(null)
      vi.mocked(daemonInfo).mockResolvedValue(daemon({ one_chat: upgraded, install_id: 'second' }))
      const reconnect = chat('writer')

      if (upgraded) {
        expect((await reconnect)?.id).toBe('canonical')
      } else {
        await pick(null)
        expect(await reconnect).toBeNull()
      }

      expect(sectionsUnarchive).toHaveBeenCalledTimes(1)
      expect(sectionsCreate).toHaveBeenCalledTimes(upgraded ? 1 : 0)
    }
  )

  it.each(['install', 'capability'] as const)(
    'a direct %s change cancels a chooser',
    async changed => {
      const pending = chat('writer')
      await vi.waitFor(() => expect(useSections.getState().choosing).not.toBeNull())
      const stale = useSections.getState().choosing!
      useConnection.getState().setDaemon(
        daemon({
          one_chat: changed === 'capability',
          install_id: changed === 'install' ? 'second' : 'first'
        })
      )
      stale.pick(section('old'))
      expect(await pending).toBeNull()
      expect(useSections.getState().choosing).toBeNull()
      expect(sectionsUnarchive).not.toHaveBeenCalled()
    }
  )
})
