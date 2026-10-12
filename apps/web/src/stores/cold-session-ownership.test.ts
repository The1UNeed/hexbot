import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Room, Section } from '../lib/types'

import { useBots } from './bots'
import { useConnection } from './connection'
import { useRooms } from './rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const bot = { name: 'owl', status: 'idle', status_detail: null } as Bot

const section = (patch: Partial<Section> = {}) =>
  ({
    id: 'stored',
    bot: 'owl',
    live_session_id: 'live',
    peer_bot: 'cat',
    archived_at: null,
    title: 'Thread',
    title_by: null,
    message_count: 0,
    preview: '',
    ...patch
  }) as Section

const event = (type: string, payload: Record<string, unknown>, session_id = 'live') =>
  routeEvent({ type, payload, session_id } as GatewayEvent)

const dot = (owner = bot) => {
  const sessions = useTranscripts.getState().bySession

  return botStatusWithLive(owner, [], liveSectionsOf(sessions), sessions)
}

const pending = (kind: 'approval' | 'clarify', patch = {}) =>
  event(`${kind}.request`, {
    bot: 'owl',
    section_id: 'stored',
    request_id: 'request',
    question: 'Continue?',
    ...patch
  })

const resolved = (kind: 'approval' | 'clarify') =>
  event(
    `${kind}.resolved`,
    kind === 'approval'
      ? { request_id: 'request', choice: 'once' }
      : { request_id: 'request', status: 'answered', answers: { request: 'Yes' } }
  )

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function rpc(rows: Section[] = []) {
  const call = vi.fn((method: string, params: { include_threads?: boolean }) =>
    method === 'hexbot.sections.list'
      ? Promise.resolve({ sections: rows.filter(row => !row.peer_bot || params.include_threads) })
      : Promise.reject(new Error('unavailable'))
  )

  setActiveRpc({ call } as never)

  return call
}

beforeEach(() => {
  clearDeletedSections()
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, sendingTitles: {} })
  useRooms.setState({
    byId: { room: { id: 'room', archived_at: 1 } as Room },
    liveTurnsByRoom: {},
    order: []
  })
  useBots.setState({ byName: { owl: bot }, order: ['owl'] })
  useConnection.setState({
    target: { kind: 'local', origin: 'http://cold.test' },
    epoch: 'cold-epoch'
  })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['approval', 'clarify'] as const)('cold %s ownership', kind => {
  it.each(['waiting', 'Working'] as const)(
    'keeps an unindexed room card pending without projecting %s',
    async progress => {
      const call = rpc()
      pending(kind)

      if (progress === 'Working') {
        resolved(kind)
        event('status.update', { kind: 'working', text: 'Working' })
      }

      event('hexbot.bots.changed', {}, '')
      await flush()
      expect(dot()).toBe('idle')
      expect(call).toHaveBeenCalledWith('hexbot.sections.list', {
        bot: 'owl',
        include_archived: true,
        include_threads: true
      })
      expect(useTranscripts.getState().bySession.live?.sectionId).toBe('stored')
      expect(
        kind === 'approval'
          ? useTranscripts.getState().bySession.live?.approvals
          : useTranscripts.getState().bySession.live?.clarifies
      ).toHaveLength(1)
      expect(useSections.getState().liveSessionId.stored).toBeUndefined()
    }
  )

  it('verifies a real unopened teammate thread and preserves its resumed Working', async () => {
    const call = rpc([section()])
    pending(kind)
    await flush()
    expect(call).toHaveBeenCalledWith('hexbot.sections.list', {
      bot: 'owl',
      include_archived: true,
      include_threads: true
    })
    expect(dot()).toBe('needs_you')
    expect(useSections.getState().byId.stored).toBeUndefined()
    expect(useSections.getState().idsByBot.owl).toBeUndefined()
    resolved(kind)
    event('status.update', { kind: 'working', text: 'Working' })
    event('hexbot.bots.changed', {}, '')
    await flush()
    expect(dot()).toBe('working')
    expect(dot({ ...bot, name: 'cat' })).toBe('idle')
  })

  it.each([
    { id: 'different' },
    { bot: 'cat' },
    { live_session_id: 'other' },
    { live_session_id: null },
    { archived_at: 1 }
  ])('rejects metadata that does not certify this private session: %j', async patch => {
    rpc([section(patch)])
    pending(kind)
    await flush()
    expect(dot()).toBe('idle')
    expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(
      'live_session_id' in patch && patch.live_session_id === null ? 0 : 1
    )
    expect(
      kind === 'approval'
        ? useTranscripts.getState().bySession.live?.approvals
        : useTranscripts.getState().bySession.live?.clarifies
    ).toHaveLength(1)
  })

  it('preserves cards but establishes no ownership when its metadata read fails', async () => {
    setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    pending(kind)
    await flush()
    expect(dot()).toBe('idle')
    expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)
  })

  it.each(['Working', 'new request'] as const)(
    'late verification preserves newer %s',
    async progress => {
      const held = deferred()
      setActiveRpc({
        call: vi.fn((method: string, params: { include_threads?: boolean }) =>
          method === 'hexbot.sections.list' && params.include_threads
            ? held.promise
            : Promise.reject(new Error('unavailable'))
        )
      } as never)
      pending(kind)
      expect(dot()).toBe('idle')
      resolved(kind)
      event('status.update', { kind: 'working', text: 'Working' })

      if (progress === 'new request') {
        pending(kind, { request_id: 'new' })
      }

      held.resolve({ sections: [section()] })
      await flush()
      expect(dot()).toBe(progress === 'Working' ? 'working' : 'needs_you')
      expect(useTranscripts.getState().bySession.live?.liveStatus).toBe('working')
    }
  )

  it.each(['deleted', 'drop', 'new epoch', 'new target', 'archive', 'new binding'] as const)(
    'fences late ownership after %s',
    async boundary => {
      const held = deferred()
      setActiveRpc({
        call: vi.fn((method: string, params: { include_threads?: boolean }) =>
          method === 'hexbot.sections.list' && params.include_threads
            ? held.promise
            : Promise.reject(new Error('unavailable'))
        )
      } as never)
      pending(kind)

      if (boundary === 'deleted') {
        event('hexbot.sections.changed', { id: 'stored', deleted: true }, '')
      }

      if (boundary === 'drop') {
        useTranscripts.getState().drop('live')
      }

      if (boundary === 'new epoch') {
        useSections.getState().clearLive()
      }

      if (boundary === 'new target') {
        useConnection.setState({ target: { kind: 'local', origin: 'http://new.test' } })
      }

      if (boundary === 'archive') {
        setActiveRpc({
          call: vi.fn().mockResolvedValue({ section: section({ archived_at: 1 }) })
        } as never)
        await useSections.getState().archive('stored')
      }

      if (boundary === 'new binding') {
        setActiveRpc({
          call: vi
            .fn()
            .mockResolvedValue({ section: section({ live_session_id: 'new-live' }), messages: [] })
        } as never)
        await useSections.getState().openThread('stored', 'cat')
      }

      held.resolve({ sections: [section()] })
      await flush()
      expect(useSections.getState().liveSessionId.stored).toBe(
        boundary === 'new binding' ? 'new-live' : undefined
      )
      expect(dot()).toBe('idle')
    }
  )

  it('withdraws and restores verified thread ownership on archive and unarchive without settling cards', async () => {
    rpc([section()])
    pending(kind)
    await flush()
    expect(dot()).toBe('needs_you')
    setActiveRpc({
      call: vi.fn().mockResolvedValue({ section: section({ archived_at: 1 }) })
    } as never)
    await useSections.getState().archive('stored')
    expect(dot()).toBe('idle')
    expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)
    setActiveRpc({ call: vi.fn().mockResolvedValue({ section: section() }) } as never)
    await useSections.getState().unarchive('stored')
    expect(dot()).toBe('needs_you')
    expect(useSections.getState().byId.stored?.peer_bot).toBe('cat')
    expect(useSections.getState().idsByBot.owl).toBeUndefined()
  })

  it('accepts fresh unlisted archive metadata and survives a failed later read', async () => {
    rpc([section()])
    pending(kind)
    await flush()
    rpc([section({ archived_at: 1 })])
    event('hexbot.sections.changed', { id: 'stored' }, '')
    await flush()
    expect(dot()).toBe('idle')
    rpc([section()])
    event('hexbot.sections.changed', { id: 'stored' }, '')
    await flush()
    expect(dot()).toBe('needs_you')
    setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    event('hexbot.sections.changed', { id: 'stored' }, '')
    await flush()
    expect(dot()).toBe('needs_you')
    expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)
  })
})

it('keeps verified indexed owner identity ahead of conflicting card metadata', async () => {
  useSections.setState({
    byId: { stored: section({ peer_bot: null }) },
    idsByBot: { owl: ['stored'] },
    liveSessionId: { stored: 'live' }
  })
  rpc()
  pending('approval', { bot: 'cat' })
  await flush()
  expect(useTranscripts.getState().bySession.live?.bot).toBe('owl')
  expect(dot()).toBe('needs_you')
  expect(dot({ ...bot, name: 'cat' })).toBe('idle')
})

it('keeps an actual current room turn ahead of its stored card ID', async () => {
  const call = rpc()
  event(
    'hexbot.rooms.turn',
    { bot: 'owl', room_id: 'room', live_session_id: 'live', status: 'running' },
    ''
  )
  pending('clarify')
  await flush()
  expect(useTranscripts.getState().bySession.live?.sectionId).toBe('room:room')
  expect(call).not.toHaveBeenCalledWith(
    'hexbot.sections.list',
    expect.objectContaining({ include_threads: true })
  )
  expect(dot()).toBe('idle')
  useRooms.setState({ byId: { room: { id: 'room', archived_at: null } as Room } })
  expect(dot()).toBe('needs_you')
})

it.each(['absent', 'wrong bot', 'wrong SID', 'failed'] as const)(
  'only accepted latest ownership reads fence an older proof: %s',
  async newer => {
    const first = deferred(),
      second = deferred()

    setActiveRpc({
      call: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    } as never)
    pending('approval')
    const checking = useSections.getState().verifySessionOwner('live')

    if (newer === 'failed') {
      second.reject(new Error('offline'))
    } else {
      second.resolve({
        sections:
          newer === 'absent'
            ? []
            : [section(newer === 'wrong bot' ? { bot: 'cat' } : { live_session_id: 'other' })]
      })
    }

    await checking
    first.resolve({ sections: [section()] })
    await flush()
    expect(dot()).toBe(newer === 'failed' ? 'needs_you' : 'idle')
  }
)

it.each([
  ['approval', 'turn'],
  ['approval', 'snapshot'],
  ['clarify', 'turn'],
  ['clarify', 'snapshot']
] as const)('reconciles a pending %s into its exact later room %s', async (kind, source) => {
  rpc()

  if (kind === 'approval') {
    pending(kind)
  } else {
    pending(kind, {
      questions: [
        { id: 'one', question: 'First?' },
        { id: 'two', question: 'Second?' }
      ]
    })
    event('clarify.resolved', { request_id: 'request', status: 'waiting', answers: { one: 'Yes' } })
  }

  await flush()
  expect(dot()).toBe('idle')
  const turn = { bot: 'owl', room_id: 'room', live_session_id: 'live', status: 'running' }
  useRooms.setState({ byId: { room: { id: 'room', archived_at: null } as Room } })

  if (source === 'turn') {
    event('hexbot.rooms.turn', turn, '')
  } else {
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.rooms.list'
            ? { rooms: [{ id: 'room', archived_at: null, turns: [turn] }] }
            : { events: [] }
        )
      )
    } as never)
    await useRooms.getState().refresh()
  }

  expect(useTranscripts.getState().bySession.live?.sectionId).toBe('room:room')
  expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)

  if (kind === 'clarify') {
    expect(useTranscripts.getState().bySession.live?.clarifies[0]?.answers).toEqual({ one: 'Yes' })
  }

  expect(dot()).toBe('needs_you')
})

it.each(['archive', 'unarchive'] as const)(
  'ownership-only metadata does not supersede a pending indexed %s',
  async operation => {
    const original = section({ peer_bot: null, archived_at: operation === 'archive' ? null : 1 })
    const saving = deferred()
    useSections.setState({
      byId: { stored: original },
      idsByBot: { owl: ['stored'] },
      liveSessionId: {}
    })
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === `hexbot.sections.${operation}`
          ? saving.promise
          : Promise.resolve({ sections: [original] })
      )
    } as never)
    const editing = useSections.getState()[operation]('stored')
    pending('approval')
    await flush()
    expect(useSections.getState().byId.stored?.archived_at).toBe(original.archived_at)
    saving.resolve({ section: { ...original, archived_at: operation === 'archive' ? 1 : null } })
    await editing
    expect(useSections.getState().byId.stored?.archived_at).toBe(operation === 'archive' ? 1 : null)
  }
)

it.each([
  ['approval', null],
  ['approval', 'old-live'],
  ['clarify', null],
  ['clarify', 'old-live']
] as const)(
  'native idle-close handoff %s with held %s metadata keeps the new card projected',
  async (kind, oldLive) => {
    setActiveRpc({
      call: vi
        .fn()
        .mockResolvedValue({ section: section({ live_session_id: 'old-live' }), messages: [] })
    } as never)
    await useSections.getState().openThread('stored', 'cat')
    expect(useSections.getState().liveSessionId.stored).toBe('old-live')
    const held = deferred()
    let lookups = 0

    const call = vi.fn((method: string, params: { include_threads?: boolean }) => {
      if (method === 'hexbot.sections.list') {
        if (!params.include_threads) {
          return Promise.resolve({ sections: [] })
        }

        if (++lookups === 1) {
          return held.promise
        }

        return Promise.resolve({ sections: [section({ live_session_id: 'new-live' })] })
      }

      return Promise.reject(new Error('Bot refresh unavailable'))
    })

    setActiveRpc({ call } as never)
    // close_stored clears last_live_session_id; ensure records the new SID before card events.
    event('hexbot.sections.changed', { id: 'stored' }, '')
    await flush()
    event(
      `${kind}.request`,
      { bot: 'owl', section_id: 'stored', request_id: 'new-request', question: 'Continue?' },
      'new-live'
    )
    event('hexbot.bots.changed', {}, '')
    await flush()
    held.resolve({ sections: [section({ live_session_id: oldLive })] })
    await flush()
    expect(useTranscripts.getState().bySession['new-live']?.waitingRequests).toHaveLength(1)
    expect(dot()).toBe('needs_you')
    expect(useSections.getState().liveSessionId.stored).toBe('new-live')
  }
)

async function oldPrivateBinding() {
  setActiveRpc({
    call: vi.fn().mockResolvedValue({
      section: section({ live_session_id: 'old-live' }),
      messages: []
    })
  } as never)
  await useSections.getState().openThread('stored', 'cat')
}

it.each(['approval', 'clarify'] as const)(
  'verifies a direct new %s SID despite an older private mapping',
  async kind => {
    await oldPrivateBinding()
    rpc([section({ live_session_id: 'new-live' })])
    event(
      `${kind}.request`,
      {
        bot: 'owl',
        section_id: 'stored',
        request_id: 'new-request',
        question: 'Continue?'
      },
      'new-live'
    )
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBe('new-live')
    expect(dot()).toBe('needs_you')
  }
)

it.each(['approval', 'clarify'] as const)(
  'accepts the fresh %s tuple after an older null lookup already retired its map',
  async kind => {
    await oldPrivateBinding()

    const old = deferred(),
      fresh = deferred()

    let lookups = 0
    setActiveRpc({
      call: vi.fn((method: string, params: { include_threads?: boolean }) => {
        if (method === 'hexbot.sections.list') {
          if (!params.include_threads) {
            return Promise.resolve({ sections: [] })
          }

          return ++lookups === 1 ? old.promise : fresh.promise
        }

        return Promise.reject(new Error('Bot refresh unavailable'))
      })
    } as never)
    event('hexbot.sections.changed', { id: 'stored' }, '')
    event(
      `${kind}.request`,
      {
        bot: 'owl',
        section_id: 'stored',
        request_id: 'new-request',
        question: 'Continue?'
      },
      'new-live'
    )
    old.resolve({ sections: [section({ live_session_id: null })] })
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBeUndefined()
    fresh.resolve({ sections: [section({ live_session_id: 'new-live' })] })
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBe('new-live')
    expect(dot()).toBe('needs_you')
  }
)

it.each(['open', 'away and back', 'catalog', 'newer lookup'] as const)(
  'preserves a private binding accepted after the new-SID read by %s',
  async boundary => {
    await oldPrivateBinding()
    const held = deferred()
    const call = vi.fn(() => held.promise)
    setActiveRpc({ call } as never)
    event(
      'approval.request',
      {
        bot: 'owl',
        section_id: 'stored',
        request_id: 'new-request',
        command: 'check'
      },
      'new-live'
    )
    expect(call).toHaveBeenCalledWith('hexbot.sections.list', {
      bot: 'owl',
      include_archived: true,
      include_threads: true
    })

    if (boundary === 'catalog') {
      rpc([section({ peer_bot: null, live_session_id: 'third-live' })])
      await useSections.getState().refresh()
    } else if (boundary === 'newer lookup') {
      rpc([section({ live_session_id: 'third-live' })])
      event(
        'approval.request',
        {
          bot: 'owl',
          section_id: 'stored',
          request_id: 'third-request',
          command: 'check'
        },
        'third-live'
      )
      await flush()
    } else {
      setActiveRpc({
        call: vi.fn().mockResolvedValue({
          section: section({ live_session_id: 'third-live' }),
          messages: []
        })
      } as never)
      await useSections.getState().openThread('stored', 'cat')

      if (boundary === 'away and back') {
        await oldPrivateBinding()
      }
    }

    held.resolve({ sections: [section({ live_session_id: 'new-live' })] })
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBe(
      boundary === 'away and back' ? 'old-live' : 'third-live'
    )
    expect(useTranscripts.getState().bySession['new-live']?.waitingRequests).toHaveLength(1)
  }
)

it.each([
  [{ bot: 'cat' }, 'old-live'],
  [{ live_session_id: 'different' }, 'different'],
  [{ archived_at: 1 }, undefined]
] as const)(
  'reconciles an older private binding only from an exact owner row: %j',
  async (patch, expected) => {
    await oldPrivateBinding()
    rpc([section({ live_session_id: 'new-live', ...patch })])
    event(
      'approval.request',
      {
        bot: 'owl',
        section_id: 'stored',
        request_id: 'new-request',
        command: 'check'
      },
      'new-live'
    )
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBe(expected)
    expect(useTranscripts.getState().bySession['new-live']?.waitingRequests).toHaveLength(1)
    expect(dot()).toBe('idle')
  }
)

describe.each(['approval', 'clarify', 'working'] as const)('superseded private %s', kind => {
  it.each([
    ['thread', 'third-live', null],
    ['thread', null, null],
    ['thread', 'third-live', 1],
    ['indexed', 'third-live', null],
    ['indexed', null, null],
    ['indexed', 'third-live', 1]
  ] as const)(
    'retires old activity for %s with SID %s and archive %s',
    async (surface, sid, archive) => {
      const original = section({
        live_session_id: 'old-live',
        peer_bot: surface === 'thread' ? 'cat' : null
      })

      setActiveRpc({
        call: vi.fn().mockResolvedValue({ section: original, messages: [] })
      } as never)

      if (surface === 'thread') {
        await useSections.getState().openThread('stored', 'cat')
      } else {
        await useSections.getState().open('stored')
      }

      event(
        `${kind === 'working' ? 'approval' : kind}.request`,
        {
          bot: 'owl',
          section_id: 'stored',
          request_id: 'old-request',
          question: 'Continue?'
        },
        'old-live'
      )

      if (kind === 'working') {
        event('approval.resolved', { request_id: 'old-request', choice: 'once' }, 'old-live')
        event('status.update', { kind: 'working', text: 'Working' }, 'old-live')
      }

      rpc([{ ...original, live_session_id: sid, archived_at: archive }])
      event(
        'approval.request',
        {
          bot: 'owl',
          section_id: 'stored',
          request_id: 'new-request',
          command: 'check'
        },
        'new-live'
      )
      await flush()
      const sessions = useTranscripts.getState().bySession
      const live = liveSectionsOf(sessions)
      const rows = surface === 'thread' ? [] : [useSections.getState().byId.stored!]
      expect(botStatusWithLive(bot, rows, live, sessions)).toBe('idle')
      expect(sectionStatusOf(bot, 'stored', live)).toBe('idle')
      expect(sessions['third-live']).toBeUndefined()
      expect(sessions['new-live']?.approvals).toHaveLength(1)
      expect(
        kind === 'clarify' ? sessions['old-live']?.clarifies : sessions['old-live']?.approvals
      ).toHaveLength(1)

      if (surface === 'thread') {
        expect(useSections.getState().idsByBot.owl).toBeUndefined()
      }
    }
  )
})

describe.each(['approval', 'clarify'] as const)('%s lifecycle authority', kind => {
  it.each(['archive', 'unarchive'] as const)(
    'completed %s fences an earlier lookup snapshot',
    async operation => {
      const before = operation === 'archive' ? null : 1
      const after = operation === 'archive' ? 1 : null
      rpc([section({ archived_at: before })])
      pending(kind)
      await flush()

      const saving = deferred(),
        reading = deferred()

      setActiveRpc({
        call: vi.fn((method: string) =>
          method === `hexbot.sections.${operation}` ? saving.promise : reading.promise
        )
      } as never)
      const editing = useSections.getState()[operation]('stored')
      const checking = useSections.getState().verifySessionOwner('live', true)
      saving.resolve({ section: section({ archived_at: after }) })
      await editing
      reading.resolve({ sections: [section({ archived_at: before })] })
      await checking
      expect(dot()).toBe(operation === 'archive' ? 'idle' : 'needs_you')
      expect(useSections.getState().byId.stored?.archived_at).toBe(after)
      expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)
    }
  )

  it.each(['archive', 'unarchive'] as const)(
    'late %s ACK preserves a newer verified SID through restore',
    async operation => {
      rpc([section({ live_session_id: 'old-live', archived_at: 1 })])
      event('approval.request', { bot: 'owl', section_id: 'stored', request_id: 'old' }, 'old-live')
      event('approval.resolved', { request_id: 'old', choice: 'once' }, 'old-live')
      event('status.update', { kind: 'idle', text: 'Ready' }, 'old-live')
      await flush()
      const saving = deferred()
      setActiveRpc({ call: vi.fn(() => saving.promise) } as never)
      const editing = useSections.getState()[operation]('stored')
      rpc([section()])
      pending(kind)
      await flush()
      expect(dot()).toBe('needs_you')
      saving.resolve({
        section: section({
          live_session_id: 'old-live',
          archived_at: operation === 'archive' ? 1 : null
        })
      })
      await editing
      expect(dot()).toBe(operation === 'archive' ? 'idle' : 'needs_you')
      expect(useSections.getState().byId.stored?.live_session_id).toBe('live')

      if (operation === 'archive') {
        rpc([section()])
        event('hexbot.sections.changed', { id: 'stored' }, '')
        await flush()
      }

      expect(dot()).toBe('needs_you')
      expect(useSections.getState().liveSessionId.stored).toBe('live')
      expect(useTranscripts.getState().bySession.live?.waitingRequests).toHaveLength(1)
    }
  )
})

// A list can arrive after a private lookup has disproved its captured live id.
describe.each(['approval', 'clarify'] as const)('%s catalog lifecycle ordering', kind => {
  it.each([
    ['full', 'archived', true],
    ['full', 'closed', true],
    ['scoped', 'archived', true],
    ['scoped', 'closed', true],
    ['full', 'archived', false],
    ['full', 'closed', false],
    ['scoped', 'archived', false],
    ['scoped', 'closed', false]
  ] as const)(
    'keeps an older %s catalog behind newer %s lookup metadata with row present %s',
    async (scope, lifecycle, present) => {
      const original = section({ peer_bot: null, live_session_id: 'old-live' })
      setActiveRpc({
        call: vi.fn().mockResolvedValue({ section: original, messages: [] })
      } as never)
      await useSections.getState().open('stored')
      event(
        `${kind}.request`,
        { bot: 'owl', section_id: 'stored', request_id: 'old-request', question: 'Continue?' },
        'old-live'
      )

      const catalog = deferred(),
        lookup = deferred()

      setActiveRpc({
        call: vi.fn((method: string, params: { include_threads?: boolean }) =>
          method === 'hexbot.sections.list'
            ? params.include_threads
              ? lookup.promise
              : catalog.promise
            : Promise.reject(new Error('offline'))
        )
      } as never)
      const reading = useSections.getState().refresh(scope === 'scoped' ? { bot: 'owl' } : {})
      pending(kind)

      const verified = {
        ...original,
        live_session_id: lifecycle === 'closed' ? null : 'third-live',
        archived_at: lifecycle === 'archived' ? 1 : null
      }

      lookup.resolve({ sections: [verified] })
      await flush()
      const sibling = section({ id: 'sibling', peer_bot: null, live_session_id: null })
      catalog.resolve({
        sections: [...(present ? [{ ...original, title: 'Catalog title' }] : []), sibling]
      })
      await reading
      const sessions = useTranscripts.getState().bySession
      const live = liveSectionsOf(sessions)
      const row = useSections.getState().byId.stored!
      expect(botStatusWithLive(bot, [row], live, sessions)).toBe('idle')
      expect(sectionStatusOf(bot, 'stored', live)).toBe('idle')
      expect(row).toMatchObject({
        archived_at: verified.archived_at,
        live_session_id: verified.live_session_id,
        title: present ? 'Catalog title' : original.title
      })
      expect(useSections.getState().idsByBot.owl).toContain('sibling')
      expect(useSections.getState().idsByBot.owl).toContain('stored')
      expect(useSections.getState().liveSessionId.stored).toBeUndefined()
      expect(
        kind === 'approval' ? sessions['old-live']?.approvals : sessions['old-live']?.clarifies
      ).toHaveLength(1)
    }
  )
})

it.each(['full', 'scoped'] as const)(
  'accepts a later %s catalog after an exact archived ownership lookup',
  async scope => {
    const original = section({ peer_bot: null, archived_at: 1 })
    useSections.setState({ byId: { stored: original }, idsByBot: { owl: ['stored'] } })
    rpc([original])
    pending('approval')
    await flush()
    expect(useSections.getState().liveSessionId.stored).toBeUndefined()
    rpc([section({ peer_bot: null, title: 'Restored', live_session_id: 'new-live' })])
    await useSections.getState().refresh(scope === 'scoped' ? { bot: 'owl' } : {})
    event(
      'approval.request',
      { bot: 'owl', section_id: 'stored', request_id: 'new-request' },
      'new-live'
    )
    const row = useSections.getState().byId.stored!
    const sessions = useTranscripts.getState().bySession
    const live = liveSectionsOf(sessions)
    expect(row).toMatchObject({ archived_at: null, live_session_id: 'new-live', title: 'Restored' })
    expect(useSections.getState().liveSessionId.stored).toBe('new-live')
    expect(botStatusWithLive(bot, [row], live, sessions)).toBe('needs_you')
    expect(sectionStatusOf(bot, 'stored', live)).toBe('needs_you')
  }
)

it.each([
  ['full', 'approval'],
  ['full', 'clarify'],
  ['scoped', 'approval'],
  ['scoped', 'clarify']
] as const)(
  'a %s catalog retaining archived %s proof does not veto a pending unarchive',
  async (scope, kind) => {
    const original = section({ peer_bot: null, archived_at: 1 })

    const saving = deferred(),
      catalog = deferred(),
      lookup = deferred()

    setActiveRpc({
      call: vi.fn((method: string, params: { include_threads?: boolean }) => {
        if (method === 'hexbot.sections.open') {
          return Promise.resolve({ section: original, messages: [] })
        }

        if (method === 'hexbot.sections.unarchive') {
          return saving.promise
        }

        if (method === 'hexbot.sections.list') {
          return params.include_threads ? lookup.promise : catalog.promise
        }

        return Promise.reject(new Error('offline'))
      })
    } as never)
    await useSections.getState().open('stored')
    pending(kind)
    const restoring = useSections.getState().unarchive('stored')
    const reading = useSections.getState().refresh(scope === 'scoped' ? { bot: 'owl' } : {})
    const checking = useSections.getState().verifySessionOwner('live', true)
    lookup.resolve({ sections: [original] })
    await checking
    catalog.resolve({ sections: [{ ...original, archived_at: null, title: 'Catalog title' }] })
    await reading
    saving.resolve({ section: { ...original, archived_at: null } })
    await restoring
    const row = useSections.getState().byId.stored!
    const sessions = useTranscripts.getState().bySession
    const live = liveSectionsOf(sessions)
    expect(row).toMatchObject({ archived_at: null, title: 'Catalog title' })
    expect(botStatusWithLive(bot, [row], live, sessions)).toBe('needs_you')
    expect(sectionStatusOf(bot, 'stored', live)).toBe('needs_you')
  }
)

it.each(
  (['thread', 'indexed'] as const).flatMap(surface =>
    (['approval', 'clarify', 'working'] as const).map(kind => ({ surface, kind }))
  )
)(
  'retires a missing $surface with $kind after deletion while disconnected',
  async ({ surface, kind }) => {
    const original = section({ peer_bot: surface === 'thread' ? 'cat' : null })
    setActiveRpc({ call: vi.fn().mockResolvedValue({ section: original, messages: [] }) } as never)

    if (surface === 'thread') {
      await useSections.getState().openThread('stored', 'cat')
    } else {
      await useSections.getState().open('stored')
    }

    pending(kind === 'working' ? 'approval' : kind)

    if (kind === 'working') {
      resolved('approval')
      event('status.update', { kind: 'working', text: 'Working' })
    }

    // The connection missed the deletion notification; its next catalog refresh fails.
    const owner = {
      ...bot,
      status: kind === 'working' ? 'working' : 'needs_you',
      status_detail: { section_id: 'stored', session_id: 'live' }
    } as Bot

    const call = vi.fn((method: string, params: { include_threads?: boolean }) =>
      method === 'hexbot.sections.list' && params.include_threads
        ? Promise.resolve({ sections: [] })
        : Promise.reject(new Error('offline'))
    )

    setActiveRpc({ call } as never)
    await Promise.all([
      useSections.getState().refresh(),
      useSections.getState().verifySessionOwner('live', true)
    ])
    const sessions = useTranscripts.getState().bySession
    const live = liveSectionsOf(sessions)
    expect(botStatusWithLive(owner, [], live, sessions)).toBe('idle')
    expect(sectionStatusOf(owner, 'stored', live)).toBe('idle')
    expect(useSections.getState().byId.stored).toBeUndefined()
    expect(useSections.getState().liveSessionId.stored).toBeUndefined()
    expect(useSections.getState().idsByBot.owl ?? []).not.toContain('stored')
    expect(kind === 'clarify' ? sessions.live?.clarifies : sessions.live?.approvals).toHaveLength(1)
  }
)

async function indexedPending() {
  const original = section({ peer_bot: null })
  setActiveRpc({ call: vi.fn().mockResolvedValue({ section: original, messages: [] }) } as never)
  await useSections.getState().open('stored')
  pending('approval')

  return original
}

it.each(['full', 'scoped'] as const)(
  'an older %s list cannot restore an absent private section or remove its sibling',
  async scope => {
    const original = await indexedPending()
    const sibling = section({ id: 'sibling', peer_bot: null, live_session_id: null })
    const catalog = deferred()
    setActiveRpc({
      call: vi.fn((method: string, params: { include_threads?: boolean }) =>
        method === 'hexbot.sections.list' && params.include_threads
          ? Promise.resolve({ sections: [sibling] })
          : catalog.promise
      )
    } as never)
    const reading = useSections.getState().refresh(scope === 'scoped' ? { bot: 'owl' } : {})
    await useSections.getState().verifySessionOwner('live', true)
    catalog.resolve({ sections: [original, sibling] })
    await reading
    expect(useSections.getState().byId.stored).toBeUndefined()
    expect(useSections.getState().liveSessionId.stored).toBeUndefined()
    expect(useSections.getState().idsByBot.owl).toEqual(['sibling'])
    expect(dot()).toBe('idle')
    expect(useTranscripts.getState().bySession.live?.approvals).toHaveLength(1)
    rpc([{ ...original, live_session_id: 'new-live' }, sibling])
    await useSections.getState().refresh(scope === 'scoped' ? { bot: 'owl' } : {})
    event('approval.request', { bot: 'owl', section_id: 'stored', request_id: 'new' }, 'new-live')
    expect(useSections.getState().liveSessionId.stored).toBe('new-live')
    expect(dot()).toBe('needs_you')
  }
)

it.each([
  'open',
  'ownership',
  'rename',
  'archive',
  'unarchive',
  'target',
  'epoch',
  'new request',
  'Working'
] as const)('held absence preserves newer %s proof', async boundary => {
  const original = await indexedPending()
  const held = deferred()
  setActiveRpc({ call: vi.fn(() => held.promise) } as never)
  const checking = useSections.getState().verifySessionOwner('live', true)

  if (boundary === 'open') {
    setActiveRpc({
      call: vi
        .fn()
        .mockResolvedValue({ section: { ...original, live_session_id: 'new-live' }, messages: [] })
    } as never)
    await useSections.getState().open('stored')
  } else if (boundary === 'ownership') {
    rpc([{ ...original, live_session_id: 'new-live' }])
    event('approval.request', { bot: 'owl', section_id: 'stored', request_id: 'new' }, 'new-live')
    await flush()
  } else if (boundary === 'rename' || boundary === 'archive' || boundary === 'unarchive') {
    setActiveRpc({
      call: vi.fn().mockResolvedValue({
        section: { ...original, title: 'Edited', archived_at: boundary === 'archive' ? 1 : null }
      })
    } as never)

    if (boundary === 'rename') {
      await useSections.getState().rename('stored', 'Edited')
    } else {
      await useSections.getState()[boundary]('stored')
    }
  } else if (boundary === 'target') {
    useConnection.setState({ target: { kind: 'local', origin: 'http://different.test' } })
  } else if (boundary === 'epoch') {
    useConnection.setState({ epoch: 'new-epoch' })
  } else if (boundary === 'new request') {
    pending('approval', { request_id: 'new' })
  } else {
    resolved('approval')
    event('status.update', { kind: 'working', text: 'Working' })
  }

  held.resolve({ sections: [] })
  await checking
  expect(useSections.getState().byId.stored).toBeDefined()
  expect(useSections.getState().liveSessionId.stored).toBe(
    boundary === 'open' || boundary === 'ownership' ? 'new-live' : 'live'
  )

  if (boundary !== 'archive' && boundary !== 'open') {
    expect(dot()).toBe(boundary === 'Working' ? 'working' : 'needs_you')
  }
})

it.each(['failed', 'missing array', 'malformed row', 'wrong owner'] as const)(
  '%s ownership cannot retire known private activity',
  async result => {
    const original = await indexedPending()
    setActiveRpc({
      call: vi.fn(() =>
        result === 'failed'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              result === 'missing array'
                ? {}
                : { sections: result === 'malformed row' ? [{}] : [{ ...original, bot: 'cat' }] }
            )
      )
    } as never)
    await useSections.getState().verifySessionOwner('live', true)
    expect(useSections.getState().byId.stored).toEqual(original)
    expect(useSections.getState().liveSessionId.stored).toBe('live')
    expect(dot()).toBe('needs_you')
  }
)
