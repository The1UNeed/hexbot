import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { ConnectionSupervisor } from './connection'
import type { Bot, Section } from './types'

async function fixture(marked = true, unopened?: 'indexed' | 'cached') {
  const section = {
    id: 'retry-section',
    bot: 'owl',
    archived_at: null,
    live_session_id: 'retry-live'
  } as Section

  const stopped = {
    name: 'owl',
    status: 'stopped',
    status_detail: {
      section_id: section.id,
      session_id: section.live_session_id,
      room_id: null,
      since: 1,
      text: 'Failed last turn',
      action: { kind: 'retry' }
    },
    sections_recent: [section]
  } as Bot

  const state = {
    epoch: 'epoch-A',
    failHydration: false,
    unauthorized: false,
    proofCode: null as string | null,
    roster: stopped
  }

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

    event(type: string, payload: Record<string, unknown> = {}, sessionId = 'retry-live') {
      this.frame({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: sessionId, payload }
      })
    }

    send(data: string) {
      const { id, method } = JSON.parse(data)
      requests.push(method)

      const failed =
        state.failHydration &&
        ['hexbot.bots.list', 'hexbot.bots.get', 'hexbot.rooms.list', 'hexbot.info'].includes(method)

      const result =
        method === 'hexbot.bots.list'
          ? { bots: [state.roster] }
          : method === 'hexbot.bots.get'
            ? { bot: state.roster }
            : method === 'hexbot.rooms.list'
              ? { rooms: [] }
              : method === 'hexbot.info'
                ? { install_id: 'fixture', daemon_name: 'fixture' }
                : {}

      queueMicrotask(() =>
        this.frame({
          jsonrpc: '2.0',
          id,
          ...(failed ? { error: { code: -32000, message: 'Refresh unavailable' } } : { result })
        })
      )
    }

    close(code = 1006) {
      this.readyState = 3
      this.dispatchEvent(new CloseEvent('close', { code }))
    }
  }

  const target = { kind: 'local' as const }
  useConnection.setState({ epoch: 'epoch-A', daemon: null, target })
  useBots.setState({ byName: {}, order: [], error: null })
  useSections.setState({
    byId: unopened === 'cached' ? {} : { [section.id]: section },
    idsByBot: unopened === 'cached' ? {} : { owl: [section.id] },
    liveSessionId: unopened === 'cached' ? {} : { [section.id]: section.live_session_id! }
  })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })

  if (!unopened) {
    useTranscripts.getState().open('retry-live', section.id, [], undefined, 'owl')
  }

  const supervisor = new ConnectionSupervisor({
    bridge: () => null,
    fetch: async input =>
      String(input).endsWith('/api/auth/ws-ticket') && state.proofCode
        ? new Response(
            JSON.stringify({ code: state.proofCode, server_time: 500, proof_time: 100 }),
            {
              status: 401
            }
          )
        : new Response(JSON.stringify({ ticket: 'fixture' }), {
            status: state.unauthorized ? 401 : 200
          }),
    socketFactory: () => new TestSocket() as unknown as WebSocket
  })

  await supervisor.start(target)
  state.failHydration = true
  sockets[0]!.event('message.start', marked ? { retry_resolved: true } : {})
  sockets[0]!.event('status.update', { kind: 'working', text: 'Working' })
  await useBots.getState().refresh()

  const transcript = () => useTranscripts.getState().bySession['retry-live']

  const status = () => {
    const transcripts = useTranscripts.getState().bySession
    const live = liveSectionsOf(transcripts)
    const bot = useBots.getState().byName.owl!

    return {
      section: sectionStatusOf(bot, section.id, live),
      bot: botStatusWithLive(bot, unopened === 'cached' ? [] : [section], live, transcripts)
    }
  }

  return { requests, section, sockets, state, status, stopped, supervisor, target, transcript }
}

afterEach(() => resetTranscriptEffects())

it.each(['indexed', 'cached'] as const)(
  'binds an unopened %s retry before failed hydration and preserves its proof on reconnect',
  async lookup => {
    const f = await fixture(true, lookup)

    try {
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
      expect(f.transcript()).toMatchObject({
        sectionId: f.section.id,
        bot: 'owl',
        retryResolved: true
      })
      f.sockets[0]!.close()
      await f.supervisor.retryNow()
      expect(useConnection.getState().status).toBe('connected')
      expect(f.status().section).toBe('working')
      expect(f.transcript()?.retryResolved).toBe(true)
      f.sockets[1]!.event('message.complete', { text: 'Done' })
      expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
      f.sockets[1]!.close()
      f.state.epoch = 'epoch-B'
      await f.supervisor.retryNow()
      expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
    } finally {
      f.supervisor.stop()
    }
  }
)

it.each(['approval', 'clarify'] as const)(
  'preserves resolved Retry through a failed same-daemon reconnect while retiring %s answer evidence',
  async kind => {
    const f = await fixture()

    try {
      const actions = useTranscripts.getState()
      actions.open('answer-live', 'answer-section', [], undefined, 'owl')

      if (kind === 'approval') {
        f.sockets[0]!.event(
          'approval.request',
          { request_id: 'answered', section_id: 'answer-section', bot: 'owl' },
          'answer-live'
        )
        actions.resolveApproval('answer-live', 'answered', 'once')
      } else {
        f.sockets[0]!.event(
          'clarify.request',
          { request_id: 'answered', question: 'Choose?', section_id: 'answer-section', bot: 'owl' },
          'answer-live'
        )
        actions.answerClarify('answer-live', 'answered', 'answered', 'Yes')
      }

      expect(useTranscripts.getState().bySession['answer-live']?.answeredWaiting?.requestId).toBe(
        'answered'
      )
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
      f.sockets[0]!.close()
      expect(f.transcript()?.retryResolved).toBe(true)
      expect(useTranscripts.getState().bySession['answer-live']?.answeredWaiting).toBeUndefined()
      expect(f.transcript()?.liveStatus).toBeUndefined()
      await f.supervisor.retryNow()
      expect(useConnection.getState().status).toBe('connected')
      expect(useBots.getState().byName.owl?.status).toBe('stopped')
      expect(f.transcript()?.retryResolved).toBe(true)
      expect(useTranscripts.getState().bySession['answer-live']?.answeredWaiting).toBeUndefined()
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
      expect(f.requests).not.toContain('session.events.since')
    } finally {
      f.supervisor.stop()
    }
  }
)

it('keeps resolved Retry when the same target is explicitly stopped and reconnected', async () => {
  const f = await fixture()

  try {
    f.supervisor.stop()
    expect(f.transcript()?.retryResolved).toBe(true)
    await f.supervisor.start({ kind: 'local' })
    expect(f.transcript()?.retryResolved).toBe(true)
    expect(f.status()).toEqual({ section: 'working', bot: 'working' })
  } finally {
    f.supervisor.stop()
  }
})

it.each(['new epoch', 'other origin', 'revocation', 'unauthorized handshake'] as const)(
  'retires resolved Retry on %s even when hydration fails',
  async boundary => {
    const f = await fixture()

    try {
      if (boundary === 'revocation') {
        f.sockets[0]!.close(4403)
        expect(useConnection.getState().status).toBe('unauthorized')
      } else if (boundary === 'other origin') {
        await f.supervisor.start({
          kind: 'remote',
          host: 'other.test',
          port: 80,
          tls: false,
          deviceToken: ''
        })
      } else if (boundary === 'unauthorized handshake') {
        f.sockets[0]!.close()
        f.state.unauthorized = true
        await f.supervisor.retryNow()
        expect(useConnection.getState().status).toBe('unauthorized')
      } else {
        f.sockets[0]!.close()
        f.state.epoch = 'epoch-B'
        await f.supervisor.retryNow()
      }

      expect(f.transcript()?.retryResolved).toBeUndefined()
      expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
    } finally {
      f.supervisor.stop()
    }
  }
)

it('keeps a successfully completed retry Idle after a failed same-daemon reconnect', async () => {
  const f = await fixture()

  try {
    f.sockets[0]!.event('message.complete', { text: 'Done.' })
    f.sockets[0]!.event('status.update', { kind: 'idle', text: '' })
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    f.sockets[0]!.close()
    await f.supervisor.retryNow()
    expect(f.transcript()?.retryResolved).toBe(true)
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  } finally {
    f.supervisor.stop()
  }
})

it.each(['dpop_key_mismatch', 'dpop_clock_skew', 'dpop_cache_full'] as const)(
  'retains retry proof only for a recoverable device proof failure (%s)',
  async code => {
    const f = await fixture()

    try {
      f.sockets[0]!.close()
      f.state.proofCode = code
      await f.supervisor.retryNow()
      const permanent = code === 'dpop_key_mismatch'
      expect(useConnection.getState().status).toBe(permanent ? 'unauthorized' : 'reconnecting')
      expect(useConnection.getState().proofError?.code).toBe(code)
      expect(useConnection.getState().target).toBe(f.target)
      expect(f.transcript()?.retryResolved).toBe(permanent ? undefined : true)
      expect(f.status()).toEqual({
        section: permanent ? 'stopped' : 'working',
        bot: permanent ? 'stopped' : 'working'
      })

      if (!permanent) {
        f.state.proofCode = null
        await f.supervisor.retryNow()
        expect(useConnection.getState().status).toBe('connected')
        expect(f.transcript()?.retryResolved).toBe(true)
      }
    } finally {
      f.supervisor.stop()
    }
  }
)

it('does not turn an unmarked compaction into retry resolution on reconnect', async () => {
  const f = await fixture(false)

  try {
    f.sockets[0]!.close()
    await f.supervisor.retryNow()
    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  } finally {
    f.supervisor.stop()
  }
})

it.each(['connector', 'global', 'room', 'other section', 'other session'] as const)(
  'preserves unrelated %s Stopped priority after reconnect',
  async cause => {
    const f = await fixture()

    try {
      const detail = { ...f.stopped.status_detail! }

      if (cause === 'connector') {
        detail.action = { kind: 'fix_connector', connector: 'mail' }
      } else if (cause === 'global') {
        detail.section_id = null
        detail.action = null
      } else if (cause === 'room') {
        detail.room_id = 'room-1'
      } else if (cause === 'other section') {
        detail.section_id = 'other-section'
      } else {
        detail.session_id = 'other-live'
      }

      useBots.setState({ byName: { owl: { ...f.stopped, status_detail: detail } } })
      f.sockets[0]!.close()
      await f.supervisor.retryNow()
      expect(f.transcript()?.retryResolved).toBe(true)
      expect(f.status().bot).toBe('stopped')
    } finally {
      f.supervisor.stop()
    }
  }
)

it.each(['full', 'scoped'] as const)(
  'keeps exact retry proof when a newer accepted %s roster names a sibling session',
  async scope => {
    const f = await fixture()

    try {
      f.sockets[0]!.close()
      await f.supervisor.retryNow()
      f.state.failHydration = false
      f.state.roster = {
        ...f.stopped,
        status: 'working',
        status_detail: {
          ...f.stopped.status_detail!,
          section_id: 'other-section',
          session_id: 'other-live',
          action: null,
          text: 'Working'
        }
      }

      if (scope === 'full') {
        await useBots.getState().refresh()
      } else {
        await useBots.getState().refreshOne('owl')
      }

      expect(f.transcript()?.retryResolved).toBe(true)
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
    } finally {
      f.supervisor.stop()
    }
  }
)

it.each([
  'full roster',
  'scoped roster',
  'new error',
  'new incident',
  'failed completion'
] as const)('retires preserved retry proof after %s', async boundary => {
  const f = await fixture()

  try {
    f.sockets[0]!.close()
    await f.supervisor.retryNow()
    expect(f.transcript()?.retryResolved).toBe(true)

    if (boundary === 'full roster' || boundary === 'scoped roster') {
      f.state.failHydration = false

      if (boundary === 'full roster') {
        await useBots.getState().refresh()
      } else {
        await useBots.getState().refreshOne('owl')
      }
    } else if (boundary === 'new error') {
      f.sockets[1]!.event('error', { message: 'Failed again' })
    } else if (boundary === 'new incident') {
      f.sockets[1]!.event('hexbot.bots.incident', {
        bot: 'owl',
        section_id: f.section.id,
        session_id: 'retry-live',
        incident: { id: 'next-failure', text: 'Failed again' }
      })
    } else {
      f.sockets[1]!.event('message.complete', { status: 'error', error: 'Failed again' })
    }

    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  } finally {
    f.supervisor.stop()
  }
})
