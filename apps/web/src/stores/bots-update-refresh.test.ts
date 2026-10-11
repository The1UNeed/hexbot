import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, BotUpdatePatch, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const bot = (overrides: Partial<Bot> = {}) =>
  ({
    name: 'owl',
    title: 'Old',
    status: 'idle',
    status_detail: null,
    updated_at: 10,
    last_activity_at: 1,
    sections_recent: [],
    sections_total: 1,
    avatar: null,
    notify: true,
    skills: [],
    ...overrides
  }) as Bot

const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  useBots.setState({ byName: { owl: bot() }, order: ['owl'], loaded: true, loading: false })
  useSections.setState({ idsByBot: { owl: ['s1', 's2'] } })
  useRooms.setState({ liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['full', 'scoped'] as const)('%s refresh overlapping a successful edit', scope => {
  it.each([
    [true, 'working', false],
    [false, 'working', false],
    [true, 'needs_you', false],
    [false, 'needs_you', false],
    [true, 'working', true],
    [false, 'working', true],
    [true, 'needs_you', true],
    [false, 'needs_you', true]
  ] as const)(
    'accepts later status and saved metadata (edit first=%s, status=%s, pre-write read=%s)',
    async (editFirst, status, preWrite) => {
      const edit = deferred()
      const read = deferred()

      const call = vi.fn((method: string) =>
        method === 'hexbot.bots.update' ? edit.promise : read.promise
      )

      setActiveRpc({ call } as never)
      const saving = useBots.getState().update('owl', { title: 'Fresh' })
      let refreshing!: Promise<void>
      routeEvent({ type: 'hexbot.bots.changed', payload: { name: 'owl' } } as GatewayEvent, {
        refreshBots: () => {
          refreshing =
            scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')
        }
      })
      const saved = bot({ title: 'Fresh', updated_at: 5 })

      const current = bot({
        title: preWrite ? 'Old' : 'Fresh',
        updated_at: preWrite ? 10 : 5,
        status,
        status_detail: { section_id: 's2', session_id: 'second' } as Bot['status_detail'],
        last_activity_at: 20,
        sections_total: 2,
        sections_recent: [{ id: 's2' } as Section]
      })

      const acceptEdit = async () => {
        edit.resolve({ bot: saved })
        await saving
      }

      const acceptRead = async () => {
        read.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
        await refreshing
      }

      if (editFirst) {
        await acceptEdit()
        await acceptRead()
      } else {
        await acceptRead()
        await acceptEdit()
      }

      expect(useBots.getState().byName.owl).toMatchObject({
        title: 'Fresh',
        updated_at: 5,
        status,
        status_detail: current.status_detail,
        last_activity_at: 20,
        sections_total: 2,
        sections_recent: [{ id: 's2' }]
      })
    }
  )

  it('lets a read started after edit completion replace saved metadata normally', async () => {
    setActiveRpc({
      call: vi.fn(async (method: string) =>
        method === 'hexbot.bots.update'
          ? { bot: bot({ title: 'Fresh', updated_at: 10 }) }
          : scope === 'full'
            ? { bots: [bot({ title: 'Other device', status: 'working', updated_at: 1 })] }
            : { bot: bot({ title: 'Other device', status: 'working', updated_at: 1 }) }
      )
    } as never)
    await useBots.getState().update('owl', { title: 'Fresh' })

    if (scope === 'full') {
      await useBots.getState().refresh()
    } else {
      await useBots.getState().refreshOne('owl')
    }

    expect(useBots.getState().byName.owl).toMatchObject({
      title: 'Other device',
      status: 'working',
      updated_at: 1
    })
  })

  it.each([true, false])(
    'uses canonical null and array values across an overlapping read (edit first=%s)',
    async editFirst => {
      const edit = deferred()
      const read = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.update' ? edit.promise : read.promise
        )
      } as never)

      const saving = useBots
        .getState()
        .update('owl', { workdir: '/workspace/', avatar: null, tools: ['terminal', 'terminal'] })

      const refreshing =
        scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

      const saved = bot({
        workdir: '/workspace',
        avatar: null,
        tools: ['terminal'],
        updated_at: null
      })

      const current = bot({
        workdir: '/old',
        avatar: { mime: 'image/png', data: 'fixture' },
        tools: ['browser'],
        status: 'working'
      })

      if (editFirst) {
        edit.resolve({ bot: saved })
        await saving
      }

      read.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
      await refreshing

      if (!editFirst) {
        edit.resolve({ bot: saved })
        await saving
      }

      expect(useBots.getState().byName.owl).toMatchObject({
        workdir: '/workspace',
        avatar: null,
        tools: ['terminal'],
        updated_at: null,
        status: 'working'
      })
    }
  )

  it('does not protect omitted legacy fields or unspecified patch values', async () => {
    const edit = deferred()
    const read = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.bots.update' ? edit.promise : read.promise
      )
    } as never)
    const saving = useBots.getState().update('owl', { notify: false, title: undefined })

    const refreshing =
      scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

    const saved = bot({ title: 'Old' })
    delete saved.notify
    edit.resolve({ bot: saved })
    await saving
    const current = bot({ title: 'Other device', notify: true, updated_at: 1, status: 'working' })
    read.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
    await refreshing
    expect(useBots.getState().byName.owl).toMatchObject({
      title: 'Other device',
      notify: true,
      updated_at: 1,
      status: 'working'
    })
  })

  it('keeps sibling live evidence while accepting runtime from an overlaid roster', async () => {
    const actions = useTranscripts.getState()
    actions.open('first', 's1', [], undefined, 'owl')
    actions.statusUpdate('first', { kind: 'working', text: '' })
    actions.open('second', 's2', [], undefined, 'owl')
    actions.statusUpdate('second', { kind: 'working', text: '' })
    const edit = deferred()
    const read = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.bots.update' ? edit.promise : read.promise
      )
    } as never)
    const saving = useBots.getState().update('owl', { title: 'Fresh' })

    const refreshing =
      scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

    edit.resolve({ bot: bot({ title: 'Fresh' }) })
    await saving

    const current = bot({
      status: 'needs_you',
      status_detail: { section_id: 's2', session_id: 'second' } as Bot['status_detail']
    })

    read.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
    await refreshing
    expect(useBots.getState().byName.owl?.title).toBe('Fresh')
    expect(useTranscripts.getState().bySession.first?.liveStatus).toBe('working')
    expect(useTranscripts.getState().bySession.second?.liveStatus).toBeUndefined()
    const live = liveSectionsOf(useTranscripts.getState().bySession)
    expect(sectionStatusOf(useBots.getState().byName.owl, 's1', live)).toBe('working')
    expect(sectionStatusOf(useBots.getState().byName.owl, 's2', live)).toBe('needs_you')
  })

  it('a failed newer refresh does not suppress an older successful runtime reply', async () => {
    const edit = deferred()
    const read = deferred()
    const failed = deferred()

    const call = vi
      .fn()
      .mockReturnValueOnce(edit.promise)
      .mockReturnValueOnce(read.promise)
      .mockReturnValueOnce(failed.promise)

    setActiveRpc({ call } as never)
    const saving = useBots.getState().update('owl', { title: 'Fresh' })

    const refreshing =
      scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

    const failing = useBots.getState().refresh()
    edit.resolve({ bot: bot({ title: 'Fresh' }) })
    await saving
    failed.reject(new Error('offline'))
    await failing
    const current = bot({ status: 'working' })
    read.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
    await refreshing
    expect(useBots.getState().byName.owl).toMatchObject({ title: 'Fresh', status: 'working' })
  })

  it.each(['remove', 'omission'] as const)(
    'does not apply a late edit to a same-name replacement after %s',
    async deletion => {
      const edit = deferred()
      let current = bot()
      let listed: Bot[] = []
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.update'
            ? edit.promise
            : Promise.resolve(
                method === 'hexbot.bots.list'
                  ? { bots: listed }
                  : method === 'hexbot.bots.get'
                    ? { bot: current }
                    : { deleted: true }
              )
        )
      } as never)
      const saving = useBots.getState().update('owl', { title: 'Old saved edit' })

      if (deletion === 'remove') {
        await useBots.getState().remove('owl')
      } else {
        await useBots.getState().refresh()
      }

      expect(useBots.getState().byName.owl).toBeUndefined()
      current = bot({ title: 'Replacement', status: 'working', updated_at: 1 })
      listed = [current]

      if (scope === 'full') {
        await useBots.getState().refresh()
      } else {
        await useBots.getState().refreshOne('owl')
      }

      edit.resolve({ bot: bot({ title: 'Old saved edit' }) })
      await saving
      expect(useBots.getState().byName.owl).toMatchObject({
        title: 'Replacement',
        status: 'working',
        updated_at: 1
      })
    }
  )
})

it.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true]
])(
  'orders overlapping field edits (older reply first=%s, disjoint=%s)',
  async (olderFirst, disjoint) => {
    const older = deferred()
    const newer = deferred()
    const call = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    setActiveRpc({ call } as never)
    const first = useBots.getState().update('owl', { title: 'First' })

    const second = useBots
      .getState()
      .update('owl', disjoint ? { notify: false } : { title: 'Second' })

    if (olderFirst) {
      older.resolve({ bot: bot({ title: 'First', updated_at: 5 }) })
      await first
    }

    newer.resolve({
      bot: bot({
        title: disjoint ? 'Old' : 'Second',
        notify: false,
        updated_at: 1,
        status: 'working'
      })
    })
    await second

    if (!olderFirst) {
      older.resolve({ bot: bot({ title: 'First', updated_at: 5 }) })
      await first
    }

    expect(useBots.getState().byName.owl).toMatchObject({
      title: disjoint ? 'First' : 'Second',
      notify: false,
      updated_at: 1,
      status: 'working'
    })
  }
)

it('does not forget newer same-field edit order after a post-completion read', async () => {
  const older = deferred()

  const call = vi
    .fn()
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ bot: bot({ title: 'Second' }) })
    .mockResolvedValueOnce({ bots: [bot({ title: 'Other device', status: 'working' })] })

  setActiveRpc({ call } as never)
  const first = useBots.getState().update('owl', { title: 'First' })
  await useBots.getState().update('owl', { title: 'Second' })
  await useBots.getState().refresh()
  older.resolve({ bot: bot({ title: 'First' }) })
  await first
  expect(useBots.getState().byName.owl).toMatchObject({ title: 'Other device', status: 'working' })
})

it.each(['s1', 'thread', 'room:r'])(
  'a legacy catalog-only profile save preserves activity in %s',
  async sectionId => {
    const owner = bot({
      status: 'needs_you',
      status_detail: {
        section_id: sectionId === 'room:r' ? null : sectionId,
        room_id: sectionId === 'room:r' ? 'r' : null,
        session_id: 'active'
      } as Bot['status_detail']
    })

    useBots.setState({ byName: { owl: owner } })
    const actions = useTranscripts.getState()
    actions.open('active', sectionId, [], undefined, 'owl')
    actions.approvalRequest('active', { request_id: 'pending' }, { notify: false })
    actions.open('sibling', 's2', [], undefined, 'owl')
    actions.statusUpdate('sibling', { kind: 'working', text: '' })
    setActiveRpc({
      call: vi
        .fn()
        .mockResolvedValueOnce({ bot: bot({ title: 'Fresh' }) })
        .mockRejectedValueOnce(new Error('offline'))
    } as never)
    await useBots.getState().update('owl', { title: 'Fresh' })
    await useBots.getState().refresh() // The following changed-event roster can fail.
    const current = useBots.getState().byName.owl!
    const transcripts = useTranscripts.getState().bySession
    const live = liveSectionsOf(transcripts)
    expect(current).toMatchObject({
      title: 'Fresh',
      status: 'needs_you',
      status_detail: owner.status_detail
    })
    expect(transcripts.active?.waitingRequests).toHaveLength(1)
    expect(transcripts.sibling?.liveStatus).toBe('working')
    expect(sectionStatusOf(current, 's2', live)).toBe('working')
    expect(
      botStatusWithLive(current, [{ id: 's2', bot: 'owl' } as Section], live, transcripts)
    ).toBe('needs_you')
  }
)

it('does not create protection for a failed edit', async () => {
  const read = deferred()
  const edit = deferred()
  setActiveRpc({
    call: vi.fn().mockReturnValueOnce(read.promise).mockReturnValueOnce(edit.promise)
  } as never)
  const refreshing = useBots.getState().refresh()
  const saving = useBots.getState().update('owl', { title: 'Unsaved' } as BotUpdatePatch)
  edit.reject(new Error('offline'))
  await expect(saving).rejects.toThrow('offline')
  read.resolve({ bots: [bot({ title: 'Other device', status: 'working' })] })
  await refreshing
  expect(useBots.getState().byName.owl).toMatchObject({ title: 'Other device', status: 'working' })
})
