import { ConnectionSupervisor } from '../lib/connection'
import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Room } from '../lib/types'

import { useBots } from './bots'
import { useConnection } from './connection'
import { useRooms } from './rooms'
import { botStatusWithLive, liveSectionsOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const room: Room = {
  id: 'r',
  approval_mode: null,
  archived_at: null,
  created_at: 1,
  last_activity_at: 1,
  limits: {},
  main_bot: null,
  members: [],
  name: 'Lab',
  owner_id: 'owner',
  turns: [{ bot: 'owl', live_session_id: 'room-live' }],
  updated_at: 1
}

const idle = { name: 'owl', status: 'idle', status_detail: null } as Bot

function fixture(bot = idle) {
  useBots.setState({ byName: { owl: bot }, order: ['owl'] })
  useConnection.setState({ epoch: 'epoch-A', daemon: null })
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })

  const call = vi.fn((method: string): Promise<unknown> => {
    if (method === 'hexbot.bots.list') {
      throw new Error('Bot refresh unavailable')
    }

    return Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
  })

  setActiveRpc({ call } as never)

  return call
}

function status() {
  const sessions = useTranscripts.getState().bySession

  return botStatusWithLive(useBots.getState().byName.owl!, [], liveSectionsOf(sessions), sessions)
}

function event(type: string, payload: Record<string, unknown> = {}, sessionId = 'room-live') {
  routeEvent({ type, session_id: sessionId, payload } as never, { refreshBots: vi.fn() })
}

function deferred() {
  let resolve!: (value: unknown) => void

  const promise = new Promise<unknown>(release => {
    resolve = release
  })

  return { promise, resolve }
}

afterEach(() => {
  resetTranscriptEffects()
  setActiveRpc(null)
})

it.each(['empty', 'live messages'] as const)(
  'restores Working from the exact running room snapshot with %s transcript history',
  async history => {
    fixture()

    if (history === 'live messages') {
      useTranscripts.getState().open('room-live', 'room:r', [], undefined, 'owl')
      useTranscripts.getState().appendUserMessage('room-live', 'Hello')
    }

    await useBots.getState().refresh()
    await useRooms.getState().refresh()
    expect(useBots.getState().byName.owl?.status).toBe('idle')
    expect(useRooms.getState().liveTurnsByRoom.r?.owl?.live_session_id).toBe('room-live')
    expect(status()).toBe('working')
  }
)

it('keeps cached named Waiting when running means an unseen human request is still pending', async () => {
  fixture({
    ...idle,
    status: 'needs_you',
    status_detail: {
      action: null,
      room_id: 'r',
      section_id: null,
      session_id: 'room-live',
      since: 1,
      text: 'Waiting for you'
    }
  })
  await useRooms.getState().refresh()
  expect(useTranscripts.getState().bySession['room-live']?.waitingRequests).toEqual([])
  expect(status()).toBe('needs_you')
})

it.each(['list', 'log'] as const)(
  'keeps a newer session completion received while awaiting the room %s',
  async stage => {
    fixture()
    const pending = deferred()

    const call = vi.fn((method: string) =>
      method === `hexbot.rooms.${stage}`
        ? pending.promise
        : Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
    )

    setActiveRpc({ call } as never)
    const refreshing = useRooms.getState().refresh()
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(`hexbot.rooms.${stage}`, expect.anything())
    )
    event('message.complete', { text: 'Done.' })
    event('status.update', { kind: 'idle', text: '' })
    pending.resolve(stage === 'list' ? { rooms: [room] } : { events: [] })
    await refreshing
    expect(useTranscripts.getState().bySession['room-live']?.liveStatus).toBe('idle')
    expect(status()).toBe('idle')
  }
)

it('lets a genuinely newer accepted Idle bot roster retire restored room activity', async () => {
  fixture()
  await useRooms.getState().refresh()
  setActiveRpc({ call: vi.fn(async () => ({ bots: [idle] })) } as never)
  await useBots.getState().refresh()
  expect(status()).toBe('idle')
})

it.each(['message.start', 'message.delta', 'tool.start', 'status', 'provider retry'] as const)(
  'keeps restored activity through fresh %s before a Working status frame',
  async progress => {
    fixture()
    await useRooms.getState().refresh()
    expect(status()).toBe('working')

    if (progress === 'status' || progress === 'provider retry') {
      event('status.update', {
        kind: progress === 'status' ? 'status' : 'waiting',
        text: 'Retrying the model request'
      })
    } else {
      event(progress, { text: 'Hello', name: 'read' })
    }

    expect(status()).toBe('working')
  }
)

it.each(['full', 'scoped'] as const)(
  'keeps a newer accepted %s Idle roster when an older room read creates its transcript',
  async scope => {
    fixture()
    const pending = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.rooms.list'
          ? pending.promise
          : Promise.resolve(
              method === 'hexbot.bots.list'
                ? { bots: [idle] }
                : method === 'hexbot.bots.get'
                  ? { bot: idle }
                  : { events: [] }
            )
      )
    } as never)
    const refreshing = useRooms.getState().refresh()

    if (scope === 'full') {
      await useBots.getState().refresh()
    } else {
      await useBots.getState().refreshOne('owl')
    }

    expect(useTranscripts.getState().bySession['room-live']).toBeUndefined()
    pending.resolve({ rooms: [room] })
    await refreshing
    expect(status()).toBe('idle')
  }
)

it("does not let another bot's newer Idle retire the restored turn", async () => {
  fixture()
  const pending = deferred()
  setActiveRpc({
    call: vi.fn((method: string) =>
      method === 'hexbot.rooms.list'
        ? pending.promise
        : Promise.resolve(
            method === 'hexbot.bots.get' ? { bot: { ...idle, name: 'fox' } } : { events: [] }
          )
    )
  } as never)
  const refreshing = useRooms.getState().refresh()
  await useBots.getState().refreshOne('fox')
  pending.resolve({ rooms: [room] })
  await refreshing
  expect(status()).toBe('working')
})

it.each(['approval', 'clarify'] as const)(
  'keeps a fresh confirmed %s above restored Working',
  async kind => {
    fixture()
    const pending = deferred()
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.rooms.list' ? pending.promise : Promise.resolve({ events: [] })
      )
    } as never)
    const refreshing = useRooms.getState().refresh()
    event(`${kind}.request`, {
      request_id: 'pending',
      question: 'Choose?',
      bot: 'owl',
      section_id: 'stored-room-section'
    })
    pending.resolve({ rooms: [room] })
    await refreshing
    expect(status()).toBe('needs_you')
  }
)

it.each(['missing', 'ended', 'archived', 'other bot'] as const)(
  'retires old room activity when the next authoritative snapshot is %s',
  async boundary => {
    fixture()
    await useRooms.getState().refresh()
    expect(status()).toBe('working')

    const rooms =
      boundary === 'missing'
        ? []
        : [
            {
              ...room,
              archived_at: boundary === 'archived' ? 1 : null,
              turns: boundary === 'other bot' ? [{ bot: 'fox', live_session_id: 'fox-live' }] : []
            }
          ]

    setActiveRpc({
      call: vi.fn(async (method: string) =>
        method === 'hexbot.rooms.list' ? { rooms } : { events: [] }
      )
    } as never)
    await useRooms.getState().refresh()
    expect(useTranscripts.getState().bySession['room-live']).toBeUndefined()
    expect(status()).toBe('idle')
  }
)

it.each(['failed read', 'legacy snapshot'] as const)(
  'does not manufacture Working from retained turns after a %s',
  async boundary => {
    fixture()
    await useRooms.getState().refresh()
    useTranscripts.getState().clearAnsweredWaiting()
    setActiveRpc({
      call: vi.fn(async (method: string) => {
        if (boundary === 'failed read') {
          throw new Error('Room refresh unavailable')
        }

        const legacy = { ...room }
        delete legacy.turns

        return method === 'hexbot.rooms.list' ? { rooms: [legacy] } : { events: [] }
      })
    } as never)
    await useRooms.getState().refresh()
    expect(useRooms.getState().liveTurnsByRoom.r?.owl?.live_session_id).toBe('room-live')
    expect(status()).toBe('idle')
  }
)

it.each(['ended', 'replacement', 'failed'] as const)(
  'accepts an older running snapshot only if the newer room read %s did not succeed',
  async result => {
    fixture()
    const pending = deferred()
    let lists = 0

    setActiveRpc({
      call: vi.fn((method: string) => {
        if (method !== 'hexbot.rooms.list') {
          return Promise.resolve({ events: [] })
        }

        if (++lists === 1) {
          return pending.promise
        }

        return result === 'failed'
          ? Promise.reject(new Error('Room refresh unavailable'))
          : Promise.resolve({
              rooms: [
                {
                  ...room,
                  turns:
                    result === 'replacement' ? [{ bot: 'owl', live_session_id: 'next-live' }] : []
                }
              ]
            })
      })
    } as never)
    const old = useRooms.getState().refresh()
    await useRooms.getState().refresh()
    pending.resolve({ rooms: [room] })
    await old
    expect(status()).toBe(result === 'ended' ? 'idle' : 'working')
    expect(useRooms.getState().liveTurnsByRoom.r?.owl?.live_session_id).toBe(
      result === 'ended' ? undefined : result === 'replacement' ? 'next-live' : 'room-live'
    )
  }
)

it.each(['complete', 'failed', 'stopped', 'replacement'] as const)(
  'keeps a newer %s turn event while the old running snapshot awaits its log',
  async boundary => {
    const call = fixture()
    await useRooms.getState().refresh()
    const pending = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.rooms.log' ? pending.promise : Promise.resolve({ rooms: [room] })
    )
    const refreshing = useRooms.getState().refresh()
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.log', expect.anything()))
    event('hexbot.rooms.turn', {
      room_id: 'r',
      bot: 'owl',
      live_session_id: 'room-live',
      status: boundary === 'replacement' ? 'complete' : boundary
    })

    if (boundary === 'replacement') {
      event('hexbot.rooms.turn', {
        room_id: 'r',
        bot: 'owl',
        live_session_id: 'next-live',
        status: 'running'
      })
    }

    pending.resolve({ events: [] })
    await refreshing
    expect(useTranscripts.getState().bySession['room-live']).toBeUndefined()
    expect(status()).toBe(boundary === 'replacement' ? 'working' : 'idle')
  }
)

it("uses a new exact running session and ignores the replaced process's pending card", async () => {
  fixture()
  await useRooms.getState().refresh()
  event('approval.request', { request_id: 'old-pending' })
  setActiveRpc({
    call: vi.fn(async (method: string) =>
      method === 'hexbot.rooms.list'
        ? { rooms: [{ ...room, turns: [{ bot: 'owl', live_session_id: 'next-live' }] }] }
        : { events: [] }
    )
  } as never)
  await useRooms.getState().refresh()
  expect(useTranscripts.getState().bySession['room-live']).toBeUndefined()
  expect(useRooms.getState().liveTurnsByRoom.r?.owl?.live_session_id).toBe('next-live')
  expect(status()).toBe('working')
})

it.each(['connector', 'room', 'global'] as const)(
  'preserves independent %s Stopped priority over restored room activity',
  async cause => {
    fixture({
      ...idle,
      status: 'stopped',
      status_detail: {
        room_id: cause === 'room' ? 'r' : null,
        section_id: null,
        session_id: cause === 'room' ? 'room-live' : null,
        action: cause === 'connector' ? { kind: 'fix_connector', connector: 'mail' } : null,
        since: 1,
        text: 'Stopped'
      }
    })
    await useRooms.getState().refresh()
    expect(status()).toBe('stopped')
  }
)

it.each(['same daemon', 'new epoch', 'other origin failed snapshot'] as const)(
  'uses only current room evidence on supervisor reconnect (%s)',
  async boundary => {
    fixture()
    const state = { rooms: [room], failBots: false, failRooms: false, epoch: 'epoch-A' }
    const sockets: TestSocket[] = []
    const requests: string[] = []

    class TestSocket extends EventTarget {
      readyState = 0

      constructor() {
        super()
        sockets.push(this)
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
          this.frame({
            jsonrpc: '2.0',
            method: 'event',
            params: { type: 'gateway.ready', payload: { replay_epoch: state.epoch } }
          })
        })
      }

      frame(value: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
      }

      send(data: string) {
        const { id, method } = JSON.parse(data)
        requests.push(method)

        const result =
          method === 'hexbot.bots.list'
            ? { bots: [idle] }
            : method === 'hexbot.rooms.list'
              ? { rooms: state.rooms }
              : method === 'hexbot.rooms.log'
                ? { events: [] }
                : method === 'hexbot.info'
                  ? { install_id: 'fixture', daemon_name: 'fixture' }
                  : {}

        queueMicrotask(() =>
          this.frame({
            jsonrpc: '2.0',
            id,
            ...((state.failBots && method === 'hexbot.bots.list') ||
            (state.failRooms && method === 'hexbot.rooms.list')
              ? { error: { code: -32000, message: 'Bot refresh unavailable' } }
              : { result })
          })
        )
      }

      close() {
        this.readyState = 3
        this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
      }
    }

    const supervisor = new ConnectionSupervisor({
      bridge: () => null,
      fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
      socketFactory: () => new TestSocket() as unknown as WebSocket
    })

    try {
      await supervisor.start({ kind: 'local' })
      sockets[0]!.close()
      state.failBots = true

      if (boundary === 'new epoch') {
        state.epoch = 'epoch-B'
        state.rooms = [{ ...room, turns: [{ bot: 'owl', live_session_id: 'new-live' }] }]
      }

      if (boundary === 'other origin failed snapshot') {
        state.failRooms = true
        await supervisor.start({
          kind: 'remote',
          host: 'other.test',
          port: 80,
          tls: false,
          deviceToken: ''
        })
      } else {
        await supervisor.retryNow()
      }

      expect(useConnection.getState().status).toBe('connected')
      const id = boundary === 'new epoch' ? 'new-live' : 'room-live'
      expect(useTranscripts.getState().bySession[id]?.messages).toEqual([])
      expect(useTranscripts.getState().bySession[id]?.streamingMessageId).toBeNull()

      if (boundary === 'new epoch') {
        expect(useTranscripts.getState().bySession['room-live']).toBeUndefined()
      }

      expect(requests).not.toContain('session.events.since')
      expect(status()).toBe(boundary === 'other origin failed snapshot' ? 'idle' : 'working')
    } finally {
      supervisor.stop()
    }
  }
)
