import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  useSections
} from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { ConnectionSupervisor } from './connection'
import type { Bot, Room } from './types'

async function fixture(completed: boolean) {
  const live = 'room-retry-live'

  const room = {
    id: 'r',
    archived_at: null,
    turns: [{ bot: 'owl', live_session_id: live }]
  } as Room

  const stopped = {
    name: 'owl',
    status: 'stopped',
    status_detail: {
      room_id: 'r',
      section_id: 'room-stored',
      session_id: 'old-failed-live',
      action: { kind: 'retry' }
    }
  } as Bot

  const state = { epoch: 'epoch-A', room, failedBotRead: true }
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
        this.event('gateway.ready', { replay_epoch: state.epoch })
      })
    }
    frame(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
    }
    event(type: string, payload: Record<string, unknown> = {}, sessionId = live) {
      this.frame({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: sessionId, payload }
      })
    }
    send(data: string) {
      const { id, method } = JSON.parse(data)
      requests.push(method)
      const failed = state.failedBotRead && ['hexbot.bots.list', 'hexbot.bots.get'].includes(method)

      const result =
        method === 'hexbot.rooms.list'
          ? { rooms: [state.room] }
          : method === 'hexbot.rooms.log'
            ? { events: [] }
            : method === 'hexbot.bots.list'
              ? { bots: [stopped] }
              : method === 'hexbot.bots.get'
                ? { bot: stopped }
                : method === 'hexbot.info'
                  ? { install_id: 'fixture', daemon_name: 'fixture' }
                  : {}

      queueMicrotask(() =>
        this.frame({
          jsonrpc: '2.0',
          id,
          ...(failed ? { error: { code: -32000, message: 'Read unavailable' } } : { result })
        })
      )
    }
    close() {
      this.readyState = 3
      this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
    }
  }
  clearDeletedSections()
  useConnection.setState({ epoch: 'epoch-A', daemon: null })
  useBots.setState({ byName: { owl: stopped }, order: ['owl'] })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {}, eventsByRoom: {}, order: [] })
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })

  const supervisor = new ConnectionSupervisor({
    bridge: () => null,
    fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
    socketFactory: () => new TestSocket() as unknown as WebSocket
  })

  await supervisor.start({ kind: 'local' })
  const socket = sockets[0]!
  socket.event('hexbot.rooms.turn', {
    room_id: 'r',
    bot: 'owl',
    live_session_id: live,
    status: 'running'
  })
  socket.event('message.start', { retry_resolved: true })
  socket.event('status.update', { kind: 'working', text: 'Working' })

  if (completed) {
    socket.event('message.complete', { text: 'Done', status: 'complete' })
    socket.event('hexbot.rooms.turn', {
      room_id: 'r',
      bot: 'owl',
      live_session_id: live,
      status: 'complete'
    })
    state.room = { ...room, turns: [] }
  }

  const transcript = () => useTranscripts.getState().bySession[live]

  const status = () => {
    const sessions = useTranscripts.getState().bySession

    return botStatusWithLive(useBots.getState().byName.owl!, [], liveSectionsOf(sessions), sessions)
  }

  return { live, requests, sockets, state, status, supervisor, transcript }
}

afterEach(resetTranscriptEffects)

describe.each([false, true])('room retry completed=%s', completed => {
  it('retains exact accepted retry proof through real same-epoch reconnect hydration with failed bot reads', async () => {
    const f = await fixture(completed)

    try {
      expect(f.status()).toBe(completed ? 'idle' : 'working')
      f.sockets[0]!.close()
      await f.supervisor.retryNow()
      expect(useConnection.getState().status).toBe('connected')
      expect(f.transcript()?.retryResolved).toBe(true)
      expect(f.status()).toBe(completed ? 'idle' : 'working')
      expect(f.requests).not.toContain('session.events.since')
    } finally {
      f.supervisor.stop()
    }
  })

  it.each(['new epoch', 'other origin'] as const)(
    'does not transfer retry proof across %s',
    async boundary => {
      const f = await fixture(completed)

      try {
        f.sockets[0]!.close()

        if (boundary === 'new epoch') {
          f.state.epoch = 'epoch-B'
          await f.supervisor.retryNow()
        } else {
          await f.supervisor.start({
            kind: 'remote',
            host: 'other.test',
            port: 80,
            tls: false,
            deviceToken: ''
          })
        }

        expect(f.transcript()?.retryResolved).toBeUndefined()
        expect(f.status()).toBe('stopped')
      } finally {
        f.supervisor.stop()
      }
    }
  )
})
