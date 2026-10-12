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

const section = (id: string, bot = 'owl', overrides: Partial<Section> = {}) =>
  ({
    id,
    bot,
    title: id,
    title_by: null,
    archived_at: null,
    live_session_id: null,
    message_count: 1,
    preview: '',
    ...overrides
  }) as Section

const retry = (detail: Partial<NonNullable<Bot['status_detail']>> = {}, name = 'owl') =>
  ({
    name,
    status: 'stopped',
    status_detail: {
      section_id: 'deleted',
      session_id: 'deleted-live',
      room_id: null,
      action: { kind: 'retry' },
      since: 1,
      text: 'Stopped',
      ...detail
    }
  }) as Bot

const deletedEvent = (payload: Record<string, unknown> = {}) =>
  ({
    type: 'hexbot.sections.changed',
    payload: { id: 'deleted', deleted: true, ...payload }
  }) as GatewayEvent

const dot = (bot = useBots.getState().byName.owl!) => {
  const sessions = useTranscripts.getState().bySession

  return botStatusWithLive(
    bot,
    Object.values(useSections.getState().byId).filter(row => row.bot === bot.name),
    liveSectionsOf(sessions),
    sessions
  )
}

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

const notifyDelete = (payload: Record<string, unknown> = {}) =>
  routeEvent(deletedEvent(payload), { refreshSections: vi.fn(), refreshBots: vi.fn() })

beforeEach(() => {
  clearDeletedSections()
  useSections.setState({
    byId: { deleted: section('deleted'), sibling: section('sibling'), cat: section('cat', 'cat') },
    idsByBot: { owl: ['deleted', 'sibling'], cat: ['cat'] },
    liveSessionId: { deleted: 'deleted-live', sibling: 'sibling-live', cat: 'cat-live' },
    sendingTitles: {}
  })
  useBots.setState({ byName: { owl: retry() }, order: ['owl'] })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  useTranscripts.getState().open('deleted-live', 'deleted', [], undefined, 'owl')
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it('retires the remotely deleted private Retry when the bot refresh fails', async () => {
  setActiveRpc({
    call: vi.fn((method: string) =>
      method === 'hexbot.sections.list'
        ? Promise.resolve({ sections: [section('sibling'), section('cat', 'cat')] })
        : Promise.reject(new Error('offline'))
    )
  } as never)
  let sections!: Promise<void>
  let bots!: Promise<void>
  routeEvent(deletedEvent(), {
    refreshSections: () => {
      sections = useSections.getState().refresh()
    },
    refreshBots: () => {
      bots = useBots.getState().refresh()
    }
  })
  await Promise.all([sections, bots])
  expect(useSections.getState().byId.deleted).toBeUndefined()
  expect(dot()).toBe('idle')
})

describe.each(['working', 'needs_you'] as const)('deleted private %s', status => {
  const active = (detail: Partial<NonNullable<Bot['status_detail']>> = {}, name = 'owl') =>
    ({ ...retry(detail, name), status }) as Bot

  it.each(['local', 'remote'] as const)(
    'retires exact %s deletion while the following roster fails',
    async source => {
      useBots.setState({ byName: { owl: active() } })
      setActiveRpc({
        call: vi.fn((method: string) => {
          if (method === 'hexbot.sections.delete') {
            return Promise.resolve({ deleted: true })
          }

          if (method === 'hexbot.sections.list') {
            return Promise.resolve({ sections: [section('sibling')] })
          }

          return Promise.reject(new Error('offline'))
        })
      } as never)

      if (source === 'local') {
        await useSections.getState().remove('deleted')
      }

      let sections!: Promise<void>
      let bots!: Promise<void>
      routeEvent(deletedEvent(), {
        refreshSections: () => {
          sections = useSections.getState().refresh()
        },
        refreshBots: () => {
          bots = useBots.getState().refresh()
        }
      })
      await Promise.all([sections, bots])

      expect(dot()).toBe('idle')
      expect(sectionStatusOf(active(), 'deleted')).toBe('idle')
      expect(useTranscripts.getState().bySession['deleted-live']).toBeUndefined()
      expect(dot(active({}, 'cat'))).toBe(status)
    }
  )

  it.each(['working', 'needs_you'] as const)(
    'keeps fresh sibling %s above the deleted cached cause',
    siblingStatus => {
      useBots.setState({ byName: { owl: active() } })
      useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')

      if (siblingStatus === 'working') {
        routeEvent({
          type: 'status.update',
          session_id: 'sibling-live',
          payload: { kind: 'working' }
        } as GatewayEvent)
      } else {
        routeEvent({
          type: 'approval.request',
          session_id: 'sibling-live',
          payload: { bot: 'owl', section_id: 'sibling', request_id: 'sibling-ask' }
        } as GatewayEvent)
      }

      notifyDelete()
      expect(dot()).toBe(siblingStatus)
    }
  )

  it('keeps a room cause sharing the deleted private section id', () => {
    useBots.setState({ byName: { owl: active({ room_id: 'r' }) } })
    notifyDelete()
    expect(dot()).toBe(status)
  })

  it('keeps fresh room activity after retiring the deleted private cause', () => {
    useBots.setState({ byName: { owl: active() } })
    useRooms.setState({
      liveTurnsByRoom: { r: { owl: { live_session_id: 'room-live', status: 'running' } } }
    } as never)
    useTranscripts.getState().open('room-live', 'room:r', [], undefined, 'owl')
    routeEvent({
      type: 'status.update',
      session_id: 'room-live',
      payload: { kind: 'working' }
    } as GatewayEvent)
    notifyDelete()
    expect(dot()).toBe('working')
  })

  it.each([{ deleted: false }, { deleted: 'true' }, { id: undefined }])(
    'keeps the cached cause for an incomplete deletion event %j',
    payload => {
      useBots.setState({ byName: { owl: active() } })
      notifyDelete(payload)
      expect(useSections.getState().byId.deleted).toBeDefined()
      expect(dot()).toBe(status)
    }
  )

  it('keeps failed deletion unchanged', async () => {
    useBots.setState({ byName: { owl: active() } })
    setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    await expect(useSections.getState().remove('deleted')).rejects.toThrow('offline')
    expect(useSections.getState().byId.deleted).toBeDefined()
    expect(useTranscripts.getState().bySession['deleted-live']).toBeDefined()
    expect(dot()).toBe(status)
  })

  it.each(['full', 'scoped'] as const)(
    'retires a late %s roster naming only the deleted section',
    async scope => {
      useBots.setState({ byName: { owl: active() } })
      const fetching = deferred()
      setActiveRpc({ call: vi.fn().mockReturnValue(fetching.promise) } as never)

      const reading =
        scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

      notifyDelete()
      fetching.resolve(scope === 'full' ? { bots: [active()] } : { bot: active() })
      await reading
      routeEvent({
        type: 'status.update',
        session_id: 'deleted-live',
        payload: { kind: 'working' }
      } as GatewayEvent)

      expect(useSections.getState().byId.deleted).toBeUndefined()
      expect(dot()).toBe('idle')
    }
  )

  it('retires an unlisted owned thread only after its explicit remote deletion', () => {
    useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
    useBots.setState({ byName: { owl: active() } })
    expect(dot()).toBe(status)
    notifyDelete()
    expect(dot()).toBe('idle')
    expect(dot(active({}, 'cat'))).toBe(status)
  })

  it.each(['epoch', 'full', 'scoped', 'open'] as const)(
    'retires the old tombstone after newer %s authority',
    async source => {
      useBots.setState({ byName: { owl: active() } })
      notifyDelete()
      expect(dot()).toBe('idle')

      if (source === 'epoch') {
        useSections.getState().clearLive()
      } else {
        const row = section('deleted', 'owl', { live_session_id: 'new-live' })
        setActiveRpc({
          call: vi.fn((method: string) =>
            Promise.resolve(
              method === 'hexbot.sections.open'
                ? { section: row, messages: [] }
                : { sections: [row] }
            )
          )
        } as never)

        if (source === 'open') {
          await useSections.getState().open('deleted')
        } else {
          await useSections.getState().refresh({ bot: source === 'scoped' ? 'owl' : undefined })
        }
      }

      expect(dot()).toBe(status)
    }
  )
})

it.each(['row', 'transcript', 'unloaded'] as const)(
  'records definite deletion from an event without a bot (%s ownership)',
  source => {
    if (source !== 'row') {
      useSections.setState({ byId: {}, idsByBot: {} })
    }

    if (source === 'unloaded') {
      useTranscripts.getState().dropAll()
    }

    notifyDelete()
    expect(dot()).toBe('idle')
    expect(sectionStatusOf(retry(), 'deleted')).toBe('idle')

    if (source !== 'unloaded') {
      expect(dot(retry({}, 'cat'))).toBe('stopped')
    }
  }
)

it('ignores an unvalidated bot hint and retains known ownership after repeated notification', () => {
  notifyDelete({ bot: 'cat' })
  expect(dot()).toBe('idle')
  expect(dot(retry({}, 'cat'))).toBe('stopped')
  notifyDelete({ bot: 'cat' })
  expect(dot()).toBe('idle')
  expect(dot(retry({}, 'cat'))).toBe('stopped')
})

it('cleans exact row, bindings, and all its transcripts before refreshing, preserving siblings and rooms', () => {
  const transcripts = useTranscripts.getState()
  transcripts.open('older-live', 'deleted', [], undefined, 'owl')
  transcripts.open('unmapped-live', 'deleted', [], undefined, 'owl')
  transcripts.approvalRequest('unmapped-live', { request_id: 'approval' }, { notify: false })
  transcripts.open('sibling-live', 'sibling', [], undefined, 'owl')
  transcripts.open('cat-live', 'cat', [], undefined, 'cat')
  transcripts.open('room-live', 'room:deleted', [], undefined, 'owl')

  const inspect = vi.fn(() => {
    expect(useSections.getState().byId.deleted).toBeUndefined()
    expect(useSections.getState().liveSessionId).toEqual({
      sibling: 'sibling-live',
      cat: 'cat-live'
    })
    expect(Object.keys(useTranscripts.getState().bySession).sort()).toEqual([
      'cat-live',
      'room-live',
      'sibling-live'
    ])
    expect(dot()).toBe('idle')
  })

  routeEvent(deletedEvent(), { refreshSections: inspect, refreshBots: inspect })
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(useSections.getState().idsByBot).toEqual({ owl: ['sibling'], cat: ['cat'] })
})

it.each([
  { action: { kind: 'fix_connector', connector: 'mail' } },
  { room_id: 'room', action: { kind: 'retry' } },
  { section_id: null },
  { section_id: 'sibling' },
  { section_id: 'room-stored-session', room_id: null },
  { action: null }
] as Partial<NonNullable<Bot['status_detail']>>[])(
  'keeps an unrelated or non-Retry failure %j',
  detail => {
    notifyDelete()
    expect(dot(retry(detail))).toBe('stopped')
  }
)

it.each(['working', 'needs_you'] as const)('preserves a sibling %s after deletion', status => {
  useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')

  if (status === 'working') {
    useTranscripts.getState().statusUpdate('sibling-live', { kind: 'working', text: 'Working' })
  } else {
    routeEvent({
      type: 'clarify.request',
      session_id: 'sibling-live',
      payload: { bot: 'owl', section_id: 'sibling', request_id: 'question', question: 'Next?' }
    } as GatewayEvent)
  }

  notifyDelete()
  expect(dot()).toBe(status)
})

it.each([undefined, 'owl'])('does not infer deletion from missing list rows (%s)', async bot => {
  setActiveRpc({ call: vi.fn().mockResolvedValue({ sections: [] }) } as never)
  await useSections.getState().refresh({ bot })
  expect(dot()).toBe('stopped')
})

it.each([{ deleted: false }, { deleted: 'true' }, { id: undefined }])(
  'does not treat an ordinary or incomplete changed event as deletion (%j)',
  payload => {
    notifyDelete(payload)
    expect(useSections.getState().byId.deleted).toBeDefined()
    expect(dot()).toBe('stopped')
  }
)

it.each([undefined, 'owl'])(
  'fences only the deleted row in an older list, still accepting sibling data (%s)',
  async bot => {
    const listing = deferred()
    setActiveRpc({ call: vi.fn().mockReturnValue(listing.promise) } as never)
    const refresh = useSections.getState().refresh({ bot })
    notifyDelete()
    listing.resolve({
      sections: [section('deleted'), section('sibling'), section('older'), section('cat', 'cat')]
    })
    await refresh
    expect(useSections.getState().byId.deleted).toBeUndefined()
    expect(useSections.getState().byId.older).toBeDefined()
    expect(useSections.getState().liveSessionId.sibling).toBe('sibling-live')
    expect(dot()).toBe('idle')
  }
)

describe.each([false, true])('older bot roster (scoped=%s)', scoped => {
  it.each(['deleted', 'connector', 'sibling'] as const)(
    'accepts the %s projection without retiring unrelated bot state',
    async cause => {
      const fetching = deferred()
      setActiveRpc({ call: vi.fn().mockReturnValue(fetching.promise) } as never)
      const refresh = scoped ? useBots.getState().refreshOne('owl') : useBots.getState().refresh()
      notifyDelete()

      const bot = retry(
        cause === 'connector'
          ? { action: { kind: 'fix_connector', connector: 'mail' } }
          : cause === 'sibling'
            ? { section_id: 'sibling' }
            : {}
      )

      fetching.resolve(scoped ? { bot } : { bots: [bot] })
      await refresh
      expect(dot()).toBe(cause === 'deleted' ? 'idle' : 'stopped')
    }
  )
})

describe.each(['open', 'openThread'] as const)('remote deletion during %s', method => {
  it.each([false, true])('fences an old reply across daemon reset=%s', async reset => {
    const opening = deferred()
    setActiveRpc({ call: vi.fn().mockReturnValue(opening.promise) } as never)
    const actions = useSections.getState()

    const loading =
      method === 'open' ? actions.open('deleted') : actions.openThread('deleted', 'cat')

    const rejected = expect(loading).rejects.toThrow('This section was deleted.')
    routeEvent({
      type: 'approval.request',
      session_id: 'unmapped-live',
      payload: { bot: 'owl', section_id: 'deleted', request_id: 'approval' }
    } as GatewayEvent)
    notifyDelete()

    if (reset) {
      actions.clearLive()
      expect(dot()).toBe('stopped')
    }

    opening.resolve({
      section: section('deleted', 'owl', { live_session_id: 'unmapped-live' }),
      messages: [{ role: 'assistant', text: 'Deleted history' }],
      pending_clarify: { request_id: 'question', question: 'Continue?' }
    })
    await rejected
    expect(useSections.getState().byId.deleted).toBeUndefined()
    expect(useSections.getState().liveSessionId.deleted).toBeUndefined()
    expect(useTranscripts.getState().bySession['unmapped-live']).toBeUndefined()
  })
})

it.each(['full', 'scoped', 'open', 'openThread'] as const)(
  'a genuinely newer %s row retires the deletion proof',
  async source => {
    notifyDelete()
    expect(dot()).toBe('idle')
    const row = section('deleted', 'owl', { live_session_id: 'new-live' })
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.sections.open' ? { section: row, messages: [] } : { sections: [row] }
        )
      )
    } as never)
    const actions = useSections.getState()

    if (source === 'open') {
      await actions.open('deleted')
    } else if (source === 'openThread') {
      await actions.openThread('deleted', 'cat')
    } else {
      await actions.refresh({ bot: source === 'scoped' ? 'owl' : undefined })
    }

    expect(useSections.getState().liveSessionId.deleted).toBe('new-live')
    expect(dot()).toBe('stopped')
  }
)

it.each([false, true])(
  'does not reinstall proof from the local RPC after its earlier event and newer authority (reset=%s)',
  async reset => {
    const deletion = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.delete'
          ? deletion.promise
          : Promise.resolve({ sections: [section('deleted')] })
      )
    } as never)
    const actions = useSections.getState()
    const removing = actions.remove('deleted')
    notifyDelete()

    if (reset) {
      actions.clearLive()
    }

    await actions.refresh()
    expect(dot()).toBe('stopped')
    deletion.resolve({ deleted: true })
    await removing
    expect(useSections.getState().byId.deleted).toBeDefined()
    expect(dot()).toBe('stopped')
  }
)

it('keeps failed local deletion unchanged until an independent definitive event arrives', async () => {
  setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('busy')) } as never)
  await expect(useSections.getState().remove('deleted')).rejects.toThrow('busy')
  expect(useSections.getState().byId.deleted).toBeDefined()
  expect(useSections.getState().liveSessionId.deleted).toBe('deleted-live')
  expect(useTranscripts.getState().bySession['deleted-live']).toBeDefined()
  expect(dot()).toBe('stopped')
  notifyDelete()
  expect(useSections.getState().byId.deleted).toBeUndefined()
  expect(dot()).toBe('idle')
})

it('a new daemon does not inherit previous deletion ownership for the same section id', () => {
  notifyDelete()
  useSections.getState().clearLive()
  useSections.setState({ byId: {}, idsByBot: {} })
  useBots.setState({ byName: { cat: retry({}, 'cat') }, order: ['cat'] })
  notifyDelete()
  expect(dot(useBots.getState().byName.cat!)).toBe('idle')
})
