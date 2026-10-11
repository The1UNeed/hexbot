import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import { botStatusWithLive, clearDeletedSections, liveSectionsOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const section = (id: string, overrides: Partial<Section> = {}) =>
  ({
    id,
    bot: 'owl',
    title: id,
    title_by: null,
    archived_at: null,
    live_session_id: null,
    message_count: 1,
    preview: '',
    ...overrides
  }) as Section

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

const dot = (bot: Bot, sections: Section[] = []) => {
  const sessions = useTranscripts.getState().bySession

  return botStatusWithLive(bot, sections, liveSectionsOf(sessions), sessions)
}

const idleBot = { name: 'owl', status: 'idle', status_detail: null } as Bot

async function openSibling(surface: 'room' | 'thread', bot = 'owl', live = 'sibling') {
  if (surface === 'room') {
    useRooms.getState().handleTurn({
      bot,
      room_id: 'shared',
      live_session_id: live,
      status: 'running'
    })
  } else {
    setActiveRpc({
      call: vi.fn().mockResolvedValue({
        section: section('thread', { bot, peer_bot: 'cat', live_session_id: live }),
        messages: []
      })
    } as never)
    await useSections.getState().openThread('thread', 'cat')
  }
}

function ask(sessionId: string, requestId = 'pending', kind = 'approval') {
  routeEvent({
    type: `${kind}.request`,
    session_id: sessionId,
    payload: {
      bot: useTranscripts.getState().bySession[sessionId]?.bot ?? 'owl',
      section_id: 'thread',
      request_id: requestId,
      question: 'Continue?'
    }
  } as GatewayEvent)
}

beforeEach(() => {
  clearDeletedSections()
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, sendingTitles: {} })
  useBots.setState({ byName: {}, order: [] })
  useRooms.setState({ byId: {}, order: [], liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['room', 'thread'] as const)('%s siblings', surface => {
  it.each(['approval', 'clarify'] as const)(
    'shows a fresh sibling %s while the named session stays Working and its roster fails',
    async kind => {
      setActiveRpc({
        call: vi.fn((method: string, params: { id: string }) =>
          method === 'hexbot.sections.open'
            ? Promise.resolve({
                section: section(params.id, { peer_bot: 'cat', live_session_id: params.id }),
                messages: []
              })
            : Promise.reject(new Error('offline'))
        )
      } as never)

      if (surface === 'room') {
        for (const id of ['named', 'sibling']) {
          useRooms.getState().handleTurn({
            bot: 'owl',
            room_id: id,
            live_session_id: id,
            status: 'running'
          })
        }
      } else {
        await useSections.getState().openThread('named', 'cat')
        await useSections.getState().openThread('sibling', 'cat')
      }

      const bot = {
        name: 'owl',
        status: 'working',
        status_detail: {
          section_id: surface === 'thread' ? 'named' : null,
          room_id: surface === 'room' ? 'named' : null,
          session_id: 'named'
        }
      } as Bot

      useBots.setState({ byName: { owl: bot }, order: ['owl'] })
      routeEvent({
        type: `${kind}.request`,
        session_id: 'sibling',
        payload: { bot: 'owl', section_id: 'sibling', request_id: 'pending', question: 'Next?' }
      } as GatewayEvent)
      let refresh!: Promise<void>
      routeEvent({ type: 'hexbot.bots.changed' } as GatewayEvent, {
        refreshBots: () => {
          refresh = useBots.getState().refresh()
        }
      })
      await refresh
      expect(dot(useBots.getState().byName.owl!)).toBe('needs_you')
    }
  )

  it('accepts current Working while ignoring stale streaming and retained cards', async () => {
    await openSibling(surface)
    useTranscripts.getState().messageStart('sibling')
    expect(dot(idleBot)).toBe('idle')
    routeEvent({
      type: 'status.update',
      session_id: 'sibling',
      payload: { kind: 'working', text: 'Working' }
    } as GatewayEvent)
    expect(dot(idleBot)).toBe('working')
    ask('sibling')
    expect(dot(idleBot)).toBe('needs_you')
    useTranscripts.getState().clearAnsweredWaiting()
    expect(dot(idleBot)).toBe('idle')
  })

  it('ignores a teammate even when the section identity is shared', async () => {
    await openSibling(surface, 'cat')
    ask('sibling')
    expect(dot(idleBot)).toBe('idle')
    expect(dot({ ...idleBot, name: 'cat' })).toBe('needs_you')
  })

  it('uses the current process id and ignores an older owned process', async () => {
    await openSibling(surface, 'owl', 'old-live')
    ask('old-live')
    expect(dot(idleBot)).toBe('needs_you')
    await openSibling(surface, 'owl', 'new-live')
    expect(useTranscripts.getState().bySession['old-live']?.waitingRequests).toHaveLength(1)
    expect(dot(idleBot)).toBe('idle')
    ask('new-live', 'new-question', 'clarify')
    expect(dot(idleBot)).toBe('needs_you')
  })

  it('cannot override an unresolved section, room, global, or connector failure', async () => {
    await openSibling(surface)
    ask('sibling')

    const details: Partial<NonNullable<Bot['status_detail']>>[] = [
      { section_id: 'failed', session_id: 'failed-live', action: { kind: 'retry' } },
      { room_id: 'failed-room', session_id: 'failed-live', action: { kind: 'retry' } },
      { section_id: null, action: { kind: 'retry' } },
      { section_id: 'failed', action: { kind: 'fix_connector', connector: 'mail' } }
    ]

    for (const detail of details) {
      expect(
        dot({
          ...idleBot,
          status: 'stopped',
          status_detail: {
            since: 1,
            text: 'Stopped',
            action: null,
            room_id: null,
            section_id: null,
            session_id: null,
            ...detail
          }
        })
      ).toBe('stopped')
    }
  })

  it('cannot clear room-level Waiting without an exact named session', async () => {
    await openSibling(surface)
    useTranscripts.getState().statusUpdate('sibling', { kind: 'working', text: 'Working' })

    const waiting = {
      ...idleBot,
      status: 'needs_you',
      status_detail: { room_id: 'shared', session_id: null }
    } as Bot

    expect(dot(waiting)).toBe('needs_you')
  })
})

it('ignores archived private sections omitted from the visible list', async () => {
  const archived = section('archived', { archived_at: 1 })
  useSections.setState({
    byId: { archived },
    idsByBot: { owl: ['archived'] },
    liveSessionId: { archived: 'archived-live' }
  })
  useTranscripts.getState().open('archived-live', 'archived', [], undefined, 'owl')
  ask('archived-live')
  expect(dot(idleBot)).toBe('idle')
})

it.each(['room', 'thread'] as const)(
  'ignores known archived room metadata before its queued stop, preserving another active %s',
  async surface => {
    await openSibling('room')
    ask('sibling')

    const bot = {
      ...idleBot,
      status: 'working',
      status_detail: { section_id: 'named', session_id: 'named-live' }
    } as Bot

    expect(dot(bot)).toBe('needs_you')
    setActiveRpc({
      call: vi.fn().mockResolvedValue({ room: { id: 'shared', archived_at: 1 } })
    } as never)
    await useRooms.getState().refreshOne('shared')
    expect(useRooms.getState().liveTurnsByRoom.shared?.owl?.live_session_id).toBe('sibling')
    expect(dot(bot)).toBe('working')

    if (surface === 'room') {
      useRooms.getState().handleTurn({
        bot: 'owl',
        room_id: 'active',
        live_session_id: 'active-live',
        status: 'running'
      })
    } else {
      await openSibling('thread', 'owl', 'active-live')
    }

    ask('active-live', 'active-question', 'clarify')
    expect(dot(bot)).toBe('needs_you')
  }
)

describe.each(['working', 'needs_you'] as const)('a named archived room cached as %s', status => {
  it.each(['room', 'thread'] as const)(
    'retires its active status before queued stop, preserving Stopped and another active %s',
    async surface => {
      await openSibling('room')
      ask('sibling')

      const bot: Bot = {
        ...idleBot,
        status,
        status_detail: {
          room_id: 'shared',
          section_id: null,
          session_id: 'sibling',
          action: null,
          since: 1,
          text: 'Working'
        }
      }

      expect(dot(bot)).toBe('needs_you')
      setActiveRpc({
        call: vi.fn().mockResolvedValue({ room: { id: 'shared', archived_at: 1 } })
      } as never)
      await useRooms.getState().refreshOne('shared')
      expect(dot(bot)).toBe('idle')
      expect(
        dot({
          ...bot,
          status: 'stopped',
          status_detail: { ...bot.status_detail!, action: { kind: 'retry' } }
        })
      ).toBe('stopped')

      if (surface === 'room') {
        useRooms.getState().handleTurn({
          bot: 'owl',
          room_id: 'active',
          live_session_id: 'active-live',
          status: 'running'
        })
      } else {
        await openSibling('thread', 'owl', 'active-live')
      }

      ask('active-live', 'active-question', 'clarify')
      expect(dot(bot)).toBe('needs_you')
    }
  )
})

it('ignores acknowledged deletion even if a queued replay creates a later transcript', async () => {
  await openSibling('thread')
  setActiveRpc({ call: vi.fn().mockResolvedValue({ deleted: true }) } as never)
  await useSections.getState().remove('thread')
  useTranscripts.getState().setSectionId('queued-live', 'thread', 'owl')
  useSections.setState({ liveSessionId: { thread: 'queued-live' } })
  ask('queued-live')
  expect(dot(idleBot)).toBe('idle')
})

describe.each(['approval', 'clarify'] as const)('an unopened private sibling %s', kind => {
  it('honors trusted ownership and fresh confirmation without confusing retained cards', async () => {
    const bot = {
      ...idleBot,
      status: 'working',
      status_detail: { section_id: 'named', session_id: 'named-live' }
    } as Bot

    useBots.setState({ byName: { owl: bot }, order: ['owl'] })
    setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    ask('never-opened', 'pending', kind)
    expect(useSections.getState().liveSessionId.thread).toBeUndefined()
    await useBots.getState().refresh()
    expect(dot(useBots.getState().byName.owl!)).toBe('needs_you')
    expect(dot({ ...idleBot, name: 'cat' })).toBe('idle')
    useTranscripts.getState().clearAnsweredWaiting()
    expect(dot(bot)).toBe('working')
    ask('never-opened', 'pending', kind)
    expect(dot(bot)).toBe('needs_you')
    routeEvent({
      type: 'message.complete',
      session_id: 'never-opened',
      payload: {}
    } as GatewayEvent)
    routeEvent({
      type: 'status.update',
      session_id: 'never-opened',
      payload: { kind: 'idle', text: '' }
    } as GatewayEvent)
    setActiveRpc({ call: vi.fn().mockResolvedValue({ bots: [idleBot] }) } as never)
    await useBots.getState().refresh()
    expect(dot(useBots.getState().byName.owl!)).toBe('idle')
    useSections.getState().clearLive()
    expect(useTranscripts.getState().bySession['never-opened']).toBeUndefined()
  })

  it('rejects an older process request once an exact current binding is known', async () => {
    await openSibling('thread', 'owl', 'current-live')
    ask('older-process', 'old-request', kind)
    expect(useTranscripts.getState().bySession['older-process']?.sectionId).toBe('thread')
    expect(useSections.getState().liveSessionId.thread).toBe('current-live')
    expect(dot(idleBot)).toBe('idle')
  })
})

describe.each([undefined, 'owl'])('single-row edits during a %s list', bot => {
  it.each(['rename', 'archive', 'unarchive', 'create', 'remove'] as const)(
    'keeps %s while loading previously unloaded siblings',
    async edit => {
      const current = section('current', { archived_at: edit === 'unarchive' ? 1 : null })
      const cat = section('cat', { bot: 'cat' })
      useSections.setState({
        byId: { current, cat },
        idsByBot: { owl: ['current'], cat: ['cat'] }
      })
      const listing = deferred()
      const editing = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.sections.list' ? listing.promise : editing.promise
        )
      } as never)
      const refresh = useSections.getState().refresh({ bot })
      const actions = useSections.getState()

      const saving =
        edit === 'rename'
          ? actions.rename('current', 'Saved')
          : edit === 'create'
            ? actions.create('owl')
            : actions[edit]('current')

      editing.resolve(
        edit === 'remove'
          ? { deleted: true }
          : {
              section:
                edit === 'create'
                  ? section('created')
                  : {
                      ...current,
                      title: edit === 'rename' ? 'Saved' : 'current',
                      archived_at: edit === 'archive' ? 2 : null
                    }
            }
      )
      await saving
      listing.resolve({ sections: [current, section('older'), ...(bot ? [] : [cat])] })
      await refresh
      expect(useSections.getState().byId.older).toBeDefined()
      expect(useSections.getState().byId.cat).toEqual(cat)

      if (edit === 'remove') {
        expect(useSections.getState().byId.current).toBeUndefined()
      } else if (edit === 'create') {
        expect(useSections.getState().byId.created).toBeDefined()
      } else {
        expect(useSections.getState().byId.current).toMatchObject({
          title: edit === 'rename' ? 'Saved' : 'current',
          archived_at: edit === 'archive' ? 2 : null
        })
      }
    }
  )

  it('accepts a remote-created sibling after a rename already in flight completes', async () => {
    useSections.setState({ byId: { current: section('current') }, idsByBot: { owl: ['current'] } })
    const listing = deferred()
    const editing = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.list' ? listing.promise : editing.promise
      )
    } as never)
    const rename = useSections.getState().rename('current', 'Saved')
    let refresh!: Promise<void>
    routeEvent({ type: 'hexbot.sections.changed', payload: { id: 'remote' } } as GatewayEvent, {
      refreshSections: () => {
        refresh = useSections.getState().refresh({ bot })
      },
      refreshBots: vi.fn()
    })
    editing.resolve({ section: section('current', { title: 'Saved' }) })
    await rename
    listing.resolve({ sections: [section('current'), section('remote')] })
    await refresh
    expect(useSections.getState().byId.current?.title).toBe('Saved')
    expect(useSections.getState().byId.remote).toBeDefined()
  })

  it.each(['rename', 'archive', 'unarchive', 'create', 'remove'] as const)(
    'accepts the list after a failed %s without inventing a saved edit',
    async edit => {
      const listing = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.sections.list' ? listing.promise : Promise.reject(new Error('offline'))
        )
      } as never)
      const actions = useSections.getState()
      const refresh = actions.refresh({ bot })

      const saving =
        edit === 'rename'
          ? actions.rename('current', 'Unsaved')
          : edit === 'create'
            ? actions.create('owl')
            : actions[edit]('current')

      await expect(saving).rejects.toThrow('offline')
      listing.resolve({ sections: [section('current'), section('older')] })
      await refresh
      expect(useSections.getState().idsByBot.owl).toEqual(['current', 'older'])
    }
  )

  it('keeps newer accepted list membership alongside the exact saved edit', async () => {
    const old = deferred()
    const newer = deferred()
    const editing = deferred()
    let reads = 0
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.sections.list'
          ? ++reads === 1
            ? old.promise
            : newer.promise
          : editing.promise
      )
    } as never)
    const actions = useSections.getState()
    const oldRefresh = actions.refresh()
    const saving = actions.rename('current', 'Saved')
    const newRefresh = actions.refresh({ bot })
    editing.resolve({ section: section('current', { title: 'Saved' }) })
    await saving
    newer.resolve({ sections: [section('current'), section('newer')] })
    await newRefresh
    old.resolve({ sections: [section('current'), section('old')] })
    await oldRefresh
    expect(useSections.getState().idsByBot.owl).toEqual(['current', 'newer'])
    expect(useSections.getState().byId.current?.title).toBe('Saved')
  })
})
