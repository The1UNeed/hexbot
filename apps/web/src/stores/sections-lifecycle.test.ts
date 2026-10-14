import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const section = (overrides: Partial<Section> = {}) =>
  ({
    id: 's1',
    bot: 'owl',
    title: 'Old',
    title_by: null,
    archived_at: null,
    live_session_id: null,
    preview: 'Stored preview',
    message_count: 1,
    ...overrides
  }) as Section

const stopped = (overrides: Partial<Bot['status_detail']> = {}) =>
  ({
    name: 'owl',
    status: 'stopped',
    status_detail: {
      section_id: 's1',
      session_id: 'live',
      room_id: null,
      action: { kind: 'retry' },
      ...overrides
    }
  }) as Bot

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void

  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

type Opened = Awaited<ReturnType<ReturnType<typeof useSections.getState>['open']>>

beforeEach(() => {
  clearDeletedSections()
  useSections.setState({
    byId: { s1: section() },
    idsByBot: { owl: ['s1'] },
    liveSessionId: {},
    sendingTitles: {}
  })
  useBots.setState({ byName: { owl: stopped() }, order: ['owl'] })
  useRooms.setState({ liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['archive', 'unarchive', 'rename'] as const)('%s during an open', edit => {
  it.each([
    [false, true],
    [true, true],
    [false, false],
    [true, false]
  ])(
    'preserves saved metadata and new live binding (edit starts first=%s, edit replies first=%s)',
    async (editStartsFirst, editRepliesFirst) => {
      const original = section({ archived_at: edit === 'unarchive' ? 1 : null })
      useSections.setState({ byId: { s1: original } })
      const opening = deferred()
      const editing = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.sections.open' ? opening.promise : editing.promise
        )
      } as never)

      const beginEdit = () =>
        edit === 'rename'
          ? useSections.getState().rename('s1', 'Saved')
          : useSections.getState()[edit]('s1')

      let loading: Promise<Opened>
      let saving: Promise<void>

      if (editStartsFirst) {
        saving = beginEdit()
        loading = useSections.getState().open('s1')
      } else {
        loading = useSections.getState().open('s1')
        saving = beginEdit()
      }

      const saved = {
        ...original,
        title: edit === 'rename' ? 'Saved' : 'Old',
        archived_at: edit === 'archive' ? 2 : null
      }

      const finishEdit = async () => {
        editing.resolve({ section: saved })
        await saving
      }

      const finishOpen = async () => {
        opening.resolve({
          section: {
            ...original,
            live_session_id: 'new-live',
            preview: 'Fresh preview',
            message_count: 5
          },
          messages: [{ role: 'assistant', text: 'New history' }],
          pending_clarify: { request_id: 'question', question: 'Continue?' }
        })

        return await loading
      }

      let opened: Opened

      if (editRepliesFirst) {
        await finishEdit()
        opened = await finishOpen()
      } else {
        opened = await finishOpen()
        await finishEdit()
      }

      expect(useSections.getState().byId.s1).toMatchObject({
        title: saved.title,
        archived_at: saved.archived_at,
        live_session_id: 'new-live',
        preview: 'Fresh preview',
        message_count: 5
      })

      if (editRepliesFirst) {
        expect(opened.section).toMatchObject({ title: saved.title, archived_at: saved.archived_at })
      }

      expect(opened.liveSessionId).toBe('new-live')
      expect(useSections.getState().liveSessionId.s1).toBe('new-live')
      expect(useTranscripts.getState().bySession['new-live']?.messages[0]?.text).toBe('New history')
      expect(useTranscripts.getState().bySession['new-live']?.clarifies[0]?.requestId).toBe(
        'question'
      )
    }
  )
})

it('retires an exactly deleted private Retry when the following changed-event roster fails', async () => {
  setActiveRpc({
    call: vi.fn((method: string) =>
      method === 'hexbot.sections.delete'
        ? Promise.resolve({ deleted: true })
        : Promise.reject(new Error('offline'))
    )
  } as never)
  await useSections.getState().remove('s1')
  let refresh!: Promise<void>
  routeEvent({ type: 'hexbot.bots.changed', payload: { name: 'owl' } } as GatewayEvent, {
    refreshBots: () => {
      refresh = useBots.getState().refresh()
    }
  })
  await refresh
  expect(useSections.getState().byId.s1).toBeUndefined()
  const bot = useBots.getState().byName.owl!
  expect(botStatusWithLive(bot, [], liveSectionsOf(useTranscripts.getState().bySession))).toBe(
    'idle'
  )
})

it.each([undefined, 'owl'])(
  'keeps a newer accepted row while hydrating a delayed open (%s)',
  async scope => {
    const opening = deferred()
    let current = section({ title: 'Saved' })
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.open'
          ? opening.promise
          : Promise.resolve(
              method === 'hexbot.sections.list' ? { sections: [current] } : { section: current }
            )
      )
    } as never)
    const loading = useSections.getState().open('s1')
    await useSections.getState().rename('s1', 'Saved')
    current = section({ title: 'Other device', archived_at: 3 })
    await useSections.getState().refresh({ bot: scope })
    opening.resolve({
      section: section({ live_session_id: 'new-live', preview: 'Fresh', message_count: 5 }),
      messages: []
    })
    const opened = await loading
    expect(opened.section).toMatchObject({
      title: 'Other device',
      archived_at: 3,
      live_session_id: 'new-live',
      preview: 'Fresh',
      message_count: 5
    })
    expect(useSections.getState().byId.s1).toMatchObject(opened.section)
  }
)

it.each(['owl', 'cat'])(
  'opening one row survives an unrelated %s edit and scoped refresh',
  async bot => {
    const sibling = section({ id: 's2', bot })
    useSections.setState(state => ({
      byId: { ...state.byId, s2: sibling },
      idsByBot: { owl: ['s1'], [bot]: bot === 'owl' ? ['s1', 's2'] : ['s2'] }
    }))
    const opening = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.open'
          ? opening.promise
          : Promise.resolve(
              method === 'hexbot.sections.rename'
                ? { section: { ...sibling, title: 'Sibling' } }
                : {
                    sections:
                      bot === 'owl'
                        ? [section(), { ...sibling, title: 'Sibling' }]
                        : [{ ...sibling, title: 'Sibling' }]
                  }
            )
      )
    } as never)
    const loading = useSections.getState().open('s1')
    await useSections.getState().rename('s2', 'Sibling')
    await useSections.getState().refresh({ bot })
    opening.resolve({ section: section({ live_session_id: 'new-live' }), messages: [] })
    await loading
    expect(useSections.getState().byId.s1?.title).toBe('Old')
    expect(useSections.getState().byId.s2?.title).toBe('Sibling')
    expect(useSections.getState().liveSessionId.s1).toBe('new-live')
  }
)

it.each(['archive', 'unarchive', 'rename'] as const)(
  'failed %s does not cancel a good open',
  async edit => {
    const opening = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.open' ? opening.promise : Promise.reject(new Error('offline'))
      )
    } as never)
    const loading = useSections.getState().open('s1')

    const saving =
      edit === 'rename'
        ? useSections.getState().rename('s1', 'Unsaved')
        : useSections.getState()[edit]('s1')

    await expect(saving).rejects.toThrow('offline')
    opening.resolve({
      section: section({ title: 'Fresh', live_session_id: 'new-live' }),
      messages: []
    })
    expect((await loading).section.title).toBe('Fresh')
    expect(useSections.getState().byId.s1?.title).toBe('Fresh')
  }
)

describe.each(['open', 'openThread'] as const)('%s after a successful deletion', method => {
  it.each([false, true])(
    'clears approval replay and all exact owned transcripts (previous binding=%s)',
    async bound => {
      const opening = deferred()
      setActiveRpc({
        call: vi.fn((name: string) =>
          name === 'hexbot.sections.open' ? opening.promise : Promise.resolve({ deleted: true })
        )
      } as never)
      const transcripts = useTranscripts.getState()
      transcripts.open('sibling-live', 's2', [])
      transcripts.open('room-live', 'room:s1', [])

      if (bound) {
        transcripts.open('old-live', 's1', [])
        transcripts.open('current-live', 's1', [])
        useSections.setState({ liveSessionId: { s1: 'current-live' } })
      }

      const actions = useSections.getState()
      const loading = method === 'open' ? actions.open('s1') : actions.openThread('s1', 'cat')
      const rejected = expect(loading).rejects.toThrow('This section was deleted.')

      const approval = {
        type: 'approval.request',
        session_id: 'replay-live',
        payload: { section_id: 's1', bot: 'owl', request_id: 'pending' }
      } as GatewayEvent

      routeEvent(approval)
      expect(useTranscripts.getState().bySession['replay-live']?.waitingRequests).toHaveLength(1)
      await actions.remove('s1')
      const remaining = useTranscripts.getState().bySession
      expect(Object.keys(remaining).sort()).toEqual(['room-live', 'sibling-live'])
      expect(useSections.getState().liveSessionId.s1).toBeUndefined()
      opening.resolve({ section: section({ live_session_id: 'replay-live' }), messages: [] })
      await rejected
      expect(useTranscripts.getState().bySession['replay-live']).toBeUndefined()

      // An already queued broadcast can arrive after the successful delete reply.
      routeEvent(approval)
      const sessions = useTranscripts.getState().bySession
      const live = liveSectionsOf(sessions)
      expect(sectionStatusOf(stopped(), 's1', live)).toBe('idle')
      expect(botStatusWithLive(stopped(), [], live, sessions)).toBe('idle')
    }
  )

  it.each([false, true])(
    'never rebinds or hydrates an old reply (daemon changed=%s)',
    async changed => {
      const opening = deferred()
      setActiveRpc({
        call: vi.fn((name: string) =>
          name === 'hexbot.sections.open' ? opening.promise : Promise.resolve({ deleted: true })
        )
      } as never)
      const actions = useSections.getState()
      const loading = method === 'open' ? actions.open('s1') : actions.openThread('s1', 'cat')
      const rejected = expect(loading).rejects.toThrow('This section was deleted.')
      await actions.remove('s1')

      if (changed) {
        actions.clearLive()
      }

      opening.resolve({
        section: section({ live_session_id: 'deleted-live' }),
        messages: [{ role: 'assistant', text: 'Old history' }],
        pending_clarify: { request_id: 'old-question', question: 'Continue?' }
      })
      await rejected
      expect(useSections.getState().byId.s1).toBeUndefined()
      expect(useSections.getState().liveSessionId.s1).toBeUndefined()
      expect(useTranscripts.getState().bySession['deleted-live']).toBeUndefined()
    }
  )

  it('allows a genuinely newer successful open to retire deletion status proof', async () => {
    setActiveRpc({
      call: vi.fn((name: string) =>
        Promise.resolve(
          name === 'hexbot.sections.open'
            ? { section: section({ live_session_id: 'replacement-live' }), messages: [] }
            : { deleted: true }
        )
      )
    } as never)
    await useSections.getState().remove('s1')
    expect(botStatusWithLive(stopped(), [], {})).toBe('idle')

    if (method === 'open') {
      await useSections.getState().open('s1')
    } else {
      await useSections.getState().openThread('s1', 'cat')
    }

    expect(botStatusWithLive(stopped(), [], {})).toBe('stopped')
    expect(useSections.getState().liveSessionId.s1).toBe('replacement-live')
  })
})

it.each(['archive', 'unarchive', 'rename'] as const)(
  'does not resurrect a deleted row from a late %s reply',
  async edit => {
    const editing = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.delete' ? Promise.resolve({ deleted: true }) : editing.promise
      )
    } as never)

    const saving =
      edit === 'rename'
        ? useSections.getState().rename('s1', 'Old edit')
        : useSections.getState()[edit]('s1')

    await useSections.getState().remove('s1')
    editing.resolve({ section: section({ title: 'Old edit' }) })
    await saving
    expect(useSections.getState().byId.s1).toBeUndefined()
    expect(botStatusWithLive(stopped(), [], {})).toBe('idle')
  }
)

it.each([
  ['connector', { action: { kind: 'fix_connector', connector: 'search' } }],
  ['global', { section_id: null }],
  ['room', { room_id: 'room' }],
  ['room without room detail', { section_id: 'room-stored', room_id: null }],
  ['sibling', { section_id: 's2' }],
  ['error', { action: null }]
] as const)('keeps a %s failure after deleting another private section', async (_cause, detail) => {
  const current = stopped(detail)
  useBots.setState({ byName: { owl: current } })
  setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
  await useSections.getState().remove('s1')
  expect(botStatusWithLive(current, [], {})).toBe('stopped')
})

it.each(['working', 'needs_you'] as const)(
  'keeps a sibling %s after retiring the deleted Retry',
  async status => {
    const sibling = section({ id: 's2' })
    useSections.setState({ byId: { s1: section(), s2: sibling }, idsByBot: { owl: ['s1', 's2'] } })
    useTranscripts.getState().open('sibling-live', 's2', [], undefined, 'owl')

    if (status === 'working') {
      useTranscripts.getState().statusUpdate('sibling-live', { kind: 'working', text: '' })
    } else {
      useTranscripts
        .getState()
        .approvalRequest('sibling-live', { request_id: 'pending' }, { notify: false })
    }

    setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
    await useSections.getState().remove('s1')
    expect(
      botStatusWithLive(stopped(), [sibling], liveSectionsOf(useTranscripts.getState().bySession))
    ).toBe(status)
  }
)

it('does not retire a different bot’s retry with the same cached detail', async () => {
  setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
  await useSections.getState().remove('s1')
  expect(botStatusWithLive({ ...stopped(), name: 'cat' }, [], {})).toBe('stopped')
})

it('uses a successful unindexed thread deletion, rather than absence alone, as evidence', async () => {
  useSections.setState({ byId: {}, idsByBot: {} })
  useSections.setState({ liveSessionId: { s1: 'thread-live' } })
  useTranscripts.getState().open('thread-live', 's1', [], undefined, 'owl')
  expect(botStatusWithLive(stopped(), [], {})).toBe('stopped')
  setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
  await useSections.getState().remove('s1')
  expect(botStatusWithLive(stopped(), [], {})).toBe('idle')
  expect(botStatusWithLive({ ...stopped(), name: 'cat' }, [], {})).toBe('stopped')
})

it('a failed delete preserves the row, live session, and stopped state', async () => {
  useSections.setState({ liveSessionId: { s1: 'live' } })
  useTranscripts.getState().open('live', 's1', [])
  setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
  await expect(useSections.getState().remove('s1')).rejects.toThrow('offline')
  expect(useSections.getState().byId.s1).toBeDefined()
  expect(useSections.getState().liveSessionId.s1).toBe('live')
  expect(useTranscripts.getState().bySession.live).toBeDefined()
  expect(botStatusWithLive(stopped(), [section()], {})).toBe('stopped')
})

describe.each(['full', 'scoped'] as const)('%s roster overlapping delete', scope => {
  it.each(['deleted retry', 'sibling failure', 'connector'] as const)(
    'accepts only relevant %s status',
    async cause => {
      const fetching = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.sections.delete'
            ? Promise.resolve({ deleted: true })
            : fetching.promise
        )
      } as never)

      const refresh =
        scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

      await useSections.getState().remove('s1')

      const current =
        cause === 'sibling failure'
          ? stopped({ section_id: 's2' })
          : cause === 'connector'
            ? stopped({ action: { kind: 'fix_connector', connector: 'search' } })
            : stopped()

      fetching.resolve(scope === 'full' ? { bots: [current] } : { bot: current })
      await refresh
      expect(botStatusWithLive(useBots.getState().byName.owl!, [], {})).toBe(
        cause === 'deleted retry' ? 'idle' : 'stopped'
      )
    }
  )

  it('keeps an old section list from restoring an explicitly deleted row while accepting other rows', async () => {
    useSections.setState({ byId: {}, idsByBot: {} })
    const fetching = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.delete' ? Promise.resolve({ deleted: true }) : fetching.promise
      )
    } as never)
    const refresh = useSections.getState().refresh({ bot: scope === 'full' ? undefined : 'owl' })
    await useSections.getState().remove('s1')
    fetching.resolve({ sections: [section(), section({ id: 's2' })] })
    await refresh
    expect(useSections.getState().byId.s1).toBeUndefined()
    expect(useSections.getState().byId.s2).toBeDefined()
  })

  it('a newer successful row retires proof without relying on missing roster rows', async () => {
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.sections.delete' ? { deleted: true } : { sections: [section()] }
        )
      )
    } as never)
    await useSections.getState().remove('s1')
    expect(botStatusWithLive(stopped(), [], {})).toBe('idle')
    await useSections.getState().refresh({ bot: scope === 'full' ? undefined : 'owl' })
    expect(botStatusWithLive(stopped(), [section()], {})).toBe('stopped')
  })
})

it('an epoch transition retires deletion status proof without resurrecting stale requests', async () => {
  setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
  await useSections.getState().remove('s1')
  expect(sectionStatusOf(stopped(), 's1')).toBe('idle')
  useSections.getState().clearLive()
  expect(sectionStatusOf(stopped(), 's1')).toBe('stopped')
})

it.each([undefined, 'owl'])(
  'accepts later list metadata without reverting a completed binding (%s)',
  async bot => {
    const opening = deferred()
    const listing = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.open' ? opening.promise : listing.promise
      )
    } as never)
    const loading = useSections.getState().open('s1')
    const refresh = useSections.getState().refresh({ bot })
    opening.resolve({
      section: section({ live_session_id: 'new-live', message_count: 9 }),
      messages: []
    })
    await loading
    listing.resolve({
      sections: [
        section({
          title: 'Later title',
          archived_at: 3,
          live_session_id: 'pre-open-live',
          message_count: 0
        })
      ]
    })
    await refresh
    expect(useSections.getState().byId.s1).toMatchObject({
      title: 'Later title',
      archived_at: 3,
      live_session_id: 'new-live',
      message_count: 9
    })
    expect(useSections.getState().liveSessionId.s1).toBe('new-live')
    setActiveRpc({
      call: vi
        .fn()
        .mockResolvedValue({ sections: [section({ live_session_id: 'post-open-live' })] })
    } as never)
    await useSections.getState().refresh({ bot })
    expect(useSections.getState().byId.s1?.live_session_id).toBe('post-open-live')
    expect(useSections.getState().byId.s1?.message_count).toBe(1)
    expect(useSections.getState().liveSessionId.s1).toBe('post-open-live')
  }
)
